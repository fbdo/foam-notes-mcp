/**
 * Graph persistence: save/load the built graph to/from the cache directory
 * and compute a vault fingerprint used by the server to decide between
 * rebuild vs. cached-load on startup.
 *
 * Layout (under `<cacheDir>/graph/`):
 *   graph.json         — `graph.export()` serialized JSON
 *   fingerprint.txt    — SHA-256 of the vault's `.md` file list
 *
 * Layer rules: graph/* may import `cache.ts` but must not import from any
 * sibling feature layer or the MCP SDK.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import fg from "fast-glob";
import { DirectedGraph } from "graphology";

import { atomicWrite, readCacheIfExists } from "../cache.js";
import type { EdgeAttrs, GraphNodeAttrs } from "./builder.js";

const GRAPH_SUBDIR = "graph";
const GRAPH_FILE = "graph.json";
const FINGERPRINT_FILE = "fingerprint.txt";

const graphJsonPath = (cacheDir: string): string => join(cacheDir, GRAPH_SUBDIR, GRAPH_FILE);
const fingerprintPath = (cacheDir: string): string =>
  join(cacheDir, GRAPH_SUBDIR, FINGERPRINT_FILE);

/**
 * Serialize the graph via `graph.export()` and atomically write it to
 * `<cacheDir>/graph/graph.json`. Parent directories are created on demand by
 * `atomicWrite`.
 */
export const saveGraph = async (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  cacheDir: string,
): Promise<void> => {
  const serialized = graph.export();
  const json = JSON.stringify(serialized);
  atomicWrite(graphJsonPath(cacheDir), json);
  // The function is async by contract (server callers `await` it); keep the
  // shape consistent with `loadGraph` and future async-aware implementations.
  return Promise.resolve();
};

/**
 * Read and rebuild a previously-saved graph. Returns `null` when the graph
 * file is absent, so callers can treat "first boot" as a distinct state.
 */
export const loadGraph = async (
  cacheDir: string,
): Promise<DirectedGraph<GraphNodeAttrs, EdgeAttrs> | null> => {
  const raw = readCacheIfExists(graphJsonPath(cacheDir));
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw) as unknown;
  const graph = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();
  // `graphology`'s `import` accepts the shape produced by `export()`; cast
  // is justified because we just serialized it ourselves.
  graph.import(parsed as Parameters<typeof graph.import>[0]);
  return Promise.resolve(graph);
};

/**
 * Compute a deterministic fingerprint of the vault's markdown file set.
 *
 * The fingerprint changes whenever any file's `path`, `mtimeMs`, or `size`
 * changes; that's stricter than content hashing but dramatically cheaper and
 * sufficient for the "is the cache still valid?" decision.
 */
export const computeVaultFingerprint = async (vaultPath: string): Promise<string> => {
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const normalized = files.map((f) => resolvePath(f)).sort();
  const rows: string[] = [];
  for (const f of normalized) {
    const st = await stat(f);
    rows.push(`${f}:${st.mtimeMs.toString()}:${st.size.toString()}`);
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
};

/** Atomically persist the fingerprint string alongside `graph.json`. */
export const saveFingerprint = async (fingerprint: string, cacheDir: string): Promise<void> => {
  atomicWrite(fingerprintPath(cacheDir), fingerprint);
  return Promise.resolve();
};

/** Read the cached fingerprint, or `null` when absent. */
export const loadFingerprint = async (cacheDir: string): Promise<string | null> => {
  const raw = readCacheIfExists(fingerprintPath(cacheDir));
  return Promise.resolve(raw === undefined ? null : raw);
};
