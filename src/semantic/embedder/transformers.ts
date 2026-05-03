/**
 * Transformers.js embedder: the default (and, in v0.1, only) embedder provider.
 *
 * Uses `@huggingface/transformers`' `pipeline('feature-extraction', ...)` API
 * with `Xenova/all-MiniLM-L6-v2` (384 dims) per PLAN Decision #9. The pipeline
 * runs ONNX Runtime under the hood; for MiniLM-L6 it typically downloads a
 * ~23 MB quantized ONNX model the first time, then serves subsequent loads
 * from disk cache.
 *
 * Design notes:
 *
 *  - **Lazy loading.** `new TransformersEmbedder(...)` does not touch the
 *    network or disk. The model is loaded on the first call to `embed()`
 *    (or via {@link TransformersEmbedder.ensureLoaded} for tests). The
 *    `index_status` tool can read `info` without paying the download cost.
 *
 *  - **Batch embedding.** The pipeline natively accepts `string[]` and
 *    returns a rank-2 tensor of shape `[N, dims]`. We slice that into
 *    one `Float32Array` per input. No manual padding — the pipeline
 *    handles tokenization and attention masks internally.
 *
 *  - **Normalization.** We pass `{ pooling: 'mean', normalize: true }` so
 *    the pipeline emits already-L2-normalized mean-pooled vectors. This
 *    matches the embedder contract (see {@link Embedder}) and lets
 *    sqlite-vec's cosine distance work as a dot-product under the hood.
 *
 *  - **Cache location.** The model directory defaults to
 *    `${FOAM_CACHE_DIR}/semantic/models` per PLAN Decision #11. Setting
 *    `env.cacheDir` is a global side-effect on the transformers module
 *    singleton, so we scope the override to the pipeline-creation call
 *    (via the `cache_dir` option) to avoid bleeding across concurrent
 *    embedder instances in tests.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import `./types.js`, `@huggingface/transformers`, node built-ins.
 *   - MUST NOT import from any sibling feature layer.
 */

import { isAbsolute, resolve } from "node:path";

import type { Embedder, EmbedderConfig, EmbedderInfo } from "./types.js";

/** Default Hugging Face model id. 384 dims, mean-pooled. */
export const TRANSFORMERS_DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2" as const;
/** Embedding dimension of {@link TRANSFORMERS_DEFAULT_MODEL}. */
export const TRANSFORMERS_DEFAULT_DIMS = 384 as const;

/** Fallback used when {@link EmbedderConfig.cacheDir} is unset AND `FOAM_CACHE_DIR` is empty. */
const DEFAULT_CACHE_DIR_REL = "./.foam-mcp/";
/** Subdirectory layout under the cache root (PLAN Decision #11). */
const MODELS_SUBDIR = "semantic/models";

/**
 * Subset of the `@huggingface/transformers` pipeline API we actually call.
 * The real type (`AllTasks['feature-extraction']`) is re-exported as
 * `FeatureExtractionPipeline` from the library, but depending on it directly
 * forces TypeScript to walk the entire model/config graph at typecheck time
 * (sharp, onnxruntime, etc.). Using a structural subset keeps this module's
 * type surface minimal and independent of library internals.
 */
interface FeatureExtractionCallable {
  (
    texts: string | string[],
    options?: { pooling?: "mean"; normalize?: boolean },
  ): Promise<TensorLike>;
  dispose?(): Promise<void>;
}

/**
 * Structural subset of `@huggingface/transformers` `Tensor` covering the
 * fields we read. We treat the backing store as a generic typed array so
 * we don't need to narrow to `Float32Array` until we copy out.
 */
interface TensorLike {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}

/**
 * Resolve the effective cache directory for this embedder instance.
 *
 * Precedence:
 *   1. `config.cacheDir` if provided (absolute or relative-to-cwd).
 *   2. `${FOAM_CACHE_DIR}/semantic/models` when `FOAM_CACHE_DIR` is set.
 *   3. `${cwd}/.foam-mcp/semantic/models` as last-resort default.
 *
 * Kept pure + synchronous on purpose: it runs during construction to fix
 * the path before the (expensive) first `embed()` call.
 */
