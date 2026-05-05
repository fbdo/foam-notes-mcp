/**
 * Graph-layer p95 budgets on a 500-note generated vault (Wave 6).
 *
 * Budgets:
 *   - `list_backlinks` p95 < 100ms
 *   - `neighbors` (depth=2) p95 < 100ms
 *   - `central_notes` (pagerank) p95 < 100ms
 *   - `buildGraph` cold build: INFORMATIONAL only (PLAN's 100ms budget
 *     targets per-call tool latency, not the one-time graph construction).
 *
 * The graph is built once in `beforeAll` and reused across all tool
 * measurements — this matches production use where the graph is constructed
 * at server startup and every tool invocation shares a warm in-memory graph.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { buildGraph } from "../../src/graph/builder.js";
import {
  centralNotes,
  listBacklinks,
  neighbors,
  type GraphToolContext,
} from "../../src/graph/tools.js";

import { getOrCreateSyntheticVault, measureP95 } from "./helpers.js";

let vaultPath: string;
let ctx: GraphToolContext;

beforeAll(async () => {
  vaultPath = getOrCreateSyntheticVault(500);
  const graph = await buildGraph(vaultPath);
  ctx = { vaultPath, graph };
});

/**
 * Pick a deterministic note node from the graph to use as the target of
 * backlink / neighbors probes. We pick the first note-typed node in
 * iteration order; graphology's insertion order is stable for a given
 * build, and the synthetic generator produces the same paths on every run
 * (seed = 42), so this choice is reproducible across perf runs.
 */
const pickNotePath = (graphCtx: GraphToolContext): string => {
  const sample = graphCtx.graph.nodes().find((n) => {
    const attrs = graphCtx.graph.getNodeAttributes(n);
    return attrs.type === "note";
  });
  if (sample === undefined) throw new Error("no note nodes in graph");
  return sample;
};

describe("graph p95 budgets on 500-note vault", () => {
  it("buildGraph cold build (informational, no budget)", async () => {
    // 5 iterations (instead of the default 10) because each build reads every
    // markdown file on disk; we want a signal without paying for 50+ I/O-heavy
    // runs. The p95 is reported only — PLAN's 100ms budget targets per-call
    // tool latency, not the one-time graph construction.
    const { p95, mean, samples } = await measureP95(() => buildGraph(vaultPath), 5);
    console.error(
      `buildGraph (500-note, informational): p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`,
    );
    // Sanity: at least confirm we actually recorded samples. No budget.
    expect(samples.length).toBe(5);
  });

  it("list_backlinks p95 < 100ms", async () => {
    const samplePath = pickNotePath(ctx);
    const { p95, mean } = await measureP95(() => listBacklinks({ note: samplePath }, ctx));
    console.error(`list_backlinks: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(100);
  });

  it("neighbors depth=2 p95 < 100ms", async () => {
    const samplePath = pickNotePath(ctx);
    const { p95, mean } = await measureP95(() => neighbors({ note: samplePath, depth: 2 }, ctx));
    console.error(`neighbors depth=2: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(100);
  });

  it("central_notes (pagerank) p95 < 100ms", async () => {
    const { p95, mean } = await measureP95(() =>
      centralNotes({ algorithm: "pagerank", limit: 10 }, ctx),
    );
    console.error(`central_notes pagerank: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(100);
  });
});
