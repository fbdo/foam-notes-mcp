/**
 * Semantic indexing orchestrator.
 *
 * Given a vault path, an {@link Embedder}, and a {@link SemanticStore}, build
 * or update the semantic index. The orchestrator is intentionally
 * SDK-agnostic: progress is reported via a plain caller-supplied callback
 * so that the commit-5 `build_index` MCP tool can adapt it into MCP
 * progress notifications without coupling this module to the SDK.
 *
 * Two modes:
 *   - **Cold build** (`force: true` OR store has no fingerprints): enumerate
 *     every `.md` file under the vault, chunk, embed, upsert. For `force`
 *     we wipe any pre-existing state first (simpler than diffing).
 *   - **Incremental** (`force` falsy): compute a content fingerprint for
 *     every file on disk, compare to `store.getNoteFingerprint(notePath)`,
 *     and only re-embed notes whose fingerprint changed. Notes no longer
 *     on disk are removed from the store; unchanged notes are skipped.
 *
 * Error isolation: a failure on one note (read error, chunker throw, embed
 * throw) is logged into {@link IndexResult.errors} and the orchestrator
 * proceeds with the remaining notes. The overall build never rejects on a
 * per-note failure — partial success is a first-class outcome.
 *
 * Fingerprint policy: content-only SHA-256. `mtime` is deliberately
 * excluded so that git checkouts, editor round-trips, and other mtime
 * churn do not trigger spurious re-indexing. This is a different shape
 * than `cache.ts::fingerprint` (which includes mtime + size); we keep a
 * local helper rather than change `cache.ts` to avoid disturbing callers
 * in the keyword / graph layers.
 *
 * Empty notes (zero-chunk output): the note is counted as `skipped` and
 * its fingerprint is recorded anyway — this prevents us from re-reading
 * and re-chunking an empty file on every subsequent incremental run.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from `./chunker.js`, `./store.js`, `./embedder/types.js`,
 *     `../parse/*`, `../path-util.js`, `../resolver.js`, `../errors.js`,
 *     plus `fast-glob` and node built-ins.
 *   - MUST NOT import from `keyword/`, `graph/`, `hybrid/`, `tools/`,
 *     `resources/`, or `server.ts`.
 *   - MUST NOT import the MCP SDK — the orchestrator stays SDK-agnostic.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import fg from "fast-glob";

import { deriveTitle } from "../path-util.js";
import { parseFrontmatter } from "../parse/frontmatter.js";
import { extractTags } from "../parse/tags.js";

import { chunkNote, type Chunk } from "./chunker.js";
import type { Embedder } from "./embedder/types.js";
import type { SemanticStore, StoredChunk } from "./store.js";
import type { VaultIndex } from "../resolver.js";

/** Phases emitted by the progress callback. See {@link IndexProgress}. */
export type IndexPhase = "discovering" | "diffing" | "indexing" | "finalizing";

/**
 * A single progress update passed to {@link IndexOptions.onProgress}.
 *
 * Counts (`added`, `updated`, `removed`, `skipped`) are cumulative for the
 * current build — callers can render a monotonically-growing progress bar.
 * `total` is the number of notes the indexing phase will touch
 * (add+update). It is `0` during discovery / finalization.
 */
export interface IndexProgress {
  readonly phase: IndexPhase;
  /** Notes processed in the indexing phase so far. */
  readonly processed: number;
  /** Total notes the indexing phase will touch (add ∪ update). */
  readonly total: number;
  /** Relative vault path of the most recently-processed note (when phase = "indexing"). */
  readonly currentNote?: string;
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly skipped: number;
  readonly errors: readonly IndexError[];
}

/** A per-note failure captured during the build. `notePath` is vault-relative. */
export interface IndexError {
  readonly notePath: string;
  readonly message: string;
}

/** Summary returned by {@link buildIndex}. */
export interface IndexResult {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly skipped: number;
  readonly errors: readonly IndexError[];
  /** Wall-clock duration of the build in milliseconds. */
  readonly durationMs: number;
  /** Embedder identity string (`provider:model`). */
  readonly embedder: string;
  /** Vector dimension. */
  readonly dims: number;
  /** Distinct notes currently represented in the store (post-build). */
  readonly noteCount: number;
  /** Total chunks currently stored (post-build). */
  readonly chunkCount: number;
}

/** Caller-supplied options for {@link buildIndex}. */
export interface IndexOptions {
  /** `true` → wipe and rebuild; `false` (default) → incremental by fingerprint. */
  readonly force?: boolean;
  /** Chunks per embed batch. Default `32`. */
  readonly batchSize?: number;
  /** Invoked after each phase transition + per-note indexing update. */
  readonly onProgress?: (p: IndexProgress) => void;
  /** Optional vault index used by the chunker to substitute wikilinks. */
  readonly vaultIndex?: VaultIndex;
  /**
   * Optional MOC-matching glob, threaded through for future use. Not read by
   * the current orchestrator but reserved so callers can set it once without
   * an API break when MOC-aware chunk metadata lands.
   */
  readonly mocPattern?: string;
}

