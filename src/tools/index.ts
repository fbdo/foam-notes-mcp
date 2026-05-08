/**
 * MCP tool registry.
 *
 * `TOOL_ZOD_SHAPES` is the single source of truth for each tool's input
 * contract. `McpServer.registerTool` consumes the raw shape directly and
 * derives a flat JSON Schema for `tools/list`; the shape is also used to
 * validate `tools/call` input before the handler runs.
 *
 * `TOOL_METADATA` holds out-of-band, non-schema information (currently
 * just the human-readable description). It is kept separate from the
 * zod shapes so that schema invariants can be asserted without coupling
 * to prose.
 *
 * The on-wire "no $ref / $defs / definitions" invariant that originally
 * motivated PLAN decision #20 is guarded by
 * `tests/tools/wire-schemas.test.ts`, which exercises the same
 * `tools/list` code path an MCP client would see.
 *
 * This module MAY import from `keyword/` and `graph/`. It MUST NOT import
 * from `server.ts` or from any future feature layer.
 */

import { z } from "zod";

import {
  findByFrontmatter,
  findUncheckedTasks,
  getNote,
  getVaultStats,
  resolveWikilinkTool,
  searchNotes,
  type FindByFrontmatterInput,
  type FindUncheckedTasksInput,
  type GetNoteInput,
  type GetVaultStatsInput,
  type KeywordToolContext,
  type NoteContent,
  type NoteRef,
  type ResolveResponse,
  type ResolveWikilinkInput,
  type SearchNotesInput,
  type SearchResult,
  type TaskResult,
  type VaultStats,
} from "../keyword/tools.js";
import {
  centralNotes,
  listBacklinks,
  neighbors,
  orphans,
  placeholders,
  shortestPath,
  type CentralNotesInput,
  type CentralNotesOutput,
  type GraphToolContext,
  type ListBacklinksInput,
  type ListBacklinksOutput,
  type NeighborsInput,
  type NeighborsOutput,
  type OrphansInput,
  type OrphansOutput,
  type PlaceholdersInput,
  type PlaceholdersOutput,
  type ShortestPathInput,
  type ShortestPathOutput,
} from "../graph/tools.js";
import {
  indexStatus,
  runBuildIndex,
  semanticSearch,
  type BuildIndexInput,
  type BuildIndexOutput,
  type IndexStatusInput,
  type IndexStatusOutput,
  type SemanticSearchInput,
  type SemanticSearchOutput,
  type SemanticToolContext,
} from "../semantic/tools.js";
import {
  hybridSearch,
  type HybridSearchInput,
  type HybridSearchOutput,
  type HybridToolContext,
} from "../hybrid/tools.js";

export type { SemanticToolContext } from "../semantic/tools.js";
export type { HybridToolContext } from "../hybrid/tools.js";

/**
 * Combined context for tool handlers. The server builds all sub-contexts
 * once at startup and passes this widened shape into every dispatch.
 * Keyword tools consume `ctx.keyword`; graph tools consume `ctx.graph`;
 * semantic tools consume `ctx.semantic`; hybrid tools consume `ctx.hybrid`.
 */
export interface ToolContext {
  readonly keyword: KeywordToolContext;
  readonly graph: GraphToolContext;
  readonly semantic: SemanticToolContext;
  readonly hybrid: HybridToolContext;
}

/** Per-tool handler signature. Context is provided by the server layer. */
export type ToolHandler<Input, Output> = (input: Input, ctx: ToolContext) => Promise<Output>;

/**
 * Human-readable metadata for each tool. The description is surfaced to
 * MCP clients verbatim. Schema shape lives in {@link TOOL_ZOD_SHAPES}.
 */
