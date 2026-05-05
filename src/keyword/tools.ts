/**
 * The 6 keyword-layer tools. These are SDK-agnostic plain async functions:
 * a transport wrapper (`src/server.ts`, Wave C) turns thrown errors into
 * `McpError` codes and wires JSON-RPC dispatch.
 *
 * Constraints:
 *   - Never write outside the cache dir (v0.1 read-only, PLAN #23).
 *   - Reject any path that escapes the vault (normalize + prefix check).
 *   - Use the Wave A parse/resolver primitives; do not re-implement parsing.
 *   - Use `fast-glob` for discovery and `fs/promises` for I/O.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import fg from "fast-glob";

import { ToolValidationError } from "../errors.js";
import { parseFrontmatter } from "../parse/frontmatter.js";
import { extractTags } from "../parse/tags.js";
import { extractTasks, type Task } from "../parse/tasks.js";
import { extractWikilinks, type Wikilink } from "../parse/wikilink.js";
import { globToRegex, isInsideVaultAsync, safeParseFrontmatter } from "../path-util.js";
import {
  buildVaultIndex,
  resolveDirectoryLink,
  resolveWikilink,
  type ResolveConfidence,
  type VaultIndex,
} from "../resolver.js";
import { runRipgrep, type RgMatch } from "./ripgrep.js";

// ---------------------------------------------------------------------------
// Bounded-parallelism helper. Sequential file reads + parses pushed
// `getVaultStats` p95 close to the 300ms budget on 500-note vaults; chunked
// `Promise.all` brings it comfortably under budget while capping the number
// of in-flight FDs. `Promise.all` preserves input order, so callers that
// depend on iteration order (e.g. stable output lists) are unaffected.
// ---------------------------------------------------------------------------

const READ_CONCURRENCY = 32;

async function processInChunks<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Context passed into every tool. Wave C (`server.ts`) builds this once from
// `loadConfig()` and passes it to each handler. Keeping it explicit (rather
// than a hidden singleton) makes tests straightforward.
// ---------------------------------------------------------------------------

export interface KeywordToolContext {
  /** Absolute path to the vault root (normalized, without trailing slash). */
  readonly vaultPath: string;
  /** Glob pattern identifying MOC notes (default `*-MOC.md`). */
  readonly mocPattern: string;
  /** Absolute path to the ripgrep binary (threaded from `config.ripgrepPath`). */
  readonly ripgrepPath: string;
}

// ---------------------------------------------------------------------------
// Input / output shapes.
// ---------------------------------------------------------------------------

export interface SearchNotesInput {
  readonly query: string;
  readonly limit?: number;
  readonly contextLines?: number;
}

export interface SearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly match: string;
  readonly context?: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
}

export type FrontmatterOperator = "equals" | "contains" | "exists";

export interface FindByFrontmatterInput {
  readonly key: string;
  readonly value?: string | number | boolean;
  readonly operator?: FrontmatterOperator;
}

export interface NoteRef {
  readonly path: string;
}

export interface FindUncheckedTasksInput {
  readonly pathGlob?: string;
  readonly headingFilter?: string;
}

export interface TaskResult {
  readonly path: string;
  readonly text: string;
  readonly line: number;
  readonly heading?: string;
}

export interface ResolveWikilinkInput {
  readonly target: string;
}

export type ResolveStatus = "unique" | "ambiguous" | "not_found";

export interface ResolveResponse {
  readonly status: ResolveStatus;
  readonly candidates: readonly string[];
  readonly confidence: ResolveConfidence;
}

export interface GetNoteInput {
  readonly path: string;
  readonly includeBody?: boolean;
}

export interface NoteContent {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly wikilinks: readonly Wikilink[];
  readonly tasks: readonly Task[];
  readonly body?: string;
}

export type GetVaultStatsInput = Record<string, never>;

export interface VaultStats {
  readonly noteCount: number;
  readonly totalTags: number;
  readonly uniqueTags: number;
  readonly taskCount: number;
  readonly uncheckedTaskCount: number;
  readonly wikilinkCount: number;
  readonly brokenWikilinkCount: number;
  readonly mocCount: number;
}

// ---------------------------------------------------------------------------
// Public API — one async function per tool.
// ---------------------------------------------------------------------------

