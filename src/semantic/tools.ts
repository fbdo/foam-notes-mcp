/**
 * SDK-agnostic semantic tool handlers.
 *
 * Three plain async functions, each taking a validated input object and a
 * {@link SemanticToolContext}:
 *
 *   - {@link semanticSearch} — embed a query, KNN against the store, apply
 *     caller-supplied filters.
 *   - {@link runBuildIndex} — thin wrapper around the orchestrator's
 *     `buildIndex()` that threads a caller-supplied progress callback. The
 *     internal name is `runBuildIndex` to avoid a name collision with the
 *     orchestrator's `buildIndex` function; the MCP tool name remains
 *     `build_index` (registered in `src/tools/index.ts`).
 *   - {@link indexStatus} — report current store meta + best-effort
 *     up-to-date signal.
 *
 * The third positional argument of {@link runBuildIndex} is a deliberate
 * SDK seam: the server-layer wrapper in `src/server.ts` adapts this
 * callback into MCP `notifications/progress` messages. This is the only
 * place where the semantic layer leaks a progress hook; keeping it a plain
 * callback (not a `sendNotification` handle) preserves the "semantic is
 * SDK-agnostic" invariant from the orchestrator.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from `./chunker.js`, `./index.js`, `./store.js`,
 *     `./embedder/types.js`, `../errors.js`, `../config.ts` (types only),
 *     node built-ins, `fast-glob`.
 *   - MUST NOT import from `keyword/`, `graph/`, `hybrid/`, `tools/`,
 *     `resources/`, `server.ts`, or the MCP SDK.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import fg from "fast-glob";

import { ToolValidationError } from "../errors.js";

import type { Embedder } from "./embedder/types.js";
import { buildIndex, type IndexProgress, type IndexResult } from "./index.js";
import type { SemanticStore } from "./store.js";

// ---------------------------------------------------------------------------
// SemanticToolContext — the sub-context the three tools receive. Built by the
// server layer once at startup and passed into every dispatch via
// `tools/index.ts`' `ToolContext.semantic`.
// ---------------------------------------------------------------------------

/** Runtime dependencies for all three semantic tools. */
export interface SemanticToolContext {
  /** Absolute path to the vault root. */
  readonly vaultPath: string;
  /** MOC glob pattern (threaded for future use; currently unused by handlers). */
  readonly mocPattern: string;
  /** Embedder instance. Constructed lazily; `embed()` triggers model load. */
  readonly embedder: Embedder;
  /** Open semantic store. `open()` must have been called already. */
  readonly store: SemanticStore;
}

// ---------------------------------------------------------------------------
// semantic_search
// ---------------------------------------------------------------------------

/** Input for the `semantic_search` tool. */
export interface SemanticSearchInput {
  /** Natural-language query string. Trimmed non-empty, enforced at runtime. */
  readonly query: string;
  /** Max hits after filtering. Default 10. Must be ≥ 1 if supplied. */
  readonly limit?: number;
  /** Substring/prefix filter over `chunk.folder` (exact match via SQL). */
  readonly folder?: string;
  /** All-of tag filter (AND). Chunk must contain every listed tag. */
  readonly tags?: readonly string[];
  /** Minimum cosine similarity; results below this are dropped. In `[-1, 1]`. */
  readonly min_score?: number;
}

/** A single scored hit returned by `semantic_search`. */
export interface SemanticSearchHit {
  /** Absolute (vault-relative in callers' eyes) path to the source note. */
  readonly notePath: string;
  /** 0-indexed position of the chunk within its note. */
  readonly chunkIndex: number;
  /** Heading under which the chunk appears, or `null` for pre-heading body. */
  readonly heading: string | null;
  /** Raw chunk text (without the title-prepend used during embedding). */
  readonly text: string;
  /** 1-indexed inclusive line bounds inside the note. */
  readonly startLine: number;
  readonly endLine: number;
  /** Folder relative to the vault root; `""` for notes at the vault root. */
  readonly folder: string;
  /** Tags extracted from the note's frontmatter + body (union, deduplicated). */
  readonly tags: readonly string[];
  /** Cosine similarity; higher is better. Equal to `1 - cosine_distance`. */
  readonly score: number;
}

