/**
 * MCP tool registry.
 *
 * Hand-written JSON Schemas (PLAN decision #20). No `$ref`, no `definitions`
 * — some MCP clients reject references and we prefer to keep the tool
 * manifest fully flat and self-describing. `zod-to-json-schema` is avoided
 * for the same reason: it emits `$ref`s that clients reject.
 *
 * This module MAY import from `keyword/` and `graph/`. It MUST NOT import from
 * `server.ts` or from any future feature layer.
 */

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
 * Tool definition: `name`, `description`, and a flat `inputSchema`.
 *
 * `outputSchema` is intentionally omitted — v0.1 MCP clients don't require
 * it, and hand-writing both input and output schemas doubles the maintenance
 * burden without a corresponding safety win (outputs are typed at the TS
 * level via return types).
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "search_notes",
    description:
      "Full-text search across the vault using ripgrep. Returns path, line, column, matched line, and optional surrounding context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Query string (passed argv-safely to ripgrep).",
          minLength: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return. 0 or omitted = no limit.",
          minimum: 0,
        },
        contextLines: {
          type: "integer",
          description:
            "Number of lines of surrounding context to include before and after each match.",
          minimum: 0,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "find_by_frontmatter",
    description:
      "Find notes whose YAML frontmatter matches a key/value criterion. Supports `equals`, `contains`, and `exists` operators.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        key: {
          type: "string",
          description: "Frontmatter field name to filter on.",
          minLength: 1,
        },
        value: {
          description:
            "Value to compare against. Required for `equals` and `contains`. Omitted when operator is `exists`.",
          type: ["string", "number", "boolean"],
        },
        operator: {
          type: "string",
          enum: ["equals", "contains", "exists"],
          description:
            "Comparison mode. Defaults to `equals` when `value` is provided, `exists` otherwise.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "find_unchecked_tasks",
    description:
      "List all unchecked `- [ ]` tasks in the vault, optionally scoped by a path glob and filtered by heading substring.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pathGlob: {
          type: "string",
          description: "Optional fast-glob pattern (relative to vault root). Default `**/*.md`.",
        },
        headingFilter: {
          type: "string",
          description:
            "Optional substring: only tasks whose ancestor heading contains this text are returned.",
        },
      },
      required: [],
    },
  },
  {
    name: "resolve_wikilink",
    description:
      "Resolve a wikilink target (e.g. `note-a`, `02-Areas/note-b`) against the vault. Returns `unique`, `ambiguous`, or `not_found` with the matching candidate path(s).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          description:
            "The link target text (content inside `[[...]]`, minus any `|alias` or `#heading` suffix).",
          minLength: 1,
        },
      },
      required: ["target"],
    },
  },
  {
    name: "get_note",
    description:
      "Read a single note by path (inside the vault) and return its frontmatter, tags, wikilinks, and tasks. Optionally include the body with the frontmatter stripped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute or vault-relative path to a `.md` file. Paths that escape the vault are rejected.",
          minLength: 1,
        },
        includeBody: {
          type: "boolean",
          description: "Include the markdown body (frontmatter stripped) in the response.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_vault_stats",
    description:
      "Return aggregate statistics about the vault: note count, tag counts, task counts, wikilink counts (including broken), and MOC count.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_backlinks",
    description:
      "List every inbound note→note link to the given note, with source path, line, and a one-line context snippet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        note: {
          type: "string",
          description:
            "Absolute or vault-relative path to a `.md` file inside the vault. Must exist in the graph.",
          minLength: 1,
        },
      },
      required: ["note"],
    },
  },
  {
    name: "neighbors",
    description:
      "Return notes within `depth` hops of the given note along the chosen direction (`out`, `in`, or `both`). Distance is reported per neighbor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        note: {
          type: "string",
          description: "Absolute or vault-relative path to the starting note.",
          minLength: 1,
        },
        depth: {
          type: "integer",
          description: "Traversal depth (1-3). Defaults to 1.",
          minimum: 1,
          maximum: 3,
        },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description:
            "Edge direction to follow. `out` = outgoing links, `in` = backlinks, `both` = union. Defaults to `both`.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "shortest_path",
    description:
      "Find the shortest directed path (note→note) between two notes. Returns the path and hop count, or nulls when no path exists within `max_hops`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: {
          type: "string",
          description: "Starting note (absolute or vault-relative path).",
          minLength: 1,
        },
        to: {
          type: "string",
          description: "Destination note (absolute or vault-relative path).",
          minLength: 1,
        },
        max_hops: {
          type: "integer",
          description: "Maximum hop budget (positive integer). Defaults to 6.",
          minimum: 1,
        },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "orphans",
    description:
      "List notes with no note→note edges (inbound or outbound). Placeholder links do not rescue a note from orphan status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "placeholders",
    description:
      "List unresolved wikilink targets (broken links) together with the notes that reference them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "central_notes",
    description:
      "Rank notes by centrality using PageRank or total degree. Optionally restrict to notes under a given folder prefix.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        algorithm: {
          type: "string",
          enum: ["pagerank", "degree"],
          description: "Centrality algorithm: `pagerank` or `degree` (in + out).",
        },
        limit: {
          type: "integer",
          description: "Maximum number of notes to return (positive integer). Defaults to 10.",
          minimum: 1,
        },
        folder: {
          type: "string",
          description: "Optional folder prefix (e.g. `01-Projects`) to restrict the ranked set.",
        },
      },
      required: ["algorithm"],
    },
  },
] as const;

/**
 * Dispatch map. Each entry is a handler accepting the typed input for its
 * tool and a shared {@link ToolContext}. `server.ts` will look up the handler
 * by name, validate the input against the JSON Schema, and wrap thrown errors
 * into `McpError`.
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