const DEFAULT_BATCH_SIZE = 32;

/**
 * Build or update the semantic index over a vault.
 *
 * See the module docstring for the mode semantics. Resolves to a summary
 * (`IndexResult`); never rejects on per-note failures — those show up in
 * `result.errors`.
 */
export const buildIndex = async (
  vaultPath: string,
  embedder: Embedder,
  store: SemanticStore,
  options?: IndexOptions,
): Promise<IndexResult> => {
  const started = Date.now();
  const force = options?.force === true;
  const batchSize =
    options?.batchSize !== undefined && options.batchSize > 0
      ? options.batchSize
      : DEFAULT_BATCH_SIZE;
  const onProgress = options?.onProgress;

  const state: MutableState = {
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    errors: [],
    processed: 0,
  };

  // --- discover ---
  const absFiles = await discoverMarkdown(vaultPath);
  emit(onProgress, "discovering", state, absFiles.length);

  // --- fingerprint current files ---
  const fileFingerprints = await computeFingerprints(absFiles, state);

  // --- diff (or prepare force mode) ---
  const plan = force
    ? await planForce(store, fileFingerprints)
    : await planIncremental(store, fileFingerprints);
  state.skipped = plan.unchanged;
  emit(onProgress, "diffing", state, plan.toProcess.size);

  // --- remove phase ---
  for (const notePath of plan.toRemove) {
    try {
      await store.deleteByNotePath(notePath);
      // Force mode also needs to clear the fingerprint so the indexing
      // phase sees every note as a fresh add, not an update of the stale
      // pre-force row.
      if (force) await store.setNoteFingerprint(notePath, "");
      state.removed += 1;
    } catch (err) {
      state.errors.push({ notePath: relPath(vaultPath, notePath), message: asErrorMessage(err) });
    }
  }

  // --- embed + upsert phase ---
  const total = plan.toProcess.size;
  for (const [absPath, fingerprint] of plan.toProcess.entries()) {
    const notePathRel = relPath(vaultPath, absPath);
    try {
      const outcome = await indexOneNote(
        absPath,
        fingerprint,
        vaultPath,
        embedder,
        store,
        batchSize,
        options?.vaultIndex,
      );
      if (outcome === "added") state.added += 1;
      else if (outcome === "updated") state.updated += 1;
      else state.skipped += 1;
    } catch (err) {
      state.errors.push({ notePath: notePathRel, message: asErrorMessage(err) });
    }
    state.processed += 1;
    emit(onProgress, "indexing", state, total, notePathRel);
  }

  // --- finalize ---
  const noteCount = await store.getNoteCount();
  const chunkCount = await store.getChunkCount();
  await store.setMeta({ lastBuiltAt: new Date().toISOString() });
  emit(onProgress, "finalizing", state, 0);

  return {
    added: state.added,
    updated: state.updated,
    removed: state.removed,
    skipped: state.skipped,
    errors: [...state.errors],
    durationMs: Date.now() - started,
    embedder: embedder.info.name,
    dims: embedder.info.dims,
    noteCount,
    chunkCount,
  };
};

// --- internals ---

/** Mutable running counters consumed by `emit` + finalizer. */
interface MutableState {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: IndexError[];
  processed: number;
}

/** Per-file plan: which notes to re-embed, which to delete, which to skip. */
interface Plan {
  /** Map absPath → fingerprint for notes that need to be re-embedded. */
  readonly toProcess: Map<string, string>;
  /** Absolute paths (from the store) that must be removed. */
  readonly toRemove: readonly string[];
  /** Count of notes whose fingerprint matched the store — implicitly skipped. */
  readonly unchanged: number;
}

const discoverMarkdown = async (vaultPath: string): Promise<string[]> => {
  const matches = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  // `fast-glob` emits POSIX-style forward slashes even on Windows. Callers
  // compare to store paths that also came through `fast-glob` previously,
  // so we keep them as-is.
  return matches.sort((a, b) => a.localeCompare(b));
};

const computeFingerprints = async (
  absFiles: readonly string[],
  state: MutableState,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const abs of absFiles) {
    try {
      const content = await readFile(abs, "utf8");
      out.set(abs, contentFingerprint(content));
    } catch (err) {
      state.errors.push({ notePath: abs, message: asErrorMessage(err) });
    }
  }
  return out;
};

