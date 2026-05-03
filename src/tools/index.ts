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

/**
 * Combined context for tool handlers. The server builds both sub-contexts
 * once at startup and passes this widened shape into every dispatch.
 * Keyword tools only consume `ctx.keyword`; graph tools only consume
 * `ctx.graph`.
 */
export interface ToolContext {
  readonly keyword: KeywordToolContext;
  readonly graph: GraphToolContext;
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
      "Resolve a wikilink target (e.g. `note-a`, `02-Areas/note-b`) against the vault. Returns `unique`, `ambiguous`, or `not_found` with the matching candidate path(s).",
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
      "List every inbound note→note link to the given note, with source path, line, and a one-line context snippet.",
  },
  neighbors: {
    description:
      "Return notes within `depth` hops of the given note along the chosen direction (`out`, `in`, or `both`). Distance is reported per neighbor.",
  },
  shortest_path: {
    description:
      "Find the shortest directed path (note→note) between two notes. Returns the path and hop count, or nulls when no path exists within `max_hops`.",
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
} as const;

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
    query: z.string().min(1),
    limit: z.number().int().min(0).optional(),
    contextLines: z.number().int().min(0).optional(),
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
    target: z.string().min(1),
  },
  get_note: {
    path: z.string().min(1),
    includeBody: z.boolean().optional(),
  },
  get_vault_stats: {},
  list_backlinks: {
    note: z.string().min(1),
  },
  neighbors: {
    note: z.string().min(1),
    depth: z.number().int().min(1).max(3).optional(),
    direction: z.enum(["out", "in", "both"]).optional(),
  },
  shortest_path: {
    from: z.string().min(1),
    to: z.string().min(1),
    max_hops: z.number().int().min(1).optional(),
  },
  orphans: {},
  placeholders: {},
  central_notes: {
    algorithm: z.enum(["pagerank", "degree"]),
    limit: z.number().int().min(1).optional(),
    folder: z.string().optional(),
  },
} as const;
