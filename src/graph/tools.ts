/**
 * The 6 graph-layer tools. SDK-agnostic plain async functions, mirroring the
 * conventions established in `src/keyword/tools.ts`. A transport wrapper
 * (`src/server.ts`, Wave 3D) will map `ToolValidationError` to `InvalidParams`
 * and any other thrown `Error` to `InternalError`.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from: `graph/builder.ts`, `graph/pagerank.ts`, `errors.ts`,
 *     `resolver.ts`, npm deps (graphology, graphology-shortest-path),
 *     node built-ins.
 *   - MUST NOT import from: `keyword/`, `semantic/`, `hybrid/`, `tools/`,
 *     `resources/`, `server.ts`, or the MCP SDK.
 *
 * Graph shape conventions (from Wave 3A):
 *   - Note nodes are keyed by their absolute filesystem path; attrs include
 *     `type: "note"`, `folder`, `title`, `basename`, `tags`, `frontmatter`,
 *     `isMoc`.
 *   - Placeholder nodes are keyed by `placeholder:<target>`; attrs include
 *     `type: "placeholder"`, `target`.
 *   - Edges carry `{ line, column, alias?, heading? }`.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { DirectedGraph } from "graphology";
import { bidirectional } from "graphology-shortest-path/unweighted.js";

import { ToolValidationError } from "../errors.js";
import { isInsideVaultAsync } from "../path-util.js";
import type { EdgeAttrs, GraphNodeAttrs, NoteNodeAttrs } from "./builder.js";
import { computePageRank } from "./pagerank.js";

// ---------------------------------------------------------------------------
// Context. Wave 3D (`server.ts`) builds the graph once at startup and passes
// the same context into every tool invocation.
// ---------------------------------------------------------------------------

export interface GraphToolContext {
  /** Absolute path to the vault root (normalized, without trailing slash). */
  readonly vaultPath: string;
  /** Prebuilt graphology graph. */
  readonly graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
}

// ---------------------------------------------------------------------------
// Public input / output shapes.
// ---------------------------------------------------------------------------

export interface ListBacklinksInput {
  readonly note: string;
}

export interface BacklinkLocation {
  readonly sourcePath: string;
  readonly line: number;
  readonly context: string;
  readonly alias?: string;
}

export interface ListBacklinksOutput {
  readonly locations: readonly BacklinkLocation[];
}

export type NeighborDirection = "out" | "in" | "both";

export interface NeighborsInput {
  readonly note: string;
  readonly depth?: number;
  readonly direction?: NeighborDirection;
}

export interface Neighbor {
  readonly path: string;
  readonly distance: number;
  readonly direction: "out" | "in";
}

export interface NeighborsOutput {
  readonly neighbors: readonly Neighbor[];
}

export interface ShortestPathInput {
  readonly from: string;
  readonly to: string;
  readonly max_hops?: number;
}

export interface ShortestPathOutput {
  readonly path: readonly string[] | null;
  readonly hops: number | null;
}

export type OrphansInput = Record<string, never>;

export interface OrphansOutput {
  readonly notes: readonly string[];
}

export type PlaceholdersInput = Record<string, never>;

export interface PlaceholderEntry {
  readonly target: string;
  readonly referenced_by: readonly string[];
}

export interface PlaceholdersOutput {
  readonly placeholders: readonly PlaceholderEntry[];
}

export type CentralAlgorithm = "pagerank" | "degree";

export interface CentralNotesInput {
  readonly algorithm: CentralAlgorithm;
  readonly limit?: number;
  readonly folder?: string;
}

export interface CentralNote {
  readonly path: string;
  readonly score: number;
}

export interface CentralNotesOutput {
  readonly notes: readonly CentralNote[];
}

// ---------------------------------------------------------------------------
// Public API — one async function per tool.
// ---------------------------------------------------------------------------