/** Force-mode plan: wipe the store, re-embed everything on disk. */
const planForce = async (
  store: SemanticStore,
  fileFingerprints: ReadonlyMap<string, string>,
): Promise<Plan> => {
  const existing = await store.getNotePaths();
  // We wipe everything known to the store; `toRemove` captures any path the
  // store knew about (including ones that no longer exist on disk).
  return {
    toProcess: new Map(fileFingerprints),
    toRemove: existing,
    unchanged: 0,
  };
};

/** Incremental plan: diff fingerprints against the store. */
const planIncremental = async (
  store: SemanticStore,
  fileFingerprints: ReadonlyMap<string, string>,
): Promise<Plan> => {
  const storePaths = await store.getNotePaths();
  const storeSet = new Set(storePaths);
  const toProcess = new Map<string, string>();
  let unchanged = 0;

  for (const [abs, fp] of fileFingerprints.entries()) {
    const existing = await store.getNoteFingerprint(abs);
    if (existing === null) {
      // Not in store → add.
      toProcess.set(abs, fp);
    } else if (existing !== fp) {
      toProcess.set(abs, fp);
    } else {
      // Fingerprint matches → skip. Count it explicitly so callers see the
      // "unchanged" outcome in `IndexResult.skipped`.
      unchanged += 1;
    }
  }

  const onDisk = new Set(fileFingerprints.keys());
  const toRemove: string[] = [];
  for (const p of storeSet) {
    if (!onDisk.has(p)) toRemove.push(p);
  }

  return { toProcess, toRemove, unchanged };
};

type NoteOutcome = "added" | "updated" | "skipped";

/**
 * Index a single note: parse, chunk, embed, upsert, record fingerprint.
 *
 * Shared by both the cold/incremental orchestrator ({@link buildIndex})
 * and the watcher-driven per-note updater ({@link updateNoteSemantic}) so
 * behavior (chunking, fingerprint policy, empty-note handling, stale
 * chunk cleanup) is identical across entry points.
 *
 * Returns:
 *   - `"added"` / `"updated"` when chunks were written.
 *   - `"skipped"` when the note has no body (zero chunks). The fingerprint
 *     is still recorded so subsequent incremental runs are no-op.
 */
const indexOneNote = async (
  absPath: string,
  fingerprint: string,
  vaultPath: string,
  embedder: Embedder,
  store: SemanticStore,
  batchSize: number,
  vaultIndex: VaultIndex | undefined,
): Promise<NoteOutcome> => {
  const source = await readFile(absPath, "utf8");
  const fm = parseFrontmatter(source);
  const title = deriveTitle(fm.data, basenameNoExt(absPath));
  const tags = extractTags(source, fm.data);
  const folder = folderFromVault(absPath, vaultPath);

  // Chunk over the frontmatter-stripped body. `parseFrontmatter` returns the
  // body as `fm.content`; when no frontmatter was present this equals the
  // source. Passing the body avoids the chunker treating a `---` YAML
  // delimiter as a thematic break and emitting a spurious chunk for a
  // metadata-only note.
  const chunks = chunkNote(absPath, fm.content, { title, vaultIndex, vaultPath });

  // Was this note previously indexed? If so this is an "update", otherwise "add".
  // A fingerprint of `""` is a sentinel written by the force-mode wipe —
  // treat it as "not previously indexed" so the outcome is classified as
  // `added` rather than `updated` after a force rebuild.
  const prevFp = await store.getNoteFingerprint(absPath);
  const existedBefore = prevFp !== null && prevFp !== "";

  if (chunks.length === 0) {
    // No body → we still want to stop re-reading this file next run.
    // Also clear any stale chunks if the note was previously non-empty.
    if (existedBefore) await store.deleteByNotePath(absPath);
    await store.setNoteFingerprint(absPath, fingerprint);
    return "skipped";
  }

  // Re-embedding a changed note: remove previous chunks so stale entries
  // for dropped headings / content don't linger after shrinkage.
  if (existedBefore) await store.deleteByNotePath(absPath);

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map((c) => c.text));
    if (vectors.length !== batch.length) {
      throw new Error(
        `embedder returned ${vectors.length.toString()} vectors for ${batch.length.toString()} texts`,
      );
    }
    const items: { chunk: StoredChunk; embedding: Float32Array }[] = [];
    for (let k = 0; k < batch.length; k++) {
      const chunk = batch[k];
      const vec = vectors[k];
      if (chunk === undefined || vec === undefined) continue;
      items.push({ chunk: toStoredChunk(chunk, folder, tags), embedding: vec });
    }
    await store.upsertBatch(items);
  }

  await store.setNoteFingerprint(absPath, fingerprint);
  return existedBefore ? "updated" : "added";
};