export const searchNotes = async (
  input: SearchNotesInput,
  ctx: KeywordToolContext,
): Promise<SearchResult[]> => {
  if (typeof input.query !== "string" || input.query === "") {
    throw new ToolValidationError("search_notes: 'query' must be a non-empty string");
  }
  const contextLines = input.contextLines ?? 0;
  if (contextLines < 0) {
    throw new ToolValidationError("search_notes: 'contextLines' must be >= 0");
  }
  const limit = input.limit ?? 0;
  if (limit < 0) {
    throw new ToolValidationError("search_notes: 'limit' must be >= 0");
  }

  const matches = await runRipgrep(input.query, {
    cwd: ctx.vaultPath,
    contextLines,
    ripgrepPath: ctx.ripgrepPath,
  });

  const out = limit > 0 ? matches.slice(0, limit) : matches;
  return out.map(rgMatchToSearchResult);
};

export const findByFrontmatter = async (
  input: FindByFrontmatterInput,
  ctx: KeywordToolContext,
): Promise<NoteRef[]> => {
  if (typeof input.key !== "string" || input.key === "") {
    throw new ToolValidationError("find_by_frontmatter: 'key' must be a non-empty string");
  }
  const operator: FrontmatterOperator =
    input.operator ?? (input.value === undefined ? "exists" : "equals");

  if (operator !== "exists" && input.value === undefined) {
    throw new ToolValidationError(
      `find_by_frontmatter: operator '${operator}' requires a 'value' to compare against`,
    );
  }

  const files = await listMarkdownFiles(ctx.vaultPath);
  const hits: NoteRef[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    let fm: Record<string, unknown>;
    try {
      fm = parseFrontmatter(src).data;
    } catch {
      continue;
    }
    if (matchesFrontmatter(fm, input.key, operator, input.value)) {
      hits.push({ path: file });
    }
  }
  return hits;
};

export const findUncheckedTasks = async (
  input: FindUncheckedTasksInput,
  ctx: KeywordToolContext,
): Promise<TaskResult[]> => {
  const pathGlob = typeof input.pathGlob === "string" ? input.pathGlob : "**/*.md";
  const headingFilter = typeof input.headingFilter === "string" ? input.headingFilter : undefined;

  const files = await fg(pathGlob, {
    cwd: ctx.vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
  });

  // If `pathGlob` matches nothing, skip ripgrep (ripgrep would exit with
  // code 2 under `rg: No files were searched`, which `runRipgrep` surfaces
  // as an error — and we'd rather not mask that signal for real config
  // issues). Same short-circuit for an obviously empty vault.
  if (files.length === 0) return [];

  // Pre-filter with ripgrep: scanning raw bytes for the task-marker regex
  // is ~10x cheaper than running every .md file through the unified
  // markdown parser. On the synthetic 500-note vault this drops the parse
  // set from ~500 files to ~100-200 — enough to bring p95 under the
  // 300ms budget.
  //
  // The pre-filter regex (`^\s*[-*+]\s+\[[ xX]\]`) is deliberately
  // slightly broader than `extractTasks`' mdast-based definition — it
  // matches any list-bullet variant at line start (after indent), and
  // will also match task-like lines inside fenced code blocks. False
  // positives just mean we pay the parse cost for a handful of extra
  // files; correctness is unchanged because `extractTasks` still decides
  // what counts as a task. If ripgrep itself errors, we propagate the
  // error rather than silently falling back to scanning every file
  // (which would mask real failures behind a perf regression).
  const rgMatches = await runRipgrep("^\\s*[-*+]\\s+\\[[ xX]\\]", {
    cwd: ctx.vaultPath,
    ripgrepPath: ctx.ripgrepPath,
    ...(typeof input.pathGlob === "string" ? { globs: [input.pathGlob] } : {}),
  });

  if (rgMatches.length === 0) return [];

  const filesWithTaskMarkers = new Set(rgMatches.map((m) => m.path));
  // Preserve the glob's iteration order — contract tests and downstream
  // consumers rely on stable output order across invocations.
  const candidates = files.filter((f) => filesWithTaskMarkers.has(f));

  if (candidates.length === 0) return [];

  const perFile = await processInChunks(candidates, READ_CONCURRENCY, async (file) => {
    if (!file.endsWith(".md")) return { file, tasks: [] as TaskResult[] };
    if (!(await isInsideVaultAsync(file, ctx.vaultPath))) {
      return { file, tasks: [] as TaskResult[] };
    }
    const src = await readFile(file, "utf8");
    const fileTasks: TaskResult[] = [];
    collectUncheckedTasks(file, src, headingFilter, fileTasks);
    return { file, tasks: fileTasks };
  });

  const out: TaskResult[] = [];
  for (const entry of perFile) {
    for (const t of entry.tasks) out.push(t);
  }
  return out;
};