/** Output envelope for `semantic_search`. */
export interface SemanticSearchOutput {
  readonly hits: readonly SemanticSearchHit[];
  /** Count of hits after filtering (equal to `hits.length`). */
  readonly total: number;
}

const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Run a semantic search against the store.
 *
 * Pipeline: validate → guard empty store → embed query → KNN (with buffer)
 * → apply `folder` / `tags` / `min_score` filters → truncate to `limit`.
 */
export const semanticSearch = async (
  input: SemanticSearchInput,
  ctx: SemanticToolContext,
): Promise<SemanticSearchOutput> => {
  validateSemanticSearchInput(input);
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;

  const chunkCount = await ctx.store.getChunkCount();
  if (chunkCount === 0) {
    throw new ToolValidationError("Index not built. Run `build_index` first.");
  }

  const vectors = await ctx.embedder.embed([input.query.trim()]);
  const queryVec = vectors[0];
  if (queryVec === undefined) {
    throw new Error("embedder returned no vector for query");
  }

  // Over-fetch to give JS-side filters (`tags`, `min_score`) room to work.
  // SQL-side filters (`folder`) are pushed into the store below.
  const buffer = Math.max(10, limit * 2);
  const candidateK = limit + buffer;

  const hits = await ctx.store.search(queryVec, candidateK, {
    ...(input.folder !== undefined ? { folder: input.folder } : {}),
  });

  const tagFilter = input.tags ?? [];
  let filtered = hits;
  if (tagFilter.length > 0) {
    filtered = filtered.filter((h) => tagFilter.every((t) => h.chunk.tags.includes(t)));
  }
  if (input.min_score !== undefined) {
    const min = input.min_score;
    filtered = filtered.filter((h) => h.score >= min);
  }

  const truncated = filtered.slice(0, limit);
  const out: SemanticSearchHit[] = truncated.map((h) => ({
    notePath: h.chunk.notePath,
    chunkIndex: h.chunk.chunkIndex,
    heading: h.chunk.heading,
    text: h.chunk.rawText,
    startLine: h.chunk.startLine,
    endLine: h.chunk.endLine,
    folder: h.chunk.folder,
    tags: [...h.chunk.tags],
    score: h.score,
  }));

  return { hits: out, total: out.length };
};

const validateSemanticSearchInput = (input: SemanticSearchInput): void => {
  const trimmed = input.query.trim();
  if (trimmed === "") {
    throw new ToolValidationError("semantic_search: `query` must be a non-empty string");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new ToolValidationError("semantic_search: `limit` must be a positive integer");
  }
  if (input.min_score !== undefined && (input.min_score < -1 || input.min_score > 1)) {
    throw new ToolValidationError("semantic_search: `min_score` must be in [-1, 1]");
  }
};

// ---------------------------------------------------------------------------
// build_index
// ---------------------------------------------------------------------------

/**
 * Input for the `build_index` tool. The MCP progress token is NOT exposed
 * here — the SDK plucks it from `_meta.progressToken` and the server-layer
 * wrapper in `src/server.ts` translates callback invocations into
 * `notifications/progress` messages.
 */
export interface BuildIndexInput {
  /** `true` → wipe and rebuild; `false`/omitted → incremental by fingerprint. */
  readonly force?: boolean;
}

/** Caller options for the SDK-agnostic build. Supplied by the server wrapper. */
export interface BuildIndexOptions {
  readonly onProgress?: (p: IndexProgress) => void;
}

/** Output envelope for `build_index`; shape matches {@link IndexResult}. */
export interface BuildIndexOutput {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly skipped: number;
  readonly errors: readonly { readonly notePath: string; readonly message: string }[];
  readonly durationMs: number;
  readonly embedder: string;
  readonly dims: number;
  readonly noteCount: number;
  readonly chunkCount: number;
}

/**
 * Build or refresh the semantic index.
 *
 * Thin wrapper around `buildIndex()` from `./index.ts`. The internal name
 * differs to avoid colliding with the orchestrator's export; the MCP tool
 * name remains `build_index` (see `src/tools/index.ts`).
 */
