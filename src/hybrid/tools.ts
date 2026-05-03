/**
 * SDK-agnostic `hybrid_search` tool.
 *
 * Implements Reciprocal Rank Fusion (RRF) across the keyword and semantic
 * source lists, followed by a multiplicative PageRank rerank. Ships in
 * v0.1 per PLAN Decision #13; personalized-PPR is deferred to v0.2.
 *
 * Algorithm summary:
 *
 *   1. Collect source lists (note-scoped):
 *        - Semantic: group chunk hits by notePath, keep the top-scoring
 *          chunk per note as `bestMatch`.
 *        - Keyword: group location hits by notePath, keep the first match
 *          per note as `bestMatch`.
 *   2. RRF fusion with k=60:
 *        rrf(note) = Σ_i weight_i / (k + rank_i)
 *      where i ranges over the source lists the note appears in. Items
 *      absent from a list contribute 0. Weights default to
 *      `{ sem: 0.6, kw: 0.2, graph: 0.2 }` (PLAN Tool Inventory) and are
 *      NOT required to sum to 1.
 *   3. PageRank rerank (multiplicative blend):
 *        final(note) = rrf(note) * (1 + weights.graph * pr_norm(note))
 *      where `pr_norm` is min-max normalized PageRank over note-type
 *      graph nodes. IMPORTANT: `weights.graph` is the rerank coefficient,
 *      NOT a fusion weight. There is no separate graph source list.
 *   4. Tie-break on equal final score: alphabetical `notePath` (stable,
 *      caching-friendly).
 *   5. All-empty source lists → `{ hits: [], total: 0 }`, no error.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from `keyword/`, `graph/`, `semantic/`, `parse/`,
 *     `resolver`, `cache`, `config`, `errors`, `path-util`, node built-ins,
 *     npm deps.
 *   - MUST NOT import from `tools/`, `resources/`, `watcher/`, `server.ts`.
 *
 * Ship constraints:
 *   - No MCP SDK imports. Transport wiring lives in `src/server.ts`
 *     (commit 3 of Wave 5).
 *   - No watcher integration (commit 2 of Wave 5).
 */

import { ToolValidationError } from "../errors.js";
import { computePageRank } from "../graph/pagerank.js";
import type { GraphToolContext } from "../graph/tools.js";
import type { KeywordToolContext, SearchResult } from "../keyword/tools.js";
import { searchNotes } from "../keyword/tools.js";
import type { SemanticSearchHit, SemanticToolContext } from "../semantic/tools.js";
import { semanticSearch } from "../semantic/tools.js";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** Optional per-source weights for {@link HybridSearchInput}. */
export interface HybridSearchWeights {
  /** RRF weight for the semantic list. Default 0.6. Must be finite and ≥ 0. */
  readonly sem?: number;
  /** RRF weight for the keyword list. Default 0.2. Must be finite and ≥ 0. */
  readonly kw?: number;
  /**
   * PageRank rerank coefficient (NOT a fusion weight). Default 0.2.
   * Final score = `rrf * (1 + graph * pr_normalized)`. Setting `graph = 0`
   * disables the rerank; the hybrid score reduces to pure RRF.
   */
  readonly graph?: number;
}

/** Toggle which source lists are consulted. All default to `true`. */
export interface HybridSearchSources {
  readonly semantic?: boolean;
  readonly keyword?: boolean;
}

/** Input for the `hybrid_search` tool. */
export interface HybridSearchInput {
  /** Natural-language query. Trimmed non-empty. */
  readonly query: string;
  /** Max hits after filtering. Default 10; must be an integer ≥ 1. */
  readonly limit?: number;
  /** Optional per-source weights. See {@link HybridSearchWeights}. */
  readonly weights?: HybridSearchWeights;
  /** Drop hits whose final blended score is below this threshold. Default 0. */
  readonly min_score?: number;
  /** Future-proofing toggles for which sources to consult. All default true. */
  readonly sources?: HybridSearchSources;
}

/**
 * Best per-note excerpt surfaced alongside the hit. For semantic sources
 * this is the top-scoring chunk's raw text; for keyword-only hits it is
 * the first matching line.
 */
export interface HybridBestMatch {
  readonly heading: string | null;
  /** Chunk rawText (semantic) or matching line text (keyword). */
  readonly text: string;
  /** 1-indexed inclusive line bounds within the source note. */
  readonly startLine: number;
  readonly endLine: number;
}