export const listBacklinks = async (
  input: ListBacklinksInput,
  ctx: GraphToolContext,
): Promise<ListBacklinksOutput> => {
  const notePath = await requireNotePath(input.note, ctx, "list_backlinks");

  interface RawBacklink {
    readonly sourcePath: string;
    readonly line: number;
    readonly alias?: string;
  }
  const raw: RawBacklink[] = [];
  ctx.graph.forEachInboundEdge(notePath, (_edge, attrs, source, _target, srcAttrs) => {
    // Only real notes can be backlink sources; placeholders have no file.
    if (srcAttrs.type !== "note") return;
    raw.push({
      sourcePath: source,
      line: attrs.line,
      ...(attrs.alias !== undefined ? { alias: attrs.alias } : {}),
    });
  });

  // Group reads by source path so we only read each file once.
  const bySource = new Map<string, RawBacklink[]>();
  for (const entry of raw) {
    const list = bySource.get(entry.sourcePath);
    if (list) list.push(entry);
    else bySource.set(entry.sourcePath, [entry]);
  }

  const locations: BacklinkLocation[] = [];
  for (const [source, entries] of bySource.entries()) {
    const lineMap = await readLinesSafely(source);
    for (const entry of entries) {
      const context = lineMap[entry.line - 1] ?? "";
      locations.push({
        sourcePath: entry.sourcePath,
        line: entry.line,
        context,
        ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
      });
    }
  }

  // Stable ordering: by source path then by line number.
  locations.sort((a, b) => {
    if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1;
    return a.line - b.line;
  });

  return { locations };
};

export const neighbors = async (
  input: NeighborsInput,
  ctx: GraphToolContext,
): Promise<NeighborsOutput> => {
  const notePath = await requireNotePath(input.note, ctx, "neighbors");
  const depth = validateDepth(input.depth);
  const direction = validateDirection(input.direction);

  // Run each requested direction as an independent BFS. The results are then
  // merged by path, keeping the SMALLER distance — so a node reachable via
  // `out` at depth 3 and via `in` at depth 1 reports distance=1/direction=in.
  // Tiebreaker (equal distance in both directions): the first pass wins. We
  // scan `out` first so the tiebreaker favors outbound — the authorial
  // direction, matching pre-fix behavior for the tie case.
  const outResults =
    direction === "out" || direction === "both"
      ? bfsDistances(ctx.graph, notePath, depth, "out")
      : new Map<string, number>();
  const inResults =
    direction === "in" || direction === "both"
      ? bfsDistances(ctx.graph, notePath, depth, "in")
      : new Map<string, number>();

  const merged = new Map<string, Neighbor>();
  for (const [path, distance] of outResults) {
    merged.set(path, { path, distance, direction: "out" });
  }
  for (const [path, distance] of inResults) {
    const existing = merged.get(path);
    if (existing === undefined || distance < existing.distance) {
      merged.set(path, { path, distance, direction: "in" });
    }
  }

  return { neighbors: [...merged.values()] };
};

export const shortestPath = async (
  input: ShortestPathInput,
  ctx: GraphToolContext,
): Promise<ShortestPathOutput> => {
  const fromPath = await requireNotePath(input.from, ctx, "shortest_path", "from");
  const toPath = await requireNotePath(input.to, ctx, "shortest_path", "to");
  const maxHops = validateMaxHops(input.max_hops);

  if (fromPath === toPath) {
    return { path: [fromPath], hops: 0 };
  }

  const result = bidirectional(ctx.graph, fromPath, toPath);
  if (result === null) {
    return { path: null, hops: null };
  }
  const hops = result.length - 1;
  if (hops > maxHops) {
    return { path: null, hops: null };
  }
  return { path: result, hops };
};

export const orphans = async (
  _input: OrphansInput,
  ctx: GraphToolContext,
): Promise<OrphansOutput> => {
  const result: string[] = [];
  ctx.graph.forEachNode((nodeId, attrs) => {
    if (attrs.type !== "note") return;
    if (hasNoteNeighbor(ctx.graph, nodeId)) return;
    result.push(nodeId);
  });
  result.sort((a, b) => a.localeCompare(b));
  return { notes: result };
};

