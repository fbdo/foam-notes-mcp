import type { KnipConfig } from "knip";

/**
 * Wave C (v0.1 Wave 2): server.ts is now the real MCP entry. It imports
 * from @modelcontextprotocol/sdk/* and from tools/index.ts, which in turn
 * wires the keyword layer. Server.ts is reached transitively through the
 * smoke test in `tests/server.smoke.test.ts`, so it does not need a
 * redundant explicit `entry` line.
 *
 * Dependencies still scheduled for later waves (semantic/graph layers)
 * stay in `ignoreDependencies`.
 */
const config: KnipConfig = {
  entry: ["tests/**/*.test.ts"],
  project: ["src/**/*.ts"],
  ignoreBinaries: ["grype"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: [
    // Wired into entry points in later waves.
    "@huggingface/transformers",
    "better-sqlite3",
    "chokidar",
    "graphology",
    "graphology-components",
    "graphology-metrics",
    "graphology-shortest-path",
    "graphology-traversal",
    "micromatch",
    "sqlite-vec",
    "@types/better-sqlite3",
    "@types/micromatch",
  ],
};

export default config;