const collectUncheckedTasks = (
  file: string,
  src: string,
  headingFilter: string | undefined,
  out: TaskResult[],
): void => {
  const tasks = extractTasks(src);
  for (const task of tasks) {
    if (task.checked) continue;
    if (headingFilter !== undefined && !(task.heading ?? "").includes(headingFilter)) {
      continue;
    }
    out.push({
      path: file,
      text: task.text,
      line: task.line,
      ...(task.heading !== undefined ? { heading: task.heading } : {}),
    });
  }
};

export const resolveWikilinkTool = async (
  input: ResolveWikilinkInput,
  ctx: KeywordToolContext,
): Promise<ResolveResponse> => {
  if (typeof input.target !== "string") {
    throw new ToolValidationError("resolve_wikilink: 'target' must be a string");
  }
  const index = await getOrBuildVaultIndex(ctx.vaultPath);
  const result = resolveWikilink(input.target, index);

  if (result.candidates.length === 0) {
    // Directory-link fallback: `[[folder]]` → `folder/index.md`.
    const fallback = resolveDirectoryLink(input.target, ctx.vaultPath, index);
    if (fallback) {
      return {
        status: "unique",
        candidates: [fallback],
        confidence: "suffix",
      };
    }
    return { status: "not_found", candidates: [], confidence: result.confidence };
  }

  const status: ResolveStatus = result.confidence === "ambiguous" ? "ambiguous" : "unique";
  return {
    status,
    candidates: [...result.candidates],
    confidence: result.confidence,
  };
};

export const getNote = async (
  input: GetNoteInput,
  ctx: KeywordToolContext,
): Promise<NoteContent> => {
  if (typeof input.path !== "string" || input.path === "") {
    throw new ToolValidationError("get_note: 'path' must be a non-empty string");
  }

  const absolute = isAbsolute(input.path)
    ? resolvePath(input.path)
    : resolvePath(ctx.vaultPath, input.path);

  if (!(await isInsideVaultAsync(absolute, ctx.vaultPath))) {
    throw new ToolValidationError(`get_note: path escapes the vault: ${input.path}`);
  }
  if (!absolute.endsWith(".md")) {
    throw new ToolValidationError(`get_note: only markdown (.md) files can be read: ${input.path}`);
  }

  const src = await readFile(absolute, "utf8");
  const { data: frontmatter, content } = parseFrontmatter(src);
  const tags = extractTags(src, frontmatter);
  const wikilinks = extractWikilinks(src);
  const tasks = extractTasks(src);

  const result: NoteContent = {
    path: absolute,
    frontmatter,
    tags,
    wikilinks,
    tasks,
    ...(input.includeBody === true ? { body: content } : {}),
  };
  return result;
};

export const getVaultStats = async (
  _input: GetVaultStatsInput,
  ctx: KeywordToolContext,
): Promise<VaultStats> => {
  const files = await listMarkdownFiles(ctx.vaultPath);
  const index = buildVaultIndex(files);

  // Per-file read + parse runs in bounded-parallel chunks. Each task
  // returns its partial contribution; merging is a single sequential pass
  // over the results (which `Promise.all` returns in input order).
  const perFile = await processInChunks(files, READ_CONCURRENCY, async (file) => {
    const src = await readFile(file, "utf8");
    return computeFileStats(file, src, index, ctx.vaultPath, ctx.mocPattern);
  });

  const agg: MutableVaultStats = {
    noteCount: files.length,
    totalTags: 0,
    uniqueTags: 0,
    taskCount: 0,
    uncheckedTaskCount: 0,
    wikilinkCount: 0,
    brokenWikilinkCount: 0,
    mocCount: 0,
  };
  const uniqueTags = new Set<string>();

  for (const fileStats of perFile) {
    if (fileStats.isMoc) agg.mocCount += 1;
    agg.totalTags += fileStats.totalTags;
    for (const t of fileStats.tags) uniqueTags.add(t);
    agg.taskCount += fileStats.taskCount;
    agg.uncheckedTaskCount += fileStats.uncheckedTaskCount;
    agg.wikilinkCount += fileStats.wikilinkCount;
    agg.brokenWikilinkCount += fileStats.brokenWikilinkCount;
  }

  agg.uniqueTags = uniqueTags.size;
  return agg;
};

interface PerFileStats {
  readonly isMoc: boolean;
  readonly totalTags: number;
  readonly tags: readonly string[];
  readonly taskCount: number;
  readonly uncheckedTaskCount: number;
  readonly wikilinkCount: number;
  readonly brokenWikilinkCount: number;
}