export const TOOL_METADATA = {
  search_notes: {
    description:
      "Full-text search across the vault using ripgrep. Returns path, line, column, matched line, and optional surrounding context.",
  },
  find_by_frontmatter: {
    description:
      "Find notes whose YAML frontmatter matches a key/value criterion. Supports `equals`, `contains`, and `exists` operators.",
  },
  find_unchecked_tasks: {
    description:
      "List all unchecked `- [ ]` tasks in the vault, optionally scoped by a path glob and filtered by heading substring.",
  },
  resolve_wikilink: {
    description:
      "Resolve a wikilink target (e.g. `note-a`, `02-Areas/note-b`) to its canonical vault-relative path. Returns `unique`, `ambiguous`, or `not_found` with the matching candidate path(s). Call this first to get the full path needed by graph tools (list_backlinks, neighbors, shortest_path) and get_note.",
  },
  get_note: {
    description:
      "Read a single note by path (inside the vault) and return its frontmatter, tags, wikilinks, and tasks. Optionally include the body with the frontmatter stripped.",
  },
  get_vault_stats: {
    description:
      "Return aggregate statistics about the vault: note count, tag counts, task counts, wikilink counts (including broken), and MOC count.",
  },
  list_backlinks: {
    description:
      "List every inbound note→note link to the given note, with source path, line, and a one-line context snippet. The `note` parameter must be a vault-relative path ending in `.md` (e.g. `folder/note-a.md`). Use `resolve_wikilink` first if you only have a bare name.",
  },
  neighbors: {
    description:
      "Return notes within `depth` hops of the given note along the chosen direction (`out`, `in`, or `both`). Distance is reported per neighbor. The `note` parameter must be a vault-relative path ending in `.md` (e.g. `folder/note-a.md`). Use `resolve_wikilink` first if you only have a bare name.",
  },
  shortest_path: {
    description:
      "Find the shortest directed path (note→note) between two notes. Returns the path and hop count, or nulls when no path exists within `max_hops`. The `from` and `to` parameters must be vault-relative paths ending in `.md` (e.g. `folder/note-a.md`). Use `resolve_wikilink` first if you only have bare names.",
  },
  orphans: {
    description:
      "List notes with no note→note edges (inbound or outbound). Placeholder links do not rescue a note from orphan status.",
  },
  placeholders: {
    description:
      "List unresolved wikilink targets (broken links) together with the notes that reference them.",
  },
  central_notes: {
    description:
      "Rank notes by centrality using PageRank or total degree. Optionally restrict to notes under a given folder prefix.",
  },
  semantic_search: {
    description:
      "Semantic similarity search over the vault. Embeds the query, runs KNN over chunk vectors, and returns top hits with optional folder/tag/min-score filters. Requires `build_index` to have been run at least once.",
  },
  build_index: {
    description:
      "Build or refresh the semantic index. Incremental by default (only changed notes are re-embedded); pass `force: true` to wipe and rebuild from scratch. Emits MCP progress notifications when the caller supplies a progress token.",
  },
  index_status: {
    description:
      "Report semantic-index status: note/chunk counts, embedder identity, last-built timestamp, and a best-effort up-to-date signal (walks the vault to compare fingerprints).",
  },
  hybrid_search: {
    description:
      "Hybrid search fusing semantic, keyword, and PageRank signals via reciprocal-rank fusion. Returns per-hit score breakdown with semantic/keyword ranks and PageRank contribution. weights default {sem: 0.6, kw: 0.2, graph: 0.2} (graph is the PageRank rerank coefficient, not a separate fusion list).",
  },
} as const;

/**
 * Dispatch map. Each entry is a handler accepting the typed input for its
 * tool and a shared {@link ToolContext}. `server.ts` looks up the handler
 * by name; `McpServer` validates input against the zod shape before the
 * handler runs, so handlers see an already-parsed value.
 *
 * Inputs are typed per-entry; the shared map-type erases them to a permissive
 * shape so consumers can index by string. Each handler still enforces its
 * own input validation internally (the schema is the first line of defense).
 * Keyword handlers receive `ctx.keyword`; graph handlers receive `ctx.graph`.
 */
export const TOOL_HANDLERS: {
  readonly search_notes: ToolHandler<SearchNotesInput, SearchResult[]>;
  readonly find_by_frontmatter: ToolHandler<FindByFrontmatterInput, NoteRef[]>;
  readonly find_unchecked_tasks: ToolHandler<FindUncheckedTasksInput, TaskResult[]>;
  readonly resolve_wikilink: ToolHandler<ResolveWikilinkInput, ResolveResponse>;
  readonly get_note: ToolHandler<GetNoteInput, NoteContent>;
  readonly get_vault_stats: ToolHandler<GetVaultStatsInput, VaultStats>;
  readonly list_backlinks: ToolHandler<ListBacklinksInput, ListBacklinksOutput>;
  readonly neighbors: ToolHandler<NeighborsInput, NeighborsOutput>;
  readonly shortest_path: ToolHandler<ShortestPathInput, ShortestPathOutput>;
  readonly orphans: ToolHandler<OrphansInput, OrphansOutput>;
  readonly placeholders: ToolHandler<PlaceholdersInput, PlaceholdersOutput>;
  readonly central_notes: ToolHandler<CentralNotesInput, CentralNotesOutput>;
  readonly semantic_search: ToolHandler<SemanticSearchInput, SemanticSearchOutput>;
  readonly build_index: ToolHandler<BuildIndexInput, BuildIndexOutput>;
  readonly index_status: ToolHandler<IndexStatusInput, IndexStatusOutput>;
  readonly hybrid_search: ToolHandler<HybridSearchInput, HybridSearchOutput>;
} = {
  search_notes: (input, ctx) => searchNotes(input, ctx.keyword),
  find_by_frontmatter: (input, ctx) => findByFrontmatter(input, ctx.keyword),
  find_unchecked_tasks: (input, ctx) => findUncheckedTasks(input, ctx.keyword),
  resolve_wikilink: (input, ctx) => resolveWikilinkTool(input, ctx.keyword),
  get_note: (input, ctx) => getNote(input, ctx.keyword),
  get_vault_stats: (input, ctx) => getVaultStats(input, ctx.keyword),
  list_backlinks: (input, ctx) => listBacklinks(input, ctx.graph),
  neighbors: (input, ctx) => neighbors(input, ctx.graph),
  shortest_path: (input, ctx) => shortestPath(input, ctx.graph),
  orphans: (input, ctx) => orphans(input, ctx.graph),
  placeholders: (input, ctx) => placeholders(input, ctx.graph),
  central_notes: (input, ctx) => centralNotes(input, ctx.graph),
  // Semantic tools dispatch into `ctx.semantic`. Note: `build_index`'s
  // progress callback is wired at the server layer (not here) — the
  // generic handler signature doesn't carry a progress hook. The server
  // registers `build_index` out of the generic loop so it can adapt the
  // MCP progress token into an SDK-agnostic `onProgress` callback.
  semantic_search: (input, ctx) => semanticSearch(input, ctx.semantic),
  build_index: (input, ctx) => runBuildIndex(input, ctx.semantic),
  index_status: (_input, ctx) => indexStatus({}, ctx.semantic),
  hybrid_search: (input, ctx) => hybridSearch(input, ctx.hybrid),
} as const;

