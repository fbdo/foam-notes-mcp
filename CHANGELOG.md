# Changelog

All notable changes to `foam-notes-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 API note: the MCP tool surface, env-var names, and on-wire schemas
may change between `0.x` versions. v0.1 is an initial release aimed at
producing feedback; see `docs/PLAN.md` for the roadmap to v0.2 and v0.3.

## [Unreleased]

None. Next release is v0.1.0 below.

## [0.1.0] - 2026-05-08

### Added

- MCP server with 16 tools + 1 resource (`foam://graph`).
  - Keyword (6): `search_notes`, `find_by_frontmatter`, `find_unchecked_tasks`, `resolve_wikilink`, `get_note`, `get_vault_stats`.
  - Graph (6): `list_backlinks`, `neighbors`, `shortest_path`, `orphans`, `placeholders`, `central_notes`.
  - Semantic (3): `semantic_search`, `build_index`, `index_status`.
  - Hybrid (1): `hybrid_search` (RRF fusion + PageRank rerank).
  - Resource: `foam://graph` (full graph export with node/byte caps).
- Local-first semantic embeddings via `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (384 dims, L2-normalized).
- sqlite-vec KNN store (`better-sqlite3 ^12`) with content-hash incremental updates.
- Live file watcher via `chokidar ^4` with 200ms debounce; opt-out via `FOAM_WATCHER=0`.
- ripgrep pre-filter for `find_unchecked_tasks` (parallelized + parse-set reduction).
- Parallelized file reads for `get_vault_stats`.
- macOS + Linux support; Windows rejected at startup per PLAN Decision #3.
- `FOAM_*` environment-variable configuration (see [`docs/CONFIG.md`](./docs/CONFIG.md)).
- Size caps on `foam://graph` resource (`FOAM_GRAPH_MAX_NODES`, `FOAM_GRAPH_MAX_BYTES`).
- Write-boundary audit (`scripts/check-write-boundary.sh`) wired as a `quality:write-boundary` gate.
- MCP Inspector smoke test harness (`scripts/inspector-smoke.sh`, `npm run smoke:inspector`) for local pre-release verification.
- Perf harness with p95 budgets on a 500-note synthetic vault (keyword <300ms, graph <100ms, semantic <300ms, first-build <60s).
- Opt-in 5k-note perf scenario (`FOAM_PERF_5K=1`).
- CI perf job gated to main-branch push.
- Full v0.1 documentation: `README.md`, `docs/ARCHITECTURE.md`, `docs/TOOLS.md`, `docs/CONFIG.md`.

### Security

- Symlink-aware `isInsideVaultAsync` (realpath check) at every user-path entry point.
- Vault + cache overlap check at startup (prevents watcher livelock).
- Canonicalized `FOAM_VAULT_PATH` via realpath at load.
- Shutdown deadline (5s) with double-SIGINT force-exit.
- `pathGlob` validation in `find_unchecked_tasks` (rejects absolute paths and `..` segments).
- Grype CVE scanning in CI (`quality:security`).
- Flat, hand-mapped zod → JSON Schema tool inputs (no `$ref`/`$defs`/`definitions` on the wire; regression-tested).

### Deferred to v0.2

- Opt-in embedders (`ollama`, `openai`, `bedrock`). Reserved in `FOAM_EMBEDDER`; fatal error if set today.
- Cached graph persistence (graph rebuilt from disk on every boot).
- Parallel watcher dispatch (currently graph → semantic serial).
- Keyword vault-index cache invalidation on file change.
- Provider integration test suite (network-gated).
- Personalized PageRank for hybrid rerank.

[Unreleased]: https://github.com/fbdo/foam-notes-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fbdo/foam-notes-mcp/releases/tag/v0.1.0
