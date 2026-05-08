# foam-notes-mcp

Local-first [Model Context Protocol](https://modelcontextprotocol.io) server
for [Foam](https://foambubble.github.io/foam/)-style Markdown vaults. Exposes
keyword, graph, semantic, and hybrid search over your notes — wikilinks,
backlinks, frontmatter, tags, and tasks — to any MCP-compliant client
(Claude Desktop, Cursor, Kiro, and others). Runs entirely on your machine
after a one-time embedding-model download.

**Status**: v0.1 (experimental; the API may change between 0.x versions).

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [MCP client setup](#mcp-client-setup)
- [Tools](#tools)
- [Configuration](#configuration)
- [Trust boundary](#trust-boundary)
- [Tuning](#tuning)
- [Opt-in embedders (v0.2 preview)](#opt-in-embedders-v02-preview)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Dependency policy](#dependency-policy)
- [Security scanning](#security-scanning)
- [License](#license)

## Features

- 16 MCP tools plus 1 resource (`foam://graph`) — see [Tools](#tools).
- Keyword full-text search powered by ripgrep (bundled via
  `@vscode/ripgrep`, no separate install).
- Graph layer over wikilinks: backlinks, neighbors, shortest path,
  orphans, placeholders, and PageRank-based centrality.
- Semantic search with local embeddings
  (`Xenova/all-MiniLM-L6-v2`, 384 dims, via `@huggingface/transformers`).
- Hybrid search: reciprocal-rank fusion of semantic + keyword results,
  with an optional PageRank rerank.
- Incremental file watcher (chokidar, 200 ms debounce window) keeps
  caches fresh as you edit.
- Read-only with respect to your vault — writes are confined to
  `<FOAM_CACHE_DIR>` and enforced by a CI check.
- macOS and Linux (Windows is rejected at startup per
  [PLAN Decision #3](./docs/PLAN.md)).
- Node.js >= 20.
- Zero outbound network traffic after the initial model download.

## Installation

```bash
npm install -g @fbdo/foam-notes-mcp
# or invoke on demand:
npx -y @fbdo/foam-notes-mcp
```

Requirements:

- Node.js >= 20.
- macOS (`darwin`) or Linux. Windows is rejected at startup; see
  [PLAN Decision #3](./docs/PLAN.md).

The `@vscode/ripgrep` dependency ships a prebuilt `rg` binary, so there
is no separate ripgrep install step.

The first time `build_index` runs, `@huggingface/transformers` downloads
the MiniLM-L6-v2 model (roughly 90 MB of ONNX weights) into
`<FOAM_CACHE_DIR>/semantic/models/`. Subsequent runs reuse the cached
model; no further network activity is required.

## Quick start

1. Point `FOAM_VAULT_PATH` at your vault directory (absolute path).
2. Configure your MCP client with the `foam-notes-mcp` command — see
   [MCP client setup](#mcp-client-setup) below.
3. From your client, call the `build_index` tool once to populate the
   semantic index.
4. Use any of the 16 tools: keyword (`search_notes`, …), graph
   (`list_backlinks`, …), semantic (`semantic_search`), or
   hybrid (`hybrid_search`).

## MCP client setup

### Claude Desktop

Edit
`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS (on Windows the file lives at
`%APPDATA%\Claude\claude_desktop_config.json`, but foam-notes-mcp itself
does not run on Windows — see [Trust boundary](#trust-boundary)):

```json
{
  "mcpServers": {
    "foam-notes": {
      "command": "npx",
      "args": ["-y", "@fbdo/foam-notes-mcp"],
      "env": {
        "FOAM_VAULT_PATH": "/Users/you/notes"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Cursor

Edit `~/.cursor/mcp.json` (user scope) or `.cursor/mcp.json` at the root
of your workspace (project scope):

```json
{
  "mcpServers": {
    "foam-notes": {
      "command": "npx",
      "args": ["-y", "@fbdo/foam-notes-mcp"],
      "env": {
        "FOAM_VAULT_PATH": "/Users/you/notes"
      }
    }
  }
}
```

### Kiro

Consult [Kiro's MCP server configuration
documentation](https://kiro.dev/docs/mcp) for the current config format.
foam-notes-mcp implements the standard MCP stdio transport, so it works
with any MCP-compliant client.

### Other MCP clients

Any client that can launch an MCP server over stdio will work. The
minimum invocation is:

```bash
FOAM_VAULT_PATH=/Users/you/notes npx -y @fbdo/foam-notes-mcp
```

## Tools

16 tools across four categories, plus 1 resource. Full per-tool input
contracts will land in [`docs/TOOLS.md`](./docs/TOOLS.md).

| Category     | Tool                   | Purpose                                                                                                             |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Keyword (6)  | `search_notes`         | ripgrep-backed full-text search; returns path, line, column, matched line, and optional surrounding context.        |
| Keyword      | `find_by_frontmatter`  | Filter notes by a YAML frontmatter key/value with `equals`, `contains`, or `exists` operators.                      |
| Keyword      | `find_unchecked_tasks` | List open `- [ ]` tasks across the vault, optionally scoped by path glob and heading substring.                     |
| Keyword      | `resolve_wikilink`     | Resolve a wikilink target against the vault. Returns `unique`, `ambiguous`, or `not_found` with candidate(s).       |
| Keyword      | `get_note`             | Fetch a note's parsed frontmatter, tags, wikilinks, tasks, and (optionally) its body with frontmatter stripped.     |
| Keyword      | `get_vault_stats`      | Aggregate stats: note, tag, task, wikilink (including broken), and MOC counts.                                      |
| Graph (6)    | `list_backlinks`       | Every inbound note→note link, with source path, line, and a one-line context snippet.                               |
| Graph        | `neighbors`            | Notes within depth 1–3, in direction `out`, `in`, or `both`, with distance reported per neighbor.                   |
| Graph        | `shortest_path`        | Shortest directed path between two notes, bounded by `max_hops`. Returns path + hop count or nulls.                 |
| Graph        | `orphans`              | Notes with no inbound or outbound note→note edges. Placeholder links do not rescue a note from orphan status.       |
| Graph        | `placeholders`         | Unresolved wikilink targets (broken links) with the notes that reference them.                                      |
| Graph        | `central_notes`        | Top-N by PageRank or degree. Optional folder-prefix filter.                                                         |
| Semantic (3) | `semantic_search`      | Cosine KNN over chunk embeddings with optional `folder`, `tags`, and `min_score` filters.                           |
| Semantic     | `build_index`          | Build or refresh the semantic index; incremental by content hash, or `force: true` to rebuild from scratch.         |
| Semantic     | `index_status`         | Embedder identity, dims, note/chunk counts, last-built timestamp, and an up-to-date signal.                         |
| Hybrid (1)   | `hybrid_search`        | RRF fusion of keyword + semantic results with a PageRank rerank. Default weights `{sem: 0.6, kw: 0.2, graph: 0.2}`. |

### Resources

| URI            | Purpose                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `foam://graph` | Full graph export as JSON (`version`, `nodeCount`, `edgeCount`, `graph`), capped by `FOAM_GRAPH_MAX_NODES` and `FOAM_GRAPH_MAX_BYTES`. |

When either cap is exceeded, the resource read returns an MCP
`InvalidRequest` error pointing callers to the six graph tools for
targeted queries.

## Configuration

All configuration is via environment variables. A full reference will
land in [`docs/CONFIG.md`](./docs/CONFIG.md).

| Env var                | Default             | Purpose                                                                                                                                               |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOAM_VAULT_PATH`      | (required)          | Path to your vault. Absolute, or resolved against the process CWD. Canonicalized via `realpath` at load so symlinked roots are resolved once.         |
| `FOAM_CACHE_DIR`       | `./.foam-mcp/`      | Where cached artifacts live (semantic index, model cache, etc.). Must not overlap the vault in either direction; startup fails if it does.            |
| `VAULT_MOC_PATTERN`    | `*-MOC.md`          | Micromatch-style glob identifying Maps of Content.                                                                                                    |
| `FOAM_EMBEDDER`        | `transformers`      | Embedder provider. Only `transformers` is supported in v0.1; `ollama`, `openai`, and `bedrock` are reserved and produce a fatal startup error if set. |
| `FOAM_WATCHER`         | `1`                 | Start the file watcher on boot. Accepted values: `1`/`true`/`yes` or `0`/`false`/`no`. Any other value is a fatal startup error.                      |
| `FOAM_GRAPH_MAX_NODES` | `5000`              | Max node count for the `foam://graph` resource. Strictly greater than this throws.                                                                    |
| `FOAM_GRAPH_MAX_BYTES` | `10485760` (10 MiB) | Max serialized byte length of the `foam://graph` JSON payload. Strictly greater than this throws.                                                     |

All numeric vars must be decimal integers >= 1; floats, hex, exponents,
and leading signs are rejected so that typos surface at startup rather
than as silent coercions.

## Trust boundary

foam-notes-mcp trusts the MCP client (Claude Desktop, Cursor, Kiro, …)
to send well-formed JSON-RPC over stdio. The vault filesystem is trusted
structurally — the server reads it — but **note contents are treated as
untrusted input**: YAML frontmatter is parsed via `gray-matter` and
Markdown via `unified`/`remark`, both configured with safe defaults.

The server is **read-only with respect to your vault**. All filesystem
writes happen under `<FOAM_CACHE_DIR>`, and this invariant is enforced
by a CI check (`scripts/check-write-boundary.sh`) that scans `src/` for
any write, delete, rename, or mkdir outside the two allow-listed modules
(`src/cache.ts`, `src/semantic/store.ts`). No tool on the surface can
create, modify, rename, or delete vault files. See PLAN Locked
Decision #23.

Additional boundary properties:

- Windows is rejected at startup (PLAN Decision #3).
- Transport is stdio only — there is no network listener.
- The only outbound network call is the one-time MiniLM model download
  on first `build_index`. After that, the server is fully local.

## Tuning

Defaults are chosen for vaults up to ~5000 notes. A few knobs worth
knowing:

- **Small vaults (< 200 notes)**: defaults are fine; no action needed.
- **Medium vaults (200–2000 notes)**: set `FOAM_WATCHER=0` when doing
  large external edits (bulk rename, `git pull` of many files) and
  re-enable it afterwards to avoid spending CPU on a flood of
  file-change events.
- **Large vaults (2000–5000 notes)**: raise `FOAM_GRAPH_MAX_NODES` only
  if you actually read `foam://graph`; the six graph tools cover most
  targeted queries without needing the full export.
- **Incremental indexing**: the semantic index rebuilds incrementally
  from per-note content hashes, so normal editing requires no manual
  intervention. If you bulk-relocate or rename many files, call
  `build_index` with `force: true` to rebuild from scratch.
- **Bulk disk changes while the server is running**: the in-memory
  wikilink resolver is a process-lifetime index; restart the server to
  pick up sweeping filesystem reorganizations immediately instead of
  waiting for the watcher to catch up.

## Opt-in embedders (v0.2 preview)

The `FOAM_EMBEDDER` variable is wired into the config today, but only
`transformers` (local, via `@huggingface/transformers`) is a supported
value in v0.1. Setting `FOAM_EMBEDDER=ollama`, `openai`, or `bedrock`
produces a clear fatal startup error; these provider slots are reserved
for v0.2 per PLAN Locked Decision #10 (amended) and #26. The factory
interface in `src/semantic/embedder/` is shaped to accept additional
providers without changes to the tool or server layers.

## Known limitations

- Graph persistence is v0.2. v0.1 rebuilds the graph on every boot;
  that is fast enough for the 5000-note perf ceiling but adds startup
  cost on large vaults.
- The watcher dispatches graph and semantic updates serially; v0.2
  parallelizes them.
- The `resolve_wikilink` vault index is process-lifetime; restart after
  large out-of-band disk changes to see a fresh resolution set
  immediately.
- Very large frontmatter payloads bloat the `foam://graph` resource;
  use the six graph tools for targeted queries when the cap trips.

## Development

See [`docs/PLAN.md`](./docs/PLAN.md) for the authoritative development
plan, tool inventory, architecture notes, and wave-by-wave checklist.
Additional references that will land during Wave 7:
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md),
[`docs/TOOLS.md`](./docs/TOOLS.md), and
[`docs/CONFIG.md`](./docs/CONFIG.md).

For contributors:

```bash
git clone https://github.com/fbdo/foam-notes-mcp.git
cd foam-notes-mcp
npm install
npm run quality      # lint + format:check + typecheck + duplication + unused + deps + write-boundary
npm test             # unit + integration tests
npm run test:perf    # 500-note perf budget tests
```

## Dependency policy

- Production-dep majors are blocked in Dependabot; they require a manual PR
  that cross-references `docs/PLAN.md` Locked Decisions.
- Exact-pinned packages (`@huggingface/transformers`, `sqlite-vec`,
  `remark-wiki-link`, `remark-gfm`) are ignored entirely and bumped only
  via a manual PLAN update.
- Dev-dep majors are allowed except for `@types/node` and `typescript`,
  which are pinned to the current CI Node matrix.
- PRs are grouped (vitest family, eslint family, remark family, graphology
  family, `@types/*`) to keep the queue small.
- Schedule: weekly, Monday.

## Security scanning

We use [grype](https://github.com/anchore/grype) to scan for known
vulnerabilities in our dependency tree. The scan runs in CI on every
pull request and push to `main`.

**Local usage:**

```bash
npm run quality:security
```

This runs `grype dir:. --only-fixed --fail-on high`, failing on any
HIGH or CRITICAL finding that has a fix available.

**Why CI-only (no pre-commit / pre-push hook):** grype scans take ~20s
on a warm DB and much longer on a cold one. Running them on every commit
or push would slow development noticeably and train contributors to
bypass hooks with `--no-verify`. CI is the right gate — a single
centralised scan, cached DB, consistent environment, evaluated at merge
time before anything lands on `main`.

The manual `npm run quality:security` command is available as an escape
hatch when you want to verify a dependency bump before pushing.

## License

[MIT](./LICENSE) © Fabio Oliveira
