/**
 * Thin wrapper around `graphology-metrics/centrality/pagerank`.
 *
 * Import path (verified against `graphology-metrics@2.4.0`'s `files`
 * manifest): `graphology-metrics/centrality/pagerank` exports a default
 * function implementing classical PageRank via `WeightedNeighborhoodIndex`.
 *
 * We expose a Map-keyed API (rather than the object map the library returns)
 * so downstream consumers can rely on insertion order and the standard Map
 * interface.
 *
 * Layer rules: graph/* may import npm deps but must not import from sibling
 * feature layers or the MCP SDK.
 */

import { pagerank } from "graphology-metrics/centrality/index.js";
import type { DirectedGraph } from "graphology";

import type { EdgeAttrs, GraphNodeAttrs } from "./builder.js";

export interface PageRankOptions {
  readonly alpha?: number;
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

const DEFAULT_ALPHA = 0.85;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Run PageRank on the provided graph and return a `Map<nodeId, score>`.
 *
 * Scores are normalized to sum to ≈ 1 (standard convention). Edge weights
 * are ignored — the builder does not set a `weight` attribute on edges, so
 * we tell the plugin to use unit weights via `getEdgeWeight: null`.
 *
 * Degradation policy:
 *   - Empty graph (order 0): returns an empty map without invoking the
 *     upstream algorithm, which would otherwise divide by zero and throw.
 *   - Non-convergent graphs: the upstream plugin throws
 *     "failed to converge" after `maxIterations`. We catch that exact
 *     failure mode, log a single line to `stderr`, and return an empty
 *     map. Callers treat an empty map as "no centrality data" rather than
 *     an error — consistent with the tools layer's existing empty-result
 *     handling.
 */
export const computePageRank = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  options?: PageRankOptions,
): Map<string, number> => {
  if (graph.order === 0) return new Map();
  let mapping: Record<string, number>;
  try {
    mapping = pagerank(graph, {
      alpha: options?.alpha ?? DEFAULT_ALPHA,
      tolerance: options?.tolerance ?? DEFAULT_TOLERANCE,
      maxIterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      // Unit weights: the builder doesn't assign `weight` edge attributes.
      getEdgeWeight: null,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("failed to converge")) {
      console.error(
        `[pagerank] failed to converge on graph of ${String(graph.order)} nodes; returning empty scores`,
      );
      return new Map();
    }
    throw err;
  }
  const out = new Map<string, number>();
  for (const node of Object.keys(mapping)) {
    const score = mapping[node];
    if (score !== undefined) out.set(node, score);
  }
  return out;
};
