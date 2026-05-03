/**
 * Embedder interface + shared types for the semantic layer.
 *
 * The embedder is the component that turns text into fixed-dimensional
 * vectors. v0.1 ships a single `transformers` provider backed by
 * `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (384 dims),
 * per PLAN Decision #9. The `ollama`, `openai`, and `bedrock` ids are
 * reserved for v0.2: they parse but the factory rejects them with a
 * `ToolValidationError` (PLAN Decision #10, amended 2026-05-03; #26).
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import node built-ins and npm type-only imports.
 *   - MUST NOT import from any sibling feature layer (`keyword/`, `graph/`,
 *     `hybrid/`, `tools/`, `resources/`, `server.ts`).
 */

/** Embedder provider discriminator. v0.1 only accepts `"transformers"`. */
export type ProviderId = "transformers" | "ollama" | "openai" | "bedrock";

/**
 * Runtime configuration consumed by {@link createEmbedder}. Provider-specific
 * options are deliberately absent here in v0.1 — `transformers` only needs
 * `model` and `cacheDir`. v0.2 providers will extend this with their own
 * discriminated unions (API key, endpoint URL, etc.).
 */
export interface EmbedderConfig {
  /** The provider to instantiate. Only `"transformers"` is supported in v0.1. */
  readonly provider: ProviderId;
  /**
   * Provider-specific model identifier. For `transformers` this is a Hugging
   * Face model id such as `"Xenova/all-MiniLM-L6-v2"`. If omitted, the
   * provider uses its default.
   */
  readonly model?: string;
  /**
   * Directory where the provider caches downloaded model files. If omitted,
   * the provider falls back to `${FOAM_CACHE_DIR}/semantic/models` (PLAN
   * Decision #11). Creating the directory is the provider's responsibility.
   */
  readonly cacheDir?: string;
}

/**
 * Identity and shape of a constructed embedder. `name` is the stable
 * `"provider:model"` string that {@link SemanticStore} persists in its
 * `meta` table — it must match exactly on subsequent opens or the store
 * refuses to load.
 */
export interface EmbedderInfo {
  readonly provider: ProviderId;
  readonly model: string;
  readonly dims: number;
  /** `${provider}:${model}` — e.g. `"transformers:Xenova/all-MiniLM-L6-v2"`. */
  readonly name: string;
}

/**
 * A constructed embedder. Consumers call {@link embed} to vectorize text
 * and {@link close} to release resources (worker threads, ONNX sessions)
 * on shutdown. `info` MUST be populated before any I/O — the `index_status`
 * tool inspects it without ever calling `embed()`.
 */
export interface Embedder {
  readonly info: EmbedderInfo;
  /**
   * Vectorize a batch of texts. Returns one `Float32Array` per input, in
   * the same order, each of length `info.dims`. The vectors are expected
   * to be L2-normalized so cosine similarity reduces to a dot product.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * Release any underlying resources. Idempotent. After `close()` further
   * calls to `embed()` are undefined behaviour.
   */
  close(): Promise<void>;
}