/**
 * Filesystem change type for watcher-driven incremental updates. Mirrors
 * the watcher's internal vocabulary (`add|modify|delete`) to keep the
 * public API symmetric with chokidar's event names; the graph layer uses
 * its own (`added|modified|deleted`) triple and the watcher translates
 * at the dispatch boundary.
 */
export type SemanticChangeType = "add" | "modify" | "delete";

/** Outcome of a single {@link updateNoteSemantic} invocation. */
export type SemanticUpdateOutcome = "added" | "updated" | "removed" | "skipped";

/** Options accepted by {@link updateNoteSemantic}. */
export interface UpdateNoteSemanticOptions {
  /** Chunks per embed batch. Default `32`. */
  readonly batchSize?: number;
  /** Optional vault index threaded through to the chunker for wikilink substitution. */
  readonly vaultIndex?: VaultIndex;
}

/**
 * Apply a single file-change event to the semantic store.
 *
 * This is the watcher-facing per-note updater. `buildIndex` remains the
 * batch orchestrator; both share the same per-note indexing implementation
 * so behavior (chunking, fingerprint policy, empty-note handling, stale
 * chunk cleanup) is identical.
 *
 * Semantics:
 *   - `"add"` / `"modify"`: reads the file, computes a content-only SHA-256
 *     fingerprint, and re-embeds iff the fingerprint differs from the
 *     store. Empty-bodied notes are recorded as `"skipped"` (fingerprint
 *     still written to avoid re-reading on the next event).
 *   - `"delete"`: removes all chunks for the note and clears the stored
 *     fingerprint. Returns `"removed"` when rows were dropped, `"skipped"`
 *     when nothing was indexed for that path.
 *
 * Errors propagate to the caller — the watcher wraps each dispatch in a
 * try/catch and surfaces failures via its `onError` callback.
 */
export const updateNoteSemantic = async (
  notePath: string,
  change: SemanticChangeType,
  vaultPath: string,
  store: SemanticStore,
  embedder: Embedder,
  opts?: UpdateNoteSemanticOptions,
): Promise<SemanticUpdateOutcome> => {
  const batchSize =
    opts?.batchSize !== undefined && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH_SIZE;

  if (change === "delete") {
    const removed = await store.deleteByNotePath(notePath);
    // Clear any residual fingerprint so a future add is classified correctly.
    await store.setNoteFingerprint(notePath, "");
    return removed > 0 ? "removed" : "skipped";
  }

  const content = await readFile(notePath, "utf8");
  const fingerprint = contentFingerprint(content);
  const existing = await store.getNoteFingerprint(notePath);
  if (existing !== null && existing !== "" && existing === fingerprint) {
    // Fingerprint unchanged — no-op. This matters when the watcher emits
    // spurious change events (editor touch, no content diff).
    return "skipped";
  }

  return indexOneNote(
    notePath,
    fingerprint,
    vaultPath,
    embedder,
    store,
    batchSize,
    opts?.vaultIndex,
  );
};

const toStoredChunk = (chunk: Chunk, folder: string, tags: readonly string[]): StoredChunk => ({
  id: chunk.id,
  notePath: chunk.notePath,
  chunkIndex: chunk.chunkIndex,
  heading: chunk.heading,
  text: chunk.text,
  rawText: chunk.rawText,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  folder,
  tags,
});

/**
 * Content-only SHA-256 of a note body, hex-encoded. Deliberately excludes
 * `mtime` so that git checkouts / editor saves without content changes
 * don't trigger a re-embed. This is intentionally different from the
 * `fingerprint(path)` helper in `src/cache.ts` (which is path-based and
 * bundles mtime + size for cross-session reuse).
 */
export const contentFingerprint = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const relPath = (vaultPath: string, abs: string): string => {
  const r = relative(vaultPath, abs);
  return r === "" ? abs : r;
};

/** Folder relative to the vault root. `""` for notes in the vault root. */
const folderFromVault = (absPath: string, vaultPath: string): string => {
  const r = relative(vaultPath, dirname(absPath));
  return r === "." ? "" : r;
};

const basenameNoExt = (absPath: string): string => {
  const slash = absPath.lastIndexOf("/");
  const base = slash >= 0 ? absPath.slice(slash + 1) : absPath;
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
};

const asErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

const emit = (
  cb: ((p: IndexProgress) => void) | undefined,
  phase: IndexPhase,
  state: MutableState,
  total: number,
  currentNote?: string,
): void => {
  if (cb === undefined) return;
  const progress: IndexProgress = {
    phase,
    processed: state.processed,
    total,
    added: state.added,
    updated: state.updated,
    removed: state.removed,
    skipped: state.skipped,
    errors: [...state.errors],
    ...(currentNote === undefined ? {} : { currentNote }),
  };
  cb(progress);
};