const resolveCacheDir = (raw: string | undefined): string => {
  if (raw && raw.trim() !== "") {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  const fromEnv = process.env.FOAM_CACHE_DIR;
  const base = resolveCacheBaseDir(fromEnv);
  return resolve(base, MODELS_SUBDIR);
};

/**
 * Helper for {@link resolveCacheDir}: pick the base cache directory from
 * the `FOAM_CACHE_DIR` env var, or fall back to the default relative path.
 */
const resolveCacheBaseDir = (fromEnv: string | undefined): string => {
  if (!fromEnv || fromEnv.trim() === "") {
    return resolve(process.cwd(), DEFAULT_CACHE_DIR_REL);
  }
  return isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
};

/**
 * Local, type-only handle on the dynamically-imported transformers module.
 * We import lazily so that simply constructing a {@link TransformersEmbedder}
 * doesn't pay the transformers bundle's initialization cost.
 */
type TransformersModule = typeof import("@huggingface/transformers");

let cachedModulePromise: Promise<TransformersModule> | null = null;

/**
 * Dynamically import the transformers module, caching the promise across
 * all {@link TransformersEmbedder} instances. The module has global state
 * (e.g. `env`), so a single import is both cheaper and safer.
 */
const loadTransformers = (): Promise<TransformersModule> => {
  cachedModulePromise ??= import("@huggingface/transformers");
  return cachedModulePromise;
};

/**
 * Default embedder. See module-level JSDoc for behaviour and caveats.
 */
export class TransformersEmbedder implements Embedder {
  public readonly info: EmbedderInfo;

  readonly #cacheDir: string;
  /** Lazily-constructed pipeline handle; shared across `embed()` calls. */
  #pipelinePromise: Promise<FeatureExtractionCallable> | null = null;
  #closed = false;

  constructor(config: Pick<EmbedderConfig, "model" | "cacheDir">) {
    const model =
      config.model && config.model.trim() !== "" ? config.model : TRANSFORMERS_DEFAULT_MODEL;
    this.info = {
      provider: "transformers",
      model,
      dims: TRANSFORMERS_DEFAULT_DIMS,
      name: `transformers:${model}`,
    };
    this.#cacheDir = resolveCacheDir(config.cacheDir);
  }

  /**
   * Ensure the underlying pipeline is loaded (network + disk work). Exposed
   * for tests that want to isolate load failures from embedding failures.
   */
  public ensureLoaded(): Promise<FeatureExtractionCallable> {
    if (this.#closed) {
      throw new Error("TransformersEmbedder: embed() called after close()");
    }
    this.#pipelinePromise ??= this.#loadPipeline();
    return this.#pipelinePromise;
  }

  public async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensureLoaded();

    let tensor: TensorLike;
    try {
      tensor = await extractor(texts, { pooling: "mean", normalize: true });
    } catch (err) {
      throw new Error(
        `TransformersEmbedder: failed to embed ${texts.length.toString()} text(s) with model '${this.info.model}': ${(err as Error).message}`,
        { cause: err },
      );
    }
    return splitBatchTensor(tensor, texts.length, this.info.dims);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pipelinePromise;
    this.#pipelinePromise = null;
    if (!pending) return;
    try {
      const extractor = await pending;
      if (typeof extractor.dispose === "function") {
        await extractor.dispose();
      }
    } catch {
      // Best-effort: if the pipeline failed to load, there's nothing to dispose.
    }
  }

  async #loadPipeline(): Promise<FeatureExtractionCallable> {
    let mod: TransformersModule;
    try {
      mod = await loadTransformers();
    } catch (err) {
      throw new Error(
        `TransformersEmbedder: failed to load @huggingface/transformers module: ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      // Set the global cache directory. The module is a singleton per Node
      // process, so we rewrite it every load; the last-writer-wins behaviour
      // is fine because v0.1 only ever runs one embedder at a time.
      mod.env.cacheDir = this.#cacheDir;
      const extractor = (await mod.pipeline("feature-extraction", this.info.model, {
        cache_dir: this.#cacheDir,
      })) as unknown as FeatureExtractionCallable;
      return extractor;
    } catch (err) {
      throw new Error(
        `TransformersEmbedder: failed to load model '${this.info.model}'. ` +
          `Check network connectivity and ensure '${this.#cacheDir}' is writable. ` +
          `You can pre-populate the cache by downloading the model once with network access. ` +
          `Underlying error: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}

/**
 * Copy a rank-2 feature-extraction tensor into one {@link Float32Array} per
 * row. The transformers pipeline returns a flat `data` buffer of length
 * `batchSize * dims`; we slice it so each caller gets its own independently
 * owned typed array (no aliasing of the library-internal buffer).
 *
 * Throws when the tensor shape does not match the expectation. This guards
 * against model swaps that silently change dimensions.
 */
const splitBatchTensor = (tensor: TensorLike, batchSize: number, dims: number): Float32Array[] => {
  if (tensor.dims.length !== 2 || tensor.dims[0] !== batchSize || tensor.dims[1] !== dims) {
    throw new Error(
      `TransformersEmbedder: unexpected tensor shape [${tensor.dims.join(", ")}]; ` +
        `expected [${batchSize.toString()}, ${dims.toString()}]`,
    );
  }
  if (tensor.data.length !== batchSize * dims) {
    throw new Error(
      `TransformersEmbedder: tensor data length ${tensor.data.length.toString()} ` +
        `does not match ${batchSize.toString()} x ${dims.toString()}`,
    );
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    const row = new Float32Array(dims);
    const start = i * dims;
    for (let j = 0; j < dims; j++) {
      row[j] = tensor.data[start + j] ?? 0;
    }
    out.push(row);
  }
  return out;
};
