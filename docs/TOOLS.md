# Tools

This document is the per-tool contract reference for foam-notes-mcp v0.1.
The server exposes **16 tools** and **1 resource** over MCP stdio.

- User intro: see [README.md](../README.md).
- Architecture: see [ARCHITECTURE.md](./ARCHITECTURE.md).
- Configuration: see [CONFIG.md](./CONFIG.md).

All examples use the default fixture vault shipped at
`tests/fixtures/vault/` for reproducibility. Adapt paths to your own
vault. Throughout this document, `<vault>` stands for the absolute path
configured via the `$FOAM_VAULT_PATH` environment variable (or the
default vault path passed at boot). The server always returns **absolute**
paths, never vault-relative ones.

JSON-RPC framing follows MCP:

- `tools/call` dispatches with `{ "name": <tool>, "arguments": <object> }`.
- `resources/read` dispatches with `{ "uri": <string> }`.
- Every successful tool response has the shape
  `result.content = [{ "type": "text", "text": <stringified JSON> }]`.
  The `text` field is produced by `JSON.stringify(result, null, 2)` in
  `src/server.ts`.

**Error responses** follow MCP SDK conventions: any handler throw is
flattened into `{ isError: true, content: [{ type: "text", text: <message> }] }`
(per amended PLAN Decision #22). Handlers signal caller-correctable
invalid input by throwing `ToolValidationError` (see
[ARCHITECTURE.md#error-handling](./ARCHITECTURE.md#error-handling)); the
`foam://graph` resource additionally throws `GraphResourceTooLargeError`,
which the server maps to `McpError(InvalidRequest, …)`.

## Table of contents

- [Keyword tools](#keyword-tools)
  - [search_notes](#search_notes)
  - [find_by_frontmatter](#find_by_frontmatter)
  - [find_unchecked_tasks](#find_unchecked_tasks)
  - [resolve_wikilink](#resolve_wikilink)
  - [get_note](#get_note)
  - [get_vault_stats](#get_vault_stats)
- [Graph tools](#graph-tools)
  - [list_backlinks](#list_backlinks)
  - [neighbors](#neighbors)
  - [shortest_path](#shortest_path)
  - [orphans](#orphans)
  - [placeholders](#placeholders)
  - [central_notes](#central_notes)
- [Semantic tools](#semantic-tools)
  - [semantic_search](#semantic_search)
  - [build_index](#build_index)
  - [index_status](#index_status)
- [Hybrid tool](#hybrid-tool)
  - [hybrid_search](#hybrid_search)
- [Resources](#resources)
  - [foam://graph](#foamgraph)
- [Error responses](#error-responses)

---

## Keyword tools

### search_notes

> Full-text search across the vault using ripgrep. Returns path, line, column, matched line, and optional surrounding context.

**Input:**

| Field          | Type        | Required | Default | Notes                              |
| -------------- | ----------- | -------- | ------- | ---------------------------------- |
| `query`        | string      | yes      | —       | non-empty                          |
| `limit`        | integer ≥ 0 | no       | `0`     | `0` = no limit                     |
| `contextLines` | integer ≥ 0 | no       | `0`     | lines of context around each match |

**Output:** `Array<SearchResult>` where

```ts
interface SearchResult {
  path: string; // absolute path
  line: number; // 1-indexed
  column: number; // 1-indexed
  match: string; // full matching line
  context?: { before: string[]; after: string[] };
}
```

**Request (fully-framed):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_notes",
    "arguments": { "query": "Project X", "limit": 5 }
  }
}
```

**Response (fully-framed — canonical wrapping):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[\n  {\n    \"path\": \"<vault>/01-Projects/project-x.md\",\n    \"line\": 4,\n    \"column\": 1,\n    \"match\": \"# Project X\"\n  }\n]"
      }
    ]
  }
}
```

Subsequent examples in this document show the **decoded JSON** under an
"unwrapped" subheading to save reader time. The MCP wrapping shown above
applies to every tool response.

---

### find_by_frontmatter

> Find notes whose YAML frontmatter matches a key/value criterion. Supports `equals`, `contains`, and `exists` operators.

**Input:**

| Field      | Type                                 | Required | Default                                 | Notes                             |
| ---------- | ------------------------------------ | -------- | --------------------------------------- | --------------------------------- |
| `key`      | string                               | yes      | —                                       | non-empty                         |
| `value`    | string \| number \| boolean          | no       | —                                       | required unless `operator=exists` |
| `operator` | `"equals" \| "contains" \| "exists"` | no       | `"exists"` if no value; else `"equals"` |                                   |

**Output:** `Array<NoteRef>` where `NoteRef = { path: string }` (absolute path).

Operator semantics:

- `exists` — key is present in the frontmatter (any value).
- `equals` — scalar `==`; for array-valued keys, any array element `==` value.
- `contains` — substring match for string values; array membership for array-valued keys.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "find_by_frontmatter",
    "arguments": { "key": "tags", "value": "project", "operator": "contains" }
  }
}
```

**Response (unwrapped):**

```json
[{ "path": "<vault>/01-Projects/project-x.md" }, { "path": "<vault>/01-Projects/project-y.md" }]
```

---

### find_unchecked_tasks

> List all unchecked `- [ ]` tasks in the vault, optionally scoped by a path glob and filtered by heading substring.

**Input:**

| Field           | Type   | Required | Default     | Notes                                                     |
| --------------- | ------ | -------- | ----------- | --------------------------------------------------------- |
| `pathGlob`      | string | no       | `"**/*.md"` | vault-relative; absolute paths and `..` segments rejected |
| `headingFilter` | string | no       | —           | substring match against the task's enclosing heading      |

**Output:**

```ts
interface TaskResult {
  path: string; // absolute
  text: string; // task text without the "- [ ]" marker
  line: number; // 1-indexed
  heading?: string; // only present when the task has an enclosing heading
}
```

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "find_unchecked_tasks",
    "arguments": { "pathGlob": "01-Projects/**/*.md" }
  }
}
```

**Response (unwrapped):**

```json
[
  {
    "path": "<vault>/01-Projects/project-x.md",
    "text": "nested task under goals",
    "line": 7,
    "heading": "Goals"
  },
  {
    "path": "<vault>/01-Projects/project-x.md",
    "text": "nested task under tasks",
    "line": 11,
    "heading": "Tasks"
  }
]
```

Security note: `pathGlob` starting with `/` or containing a `..` segment
throws `ToolValidationError` before any filesystem scan — this blocks
enumeration attacks via absolute or climbing globs. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full threat model.

---

### resolve_wikilink

> Resolve a wikilink target (e.g. `note-a`, `02-Areas/note-b`) against the vault. Returns `unique`, `ambiguous`, or `not_found` with the matching candidate path(s).

**Input:**

| Field    | Type   | Required | Default | Notes     |
| -------- | ------ | -------- | ------- | --------- |
| `target` | string | yes      | —       | non-empty |

**Output:**

```ts
interface ResolveResponse {
  status: "unique" | "ambiguous" | "not_found";
  candidates: string[]; // absolute paths
  confidence: "exact" | "suffix" | "ambiguous" | "none";
}
```

Resolution falls back to a directory-link (`[[folder]]` → `folder/index.md`)
when no note matches; the fallback is reported as `status: "unique"` with
`confidence: "suffix"`.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "resolve_wikilink",
    "arguments": { "target": "note-a" }
  }
}
```

**Response (unwrapped):**

```json
{
  "status": "unique",
  "candidates": ["<vault>/02-Areas/note-a.md"],
  "confidence": "exact"
}
```

**Ambiguous example (`target: "ambiguous"`):**

```json
{
  "status": "ambiguous",
  "candidates": [
    "<vault>/01-Projects/202604170001-ambiguous.md",
    "<vault>/202604170000-ambiguous.md"
  ],
  "confidence": "ambiguous"
}
```

See also: [`get_note`](#get_note) to read the resolved candidate's contents.

---

### get_note

> Read a single note by path (inside the vault) and return its frontmatter, tags, wikilinks, and tasks. Optionally include the body with the frontmatter stripped.

**Input:**

| Field         | Type    | Required | Default | Notes                                           |
| ------------- | ------- | -------- | ------- | ----------------------------------------------- |
| `path`        | string  | yes      | —       | absolute or vault-relative; must stay in vault  |
| `includeBody` | boolean | no       | `false` | when `true`, `body` is included in the response |

**Output:**

```ts
interface NoteContent {
  path: string; // absolute, normalized
  frontmatter: Record<string, unknown>;
  tags: string[];
  wikilinks: Wikilink[];
  tasks: Task[];
  body?: string; // only if includeBody=true
}

interface Wikilink {
  target: string;
  heading?: string;
  alias?: string;
  line: number;
  column: number;
}
interface Task {
  text: string;
  checked: boolean;
  heading?: string;
  line: number;
}
```

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "get_note",
    "arguments": { "path": "02-Areas/note-a.md", "includeBody": false }
  }
}
```

**Response (unwrapped):**

```json
{
  "path": "<vault>/02-Areas/note-a.md",
  "frontmatter": { "title": "Note A", "tags": ["area", "alpha"] },
  "tags": ["area", "alpha"],
  "wikilinks": [{ "target": "note-b", "line": 7, "column": 15 }],
  "tasks": [
    { "text": "unchecked task in note a", "checked": false, "heading": "Section One", "line": 6 }
  ]
}
```

Paths that escape the vault, or non-`.md` extensions, throw
`ToolValidationError`.

---

### get_vault_stats

> Return aggregate statistics about the vault: note count, tag counts, task counts, wikilink counts (including broken), and MOC count.

**Input:** none (accepts an empty object).

**Output:**

```ts
interface VaultStats {
  noteCount: number;
  totalTags: number; // sum of tag occurrences
  uniqueTags: number; // cardinality of the tag set
  taskCount: number;
  uncheckedTaskCount: number;
  wikilinkCount: number;
  brokenWikilinkCount: number; // unresolvable after directory-link fallback
  mocCount: number; // notes matching mocPattern (default *-MOC.md)
}
```

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": { "name": "get_vault_stats", "arguments": {} }
}
```

**Response (unwrapped):**

```json
{
  "noteCount": 12,
  "totalTags": 9,
  "uniqueTags": 6,
  "taskCount": 6,
  "uncheckedTaskCount": 5,
  "wikilinkCount": 11,
  "brokenWikilinkCount": 1,
  "mocCount": 1
}
```

---

## Graph tools

All graph tools operate over the prebuilt in-memory graphology graph.
Note paths supplied by the caller are resolved to their absolute form and
validated to be inside the vault; a missing node throws
`ToolValidationError("<tool>: note '<raw>' not found in graph")`.

### list_backlinks

> List every inbound note→note link to the given note, with source path, line, and a one-line context snippet.

**Input:**

| Field  | Type   | Required | Default | Notes                      |
| ------ | ------ | -------- | ------- | -------------------------- |
| `note` | string | yes      | —       | absolute or vault-relative |

**Output:**

```ts
interface ListBacklinksOutput {
  locations: Array<{
    sourcePath: string;
    line: number;
    context: string; // the source line, empty string on read failure
    alias?: string;
  }>;
}
```

Ordering: locations are sorted by `sourcePath` then `line` for stability.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "list_backlinks",
    "arguments": { "note": "02-Areas/note-a.md" }
  }
}
```

**Response (unwrapped):**

```json
{
  "locations": [
    {
      "sourcePath": "<vault>/00-Index-MOC.md",
      "line": 6,
      "context": "- [[note-a]]"
    },
    {
      "sourcePath": "<vault>/01-Projects/project-y.md",
      "line": 6,
      "context": "Links: [[project-x]] and [[02-Areas/note-a]]."
    },
    {
      "sourcePath": "<vault>/02-Areas/note-b.md",
      "line": 6,
      "context": "See [[note-a|alias for A]] and the missing [[placeholder-target]].",
      "alias": "alias for A"
    },
    {
      "sourcePath": "<vault>/03-Resources/202604160900-timestamped.md",
      "line": 5,
      "context": "Real link: [[note-a]]"
    }
  ]
}
```

---

### neighbors

> Return notes within `depth` hops of the given note along the chosen direction (`out`, `in`, or `both`). Distance is reported per neighbor.

**Input:**

| Field       | Type                      | Required | Default  | Notes                      |
| ----------- | ------------------------- | -------- | -------- | -------------------------- |
| `note`      | string                    | yes      | —        | absolute or vault-relative |
| `depth`     | integer, `1..3`           | no       | `1`      | max BFS radius             |
| `direction` | `"out" \| "in" \| "both"` | no       | `"both"` |                            |

**Output:**

```ts
interface NeighborsOutput {
  neighbors: Array<{ path: string; distance: number; direction: "out" | "in" }>;
}
```

On ties between directions at equal distance, the `out` direction wins
(the authorial direction). Placeholders are traversed but never appear in
the output.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "neighbors",
    "arguments": { "note": "02-Areas/note-a.md", "depth": 1, "direction": "both" }
  }
}
```

**Response (unwrapped):**

```json
{
  "neighbors": [
    { "path": "<vault>/02-Areas/note-b.md", "distance": 1, "direction": "out" },
    { "path": "<vault>/00-Index-MOC.md", "distance": 1, "direction": "in" },
    { "path": "<vault>/01-Projects/project-y.md", "distance": 1, "direction": "in" },
    { "path": "<vault>/03-Resources/202604160900-timestamped.md", "distance": 1, "direction": "in" }
  ]
}
```

---

### shortest_path

> Find the shortest directed path (note→note) between two notes. Returns the path and hop count, or nulls when no path exists within `max_hops`.

**Input:**

| Field      | Type        | Required | Default | Notes                      |
| ---------- | ----------- | -------- | ------- | -------------------------- |
| `from`     | string      | yes      | —       | absolute or vault-relative |
| `to`       | string      | yes      | —       | absolute or vault-relative |
| `max_hops` | integer ≥ 1 | no       | `6`     |                            |

**Output:**

```ts
interface ShortestPathOutput {
  path: string[] | null; // list of absolute note paths, inclusive endpoints
  hops: number | null; // path.length - 1
}
```

When `from === to`, returns `{ path: [from], hops: 0 }`. When no path
exists or the shortest path exceeds `max_hops`, returns
`{ path: null, hops: null }`.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "shortest_path",
    "arguments": {
      "from": "01-Projects/project-y.md",
      "to": "02-Areas/note-b.md",
      "max_hops": 4
    }
  }
}
```

**Response (unwrapped):**

```json
{
  "path": [
    "<vault>/01-Projects/project-y.md",
    "<vault>/02-Areas/note-a.md",
    "<vault>/02-Areas/note-b.md"
  ],
  "hops": 2
}
```

---

### orphans

> List notes with no note→note edges (inbound or outbound). Placeholder links do not rescue a note from orphan status.

**Input:** none (accepts an empty object).

**Output:** `{ notes: string[] }` (absolute paths, sorted alphabetically).

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": { "name": "orphans", "arguments": {} }
}
```

**Response (unwrapped):**

```json
{
  "notes": ["<vault>/03-Resources/no-frontmatter.md", "<vault>/04-Archives/archived.md"]
}
```

---

### placeholders

> List unresolved wikilink targets (broken links) together with the notes that reference them.

**Input:** none (accepts an empty object).

**Output:**

```ts
interface PlaceholdersOutput {
  placeholders: Array<{ target: string; referenced_by: string[] }>;
}
```

Both the top-level array and each `referenced_by` list are sorted
alphabetically for stability.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": { "name": "placeholders", "arguments": {} }
}
```

**Response (unwrapped):**

```json
{
  "placeholders": [
    {
      "target": "placeholder-target",
      "referenced_by": ["<vault>/02-Areas/note-b.md"]
    }
  ]
}
```

---

### central_notes

> Rank notes by centrality using PageRank or total degree. Optionally restrict to notes under a given folder prefix.

**Input:**

| Field       | Type                     | Required | Default | Notes                                        |
| ----------- | ------------------------ | -------- | ------- | -------------------------------------------- |
| `algorithm` | `"pagerank" \| "degree"` | yes      | —       |                                              |
| `limit`     | integer ≥ 1              | no       | `10`    |                                              |
| `folder`    | string                   | no       | —       | vault-relative prefix; boundary match on `/` |

**Output:**

```ts
interface CentralNotesOutput {
  notes: Array<{ path: string; score: number }>;
}
```

For `algorithm: "degree"`, `score = inDegree + outDegree`. For
`algorithm: "pagerank"`, `score` is the raw PageRank over note nodes
(placeholders are excluded).

Folder filtering uses a boundary match: `folder: "01-Projects"` matches
`01-Projects` itself and any `01-Projects/<sub>/…`, but not
`01-Projects-Archive/`.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "central_notes",
    "arguments": { "algorithm": "pagerank", "limit": 3 }
  }
}
```

**Response (unwrapped):**

```json
{
  "notes": [
    { "path": "<vault>/02-Areas/note-a.md", "score": 0.21 },
    { "path": "<vault>/02-Areas/note-b.md", "score": 0.14 },
    { "path": "<vault>/01-Projects/project-x.md", "score": 0.09 }
  ]
}
```

---

## Semantic tools

All semantic tools require a running semantic store. The store is opened
at server boot, but the embedder only materializes on first `embed()`
call. See [`build_index`](#build_index) for bootstrap details.

### semantic_search

> Semantic similarity search over the vault. Embeds the query, runs KNN over chunk vectors, and returns top hits with optional folder/tag/min-score filters. Requires `build_index` to have been run at least once.

**Input:**

| Field       | Type              | Required | Default | Notes                                                  |
| ----------- | ----------------- | -------- | ------- | ------------------------------------------------------ |
| `query`     | string            | yes      | —       | non-empty after trim                                   |
| `limit`     | integer ≥ 1       | no       | `10`    |                                                        |
| `folder`    | string            | no       | —       | exact folder match (SQL-side)                          |
| `tags`      | string[]          | no       | —       | all-of AND filter; chunk must contain every listed tag |
| `min_score` | number, `[-1, 1]` | no       | —       | cosine similarity; hits below this are dropped         |

**Output:**

```ts
interface SemanticSearchOutput {
  hits: Array<{
    notePath: string;
    chunkIndex: number; // 0-indexed position within note
    heading: string | null; // null for pre-heading body
    text: string; // raw chunk text
    startLine: number; // 1-indexed inclusive
    endLine: number; // 1-indexed inclusive
    folder: string; // "" for notes at the vault root
    tags: string[];
    score: number; // cosine similarity
  }>;
  total: number; // equals hits.length
}
```

Empty-store behavior: when the store reports zero chunks,
`semantic_search` throws
`ToolValidationError("Index not built. Run 'build_index' first.")`.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "semantic_search",
    "arguments": { "query": "project goals", "limit": 3, "min_score": 0.1 }
  }
}
```

**Response (unwrapped):**

```json
{
  "hits": [
    {
      "notePath": "<vault>/01-Projects/project-x.md",
      "chunkIndex": 1,
      "heading": "Goals",
      "text": "- nested task under goals\n",
      "startLine": 6,
      "endLine": 8,
      "folder": "01-Projects",
      "tags": ["project"],
      "score": 0.37
    }
  ],
  "total": 1
}
```

See also: [`hybrid_search`](#hybrid_search), which combines this tool with
[`search_notes`](#search_notes) and a PageRank rerank.

---

### build_index

> Build or refresh the semantic index. Incremental by default (only changed notes are re-embedded); pass `force: true` to wipe and rebuild from scratch. Emits MCP progress notifications when the caller supplies a progress token.

**Input:**

| Field   | Type    | Required | Default | Notes                                        |
| ------- | ------- | -------- | ------- | -------------------------------------------- |
| `force` | boolean | no       | `false` | when `true`, wipes and rebuilds from scratch |

**Output:**

```ts
interface BuildIndexOutput {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  errors: Array<{ notePath: string; message: string }>;
  durationMs: number;
  embedder: string; // e.g. "transformers-js:Xenova/all-MiniLM-L6-v2"
  dims: number; // vector dimension
  noteCount: number; // distinct notes currently indexed
  chunkCount: number; // total chunks currently indexed
}
```

**Progress notifications:** when the client supplies
`params._meta.progressToken`, the server emits
`notifications/progress` messages during the build, populated from the
orchestrator's `IndexProgress` callbacks (see
[ARCHITECTURE.md](./ARCHITECTURE.md)).

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "method": "tools/call",
  "params": {
    "name": "build_index",
    "arguments": { "force": false },
    "_meta": { "progressToken": "build-1" }
  }
}
```

**Response (unwrapped):**

```json
{
  "added": 12,
  "updated": 0,
  "removed": 0,
  "skipped": 0,
  "errors": [],
  "durationMs": 1837,
  "embedder": "transformers-js:Xenova/all-MiniLM-L6-v2",
  "dims": 384,
  "noteCount": 12,
  "chunkCount": 27
}
```

---

### index_status

> Report semantic-index status: note/chunk counts, embedder identity, last-built timestamp, and a best-effort up-to-date signal (walks the vault to compare fingerprints).

**Input:** none (accepts an empty object).

**Output:**

```ts
interface IndexStatusOutput {
  notes: number;
  chunks: number;
  lastBuiltAt: string | null; // ISO-8601; null if never built
  embedder: string; // "provider:model"
  dims: number;
  upToDate: boolean; // false when notes=0, or when fs/store drift detected
}
```

An empty store always reports `upToDate: false` — "up to date with
nothing indexed" is not a useful affirmative signal. For a non-empty
store, the field is `true` only when every on-disk `.md` file has a
matching fingerprint in the store **and** no stored note has been
deleted from disk.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "tools/call",
  "params": { "name": "index_status", "arguments": {} }
}
```

**Response (unwrapped):**

```json
{
  "notes": 12,
  "chunks": 27,
  "lastBuiltAt": "2026-05-07T17:42:11.000Z",
  "embedder": "transformers-js:Xenova/all-MiniLM-L6-v2",
  "dims": 384,
  "upToDate": true
}
```

---

## Hybrid tool

### hybrid_search

> Hybrid search fusing semantic, keyword, and PageRank signals via reciprocal-rank fusion. Returns per-hit score breakdown with semantic/keyword ranks and PageRank contribution. `weights` default `{ sem: 0.6, kw: 0.2, graph: 0.2 }` (graph is the PageRank rerank coefficient, not a separate fusion list).

**Input:**

| Field              | Type                                                  | Required | Default                             | Notes                             |
| ------------------ | ----------------------------------------------------- | -------- | ----------------------------------- | --------------------------------- |
| `query`            | string                                                | yes      | —                                   | non-empty after trim              |
| `limit`            | integer ≥ 1                                           | no       | `10`                                |                                   |
| `weights`          | `{ sem?: number≥0; kw?: number≥0; graph?: number≥0 }` | no       | `{ sem: 0.6, kw: 0.2, graph: 0.2 }` | finite numbers; need not sum to 1 |
| `min_score`        | number (finite)                                       | no       | `0`                                 | dropped BEFORE `limit` truncation |
| `sources.semantic` | boolean                                               | no       | `true`                              |                                   |
| `sources.keyword`  | boolean                                               | no       | `true`                              |                                   |

Algorithm: two source lists (semantic + keyword) are aggregated per note
(top chunk / first match wins), then fused with RRF (k=60, weighted),
then reranked multiplicatively by `(1 + weights.graph × pr_norm)` where
`pr_norm` is min-max normalized PageRank restricted to note nodes. Ties
in final score break on alphabetical `notePath`.

**Output:**

```ts
interface HybridSearchOutput {
  hits: Array<{
    notePath: string;
    bestMatch: {
      heading: string | null;
      text: string;
      startLine: number;
      endLine: number;
    };
    score: number; // final blended score
    scoreBreakdown: {
      rrf: number; // before PageRank rerank
      pagerank: number; // normalized to [0, 1]
      semRank: number | null; // 1-indexed, null if absent
      kwRank: number | null; // 1-indexed, null if absent
    };
  }>;
  total: number; // BEFORE limit, AFTER min_score
}
```

When the semantic index is empty, `hybrid_search` silently degrades to
keyword + PageRank rerank (no error). When the graph has no note
PageRank signal (empty or all-equal), the rerank is a no-op and the
final score equals the RRF score.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 16,
  "method": "tools/call",
  "params": {
    "name": "hybrid_search",
    "arguments": {
      "query": "Project X",
      "limit": 3,
      "weights": { "sem": 0.6, "kw": 0.2, "graph": 0.2 }
    }
  }
}
```

**Response (unwrapped):**

```json
{
  "hits": [
    {
      "notePath": "<vault>/01-Projects/project-x.md",
      "bestMatch": {
        "heading": null,
        "text": "# Project X\n",
        "startLine": 4,
        "endLine": 4
      },
      "score": 0.01167,
      "scoreBreakdown": {
        "rrf": 0.00984,
        "pagerank": 0.31,
        "semRank": 1,
        "kwRank": 1
      }
    },
    {
      "notePath": "<vault>/01-Projects/project-y.md",
      "bestMatch": {
        "heading": null,
        "text": "Links: [[project-x]] and [[02-Areas/note-a]].",
        "startLine": 6,
        "endLine": 6
      },
      "score": 0.00495,
      "scoreBreakdown": {
        "rrf": 0.00488,
        "pagerank": 0.07,
        "semRank": 2,
        "kwRank": 2
      }
    }
  ],
  "total": 2
}
```

See also: [`semantic_search`](#semantic_search) and
[`search_notes`](#search_notes) for the individual source layers.

---

## Resources

### foam://graph

> Full graph export as JSON (nodes, edges, attributes). Produced via graphology's `graph.export()` and wrapped with node/edge counts for external visualization tools.

**URI:** `foam://graph`
**MIME type:** `application/json`
**Dispatch:** MCP `resources/read`

**Payload envelope:**

```ts
interface GraphResourcePayload {
  version: 1;
  nodeCount: number;
  edgeCount: number;
  graph: ReturnType<DirectedGraph["export"]>; // full graphology export
}
```

**Size caps:** configurable via `FOAM_GRAPH_MAX_NODES` (default 5000) and
`FOAM_GRAPH_MAX_BYTES` (default 5 MiB). Exceeding either cap throws
`GraphResourceTooLargeError`, which the server maps to
`McpError(InvalidRequest, …)`. The error message names the specific env
var and recommends the targeted graph tools
([`list_backlinks`](#list_backlinks), [`neighbors`](#neighbors),
[`shortest_path`](#shortest_path), [`central_notes`](#central_notes),
[`orphans`](#orphans), [`placeholders`](#placeholders)) as alternatives.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "resources/read",
  "params": { "uri": "foam://graph" }
}
```

**Response (fully-framed):**

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "result": {
    "contents": [
      {
        "uri": "foam://graph",
        "mimeType": "application/json",
        "text": "{\"version\":1,\"nodeCount\":13,\"edgeCount\":12,\"graph\":{\"options\":{\"type\":\"directed\",\"multi\":false,\"allowSelfLoops\":true},\"attributes\":{},\"nodes\":[{\"key\":\"<vault>/02-Areas/note-a.md\",\"attributes\":{\"type\":\"note\",\"folder\":\"02-Areas\",\"title\":\"Note A\",\"basename\":\"note-a.md\",\"tags\":[\"area\",\"alpha\"],\"frontmatter\":{\"title\":\"Note A\",\"tags\":[\"area\",\"alpha\"]},\"isMoc\":false}}],\"edges\":[{\"source\":\"<vault>/02-Areas/note-a.md\",\"target\":\"<vault>/02-Areas/note-b.md\",\"attributes\":{\"line\":7,\"column\":15}}]}}"
      }
    ]
  }
}
```

The `text` payload is compact JSON (no pretty-printing). Consumers should
parse it with `JSON.parse` before consuming `graph`. The `nodes`/`edges`
arrays in the example above are abbreviated for readability; a real
response contains every node and edge in the built graph.

**Size-cap error:**

```json
{
  "jsonrpc": "2.0",
  "id": 17,
  "error": {
    "code": -32600,
    "message": "Graph has 6200 nodes, exceeds FOAM_GRAPH_MAX_NODES=5000. Use the graph tools (list_backlinks, neighbors, shortest_path, central_notes, orphans, placeholders) for targeted queries."
  }
}
```

---

## Error responses

All tool errors (including `ToolValidationError`) are **flattened by the
MCP SDK into an `isError` content envelope** rather than surfaced as
JSON-RPC errors. The client must inspect `result.isError` on every tool
response.

**Example — empty query to `semantic_search`:**

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 99,
  "method": "tools/call",
  "params": {
    "name": "semantic_search",
    "arguments": { "query": "   " }
  }
}
```

Response (flattened):

```json
{
  "jsonrpc": "2.0",
  "id": 99,
  "result": {
    "isError": true,
    "content": [
      {
        "type": "text",
        "text": "semantic_search: `query` must be a non-empty string"
      }
    ]
  }
}
```

**Example — zod pre-validation failure** (e.g. `limit: -1` to
`search_notes`): `McpServer` rejects the call before the handler runs,
and the response contains a zod-formatted error under `isError: true` /
`content[0].text`. Pre-validation messages mention the offending path
(e.g. `"limit"`) and the failing constraint (e.g. `"Number must be
greater than or equal to 0"`).

**Example — path escapes vault (`get_note`):**

```json
{
  "jsonrpc": "2.0",
  "id": 98,
  "result": {
    "isError": true,
    "content": [{ "type": "text", "text": "get_note: path escapes the vault: ../outside.md" }]
  }
}
```

**Example — `foam://graph` size-cap breach:** unlike tool errors, the
resource maps `GraphResourceTooLargeError` to a JSON-RPC error
(`McpError(InvalidRequest, …)`) rather than to a content envelope (see
the example at the end of [`foam://graph`](#foamgraph)).