export const runBuildIndex = async (
  input: BuildIndexInput,
  ctx: SemanticToolContext,
  options?: BuildIndexOptions,
): Promise<BuildIndexOutput> => {
  const force = input.force === true;
  const result: IndexResult = await buildIndex(ctx.vaultPath, ctx.embedder, ctx.store, {
    force,
    ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return {
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    skipped: result.skipped,
    errors: result.errors.map((e) => ({ notePath: e.notePath, message: e.message })),
    durationMs: result.durationMs,
    embedder: result.embedder,
    dims: result.dims,
    noteCount: result.noteCount,
    chunkCount: result.chunkCount,
  };
};

// ---------------------------------------------------------------------------
// index_status
// ---------------------------------------------------------------------------

/** Input for the `index_status` tool (empty object). */
export type IndexStatusInput = Record<string, never>;

/** Output envelope for `index_status`. */
export interface IndexStatusOutput {
  /** Distinct notes currently indexed. */
  readonly notes: number;
  /** Total chunks currently indexed. */
  readonly chunks: number;
  /** ISO-8601 timestamp of the last successful build, or `null` if never built. */
  readonly lastBuiltAt: string | null;
  /** Embedder identity (`provider:model`). */
  readonly embedder: string;
  /** Vector dimension. */
  readonly dims: number;
  /**
   * `true` when every `.md` file on disk has a matching fingerprint in the
   * store and no stored note has been deleted from disk. Best-effort
   * (O(N) fs scan — tolerable for v0.1 vaults; revisit if vault size grows).
   * When the index has never been built, we report `false`: "up to date"
   * with nothing indexed is not a useful affirmative signal.
   */
  readonly upToDate: boolean;
}

/**
 * Report index status. Reads meta + note counts from the store and, when the
 * index is non-empty, walks the vault to detect drift.
 */
export const indexStatus = async (
  _input: IndexStatusInput,
  ctx: SemanticToolContext,
): Promise<IndexStatusOutput> => {
  const meta = await ctx.store.getMeta();
  const lastBuiltAt = meta.lastBuiltAt === "" ? null : meta.lastBuiltAt;

  // Empty index: not meaningfully "up to date". We report `false` so that
  // callers treat an empty store as "needs a build" rather than "all good".
  if (meta.noteCount === 0) {
    return {
      notes: meta.noteCount,
      chunks: meta.chunkCount,
      lastBuiltAt,
      embedder: meta.embedder,
      dims: meta.dims,
      upToDate: false,
    };
  }

  const upToDate = await computeUpToDate(ctx);
  return {
    notes: meta.noteCount,
    chunks: meta.chunkCount,
    lastBuiltAt,
    embedder: meta.embedder,
    dims: meta.dims,
    upToDate,
  };
};

/**
 * Best-effort "is the store up to date?" check.
 *
 *   - Fast path: if the on-disk `.md` count differs from the store's note
 *     count, return `false` without reading any file content.
 *   - Slow path: read every in-vault file, hash it, compare to the stored
 *     fingerprint. O(N) disk reads; acceptable for v0.1 vault sizes.
 *
 * A fingerprint of `""` (written by the force-mode wipe sentinel) is
 * treated as drift — the note should be re-indexed even if its content is
 * identical, so the user isn't left with stale-looking state after an
 * aborted rebuild.
 */
const computeUpToDate = async (ctx: SemanticToolContext): Promise<boolean> => {
  const absFiles = await fg("**/*.md", {
    cwd: ctx.vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const storePaths = new Set(await ctx.store.getNotePaths());
  if (absFiles.length !== storePaths.size) return false;

  for (const abs of absFiles) {
    if (!storePaths.has(abs)) return false;
    const stored = await ctx.store.getNoteFingerprint(abs);
    if (stored === null || stored === "") return false;
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return false;
    }
    const fp = createHash("sha256").update(content, "utf8").digest("hex");
    if (fp !== stored) return false;
  }
  return true;
};