const computeFileStats = (
  file: string,
  src: string,
  index: VaultIndex,
  vaultPath: string,
  mocPattern: string,
): PerFileStats => {
  const { data: fm } = safeParseFrontmatter(src);
  const tags = extractTags(src, fm);
  const tasks = extractTasks(src);
  let uncheckedTaskCount = 0;
  for (const task of tasks) if (!task.checked) uncheckedTaskCount += 1;
  const wikilinks = extractWikilinks(src);
  let brokenWikilinkCount = 0;
  for (const wl of wikilinks) {
    if (!isWikilinkResolvable(wl.target, vaultPath, index)) {
      brokenWikilinkCount += 1;
    }
  }
  return {
    isMoc: isMocFile(file, mocPattern),
    totalTags: tags.length,
    tags,
    taskCount: tasks.length,
    uncheckedTaskCount,
    wikilinkCount: wikilinks.length,
    brokenWikilinkCount,
  };
};

interface MutableVaultStats {
  noteCount: number;
  totalTags: number;
  uniqueTags: number;
  taskCount: number;
  uncheckedTaskCount: number;
  wikilinkCount: number;
  brokenWikilinkCount: number;
  mocCount: number;
}

const isWikilinkResolvable = (target: string, vaultPath: string, index: VaultIndex): boolean => {
  const resolved = resolveWikilink(target, index);
  if (resolved.candidates.length > 0) return true;
  return resolveDirectoryLink(target, vaultPath, index) !== undefined;
};

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

const rgMatchToSearchResult = (m: RgMatch): SearchResult => {
  if (m.context) {
    return {
      path: m.path,
      line: m.line,
      column: m.column,
      match: m.match,
      context: {
        before: [...m.context.before],
        after: [...m.context.after],
      },
    };
  }
  return {
    path: m.path,
    line: m.line,
    column: m.column,
    match: m.match,
  };
};

const listMarkdownFiles = async (vaultPath: string): Promise<string[]> => {
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  // `fast-glob` returns POSIX-style paths on all platforms; the vaultPath
  // prefix check uses platform-appropriate separators via `path.resolve`.
  return files.map((f) => resolvePath(f));
};

const isMocFile = (absolutePath: string, mocPattern: string): boolean => {
  // `fast-glob`'s `mm` is lightweight; we reuse its util indirectly by just
  // comparing against the basename. For the default pattern `*-MOC.md` we
  // implement a simple glob-to-regex converter to avoid re-importing
  // micromatch here (it's already a transitive dep of fast-glob, but we
  // want a focused surface).
  const base = absolutePath.split("/").pop() ?? "";
  const regex = globToRegex(mocPattern);
  return regex.test(base);
};

const matchesFrontmatter = (
  fm: Record<string, unknown>,
  key: string,
  operator: FrontmatterOperator,
  value: string | number | boolean | undefined,
): boolean => {
  const present = Object.prototype.hasOwnProperty.call(fm, key);
  if (operator === "exists") return present;
  if (!present) return false;

  const actual = fm[key];
  if (operator === "equals") return equalsScalar(actual, value);
  if (operator === "contains") return containsValue(actual, value);
  return false;
};

const equalsScalar = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(actual)) {
    return actual.some((entry) => entry === expected);
  }
  return actual === expected;
};

const containsValue = (actual: unknown, expected: unknown): boolean => {
  if (expected === undefined) return false;
  if (Array.isArray(actual)) {
    if (typeof expected === "string") {
      return actual.some((entry) => typeof entry === "string" && entry.includes(expected));
    }
    return actual.some((entry) => entry === expected);
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  return actual === expected;
};

// Simple LRU-of-size-one cache for the vault index; `resolve_wikilink` is
// the hot path. We key on the vault path so tests targeting different
// fixtures don't collide.
interface CachedIndex {
  readonly vaultPath: string;
  readonly index: VaultIndex;
}
let cachedIndex: CachedIndex | undefined;

const getOrBuildVaultIndex = async (vaultPath: string): Promise<VaultIndex> => {
  const normalized = resolvePath(vaultPath);
  if (cachedIndex && cachedIndex.vaultPath === normalized) {
    return cachedIndex.index;
  }
  const files = await listMarkdownFiles(normalized);
  const index = buildVaultIndex(files);
  cachedIndex = { vaultPath: normalized, index };
  return index;
};

/** Test-only hook: reset the cached vault index between tests. */
export const _resetVaultIndexCache = (): void => {
  cachedIndex = undefined;
};
