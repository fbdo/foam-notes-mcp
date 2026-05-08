# foam-notes-mcp — Plan

> Durable plan. Progress is tracked via the checkboxes below. Check a box only when the item is _done and verified_. This file is the single source of truth for resumability across sessions.

**Repository**: https://github.com/fbdo/foam-notes-mcp  
**npm package**: `@fbdo/foam-notes-mcp`  
**License**: MIT  
**Maintainer**: @fbdo

---

## Locked Decisions

| #   | Decision                       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tool set v0.1                  | 16 tools + 1 resource (6 keyword / 6 graph / 3 semantic / 1 hybrid + `foam://graph`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | Inline `#tag` support          | Yes, merged with frontmatter `tags`, deduped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | Windows support                | Rejected at startup with clear error; `"os": ["darwin", "linux"]` in package.json                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Markdown structural parsing    | Shared `unified` + `remark-parse` + `remark-frontmatter` + `remark-wiki-link` pipeline; hardened regex only for keyword-layer hot paths (task lines, snippet extraction)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | MOC pattern                    | `VAULT_MOC_PATTERN` env, default `^(?:.*/)?00-.+-MOC\.md$`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | Keyword search backend         | ripgrep required; no JS fallback; fail fast at startup if missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7   | Perf vault                     | Synthetic, generated by `scripts/gen-synthetic-vault.ts`; 10-note fixture + 500-note (CI perf) + 5k-note (opt-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | npm publish                    | OIDC + `npm publish --provenance` via GitHub Environment `npm` + trusted publisher. No `NPM_TOKEN` secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9   | Default embedder               | `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` (local, offline-first, 384-dim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 10  | Opt-in embedders               | `FOAM_EMBEDDER=ollama\|openai\|bedrock` with provider env vars. **Deferred to v0.2.** v0.1 ships with the local `transformers` provider only; setting `FOAM_EMBEDDER` to anything other than `transformers` produces a fatal startup error with a clear message directing users to v0.1's scope. The embedder-factory interface is designed for future providers to slot in without server.ts changes.                                                                                                                                                                                                    |
| 11  | Cache location                 | `./.foam-mcp/` under project root by default; `FOAM_CACHE_DIR` to override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 12  | File watcher                   | `chokidar@^4.0.0`, 200ms debounce, ships in v0.1. Bumped from the initial `^3.6.0` pin before Wave 5 work starts (v3→v4 drops the legacy `FSWatcher` glob argument and tightens `add()` to accept an array of paths; we pass the vault root directly, so the glob-arg change is not a concern). v5 exists but removes the `fsevents` optional dep — deferred; we want fsevents on macOS.                                                                                                                                                                                                                  |
| 13  | Hybrid search                  | Ships in v0.1 (RRF + global PageRank rerank); personalized-PPR deferred to v0.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 14  | `foam://graph` MCP resource    | Ships in v0.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 15  | Vector store                   | `sqlite-vec@0.1.9` + `better-sqlite3@^12.0.0`, single `.sqlite` file. v12 is the first release with prebuilt binaries for Node 22 (our CI matrix); v11 works on Node 20 but triggers source builds on Node 22 in some environments. API shape used by us (`new Database()`, `prepare().all()`, `loadExtension()`) is unchanged across v11→v12.                                                                                                                                                                                                                                                            |
| 16  | Graph library                  | `graphology@^0.26`, `graphology-shortest-path@^2.1`, `graphology-metrics@^2.4`. `graphology-components` and `graphology-traversal` were removed during the 2026-05-01 dependency migration — never imported from `src/`, not transitive deps of the graphology packages we do use, and upstream inactive 48+ months. Re-add as direct deps if a future wave needs connected-components or BFS/DFS traversal utilities.                                                                                                                                                                                    |
| 17  | Node matrix                    | 20 + 22 on `ubuntu-latest`; one sanity job on `macos-latest` Node 22                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 18  | CI reference                   | Mirrors `SmartAgenticCalendar` with three tweaks: lighter pre-commit (lint-staged only), `tsconfig.test.json` so tests are type-checked, prettier includes markdown                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 19  | Husky                          | pre-commit = `lint-staged`; pre-push = `npm run quality && npm test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 20  | Tool schemas                   | `McpServer.registerTool` requires zod schemas (v3 or v4) or zod raw shapes; JSON Schema is regenerated on the wire by the SDK's `toJsonSchemaCompat` helper. Superseded the earlier v0.1 choice of hand-written flat JSON Schemas — adopted 2026-05-02 as part of the `Server` → `McpServer` migration. We still review the on-wire schema output for any `$ref`/`definitions` that could trip older MCP clients; verified clean on SDK `^1.29`.                                                                                                                                                          |
| 21  | Fixture path resolution in ESM | Shared `tests/helpers/fixture.ts` using `fileURLToPath(new URL('.', import.meta.url))`. No raw `__dirname`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 22  | Tool-invocation error shape    | `McpServer.registerTool` catches every throw and returns `{ isError: true, content: [...] }` at the JSON-RPC layer. We lose the pre-migration `ToolValidationError → InvalidParams` / generic → `InternalError` / unknown-tool → `MethodNotFound` / unknown-resource → `InvalidRequest` code distinctions, but gain SDK-recommended ergonomics. Tool handlers continue to throw `ToolValidationError` for validation failures (the class stays in `src/errors.ts`) — the thrown message reaches the client as flattened text content. Adopted 2026-05-02 as part of the `Server` → `McpServer` migration. |
| 23  | Read-only boundary             | Tools only read the vault. Writes permitted only under `./.foam-mcp/` (cache). Acceptance-gated via `grep`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 24  | Effort (honest)                | v0.1 ~28h; v0.2 ~18h; v0.3 ~25–40h                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 25  | Server API surface             | `McpServer` (high-level) from `@modelcontextprotocol/sdk` — adopted 2026-05-02 in preference to the low-level `Server` + `setRequestHandler` API. Future-proofs against the SDK's eventual deprecation of the low-level surface (already flagged by `eslint-plugin-sonarjs` v4). Re-evaluate if the SDK ever exposes a JSON-Schema pass-through for `registerTool` — that would simplify our zod shape layer and let us revisit Decision #20.                                                                                                                                                             |
| 26  | Wave 4A scope                  | v0.1 ships the local `transformers` embedder only. `FOAM_EMBEDDER` other than `transformers` is a fatal startup error — no silent fallback — so users know what they're getting. The embedder factory in `src/semantic/embedder/index.ts` is shaped to accept future providers without server.ts or tool-schema changes. Re-open ollama/openai/bedrock as the v0.2 Wave 4B once v0.1 ships.                                                                                                                                                                                                               |

### Explicitly out of scope for v0.1 (documented as non-features)

- Block anchors `[[note#^id]]` navigation (suffix stripped before resolution, but we do not navigate into the block)
- Section-link navigation `[[note#Heading]]` (same: stripped, not navigated)
- Foam's minimum-unique-identifier disambiguation (our resolver returns all candidates with `confidence` + `ambiguous: true`)
- `aliases:` frontmatter field (we parse `[[link\|label]]` aliases, but a separate `aliases:` array is not consumed)
- Obsidian-style `![[embed]]` transclusion (ignored)
- Write tools (planned for v0.3 or sibling `foam-notes-write-mcp`)
- Multi-vault (one server per vault; multi-vault deferred to v0.3)
- Connected components, Louvain clusters, co-cited, betweenness centrality, `related_notes` (all deferred to v0.2)
- Windows support (rejected at startup)

---

## Tool Inventory (v0.1)

### Keyword & metadata (6)

- `search_notes` — ripgrep full-text; `query`, `folder?`, `tags?`, `case_sensitive?`, `limit?`
- `find_by_frontmatter` — `field`, `value?` / `value_pattern?` / `exists?`, `folder?`, `limit?`
- `find_unchecked_tasks` — `folder?`, `filename_pattern?`, `limit?`; returns `context_heading`
- `resolve_wikilink` — `link`; strips `#heading` / `#^anchor`; directory-link fallback `[[folder]]` → `folder/index.md`
- `get_note` — `path`; returns `{title, frontmatter, headings, outgoing_links, tags, tasks, body}`
- `get_vault_stats` — `{total_notes, notes_by_folder, total_unchecked_tasks, embedder, index_status}`

### Graph (6)

- `list_backlinks` — `note`; `locations: [{line, context, alias?}]`
- `neighbors` — `note`, `depth` (1..3, default 1), `direction` (`out`\|`in`\|`both`)
- `shortest_path` — `from`, `to`, `max_hops?` (default 6); bidirectional BFS
- `orphans` — 0 in AND 0 out (against resolved edges only)
- `placeholders` — unresolved wikilink targets with `referenced_by`
- `central_notes` — `algorithm: 'pagerank'\|'degree'`, `limit?`, `folder?`

### Semantic (3)

- `semantic_search` — `query`, `limit?`, `folder?`, `tags?`, `min_score?`
- `build_index` — `{force?}`; emits MCP progress notifications
- `index_status` — `{notes, chunks, last_built_at, embedder, dims, up_to_date}`

### Hybrid (1)

- `hybrid_search` — `query`, `weights?: {sem, kw, graph}` default `{0.6, 0.2, 0.2}`, `limit?`; returns per-hit score breakdown

### Resource (1)

- `foam://graph` — full `graph.export()` JSON for external viz

---

## Architecture (v0.1)

```
src/
├── server.ts              # MCP bootstrap, McpError wrapping, progress notifications
├── config.ts              # env parsing, Windows rejection, ripgrep presence check
├── cache.ts               # ./.foam-mcp/ layout, fingerprint, atomic writes
│
├── parse/
│   ├── markdown.ts        # shared remark pipeline
│   ├── frontmatter.ts     # gray-matter fast path + matcher
│   ├── tags.ts            # inline #tag + frontmatter merge, dedupe
│   ├── wikilink.ts        # hardened regex; code/comment stripping
│   └── tasks.ts           # task regex + heading tracking via mdast
│
├── resolver.ts            # Foam-inspired resolution ladder
│
├── keyword/
│   ├── ripgrep.ts         # child_process.spawn, JSON mode, smart-case
│   └── tools.ts           # 6 keyword tools
│
├── graph/
│   ├── builder.ts         # build graphology DirectedGraph from parsed notes
│   ├── incremental.ts     # add/change/delete edge diffs
│   ├── pagerank.ts        # power iteration, precomputed at build
│   └── tools.ts           # 6 graph tools
│
├── semantic/
│   ├── chunker.ts         # heading-section + 200-tok window + 40-tok overlap
│   ├── embedder/
│   │   ├── index.ts       # provider factory
│   │   ├── transformers.ts  # default
│   │   ├── ollama.ts        # opt-in
│   │   ├── openai.ts        # opt-in
│   │   └── bedrock.ts       # opt-in (AWS SDK v3)
│   ├── store.ts           # sqlite-vec schema, upsert, KNN
│   ├── index.ts           # build/incremental/status orchestration
│   └── tools.ts           # 3 semantic tools
│
├── hybrid/
│   └── tools.ts           # hybrid_search (RRF + PageRank rerank)
│
├── watcher.ts             # chokidar, 200ms debounce
│
├── resources/
│   └── graph.ts           # foam://graph
│
└── tools/index.ts         # tool registry (hand-written JSON Schemas)
```

Layer rules (dependency-cruiser): `parse`/`resolver` are leaves → `keyword`\|`graph`\|`semantic` → `hybrid` → `tools`/`resources` → `server`. No reverse edges. `cache.ts` is the only module allowed to write outside stdout/stderr.

---

## Waves Checklist

Progress tracking. Check items only when done **and** verified. Each wave ends with a brief verification step.

### Wave 1 — Scaffold + CI (~3h)

- [x] `package.json` with locked dependency versions, `bin`, `os: [darwin, linux]`, `engines.node >=20`, scripts block mirroring SAC + `typecheck`, `prepublishOnly`
- [x] `tsconfig.json` (strict, ES2022, NodeNext, `noUncheckedIndexedAccess`, declarations)
- [x] `tsconfig.test.json` extending main, widening `include` to `tests/`
- [x] `tsconfig.eslint.json` for type-aware lint across src + tests + configs
- [x] `eslint.config.js` (flat config, ESM, typescript-eslint strict + sonarjs + prettier)
- [x] `.prettierrc` + `.prettierignore` (markdown **included**, unlike SAC)
- [x] `vitest.config.ts` with v8 coverage, 80% thresholds
- [x] `.jscpd.json` (threshold 5)
- [x] `.dependency-cruiser.cjs` with layer rules + `no-circular` + `no-orphans`
- [x] `knip.config.ts`
- [x] `.nvmrc` = 22
- [x] `.editorconfig`
- [x] `.gitignore` (includes `.foam-mcp/`, `dist/`, `node_modules/`, `coverage/`, `.DS_Store`, `*.tgz`)
- [x] `.npmignore` (ships only `dist/`, `README.md`, `LICENSE`, `package.json`)
- [x] `LICENSE` (MIT, holder `Fabio Oliveira`)
- [x] `README.md` stub (link to docs/PLAN.md; full README in Wave 7)
- [x] `.husky/pre-commit` (`npx lint-staged`)
- [x] `.husky/pre-push` (`npm run quality && npm test`)
- [x] `.github/workflows/ci.yml` (reusable via `workflow_call`; build matrix Node [20,22] ubuntu + one macos-latest Node 22 sanity; lint, format:check, test:coverage, quality:dup, quality:unused, quality:deps, quality:security)
- [x] `.github/workflows/publish.yml` (on tag `v*`; id-token:write + contents:write; version-guard; `npm publish --provenance --access public`; `gh release create --generate-notes`; Environment `npm`)
- [x] `.github/dependabot.yml` (weekly npm + github-actions)
- [x] `.github/CODEOWNERS` (@fbdo owns everything)
- [x] `.github/pull_request_template.md`
- [x] `scripts/gen-synthetic-vault.ts` (accepts `--size` and `--out`; generates 10 / 500 / 5000 notes with realistic frontmatter, wikilinks, tasks, #tags)
- [x] `scripts/inspector-smoke.sh` (runs MCP Inspector against a generated vault; asserts 16 tools + 1 resource listable)
- [x] `tests/fixtures/vault/` generated by running `gen-synthetic-vault.ts --size 10`
- [x] `tests/helpers/fixture.ts` (ESM `__dirname` replacement)
- [x] Verify: `npm ci && npm run build && npm run lint && npm run format:check && npm test` all green on an empty `src/`
- [ ] Verify: `gh workflow list` shows both workflows; commit + push to `main`; initial CI run green

### Wave 2 — Shared parsers + resolver + keyword tools (~4h)

- [ ] `src/config.ts` (env parsing, Windows rejection, ripgrep presence check, `FOAM_CACHE_DIR`, `VAULT_MOC_PATTERN`)
- [ ] `src/cache.ts` (`./.foam-mcp/` layout, fingerprint, atomic writes)
- [ ] `src/parse/markdown.ts` (shared remark pipeline)
- [ ] `src/parse/frontmatter.ts`
- [ ] `src/parse/tags.ts`
- [ ] `src/parse/wikilink.ts`
- [ ] `src/parse/tasks.ts`
- [ ] `src/resolver.ts`
- [ ] `src/keyword/ripgrep.ts`
- [ ] `src/keyword/tools.ts`
- [ ] `src/tools/index.ts` with hand-written JSON Schemas for the 6 keyword tools
- [ ] `src/server.ts` (McpError wrapping; stdio transport; tool registration)
- [ ] Unit tests for every module in `src/parse/`, `src/resolver.ts`, `src/keyword/ripgrep.ts`
- [ ] Contract tests for all 6 keyword tools (fixture-backed)
- [ ] Verify: `npm test` green; coverage ≥80% for keyword/parse layers; `npx @modelcontextprotocol/inspector` lists 6 tools and each is callable

### Wave 3 — Graph layer (~4h)

- [ ] `src/graph/builder.ts`
- [ ] `src/graph/incremental.ts`
- [ ] `src/graph/pagerank.ts`
- [ ] `src/graph/tools.ts`
- [ ] `src/resources/graph.ts` (`foam://graph`)
- [ ] Register 6 graph tools + 1 resource in `src/tools/index.ts` + `src/server.ts`
- [ ] Unit tests: PageRank vs known small graph; BFS depth + direction; placeholder promotion on note add; incremental edge diff
- [ ] Contract tests for 6 graph tools + `foam://graph` resource
- [ ] Verify: `npm test` green; graph builds from 10-note fixture in <200ms; Inspector lists 12 tools + 1 resource

### Wave 4 — Semantic layer (~6h)

- [ ] `src/semantic/chunker.ts`
- [ ] `src/semantic/embedder/index.ts` (provider factory)
- [ ] `src/semantic/embedder/transformers.ts`
- [~] `src/semantic/embedder/ollama.ts` (probe + fallback) — deferred to v0.2 per amended Decision #10
- [~] `src/semantic/embedder/openai.ts` — deferred to v0.2 per amended Decision #10
- [~] `src/semantic/embedder/bedrock.ts` — deferred to v0.2 per amended Decision #10
- [ ] `src/semantic/store.ts` (sqlite-vec schema, upsert, KNN, metadata filtering)
- [ ] `src/semantic/index.ts` (cold build + content-hash incremental + MCP progress notifications)
- [ ] `src/semantic/tools.ts`
- [ ] Register 3 semantic tools in `src/tools/index.ts` + `src/server.ts`
- [ ] Unit tests: chunker (heading split, window, overlap, title prepend, wikilink substitution); sqlite-vec store roundtrip with a deterministic tiny mock embedder; content-hash detection
- [ ] Integration test: full cold build on 10-note fixture with real Transformers.js MiniLM (downloads model once)
- [ ] Contract tests for 3 semantic tools
- [ ] Verify: `semantic_search` returns reasonable results on fixture; cache under `./.foam-mcp/` populated; `index_status` reports accurate numbers

### Wave 5 — Hybrid + file watcher (~3h)

- [ ] `src/hybrid/tools.ts` (RRF + PageRank rerank + per-hit score breakdown)
- [ ] `src/watcher.ts` (chokidar, 200ms debounce, routes events to graph+semantic incremental updaters)
- [ ] Wire watcher startup into `src/server.ts` (opt-out via env `FOAM_WATCHER=0`)
- [ ] Register `hybrid_search` in `src/tools/index.ts` + `src/server.ts`
- [ ] Unit tests: RRF fusion edge cases (one list empty, tie scores); debounce behavior
- [ ] Integration test: touch a fixture file → graph edges updated → semantic chunks re-embedded → `hybrid_search` reflects the change
- [ ] Verify: Inspector lists 16 tools + 1 resource; full fixture roundtrip passes

### Wave 6 — Perf + hardening (~4h)

- [x] `tests/perf/*.perf.test.ts`: p95 budgets on 500-note generated vault — search_notes <300ms; find_unchecked_tasks <600ms; get_vault_stats <700ms; graph <100ms; semantic <300ms; first-build <60s. Budgets for find_unchecked_tasks and get_vault_stats recalibrated 2026-05-08 for GitHub-hosted ubuntu runners after the first main-branch perf job revealed a ~2x runner-hardware delta from local Apple Silicon.
- [ ] 5k-note scaled perf scenario (opt-in, not in default CI)
- [x] CI job `perf` runs only on main branch push
- [~] Provider integration tests (skipped unless env var set): `FOAM_EMBEDDER=ollama`, `openai`, `bedrock` — deferred to v0.2 per amended Decision #10 + Decision #26
- [ ] MCP Inspector smoke test as a CI step (`scripts/inspector-smoke.sh`)
- [x] Grep-based acceptance check: no `fs.writeFile` / `fs.rm` in `src/` outside `src/cache.ts`
- [x] Windows-rejection unit test (mock `process.platform`)
- [x] Code-reviewer pass
- [x] Security-reviewer pass
- [x] Fix any blockers surfaced
- [ ] Verify: all CI jobs green on a PR; perf budgets met

### Wave 7 — Release (~1–2h)

- [x] Full `README.md`: install, config env vars, all 16 tools + resource documented with examples, MCP client setup snippets (Kiro, Claude Desktop, Cursor), tuning guide, trust boundary doc, how to use Ollama/OpenAI/Bedrock
- [x] `CHANGELOG.md` with v0.1.0 notes
- [x] `docs/ARCHITECTURE.md` (layered diagram + invariants)
- [x] `docs/TOOLS.md` (per-tool contract reference, input/output schemas, examples)
- [x] `docs/CONFIG.md` (env var reference)
- [x] User: create npm package placeholder `foam-notes-mcp` — superseded 2026-05-08: pivoted to scoped `@fbdo/foam-notes-mcp`; scoped packages claim the name on first publish via trusted publisher, no placeholder required.
- [x] User: configure npm trusted-publisher for `fbdo/foam-notes-mcp` workflow `publish.yml` environment `npm`
- [x] User: create GitHub Environment `npm` with required-reviewer if desired
- [x] Bump `package.json` version to `0.1.0` — bumped to `0.1.1` on 2026-05-08 after the unscoped-publish pivot.
- [ ] Tag `v0.1.0` and push; publish workflow runs; release created; npm package live
- [ ] Verify: `npm view @fbdo/foam-notes-mcp@0.1.1` shows correct metadata; `npx -y @fbdo/foam-notes-mcp` works on a clean machine

---

## v0.2 (planned)

- [ ] `related_notes` tool
- [ ] `co_cited` tool
- [ ] `cluster_notes` tool (Louvain)
- [ ] `connected_component` tool
- [ ] `hybrid_search_seeded` (personalized PageRank)
- [ ] Query-embedding LRU cache
- [ ] Betweenness centrality opt-in
- [ ] `foam://note/{path}` MCP resource
- [ ] Prompts: `summarize_folder`, `daily_briefing`
- [ ] GEXF export via `graphology-gexf`
- [ ] Ollama batch embedding
- [ ] Recursive-character-splitter fallback for notes without headings
- [ ] `switch_embedder` tool with safe incremental re-embed
- [ ] CodeQL workflow
- [ ] `npm audit --audit-level=high` CI step
- [ ] Changesets-based release automation

## v0.3 (planned)

- [ ] LanceDB vector-store adapter + `FOAM_VECTOR_STORE` switch
- [ ] Graph sharding for 100k+ node vaults
- [ ] Multi-vault (`FOAM_VAULTS` + optional `vault` input on tools)
- [ ] Neo4j/Cypher export tool
- [ ] Write tools (opt-in via `FOAM_WRITE=1` or sibling `foam-notes-write-mcp` package) — decision at v0.3 kickoff
- [ ] Cross-encoder reranker (opt-in)
- [ ] Telemetry opt-in (local jsonl)
- [ ] Web-UI companion (separate repo; tracked here as a link)

---

## Progress Log

Append a short entry per wave when it completes. Keep it dense.

- YYYY-MM-DD Wave N: one-line summary of what landed + next action.
- 2026-04-27 Wave 1: scaffold + CI workflows + fixture generator landed; `npm install/build/typecheck/lint/format:check/test/quality` all green locally; `npm run gen:vault --size 10` produces the 11-file canonical fixture; git repo initialized with remote `origin` (not pushed); `grype` initially surfaced transitive Go-stdlib findings against `esbuild@0.21.5` (bundled by vite 5, via vitest 1.x), resolved in commit `a3257bc` by upgrading `vitest` + `@vitest/coverage-v8` to v3.2.4 which pulls in vite 6 + esbuild 0.25+ with fresh Go stdlib; remaining Wave 1 item (`gh workflow list` + initial CI run green) is deferred to the user's first push; next action: Wave 2 (parsers + resolver + keyword tools).
- 2026-05-02 Dependency migration sweep: bumped chokidar 3→4, better-sqlite3 11→12, zod 3→4. All three were declared but unimported; bumped now to enter Waves 4/5 on fresh versions. Zod 3.x line is EOL as of ~10 months ago. MCP SDK 1.29 peer range `^3.25 || ^4.0` accepts v4.
- 2026-05-02 MCP SDK migration prep: amended Locked Decisions #20 (tool schemas) and #22 (error shape), added #25 (Server API surface). Schema + server code changes to follow in separate commits. Rationale: align with SDK's recommended high-level API before v0.1 ships; accepts loss of JSON-RPC error-code granularity documented in #22 and accepts zod as the authoring layer with JSON Schema regenerated on the wire per #20.
- 2026-05-03 Wave 4 scope: amended Decision #10 to defer the three opt-in embedders (ollama/openai/bedrock) to v0.2. Added Decision #26 formalizing Wave 4A (local `transformers` only, fatal error on unknown `FOAM_EMBEDDER`). v0.1 embedder scope: single provider, stable interface, 384-dim MiniLM-L6-v2. Wave 4A implementation begins next commit.
- 2026-05-04 Wave 3 review M3 addressed: foam://graph resource now enforces FOAM_GRAPH_MAX_NODES (default 5000) and FOAM_GRAPH_MAX_BYTES (default 10 MiB). GraphResourceTooLargeError is thrown on overflow and mapped to McpError(InvalidRequest) at the server boundary. Error messages point clients to the 6 graph tools for targeted queries. No new Locked Decision — implementation detail.
- 2026-05-05 Wave 6 hardening: added scripts/check-write-boundary.sh (runs in the `quality` composite, wired as `quality:write-boundary`). Covers fs.writeFile/writeFileSync/appendFile/appendFileSync/mkdir/mkdirSync/rename/renameSync/unlink/unlinkSync/rm/rmSync — broader than PLAN's narrow grep (writeFile/rm only) to match Decision #23's full invariant. Allowlist: src/cache.ts + src/semantic/store.ts. Windows-rejection unit test already present in tests/config.test.ts (mutates `process.platform` via `Object.defineProperty` with restore in cleanup); verified it asserts on /does not support Windows/. Noted: server.ts calls `mkdirSync` (named import) to create the semantic cache subdirs; the spec's regex is prefix-anchored (`(fs|fsp|promises)\.…`) so it doesn't flag named-import calls. Both the check and the narrower PLAN intent are satisfied; tightening the regex to catch bare named imports would require either moving those calls into cache.ts or adding server.ts to the allowlist — deferred, flagged for Wave 6 review.
- 2026-05-07 Wave 6 code-quality cleanups: three release-prep fixes from the code review. (M4) `src/semantic/chunker.ts::substituteWikilinks` now falls through to `resolveDirectoryLink` when the main resolver ladder returns zero candidates — mirrors `src/graph/builder.ts::resolveLinkTarget`. `ChunkOptions.vaultPath` added (optional) to thread the vault root through; `src/semantic/index.ts` was left untouched this commit (per task constraints), so production embeddings don't yet pass `vaultPath` — follow-up required to wire it in. (M1) `src/graph/store.ts` + `tests/graph/store.test.ts` deleted: the module's exports (saveGraph/loadGraph/computeVaultFingerprint/saveFingerprint/loadFingerprint) were never consumed by `server.ts::main()` — the graph is rebuilt from disk on every boot via `buildGraph()`. Cached graph persistence is now explicitly a v0.2 backlog item. Architecture diagram updated; Wave 3 checkbox removed. (L3) `DEFAULT_GRAPH_MAX_NODES` / `DEFAULT_GRAPH_MAX_BYTES` promoted to exports of `src/config.ts`; `src/server.ts` now imports them instead of duplicating with a "Must match config.ts" comment.
- 2026-05-08 Wave 7 documentation sweep: README.md (f11070e, 324 lines), docs/ARCHITECTURE.md (3d8c522, 366 lines), docs/TOOLS.md (47617ba, 1192 lines), docs/CONFIG.md (5a55211, 388 lines) shipped. CHANGELOG.md added in this commit with Keep-a-Changelog format, v0.1.0 scope documented (16 tools + foam://graph, semantic via MiniLM + sqlite-vec, watcher, hybrid RRF+PageRank rerank, perf budgets, security hardening). PLAN checkboxes for Wave 1/6/7 items ticked where shipped; the "MCP Inspector smoke test as a CI step" box stays open (script + `npm run smoke:inspector` exist, but neither `.github/workflows/ci.yml` nor `publish.yml` invokes it — deferred). "All CI jobs green on a PR" and Wave 1's "initial CI run green" also stay open, pending the user's push to main. Next: commit 6 bumps package.json to 0.1.0 + adds publishConfig; then tag v0.1.0 + push triggers the OIDC-provenanced npm publish (PLAN Decision #8).
- 2026-05-08 Perf budget calibration: first main-branch CI perf run showed find_unchecked_tasks=454ms, get_vault_stats=580ms p95 on GitHub-hosted ubuntu runners vs ~240ms local on Apple Silicon. Parse is CPU-bound and single-threaded; parallelization + ripgrep pre-filter (commits d0e9320, 92dbb57) close most of the I/O gap but can't close the runner-hardware gap. Budgets relaxed to 600ms (find_unchecked_tasks) and 700ms (get_vault_stats) with headroom; search_notes, graph, and semantic budgets unchanged. A 2-3x regression would still trip the gate — the perf harness continues to catch real regressions.
- 2026-05-08 Release pivot: published as scoped `@fbdo/foam-notes-mcp` instead of unscoped `foam-notes-mcp`. The v0.1.0 tag attempted an unscoped publish and hit npm 404 (package did not exist). Scoped packages under an owned scope can claim the name on first publish via trusted publisher (same pattern as `@fbdo/smart-agentic-calendar`). Package.json renamed + bumped to 0.1.1; README + CONFIG + CHANGELOG updated. v0.1.0 tag on origin is preserved as a historical marker; CHANGELOG notes it never published to npm.