/** Per-hit score breakdown returned alongside the final blended score. */
export interface HybridScoreBreakdown {
  /** RRF score BEFORE the PageRank rerank is applied. */
  readonly rrf: number;
  /** PageRank value normalized to `[0, 1]` via min-max across note nodes. */
  readonly pagerank: number;
  /** Rank within the semantic source list (1-indexed), or `null` if absent. */
  readonly semRank: number | null;
  /** Rank within the keyword source list (1-indexed), or `null` if absent. */
  readonly kwRank: number | null;
}

/** One hit in the `hybrid_search` response. */
export interface HybridSearchHit {
  readonly notePath: string;
  readonly bestMatch: HybridBestMatch;
  /** Final blended score (RRF × PageRank multiplier). */
  readonly score: number;
  readonly scoreBreakdown: HybridScoreBreakdown;
}

/** Output envelope for `hybrid_search`. */
export interface HybridSearchOutput {
  readonly hits: readonly HybridSearchHit[];
  /** Candidate count BEFORE `limit` truncation but AFTER `min_score` filter. */
  readonly total: number;
}

/**
 * Runtime context for {@link hybridSearch}. We reuse feature-layer contexts
 * directly (rather than re-wrapping their fields) so that any future change
 * in, e.g., the semantic layer's dependencies doesn't ripple into hybrid.
 * The server layer (commit 3) is responsible for constructing each
 * sub-context once at startup and threading them here.
 */
export interface HybridToolContext {
  readonly keyword: KeywordToolContext;
  readonly graph: GraphToolContext;
  readonly semantic: SemanticToolContext;
}

// ---------------------------------------------------------------------------
// Internal intermediate types used by the pure fusion function.
// ---------------------------------------------------------------------------

/**
 * Semantic candidate (post note-scoped aggregation). `chunk` is the
 * top-scoring chunk for the note; its fields populate `bestMatch`.
 */
export interface HybridSemCandidate {
  readonly notePath: string;
  readonly score: number;
  readonly chunk: {
    readonly heading: string | null;
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
  };
}

/**
 * Keyword candidate (post note-scoped aggregation). `match` is the first
 * matching line from the source note; its position populates `bestMatch`.
 */
export interface HybridKwCandidate {
  readonly notePath: string;
  readonly line: number;
  readonly match: string;
  readonly heading?: string | null;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** Input contract for the pure {@link fuseHybridResults} function. */
export interface RRFInputs {
  readonly semList: readonly HybridSemCandidate[];
  readonly kwList: readonly HybridKwCandidate[];
  /**
   * PageRank scores normalized to `[0, 1]` per note. Notes missing from
   * the map are treated as `0` (rerank becomes a no-op for them).
   */
  readonly pagerank: ReadonlyMap<string, number>;
  readonly weights: { readonly sem: number; readonly kw: number; readonly graph: number };
  readonly limit: number;
  readonly minScore: number;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion constant. k=60 is the TREC default from
 * Cormack/Clarke/Buettcher 2009 and matches OpenSearch / Elasticsearch
 * defaults; it keeps mid-list items relevant while damping long tails.
 */
const RRF_K = 60;

/** Default number of hits returned when the caller omits `limit`. */
const DEFAULT_LIMIT = 10;

/** Default RRF weights (PLAN Tool Inventory). */
const DEFAULT_WEIGHTS = { sem: 0.6, kw: 0.2, graph: 0.2 } as const;

// ---------------------------------------------------------------------------
// Pure RRF + blend (unit-testable without touching the semantic/keyword
// layers). The wrapper {@link hybridSearch} below does all the I/O; this
// function is deterministic given its inputs.
// ---------------------------------------------------------------------------

interface ScoreAccumulator {
  rrf: number;
  semRank: number | null;
  kwRank: number | null;
}

/**
 * Fuse semantic + keyword candidate lists, apply the PageRank rerank, and
 * return the final sorted / filtered / truncated hits.
 *
 * This function assumes its inputs have already been validated and the
 * pagerank map has already been normalized to `[0, 1]` per note.
 */
export const fuseHybridResults = (inputs: RRFInputs): HybridSearchOutput => {
  const scores = new Map<string, ScoreAccumulator>();
  const semByPath = new Map<string, HybridSemCandidate>();
  const kwByPath = new Map<string, HybridKwCandidate>();

  // Accumulate RRF contributions from the semantic list.
  inputs.semList.forEach((item, i) => {
    const rank = i + 1;
    const acc = scores.get(item.notePath) ?? { rrf: 0, semRank: null, kwRank: null };
    acc.rrf += inputs.weights.sem / (RRF_K + rank);
    acc.semRank = rank;
    scores.set(item.notePath, acc);
    semByPath.set(item.notePath, item);
  });

  // Accumulate RRF contributions from the keyword list.
  inputs.kwList.forEach((item, i) => {
    const rank = i + 1;
    const acc = scores.get(item.notePath) ?? { rrf: 0, semRank: null, kwRank: null };
    acc.rrf += inputs.weights.kw / (RRF_K + rank);
    acc.kwRank = rank;
    scores.set(item.notePath, acc);
    if (!kwByPath.has(item.notePath)) kwByPath.set(item.notePath, item);
  });

  // Apply the multiplicative PageRank rerank. An empty pagerank map (or a
  // missing entry) makes the rerank a no-op for that note, which is the
  // documented degraded-graph behavior.
  const blended: HybridSearchHit[] = [];
  for (const [notePath, acc] of scores.entries()) {
    const pr = inputs.pagerank.get(notePath) ?? 0;
    const score = acc.rrf * (1 + inputs.weights.graph * pr);
    if (score < inputs.minScore) continue;
    const bestMatch = buildBestMatch(notePath, semByPath, kwByPath);
    blended.push({
      notePath,
      bestMatch,
      score,
      scoreBreakdown: {
        rrf: acc.rrf,
        pagerank: pr,
        semRank: acc.semRank,
        kwRank: acc.kwRank,
      },
    });
  }

  // Deterministic sort: descending score, alphabetical notePath for ties.
  blended.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.notePath.localeCompare(b.notePath);
  });

