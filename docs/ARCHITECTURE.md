# Architecture

`foam-notes-mcp` is a Model Context Protocol (MCP) server that exposes a
[Foam](https://foambubble.github.io/)-style Markdown vault to MCP clients
(Claude Desktop, Cursor, Kiro, …) over stdio. It ships 16 tools — six keyword
(ripgrep-backed), six graph (graphology + PageRank), three semantic
(`sqlite-vec` + local `@huggingface/transformers` embeddings), and one hybrid
(reciprocal-rank fusion with a PageRank rerank) — plus the `foam://graph`
resource for external visualization.

The server is **read-only against the vault**. Only the cache directory
(`./.foam-mcp/` by default) is ever written to. Startup loads configuration,
scans the vault to build an in-memory graph, opens the sqlite-vec store, and
optionally starts a file watcher that incrementally updates both the graph and
the semantic index on `.md` changes. No network listener is opened; the single
outbound call is the first-run HuggingFace model download.

## At a glance

```
MCP client (Claude, Cursor, Kiro, …)
           ↕ stdio JSON-RPC
┌───────────────────────────────────────────────────────────────┐
│  server.ts  (McpServer + StdioServerTransport)                │
│    · registers 15 generic tools + build_index (progress)      │
│    · registers foam://graph resource                          │
│    · boots watcher (opt-out via FOAM_WATCHER=0)               │
├───────────────────────────────────────────────────────────────┤
│  tools/index.ts          resources/graph.ts                   │
│    TOOL_HANDLERS            foam://graph (size-capped)        │
│    TOOL_ZOD_SHAPES                                            │
├───────────────────────────────────────────────────────────────┤
│  hybrid/tools.ts   — RRF (k=60) + multiplicative PageRank     │
├────────────────────┬──────────────────┬───────────────────────┤
│  keyword/          │  graph/          │  semantic/            │
│   ripgrep spawn    │   graphology     │   chunker             │
│   6 tools          │   in-memory      │   transformers (ONNX) │
│                    │   PageRank       │   sqlite-vec store    │
├────────────────────┴──────────────────┴───────────────────────┤
│  parse/  (markdown, frontmatter, tags, tasks, wikilink)       │
│  resolver.ts (Foam-inspired resolution ladder)                │
│  path-util.ts (glob→regex, realpath vault guard)              │
├───────────────────────────────────────────────────────────────┤
│  watcher.ts  — chokidar v4, 200ms per-path debounce           │
│  cache.ts · config.ts · errors.ts  (leaves)                   │
└───────────────────────────────────────────────────────────────┘
External processes: ripgrep (spawned per keyword query)
External stores   : ./.foam-mcp/semantic/index.sqlite (sqlite-vec)
                    in-memory DirectedGraph (graphology)
```

## Module layout

- `src/server.ts` — MCP bootstrap; builds tool context, registers tools +
  `foam://graph`, starts watcher, owns the shutdown chain.
- `src/config.ts` — env-var parsing, Windows rejection, ripgrep presence
  check, vault / cache realpath resolution, overlap guard.
- `src/cache.ts` — `./.foam-mcp/` layout, fingerprinting, atomic writes.
  The **sole** permitted writer in `src/` (Decision #23).
- `src/errors.ts` — `ToolValidationError`, `GraphResourceTooLargeError`
  (leaves — no project imports).
- `src/path-util.ts` — `isInsideVault` / `isInsideVaultAsync` (realpath-safe),
  `globToRegex`, `relativeFolder`, `deriveTitle`, `safeParseFrontmatter`.
- `src/resolver.ts` — Foam-inspired wikilink resolution ladder (exact →
  case-insensitive → path-suffix → ambiguous) + directory-link fallback.
- `src/watcher.ts` — chokidar v4 wrapper with per-path, last-event-wins
  200ms debounce; dispatches into graph + semantic incremental updaters.
- `src/parse/` — `markdown.ts` (unified/remark pipeline), `frontmatter.ts`
  (gray-matter fast path), `tags.ts` (inline + frontmatter merge),
  `wikilink.ts` (hardened regex), `tasks.ts` (task regex + heading tracking).
- `src/keyword/` — `ripgrep.ts` (child_process spawn, JSON mode),
  `tools.ts` (6 keyword tools).
- `src/graph/` — `builder.ts` (cold build from parsed notes),
  `incremental.ts` (add/change/delete edge diff), `pagerank.ts`
  (power iteration), `tools.ts` (6 graph tools).
- `src/semantic/` — `chunker.ts` (heading-section + 200-tok window + 40-tok
  overlap), `embedder/` (provider factory + transformers), `store.ts`
  (sqlite-vec schema + KNN + fingerprints), `index.ts` (cold/incremental
  orchestrator + `updateNoteSemantic` watcher entry), `tools.ts`
  (3 semantic tools).
- `src/hybrid/tools.ts` — `hybrid_search`: RRF fusion + multiplicative
  PageRank rerank.
- `src/resources/graph.ts` — `foam://graph` resource, size-capped.
- `src/tools/index.ts` — central `TOOL_HANDLERS`, `TOOL_METADATA`,
  `TOOL_ZOD_SHAPES`, and `ToolContext` shape.

## Layer rules

The layer rules are enforced at CI time by `.dependency-cruiser.cjs`. The
table below is the consolidated view; the rule names and comments are
verbatim from the config.

| Layer                             | May import from                                                                | Must not import from                                                            |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `parse/*`                         | node built-ins, npm deps, `errors.ts`                                          | `keyword/`, `graph/`, `semantic/`, `hybrid/`, `tools/`, `resources/`, `watcher` |
| `resolver.ts`                     | `parse/*`, `path-util.ts`, `errors.ts`, node built-ins, npm deps               | `keyword/`, `graph/`, `semantic/`, `hybrid/`, `tools/`, `resources/`, `watcher` |
| `keyword/`                        | `parse/*`, `resolver.ts`, `path-util.ts`, `cache.ts`, `config.ts`, `errors.ts` | `graph/`, `semantic/`, `hybrid/`, `tools/`, `resources/`, `watcher`             |
| `graph/`                          | `parse/*`, `resolver.ts`, `path-util.ts`, `cache.ts`, `config.ts`, `errors.ts` | `keyword/`, `semantic/`, `hybrid/`, `tools/`, `resources/`, `watcher`           |
| `semantic/`                       | `parse/*`, `resolver.ts`, `path-util.ts`, `cache.ts`, `config.ts`, `errors.ts` | `keyword/`, `graph/`, `hybrid/`, `tools/`, `resources/`, `watcher`              |
| `hybrid/`                         | `keyword/`, `graph/`, `semantic/`, plus everything above                       | `tools/`, `resources/`, `watcher`                                               |
| `tools/`, `resources/`, `watcher` | anything except `server.ts`                                                    | `server.ts`                                                                     |
| `server.ts` (top)                 | anything                                                                       | nothing may import FROM it                                                      |

Rule comments, verbatim from `.dependency-cruiser.cjs`:

- `parse-cannot-depend-on-features` — "parse/ is a leaf layer; must not import
  from keyword/, graph/, semantic/, hybrid/, tools/, resources/, or watcher"
- `resolver-cannot-depend-on-features` — "resolver.ts must not import from any
  sibling feature layer"
- `keyword-cannot-depend-on-siblings` — "keyword/ must not import from graph/,
  semantic/, hybrid/, tools/, resources/"
- `graph-cannot-depend-on-siblings` — "graph/ must not import from keyword/,
  semantic/, hybrid/, tools/, resources/"
- `semantic-cannot-depend-on-siblings` — "semantic/ must not import from
  keyword/, graph/, hybrid/, tools/, resources/"
- `hybrid-cannot-depend-on-upper` — "hybrid/ must not import from tools/,
  resources/, or server.ts"
- `nothing-depends-on-server` — "server.ts is the entrypoint; must not be
  imported"

Two general rules also apply: `no-circular` (error, no circular deps) and
`no-orphans` (warn, modules unreachable from `server.ts` — tests and
`types.ts` modules are excluded).

## Startup sequence

`src/server.ts::main()` executes these steps in order, exiting with code 1
on any failure and logging the error to stderr (`stdout` is reserved for
JSON-RPC framing):

1. **`loadConfig()`** — parse env vars, reject Windows, realpath the vault,
   verify ripgrep, resolve cache dir, enforce cache-vs-vault non-overlap
   (`FOAM_CACHE_DIR must not overlap FOAM_VAULT_PATH` — M3 Wave 6 security,
   commit 3a0ea92).
2. **`buildGraph()`** — scan the vault with `fast-glob`, parse every `.md`,
   and create a `DirectedGraph<GraphNodeAttrs, EdgeAttrs>` (graphology). Logs
   `Graph built: <N> nodes, <M> edges` to stderr.
3. **`buildSemanticDeps(config)`** — call `ensureNestedCacheDir` for
   `semantic/` and `semantic/models/`, construct the embedder (lazy — no
   model load until first `embed()` call), open `SemanticStore` over
   `<cacheDir>/semantic/index.sqlite`. Logs embedder identity + dims.
4. **`buildToolContext(config, graph, semantic)`** — assemble the
   `ToolContext` (`keyword` / `graph` / `semantic` / `hybrid` sub-contexts
   wired from the same source objects).
5. **`buildServer(ctx, options)`** — construct the `McpServer`, register
   all 15 generic tools via the `TOOL_HANDLERS` loop, special-case
   `build_index` so it can adapt the MCP `_meta.progressToken` into an
   SDK-agnostic `onProgress` callback, and register `foam://graph` with
   configured node + byte caps.
6. **`initVaultWatcher(config, graph, semantic)`** — if `FOAM_WATCHER` is
   not disabled, enumerate vault `.md` paths, build a `VaultIndex`, and
   construct a `createVaultWatcher(...)` with a 200ms debounce (Decision
   #12). Starts the watcher and logs `watcher started (debounce 200ms)`.
7. **Install `SIGINT` / `SIGTERM` handlers** — see the shutdown sequence
   below.
8. **`server.connect(new StdioServerTransport())`** — wire up stdio
   JSON-RPC. Logs `ready (vault=<path>)`.

## Shutdown sequence

`SIGINT` / `SIGTERM` triggers a deadline-bounded graceful shutdown
(`src/server.ts` handler, M1 Wave 6 security, commit 3a0ea92). Key points:

- A **second** `SIGINT` received during shutdown force-exits with 130 so an
  operator can always regain control with Ctrl-C.
- The close chain runs in `closeAll()` and each step swallows its own error
  so a hang in one piece does not starve the others:
  1. `watcher.stop()` — flushes pending debounced events and awaits
     in-flight dispatches before closing chokidar.
  2. `server.close()` — closes the `McpServer` and its transport.
  3. `semantic.store.close()` — closes the sqlite-vec / better-sqlite3
     handle.
  4. `semantic.embedder.close()` — releases the ONNX session.
- `Promise.race([closeAll, 5000ms timeout])` bounds total shutdown to
  **5 seconds** (`SHUTDOWN_DEADLINE_MS = 5000`). On timeout the process
  exits 1 after logging `shutdown deadline … exceeded, forcing exit`;
  otherwise it exits 0.

## Request flow

Example: a `hybrid_search` call from an MCP client.

1. Client sends `{"method": "tools/call", "params": {"name": "hybrid_search",
"arguments": {"query": "rrf pagerank", "limit": 10}}}` over stdio.
2. `StdioServerTransport` parses the JSON-RPC frame and hands it to
   `McpServer`, which looks up the `hybrid_search` registration.
3. `McpServer` validates `arguments` against the zod raw shape in
   `TOOL_ZOD_SHAPES.hybrid_search`. On failure it returns
   `{ isError: true, content: [{ type: "text", text: <zod message> }] }`
   without invoking the handler.
4. `McpServer` calls the generic dispatch closure in `buildServer`, which
   routes through `TOOL_HANDLERS.hybrid_search(input, ctx)` →
   `hybridSearch(input, ctx.hybrid)` in `src/hybrid/tools.ts`.
5. `hybridSearch` runs:
   - `collectSemanticCandidates` → `semanticSearch({query, limit:30, min_score:0}, ctx.semantic)`
     → embedder.embed + `store.knn`. (`ToolValidationError("Index not built")`
     is caught and returns `[]`.)
   - `collectKeywordCandidates` → `searchNotes({query, limit:30}, ctx.keyword)`
     → `ripgrep.ts` spawns ripgrep in JSON mode.
   - `computeNormalizedPageRank(ctx.graph)` → power iteration restricted to
     `type === "note"` nodes, min-max normalized to `[0, 1]`.
   - `fuseHybridResults({...})` applies RRF at `k=60`:
     `rrf(note) = Σ weight_i / (k + rank_i)`, then the multiplicative rerank
     `final = rrf * (1 + weights.graph * pr_norm)`, sorts (desc score,
     tiebreak alphabetical `notePath`), filters by `min_score`, truncates to
     `limit`.
6. The handler returns an `HybridSearchOutput`. The dispatch closure wraps
   it into `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`.
7. `McpServer` returns that as the JSON-RPC response. The transport writes
   the frame to stdout.

Any thrown `ToolValidationError` (e.g. empty `query`) surfaces as
`{ isError: true, content: [{ type: "text", text: <message> }] }` per
amended Decision #22.

## Watcher dispatch

`src/watcher.ts::createVaultWatcher` wraps `chokidar@^4`. Behavior:

- **Ignore predicate**: directories always pass so the recursive walker
  reaches `.md` descendants; any non-directory path not ending in `.md`
  is ignored at the chokidar layer.
- **Per-path, last-event-wins debounce** (Decision #12, default 200ms via
  `DEFAULT_DEBOUNCE_MS`): on each `add` / `change` / `unlink`, the watcher
  replaces any existing pending entry for that path, stores the latest
  change type, and resets the timer. A rapid
  `add → change → unlink` coalesces to a single `delete` dispatch.
- **Dispatch**: on flush, `dispatch(change)` first calls
  `graph/incremental.ts::updateNote` (graph update), then
  `semantic/index.ts::updateNoteSemantic` (semantic update). Each is wrapped
  in its own try/catch — one side's failure is surfaced through the
  caller-supplied `onError` callback and does **not** starve the other.
- **Event-type translation** happens at the dispatch boundary only: the
  watcher speaks `add|modify|delete`, the graph layer speaks
  `added|modified|deleted`, the semantic layer uses the watcher's
  vocabulary directly.
- **Test seams**: `_applyChange(change)` bypasses chokidar + debounce;
  `_waitIdle()` awaits every in-flight dispatch promise (unit tests only).

## Cache layout

The cache root defaults to `./.foam-mcp/` under the project working directory
and can be overridden via `FOAM_CACHE_DIR`. Layout is defined by
`CACHE_SUBDIRS` in `src/cache.ts`:

```
.foam-mcp/
├── keyword/       # reserved for keyword-layer cache; currently unused in v0.1
├── graph/         # reserved; cached graph persistence is a v0.2 topic
├── semantic/
│   ├── index.sqlite   # sqlite-vec KNN + chunks + note fingerprints + meta
│   └── models/        # @huggingface/transformers model download cache
└── meta/          # reserved; fingerprints / build stamps / version markers
```

`keyword/`, `graph/`, and `meta/` are materialized at startup by
`ensureCacheLayout` but nothing writes into them yet — the sole live user of
the cache is the semantic layer (sqlite file + HF model downloads).

## Invariants

These are promises the code keeps. Every item below has a concrete
enforcement point.

- **Read-only against the vault** (Decision #23). Only `src/cache.ts` and
  `src/semantic/store.ts` write to disk; enforced by
  [`scripts/check-write-boundary.sh`](../scripts/check-write-boundary.sh)
  as a CI gate.
- **`FOAM_CACHE_DIR` must not overlap `FOAM_VAULT_PATH`** (Decision #11;
  M3 Wave 6, commit 3a0ea92). Enforced in `src/config.ts::loadConfig` —
  the server refuses to boot if either path is a prefix of the other.
- **No reverse layer imports.** Enforced by `.dependency-cruiser.cjs` rules
  listed in the Layer rules section.
- **Hand-written zod-backed schemas, never `$ref`'d on the wire**
  (Decision #20, amended). `TOOL_ZOD_SHAPES` in `src/tools/index.ts` is the
  single source of truth; pinned by
  `tests/tools/wire-schemas.test.ts` (asserts no `$ref` / `$defs` /
  `definitions` appear in derived `tools/list` schemas).
- **Windows rejected at startup** (Decision #3). `rejectWindows()` in
  `src/config.ts` throws on `process.platform === "win32"` before any
  other config work runs.
- **stdio only; no network listener.** The transport is always
  `StdioServerTransport`; no HTTP/TCP listener is opened anywhere in
  `src/`.
- **Model download is the only outbound network call.** Performed lazily
  by `@huggingface/transformers` on first `embed()`; target cache dir is
  `<cacheDir>/semantic/models/` (Decision #11).
- **`ToolValidationError` message reaches the client** across `McpServer`'s
  error flattening (amended Decision #22). Handlers throw
  `ToolValidationError`; `McpServer` wraps it into
  `{ isError: true, content: [{ type: "text", text: err.message }] }`.
- **Content-hash fingerprints for semantic incremental.**
  `src/semantic/index.ts::contentFingerprint` is SHA-256 of the UTF-8 body
  only — mtime is deliberately excluded so git checkouts and editor
  round-trips do not trigger spurious re-embeds.
- **User-supplied vault paths pass `isInsideVaultAsync` (realpath) at every
  entry point** (M5). Keyword tools and `get_note` call the async variant,
  which canonicalizes via `fs.realpath` so a symlinked escape is rejected
  even if the textual path would pass.
- **`foam://graph` resource is size-capped** (M3). The read path honors
  `FOAM_GRAPH_MAX_NODES` (default 5000) and `FOAM_GRAPH_MAX_BYTES` (default
  10 MiB); overshoots throw `GraphResourceTooLargeError`, mapped to
  `McpError(InvalidRequest, ...)` at the boundary.

## Error handling

Two typed errors live in `src/errors.ts`:

- **`ToolValidationError`** — thrown by tool handlers on invalid caller
  input. Has `code: "TOOL_VALIDATION_ERROR"` and
  `Object.setPrototypeOf` in the constructor so `instanceof` survives TS
  down-leveling. Handed to `McpServer`, which flattens it into
  `{ isError: true, content: [{ type: "text", text: err.message }] }`
  at the JSON-RPC layer (amended Decision #22).
- **`GraphResourceTooLargeError`** — thrown only by
  `resources/graph.ts::readGraphResource` when the serialized payload
  exceeds the configured node or byte cap. Carries `kind: "nodes" | "bytes"`,
  `actual`, and `limit` fields for future telemetry. `src/server.ts`'s
  `foam://graph` handler catches it and re-throws as
  `McpError(ErrorCode.InvalidRequest, err.message)` so MCP clients see a
  fail-fast, caller-correctable error rather than a silent multi-MB stdio
  payload.

Everything else that escapes a handler propagates through `McpServer`'s
generic catch path and surfaces to the client as a flattened error content
block. The boundary lives entirely in `src/server.ts`; feature layers never
need to know about MCP error codes.

## Testing architecture

Tests live under `tests/` and mirror the `src/` tree
(`tests/semantic/chunker.test.ts` ↔ `src/semantic/chunker.ts`, etc.).
Test categories:

- **Unit** — per-module (`tests/cache.test.ts`, `tests/watcher.test.ts`,
  `tests/parse/tasks.test.ts`, …).
- **Contract** — tool wire shapes (`tests/keyword/tools.contract.test.ts`,
  `tests/tools/wire-schemas.test.ts`).
- **Integration** — end-to-end watcher → graph + semantic round-trip
  (`tests/integration/watcher-roundtrip.test.ts`).
- **Smoke** — server boot (`tests/server.smoke.test.ts`).
- **Perf** — wall-clock budgets on a 500-note synthetic vault
  (`tests/perf/**`); each suite runs in its own forked process, files are
  run sequentially to avoid tmpdir races.

Four vitest configs run these:

| Command                   | Config                                     | Purpose                                             |
| ------------------------- | ------------------------------------------ | --------------------------------------------------- |
| `npm test` / `vitest run` | `vitest.config.ts`                         | Default suite (excludes `tests/perf/**`).           |
| `npm run test:coverage`   | `vitest.config.ts`                         | Same suite + v8 coverage (thresholds: 80/75/80/80). |
| `npm run test:perf`       | `vitest.perf.config.ts`                    | Perf suite on the 500-note vault.                   |
| `npm run test:perf:5k`    | `vitest.perf.config.ts` + `FOAM_PERF_5K=1` | Opt-in 5 000-note perf run (headroom check).        |

## References

- [`docs/PLAN.md`](./PLAN.md) — authoritative development plan, Locked
  Decisions, wave checklists, Tool Inventory.
- [`docs/TOOLS.md`](./TOOLS.md) — per-tool contract reference _(to be
  added in Wave 7 commit 3)_.
- [`docs/CONFIG.md`](./CONFIG.md) — env var reference _(to be added in
  Wave 7 commit 4)_.
- [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs) — enforced layer
  rules (source of truth for the layer-rule table above).
- [`scripts/check-write-boundary.sh`](../scripts/check-write-boundary.sh) —
  write-boundary audit (Decision #23 gate).