export const placeholders = async (
  _input: PlaceholdersInput,
  ctx: GraphToolContext,
): Promise<PlaceholdersOutput> => {
  const result: PlaceholderEntry[] = [];
  ctx.graph.forEachNode((nodeId, attrs) => {
    if (attrs.type !== "placeholder") return;
    const referencedBy: string[] = [];
    ctx.graph.forEachInboundEdge(nodeId, (_edge, _attrs, source, _target, srcAttrs) => {
      if (srcAttrs.type === "note") referencedBy.push(source);
    });
    referencedBy.sort((a, b) => a.localeCompare(b));
    result.push({ target: attrs.target, referenced_by: referencedBy });
  });
  result.sort((a, b) => a.target.localeCompare(b.target));
  return { placeholders: result };
};

export const centralNotes = async (
  input: CentralNotesInput,
  ctx: GraphToolContext,
): Promise<CentralNotesOutput> => {
  const algorithm = validateAlgorithm(input.algorithm);
  const limit = validateLimit(input.limit);
  const folder = validateFolder(input.folder);

  const scores = computeScores(ctx.graph, algorithm);
  const filtered = filterByFolder(ctx.graph, scores, folder);
  filtered.sort((a, b) => b.score - a.score);
  return { notes: filtered.slice(0, limit) };
};

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

/** Default depth when the caller omits `depth`. */
const DEFAULT_NEIGHBOR_DEPTH = 1;
const MIN_NEIGHBOR_DEPTH = 1;
const MAX_NEIGHBOR_DEPTH = 3;
const DEFAULT_MAX_HOPS = 6;
const DEFAULT_CENTRAL_LIMIT = 10;

const validateDepth = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_NEIGHBOR_DEPTH;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ToolValidationError("neighbors: 'depth' must be an integer");
  }
  if (raw < MIN_NEIGHBOR_DEPTH || raw > MAX_NEIGHBOR_DEPTH) {
    throw new ToolValidationError(
      `neighbors: 'depth' must be between ${String(MIN_NEIGHBOR_DEPTH)} and ${String(MAX_NEIGHBOR_DEPTH)}`,
    );
  }
  return raw;
};

const validateDirection = (raw: NeighborDirection | undefined): NeighborDirection => {
  if (raw === undefined) return "both";
  if (raw !== "out" && raw !== "in" && raw !== "both") {
    throw new ToolValidationError("neighbors: 'direction' must be one of 'out', 'in', 'both'");
  }
  return raw;
};

const validateMaxHops = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_MAX_HOPS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ToolValidationError("shortest_path: 'max_hops' must be a positive integer");
  }
  return raw;
};

const validateAlgorithm = (raw: unknown): CentralAlgorithm => {
  if (raw !== "pagerank" && raw !== "degree") {
    throw new ToolValidationError("central_notes: 'algorithm' must be one of 'pagerank', 'degree'");
  }
  return raw;
};

const validateLimit = (raw: number | undefined): number => {
  if (raw === undefined) return DEFAULT_CENTRAL_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ToolValidationError("central_notes: 'limit' must be a positive integer");
  }
  return raw;
};

const validateFolder = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ToolValidationError("central_notes: 'folder' must be a string");
  }
  return raw;
};

/**
 * Normalize a caller-supplied note path to its absolute form, reject paths
 * outside the vault, and assert the node exists in the graph.
 *
 * Async because the vault-scope check uses {@link isInsideVaultAsync},
 * which realpath's both sides to reject symlink-escape attempts on paths
 * that exist on disk (a symlink inside the vault pointing outside).
 */
const requireNotePath = async (
  raw: unknown,
  ctx: GraphToolContext,
  tool: string,
  field = "note",
): Promise<string> => {
  if (typeof raw !== "string" || raw === "") {
    throw new ToolValidationError(`${tool}: '${field}' must be a non-empty string`);
  }
  const absolute = isAbsolute(raw) ? resolvePath(raw) : resolvePath(ctx.vaultPath, raw);
  if (!(await isInsideVaultAsync(absolute, ctx.vaultPath))) {
    throw new ToolValidationError(`${tool}: path escapes the vault: ${raw}`);
  }
  if (!ctx.graph.hasNode(absolute)) {
    throw new ToolValidationError(`${tool}: note '${raw}' not found in graph`);
  }
  const attrs = ctx.graph.getNodeAttributes(absolute);
  if (attrs.type !== "note") {
    throw new ToolValidationError(`${tool}: '${raw}' is not a note node`);
  }
  return absolute;
};