  const total = blended.length;
  const limited = blended.slice(0, inputs.limit);
  return { hits: limited, total };
};

/**
 * Assemble the `bestMatch` payload for a note, preferring the semantic
 * candidate when available (its heading/line data is chunk-accurate) and
 * falling back to the keyword location otherwise.
 */
const buildBestMatch = (
  notePath: string,
  semByPath: ReadonlyMap<string, HybridSemCandidate>,
  kwByPath: ReadonlyMap<string, HybridKwCandidate>,
): HybridBestMatch => {
  const sem = semByPath.get(notePath);
  if (sem !== undefined) {
    return {
      heading: sem.chunk.heading,
      text: sem.chunk.text,
      startLine: sem.chunk.startLine,
      endLine: sem.chunk.endLine,
    };
  }
  const kw = kwByPath.get(notePath);
  // One of sem/kw must exist: the accumulator only gets populated via one
  // of the two forEach loops above. If we ever get here with both missing
  // it's a programmer error.
  if (kw === undefined) {
    throw new Error(`fuseHybridResults: no best match found for ${notePath}`);
  }
  return {
    heading: kw.heading ?? null,
    text: kw.match,
    startLine: kw.startLine ?? kw.line,
    endLine: kw.endLine ?? kw.line,
  };
};

// ---------------------------------------------------------------------------
// Public tool wrapper. Thin glue: validate input → pull candidates from the
// keyword + semantic layers → normalize PageRank → call fuseHybridResults.
// ---------------------------------------------------------------------------

/**
 * Run a hybrid search. See the module header for the algorithm, and
 * {@link HybridSearchInput} / {@link HybridSearchOutput} for the contract.
 */
export const hybridSearch = async (
  input: HybridSearchInput,
  ctx: HybridToolContext,
): Promise<HybridSearchOutput> => {
  validateHybridSearchInput(input);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const minScore = input.min_score ?? 0;
  const weights = resolveWeights(input.weights);
  const sources = resolveSources(input.sources);

  // Widen the candidate pool so downstream filters (min_score) have enough
  // to work with. 3× the output limit matches the widening convention used
  // by the keyword + semantic layers' own over-fetching heuristics.
  const candidateLimit = Math.max(1, limit * 3);

  const semList = sources.semantic
    ? await collectSemanticCandidates(input.query, candidateLimit, ctx.semantic)
    : [];
  const kwList = sources.keyword
    ? await collectKeywordCandidates(input.query, candidateLimit, ctx.keyword)
    : [];
  const pagerank = computeNormalizedPageRank(ctx.graph);

  return fuseHybridResults({
    semList,
    kwList,
    pagerank,
    weights,
    limit,
    minScore,
  });
};

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

const validateHybridSearchInput = (input: HybridSearchInput): void => {
  if (typeof input.query !== "string" || input.query.trim() === "") {
    throw new ToolValidationError("hybrid_search: 'query' must be a non-empty string");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new ToolValidationError("hybrid_search: 'limit' must be a positive integer");
  }
  if (input.min_score !== undefined && !Number.isFinite(input.min_score)) {
    throw new ToolValidationError("hybrid_search: 'min_score' must be a finite number");
  }
  if (input.weights !== undefined) {
    validateWeight("sem", input.weights.sem);
    validateWeight("kw", input.weights.kw);
    validateWeight("graph", input.weights.graph);
  }
};