const NOTE_PATH_DESC =
  "Vault-relative path to the note including .md extension (e.g. 'projects/my-note.md'). Use resolve_wikilink to convert a bare name to a path.";

/**
 * Zod raw shapes for each tool's input schema. Single source of truth for
 * schema shape: `McpServer.registerTool` consumes these directly and
 * derives the flat JSON Schema advertised via `tools/list`.
 *
 * A "raw shape" is a plain object whose values are zod schemas (not a
 * full `z.object(...)`). `McpServer` wraps each shape with `z.object(...)`
 * internally, validates `tools/call` input against it, and converts it to
 * JSON Schema for the wire. The test in `tests/tools/wire-schemas.test.ts`
 * pins the invariant that no `$ref` / `$defs` / `definitions` appear in
 * that derived schema (PLAN decision #20).
 *
 * Fields NOT wrapped in `.optional()` are required.
 */
export const TOOL_ZOD_SHAPES = {
  search_notes: {
    query: z.string().min(1).describe("Text pattern to search for (ripgrep syntax)."),
    limit: z.number().int().min(0).optional().describe("Maximum number of matches to return."),
    contextLines: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of surrounding context lines per match."),
  },
  find_by_frontmatter: {
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    operator: z.enum(["equals", "contains", "exists"]).optional(),
  },
  find_unchecked_tasks: {
    pathGlob: z.string().optional(),
    headingFilter: z.string().optional(),
  },
  resolve_wikilink: {
    target: z
      .string()
      .min(1)
      .describe(
        "Wikilink target to resolve — accepts bare names (e.g. 'my-note'), paths ('folder/my-note'), or names with .md extension. Returns the canonical vault path.",
      ),
  },
  get_note: {
    path: z.string().min(1).describe(NOTE_PATH_DESC),
    includeBody: z.boolean().optional().describe("If true, include the markdown body content."),
  },
  get_vault_stats: {},
  list_backlinks: {
    note: z.string().min(1).describe(NOTE_PATH_DESC),
  },
  neighbors: {
    note: z.string().min(1).describe(NOTE_PATH_DESC),
    depth: z.number().int().min(1).max(3).optional().describe("BFS traversal depth (1-3)."),
    direction: z
      .enum(["out", "in", "both"])
      .optional()
      .describe("Edge direction: 'out' (links from note), 'in' (links to note), or 'both'."),
  },
  shortest_path: {
    from: z.string().min(1).describe(NOTE_PATH_DESC),
    to: z.string().min(1).describe(NOTE_PATH_DESC),
    max_hops: z.number().int().min(1).optional().describe("Maximum path length (default 6)."),
  },
  orphans: {},
  placeholders: {},
  central_notes: {
    algorithm: z.enum(["pagerank", "degree"]),
    limit: z.number().int().min(1).optional(),
    folder: z.string().optional(),
  },
  semantic_search: {
    query: z.string().min(1),
    limit: z.number().int().min(1).optional(),
    folder: z.string().optional(),
    tags: z.array(z.string()).optional(),
    min_score: z.number().min(-1).max(1).optional(),
  },
  build_index: {
    force: z.boolean().optional(),
  },
  index_status: {},
  hybrid_search: {
    query: z.string().min(1),
    limit: z.number().int().min(1).optional(),
    weights: z
      .object({
        sem: z.number().min(0).optional(),
        kw: z.number().min(0).optional(),
        graph: z.number().min(0).optional(),
      })
      .optional(),
    min_score: z.number().optional(),
    sources: z
      .object({
        semantic: z.boolean().optional(),
        keyword: z.boolean().optional(),
      })
      .optional(),
  },
} as const;
