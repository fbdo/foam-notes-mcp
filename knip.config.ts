import type { KnipConfig } from "knip";

/**
 * Wave 1: src/ is empty apart from a placeholder. Dependencies listed below
 * are wired into the real entry point in Wave 2+. Suppress knip's "unused"
 * noise for them here so the quality gate stays green during scaffolding.
 */
const config: KnipConfig = {
  entry: ["src/server.ts!", "src/placeholder.ts"],
  project: ["src/**/*.ts"],
  ignoreBinaries: ["grype"],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: [
    "@huggingface/transformers",
    "@modelcontextprotocol/sdk",
    "@vscode/ripgrep",
    "better-sqlite3",
    "chokidar",
    "fast-glob",
    "graphology",
    "graphology-components",
    "graphology-metrics",
    "graphology-shortest-path",
    "graphology-traversal",
    "gray-matter",
    "micromatch",
    "remark-frontmatter",
    "remark-parse",
    "sqlite-vec",
    "unified",
    "zod",
    "@types/better-sqlite3",
    "@types/micromatch",
  ],
};

export default config;
