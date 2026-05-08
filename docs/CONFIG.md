# Configuration

All runtime configuration for foam-notes-mcp is provided via environment
variables. This document is the authoritative reference; behavior is
defined by [`src/config.ts`](../src/config.ts).

- User intro: see [README.md](../README.md).
- Architecture: see [ARCHITECTURE.md](./ARCHITECTURE.md).
- Tool contracts: see [TOOLS.md](./TOOLS.md).
- Development plan + Locked Decisions: see [PLAN.md](./PLAN.md).

## Table of contents

- [Quick reference](#quick-reference)
- [Path config](#path-config)
  - [FOAM_VAULT_PATH](#foam_vault_path)
  - [FOAM_CACHE_DIR](#foam_cache_dir)
- [Feature toggles](#feature-toggles)
  - [FOAM_WATCHER](#foam_watcher)
  - [FOAM_EMBEDDER](#foam_embedder)
- [Vault conventions](#vault-conventions)
  - [VAULT_MOC_PATTERN](#vault_moc_pattern)
- [Resource caps](#resource-caps)
  - [FOAM_GRAPH_MAX_NODES](#foam_graph_max_nodes)
  - [FOAM_GRAPH_MAX_BYTES](#foam_graph_max_bytes)
- [Platform requirements](#platform-requirements)
- [Test-only environment variables](#test-only-environment-variables)
- [Validation + error messages](#validation--error-messages)
- [Configuration examples](#configuration-examples)
- [See also](#see-also)

## Quick reference

| Env var                | Required | Default             | Purpose                                             |
| ---------------------- | -------- | ------------------- | --------------------------------------------------- |
| `FOAM_VAULT_PATH`      | yes      | —                   | Absolute or cwd-relative path to the markdown vault |
| `FOAM_CACHE_DIR`       | no       | `./.foam-mcp/`      | Cache location (semantic index, model downloads)    |
| `VAULT_MOC_PATTERN`    | no       | `*-MOC.md`          | Micromatch-style glob identifying Maps of Content   |
| `FOAM_EMBEDDER`        | no       | `transformers`      | Embedder provider (v0.1: `transformers` only)       |
| `FOAM_WATCHER`         | no       | `1`                 | File-watcher toggle (`0`/`false`/`no` disables)     |
| `FOAM_GRAPH_MAX_NODES` | no       | `5000`              | Cap for `foam://graph` node count                   |
| `FOAM_GRAPH_MAX_BYTES` | no       | `10485760` (10 MiB) | Cap for `foam://graph` serialized JSON payload size |

All numeric variables must be decimal integers `>= 1`. Floats, hex,
exponents, leading signs, and `0` are rejected so typos surface at
startup rather than as silent coercions.

---

## Path config

### FOAM_VAULT_PATH

**Required.** Path to the vault directory to serve.

- **Type**: string (filesystem path)
- **Default**: none; startup fails if unset, empty, or whitespace-only.
- **Resolution**: absolute, or resolved against `process.cwd()` if
  relative. Canonicalized via `fs.realpathSync` at load — symlinked
  vault roots are followed to their target, and the canonical path is
  what all downstream code sees (M2 hardening, Wave 6).
- **Validation**:
  - Must exist (otherwise: `FOAM_VAULT_PATH does not exist or is not accessible: <path> (<reason>)`).
  - Must be a directory (otherwise: `FOAM_VAULT_PATH is not a directory: <path>`).
- **Security**: all user-supplied paths are validated to fall inside
  the canonicalized vault via `isInsideVaultAsync` in
  [`src/path-util.ts`](../src/path-util.ts).

**Example:**

```bash
export FOAM_VAULT_PATH=/Users/you/notes
```

### FOAM_CACHE_DIR

**Optional.** Where foam-notes-mcp writes cache artifacts (semantic
index, model downloads, reserved subdirectories).

- **Type**: string (filesystem path)
- **Default**: `./.foam-mcp/` (resolved against `process.cwd()`)
- **Created on demand** — the server creates it if missing, via
  `cache.ts`'s helpers.
- **Constraint**: must NOT overlap `FOAM_VAULT_PATH` in either
  direction. Checked at startup after both paths are resolved. Cache
  inside the vault would livelock the file watcher on cache writes and
  surface cache files as notes; vault inside the cache would let vault
  writes clobber cache state. Both are config footguns — fail fast.
  See PLAN Decision #11.
- **Layout** (reserved subdirectories; only `semantic/` is populated in v0.1):
  ```
  <FOAM_CACHE_DIR>/
    keyword/              # reserved (keyword-layer cache, v0.2)
    graph/                # reserved (graph persistence, v0.2)
    meta/                 # reserved
    semantic/
      index.sqlite        # sqlite-vec DB: chunks, vectors, fingerprints, meta
      models/             # @huggingface/transformers model download cache
  ```
- **Writes**: only `src/cache.ts` and `src/semantic/store.ts` may write
  anywhere on disk. Enforced by `scripts/check-write-boundary.sh` in
  the `npm run quality` composite. See PLAN Decision #23.

**Example:**

```bash
export FOAM_CACHE_DIR=/Users/you/.cache/foam-notes
```

---

## Feature toggles

### FOAM_WATCHER

**Optional.** Live file-watching. Default on. See PLAN Decision #12.

- **Type**: bool-like string
- **Default**: `1` (enabled) when unset, empty, or whitespace-only.
- **Accepted values** (case-insensitive):
  - Enable: `1`, `true`, `yes`
  - Disable: `0`, `false`, `no`
  - Any other value is a fatal startup error (no silent fallback).
- **Behavior**: when enabled, chokidar watches the vault. Add / modify /
  delete events dispatch to graph and semantic incremental updaters
  after a 200 ms debounce window (last-event-wins per path). See
  [ARCHITECTURE.md](./ARCHITECTURE.md).
- **When to disable**: bulk-editing sessions where you want to call
  `build_index` manually once changes settle, or environments where fs
  events are unreliable (some FUSE filesystems, some network mounts).

**Example:**

```bash
export FOAM_WATCHER=0
```

### FOAM_EMBEDDER

**Optional.** Which embedder provider to use for semantic tools. See
PLAN Decisions #9, #10, #26.

- **Type**: enum string
- **Default**: `transformers`
- **Accepted values in v0.1**: `transformers` only (local, via
  `@huggingface/transformers`, model `Xenova/all-MiniLM-L6-v2`,
  384 dims).
- **Deferred to v0.2**: `ollama`, `openai`, `bedrock`. Setting any
  value other than `transformers` is a fatal startup error — the server
  refuses to boot rather than silently falling back (Decision #26).
- **Behavior**: the embedder factory in
  [`src/semantic/embedder/index.ts`](../src/semantic/embedder/index.ts)
  dispatches by this value.

**Example:**

```bash
export FOAM_EMBEDDER=transformers
```

Setting `FOAM_EMBEDDER=ollama` today fails with:

```
FOAM_EMBEDDER='ollama' is not supported in v0.1. Only 'transformers' is available. ollama/openai/bedrock are deferred to v0.2 per PLAN Decisions #10 (amended 2026-05-03) and #26.
```

---

## Vault conventions

### VAULT_MOC_PATTERN

**Optional.** Glob identifying Map-of-Content notes.

- **Type**: micromatch-style glob string (not a regex)
- **Default**: `*-MOC.md`
- **Matching**: evaluated against `<basename>.md` (i.e. file basename,
  not the full vault-relative path). Internally converted to a regex
  by the glob helper in [`src/path-util.ts`](../src/path-util.ts),
  which supports the subset of glob syntax used for MOC detection
  (`*`, literal segments). If you need richer glob semantics, open an
  issue — we'll revisit the helper.
- **Behavior**: note nodes whose basename matches are flagged
  `isMoc: true` in the graph. Used by `get_vault_stats` for the
  `mocCount` metric and by downstream tools that weight MOCs.

**Example:**

```bash
export VAULT_MOC_PATTERN='*-Index.md'
```

---

## Resource caps

Both caps protect the `foam://graph` resource payload — MCP stdio
responses are single shots, so a very large graph JSON can exceed
client framing or memory limits.

### FOAM_GRAPH_MAX_NODES

**Optional.** Cap on node count for the `foam://graph` resource
payload.

- **Type**: positive integer (decimal digits only, `>= 1`)
- **Default**: `5000` (the v0.1 perf ceiling)
- **Behavior**: when a client reads `foam://graph`, the server first
  counts graph nodes. If `graph.order > FOAM_GRAPH_MAX_NODES`, throws
  `GraphResourceTooLargeError` (`kind: "nodes"`), which the transport
  layer maps to `McpError(InvalidRequest, ...)`. The error message
  directs callers to the six graph tools for targeted queries.
- **Rationale**: avoids shipping a multi-megabyte JSON blob over stdio
  when a targeted graph tool would serve better.

**Example:**

```bash
export FOAM_GRAPH_MAX_NODES=10000
```

### FOAM_GRAPH_MAX_BYTES

**Optional.** Cap on serialized JSON size for the `foam://graph`
resource payload (UTF-8 bytes).

- **Type**: positive integer bytes (decimal digits only, `>= 1`)
- **Default**: `10485760` (10 MiB)
- **Behavior**: after the node-count check passes, the graph is
  serialized. If the resulting JSON exceeds `FOAM_GRAPH_MAX_BYTES`,
  throws `GraphResourceTooLargeError` (`kind: "bytes"`). Protects
  against pathological cases — dense edge payloads, or a single note
  with multi-MB frontmatter — that slip through the node-count check.
- **Check order**: node count first (cheap, pre-serialize), then byte
  size (requires `JSON.stringify`).

**Example:**

```bash
export FOAM_GRAPH_MAX_BYTES=20971520   # 20 MiB
```

See [`src/errors.ts`](../src/errors.ts) for the
`GraphResourceTooLargeError` class (carries `kind`, `actual`, and
`limit` fields for future telemetry).

---

## Platform requirements

- **Operating system**: macOS (`darwin`) or Linux. Windows is rejected
  at startup. See PLAN Decision #3.
- **Node.js**: `>= 20` (enforced by `engines.node` in `package.json`).
  CI runs Node 20 and Node 22.
- **ripgrep**: bundled via `@vscode/ripgrep`. No separate install. The
  server verifies the binary exists and is a regular file at startup,
  and fails fast with a `Reinstall dependencies` hint otherwise.
- **Disk**: ~90 MB for the MiniLM model cache (one-time download on
  first `build_index`), plus the SQLite index (scales with vault size).
- **Network**: outbound only, once, for the model download. No inbound
  listener — transport is MCP stdio.

---

## Test-only environment variables

These variables are NOT read by `src/config.ts`. They gate optional
test runs and are documented here so developers can find them alongside
production config.

- **`FOAM_SKIP_MODEL_DOWNLOAD`** — set to `true` to skip integration
  tests that require a network round-trip to `huggingface.co`. Read by:
  - `tests/semantic/embedder/integration.test.ts`
  - `tests/integration/watcher-roundtrip.test.ts`
  - `tests/perf/semantic.perf.test.ts`

  CI sets this to `false` (see `.github/workflows/ci.yml`) so the full
  integration suite runs on every PR.

- **`FOAM_PERF_5K`** — set to `1` or `true` to enable the opt-in
  5000-note perf scenarios (headroom checks above the 500-note default
  budget). Read by:
  - `tests/perf/semantic.perf.test.ts`
  - `tests/perf/graph.perf.test.ts`
  - `tests/perf/keyword.perf.test.ts`

  Wired via the `npm run test:perf:5k` script.

---

## Validation + error messages

All validation runs during `loadConfig()` at server startup. Failures
throw synchronously; the server exits with a non-zero code and the
message on stderr. Messages below are the actual text thrown by
`src/config.ts` — verified against the source.

**Validation order** (early failures stop later checks):

1. Platform check (`win32` → reject).
2. `FOAM_VAULT_PATH` parse + exists + directory + `realpath`.
3. `FOAM_CACHE_DIR` resolve, overlap-with-vault check.
4. `VAULT_MOC_PATTERN` resolve (defaulting).
5. ripgrep binary check.
6. `FOAM_EMBEDDER` enum check.
7. `FOAM_WATCHER` bool parse.
8. `FOAM_GRAPH_MAX_NODES` positive-int parse.
9. `FOAM_GRAPH_MAX_BYTES` positive-int parse.

| Condition                                     | Message                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows detected                              | `foam-notes-mcp does not support Windows. Supported platforms: darwin, linux.`                                                                                                        |
| `FOAM_VAULT_PATH` unset / empty / whitespace  | `FOAM_VAULT_PATH is required. Set it to an absolute path of your Foam/Markdown vault directory.`                                                                                      |
| `FOAM_VAULT_PATH` stat fails                  | `FOAM_VAULT_PATH does not exist or is not accessible: <path> (<reason>)`                                                                                                              |
| `FOAM_VAULT_PATH` is not a directory          | `FOAM_VAULT_PATH is not a directory: <path>`                                                                                                                                          |
| `FOAM_VAULT_PATH` realpath ENOENT             | `FOAM_VAULT_PATH does not exist: <path>`                                                                                                                                              |
| `FOAM_CACHE_DIR` overlaps `FOAM_VAULT_PATH`   | `FOAM_CACHE_DIR must not overlap FOAM_VAULT_PATH (cache=<path>, vault=<path>)`                                                                                                        |
| ripgrep binary missing                        | `ripgrep binary is missing. Reinstall dependencies:` `` `npm install @vscode/ripgrep` `` `.`                                                                                          |
| ripgrep binary not accessible                 | `ripgrep binary is not accessible at <path>: <reason>`                                                                                                                                |
| ripgrep path is not a regular file            | `ripgrep path is not a regular file: <path>`                                                                                                                                          |
| `FOAM_EMBEDDER` unsupported value             | `FOAM_EMBEDDER='<value>' is not supported in v0.1. Only 'transformers' is available. ollama/openai/bedrock are deferred to v0.2 per PLAN Decisions #10 (amended 2026-05-03) and #26.` |
| `FOAM_WATCHER` invalid value                  | `FOAM_WATCHER='<raw>' is not a valid boolean. Accepted values: 1/true/yes or 0/false/no.`                                                                                             |
| `FOAM_GRAPH_MAX_NODES` not a positive integer | `FOAM_GRAPH_MAX_NODES='<raw>' is not a valid positive integer. Accepted values: a decimal integer >= 1.`                                                                              |
| `FOAM_GRAPH_MAX_BYTES` not a positive integer | `FOAM_GRAPH_MAX_BYTES='<raw>' is not a valid positive integer. Accepted values: a decimal integer >= 1.`                                                                              |

The "positive integer" parser rejects `0`, negative values, floats
(`1.5`), hex (`0x10`), exponent notation (`1e9`), and leading signs
(`+5`, `-5`). See `parsePositiveInt` in
[`src/config.ts`](../src/config.ts).

---

## Configuration examples

### Minimal

```bash
FOAM_VAULT_PATH=/Users/you/notes npx -y @fbdo/foam-notes-mcp
```

### Explicit cache location, watcher off

```bash
FOAM_VAULT_PATH=/Users/you/notes \
FOAM_CACHE_DIR=/Users/you/.cache/foam-notes \
FOAM_WATCHER=0 \
npx -y @fbdo/foam-notes-mcp
```

### Large-vault tuning

```bash
FOAM_VAULT_PATH=/Users/you/notes \
FOAM_GRAPH_MAX_NODES=20000 \
FOAM_GRAPH_MAX_BYTES=52428800 \
npx -y @fbdo/foam-notes-mcp
```

### MCP client (Claude Desktop)

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

For additional client examples (Cursor, Kiro, other MCP-compliant
clients), see [README.md#mcp-client-setup](../README.md#mcp-client-setup).

---

## See also

- [README.md](../README.md) — user-facing overview, installation, quick start.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — internal structure, module boundaries, invariants.
- [TOOLS.md](./TOOLS.md) — per-tool input/output contracts.
- [PLAN.md](./PLAN.md) — development plan and Locked Decisions
  (#3 Windows rejection, #9 embedder architecture, #10 opt-in
  embedders, #11 cache/vault separation, #12 watcher opt-out,
  #23 read-only vault, #26 fatal unknown `FOAM_EMBEDDER`).
