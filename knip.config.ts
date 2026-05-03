import type { KnipConfig } from "knip";

/**
 * Wave C (v0.1 Wave 2): server.ts is the real MCP entry. It imports from
 * @modelcontextprotocol/sdk/*, from tools/index.ts (which wires both the
 * keyword and graph layers), and from resources/graph.ts. Server.ts is
 * reached transitively through the smoke test in
 * `tests/server.smoke.test.ts`, so it does not need a redundant explicit
 * `entry` line.
 *
 * Wave 3D: graph-layer deps reached via
 *   server.ts → tools/index.ts → graph/tools.ts
 * are `graphology`, `graphology-shortest-path`, and `graphology-metrics`
 * (via graph/pagerank.ts). They are no longer ignored.
 *
 * Wave 4A commit 2: semantic-layer deps `better-sqlite3` + `sqlite-vec`
 * are now imported from `src/semantic/store.ts`, which is reached via
 * `tests/semantic/store.test.ts` as an entry. The type-only
 * `@types/better-sqlite3` is resolved through the runtime import as well.
 *
 * `graphology-components` and `graphology-traversal` remain declared
 * dependencies for anticipated future-wave usage but are not yet imported,
 * so they stay in `ignoreDependencies` to keep knip clean. Remove from
 * this list once they are wired into a source file.
 *
 * Dependencies still scheduled for later waves (embedder, watcher) remain
 * in `ignoreDependencies`.
 */
const config: KnipConfig = {
  entry: ["tests/**/*.test.ts"],
  project: ["src/**/*.ts"],
  ignoreBinaries: ["grype"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: [
    // Wired into entry points in later waves.
    "@huggingface/transformers",
    "chokidar",
    "micromatch",
    "@types/micromatch",
  ],
};

export default config;