// ---------------------------------------------------------------------------
// Traversal / scoring helpers.
// ---------------------------------------------------------------------------

/**
 * Level-order BFS from `start` in a single direction, up to `depth` hops.
 * Returns a map of note-node path → minimum distance reached. Placeholder
 * nodes are traversed (so that a note behind a placeholder is still
 * discoverable) but never appear in the result map — the `neighbors` tool
 * only reports real notes. The starting node is always excluded.
 */
const bfsDistances = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  start: string,
  depth: number,
  direction: "out" | "in",
): Map<string, number> => {
  const distances = new Map<string, number>();
  const visited = new Set<string>([start]);
  let frontier = [start];
  for (let distance = 1; distance <= depth; distance += 1) {
    const next = expandBfsFrontier(graph, frontier, direction, distance, visited, distances);
    if (next.length === 0) break;
    frontier = next;
  }
  return distances;
};

const expandBfsFrontier = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  frontier: readonly string[],
  direction: "out" | "in",
  distance: number,
  visited: Set<string>,
  distances: Map<string, number>,
): string[] => {
  const next: string[] = [];
  for (const node of frontier) {
    const neighborIds = direction === "out" ? graph.outNeighbors(node) : graph.inNeighbors(node);
    for (const neighborId of neighborIds) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      if (graph.getNodeAttributes(neighborId).type === "note") {
        distances.set(neighborId, distance);
      }
      next.push(neighborId);
    }
  }
  return next;
};

/**
 * Return `true` if `node` has any edge (inbound or outbound) to another NOTE
 * node. Edges to/from placeholder nodes do not count — they represent broken
 * wikilinks and shouldn't rescue a note from orphan status.
 */
const hasNoteNeighbor = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  node: string,
): boolean => {
  for (const neighbor of graph.outNeighbors(node)) {
    if (graph.getNodeAttributes(neighbor).type === "note") return true;
  }
  for (const neighbor of graph.inNeighbors(node)) {
    if (graph.getNodeAttributes(neighbor).type === "note") return true;
  }
  return false;
};

const computeScores = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  algorithm: CentralAlgorithm,
): Map<string, number> => {
  if (algorithm === "pagerank") {
    const ranks = computePageRank(graph);
    // Restrict to note nodes; placeholders shouldn't appear in centrality.
    const out = new Map<string, number>();
    for (const [nodeId, score] of ranks.entries()) {
      if (graph.getNodeAttributes(nodeId).type === "note") {
        out.set(nodeId, score);
      }
    }
    return out;
  }
  // degree: sum of in + out counts, restricted to note nodes.
  const out = new Map<string, number>();
  graph.forEachNode((nodeId, attrs) => {
    if (attrs.type !== "note") return;
    out.set(nodeId, graph.inDegree(nodeId) + graph.outDegree(nodeId));
  });
  return out;
};

const filterByFolder = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  scores: Map<string, number>,
  folder: string | undefined,
): CentralNote[] => {
  const out: CentralNote[] = [];
  for (const [path, score] of scores.entries()) {
    if (folder !== undefined) {
      const attrs = graph.getNodeAttributes(path) as NoteNodeAttrs;
      // Boundary match: accept the folder itself OR any nested sub-folder.
      // Naively using `startsWith(folder)` would also match sibling folders
      // whose names *start with* `folder` (e.g. `01-Projects-Archive` when
      // caller asked for `01-Projects`).
      if (attrs.folder !== folder && !attrs.folder.startsWith(folder + "/")) continue;
    }
    out.push({ path, score });
  }
  return out;
};

// ---------------------------------------------------------------------------
// File I/O helper.
// ---------------------------------------------------------------------------

/**
 * Read a file and split into lines. Returns an empty array on any I/O error
 * (the caller treats missing lines as an empty context string, per PLAN:
 * "if IO fails, context can be empty string").
 */
const readLinesSafely = async (path: string): Promise<string[]> => {
  try {
    const src = await readFile(path, "utf8");
    return src.split(/\r?\n/);
  } catch {
    return [];
  }
};