const validateWeight = (name: "sem" | "kw" | "graph", value: number | undefined): void => {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new ToolValidationError(`hybrid_search: 'weights.${name}' must be a finite number >= 0`);
  }
};

const resolveWeights = (
  provided: HybridSearchWeights | undefined,
): { sem: number; kw: number; graph: number } => ({
  sem: provided?.sem ?? DEFAULT_WEIGHTS.sem,
  kw: provided?.kw ?? DEFAULT_WEIGHTS.kw,
  graph: provided?.graph ?? DEFAULT_WEIGHTS.graph,
});

const resolveSources = (
  provided: HybridSearchSources | undefined,
): { semantic: boolean; keyword: boolean } => ({
  semantic: provided?.semantic ?? true,
  keyword: provided?.keyword ?? true,
});

// ---------------------------------------------------------------------------
// Source-list collection (note-scoped aggregation).
// ---------------------------------------------------------------------------

/**
 * Call `semanticSearch` and aggregate chunk hits by notePath, keeping the
 * top-scoring chunk per note as the representative `bestMatch`.
 *
 * The semantic layer throws `ToolValidationError` with "Index not built"
 * when the store is empty. We catch that specific error and treat it as
 * "no semantic candidates" so callers can still get keyword + rerank
 * results from a fresh vault. Every other error propagates.
 */
const collectSemanticCandidates = async (
  query: string,
  limit: number,
  ctx: SemanticToolContext,
): Promise<HybridSemCandidate[]> => {
  let output;
  try {
    output = await semanticSearch({ query, limit, min_score: 0 }, ctx);
  } catch (err) {
    if (err instanceof ToolValidationError && err.message.includes("Index not built")) {
      return [];
    }
    throw err;
  }

  const byNote = new Map<string, SemanticSearchHit>();
  for (const hit of output.hits) {
    const existing = byNote.get(hit.notePath);
    if (existing === undefined || hit.score > existing.score) {
      byNote.set(hit.notePath, hit);
    }
  }

  // Preserve insertion order (= semantic ranking order of the top chunk
  // per note). `Map` keeps insertion order; we iterate through `hits` in
  // order and only overwrite with better scores, so the first appearance
  // of each note path defines its position in the fused list.
  const ordered: HybridSemCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of output.hits) {
    if (seen.has(hit.notePath)) continue;
    const winner = byNote.get(hit.notePath);
    if (winner === undefined) continue;
    seen.add(hit.notePath);
    ordered.push({
      notePath: winner.notePath,
      score: winner.score,
      chunk: {
        heading: winner.heading,
        text: winner.text,
        startLine: winner.startLine,
        endLine: winner.endLine,
      },
    });
  }
  return ordered;
};

/**
 * Call `searchNotes` and aggregate location hits by notePath, keeping the
 * FIRST match per note (preserves keyword rank ordering).
 */
const collectKeywordCandidates = async (
  query: string,
  limit: number,
  ctx: KeywordToolContext,
): Promise<HybridKwCandidate[]> => {
  const results: readonly SearchResult[] = await searchNotes({ query, limit }, ctx);
  const seen = new Set<string>();
  const ordered: HybridKwCandidate[] = [];
  for (const r of results) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    ordered.push({
      notePath: r.path,
      line: r.line,
      match: r.match,
    });
  }
  return ordered;
};

// ---------------------------------------------------------------------------
// PageRank normalization.
// ---------------------------------------------------------------------------

/**
 * Compute PageRank across the whole graph, restrict to note-type nodes,
 * and min-max normalize to `[0, 1]`.
 *
 * Edge cases handled silently:
 *   - Empty graph → empty map (rerank becomes a no-op).
 *   - All-zero or single-unique scores → normalized to 0 (rerank no-op).
 */
const computeNormalizedPageRank = (ctx: GraphToolContext): Map<string, number> => {
  const rawRanks = computePageRank(ctx.graph);
  const noteScores: (readonly [string, number])[] = [];
  for (const [id, score] of rawRanks.entries()) {
    if (ctx.graph.getNodeAttributes(id).type === "note") {
      noteScores.push([id, score]);
    }
  }
  if (noteScores.length === 0) return new Map();

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [, s] of noteScores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  const out = new Map<string, number>();
  if (range === 0) {
    // Degenerate: all note PRs are equal. Pick 0 so the rerank is a no-op.
    for (const [id] of noteScores) out.set(id, 0);
    return out;
  }
  for (const [id, s] of noteScores) {
    out.set(id, (s - min) / range);
  }
  return out;
};
