/**
 * SDK-agnostic core of the `foam://graph` MCP resource.
 *
 * PLAN Locked Decision #14: v0.1 ships the full `graph.export()` JSON so
 * external tools (viz libraries, notebook cells, etc.) can re-hydrate the
 * graph without calling any of the graph-layer tools.
 *
 * This module intentionally knows nothing about the MCP SDK. Wave 3D
 * (`src/server.ts`) is responsible for adapting the descriptors returned
 * here into the concrete `ListResourcesResult` / `ReadResourceResult`
 * shapes the SDK expects. Keeping the SDK out of this file lets the unit
 * tests exercise the resource without spinning up a transport.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from: `graph/builder.ts` (types only), `graphology` types,
 *     `errors.ts`, node built-ins.
 *   - MUST NOT import from: `keyword/`, `semantic/`, `hybrid/`, `tools/`,
 *     `server.ts`, or the MCP SDK.
 *   - MUST NOT perform filesystem I/O — the graph is passed in via context.
 */

import type { DirectedGraph } from "graphology";

import { GraphResourceTooLargeError } from "../errors.js";
import type { EdgeAttrs, GraphNodeAttrs } from "../graph/builder.js";

/** Canonical URI for the graph resource. */
export const GRAPH_RESOURCE_URI = "foam://graph" as const;

/**
 * Static metadata for the `foam://graph` resource, as returned by
 * `resources/list`. Kept as a plain object (not a factory) so tests and
 * future server wiring can reference it directly.
 */
export interface GraphResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: "application/json";
}

export const GRAPH_RESOURCE: GraphResourceDescriptor = {
  uri: GRAPH_RESOURCE_URI,
  name: "Foam graph",
  description:
    "Full graph export as JSON (nodes, edges, attributes). Produced via graphology's " +
    "graph.export() and wrapped with node/edge counts for external visualization tools.",
  mimeType: "application/json",
};

/**
 * Result of reading the resource. Mirrors the MCP `ReadResourceResult`
 * content entry shape (`{ uri, mimeType, text }`) but without importing
 * the SDK: Wave 3D will wrap this value in `{ contents: [result] }`.
 */
export interface GraphResourceContents {
  readonly uri: string;
  readonly mimeType: "application/json";
  readonly text: string;
}

/**
 * Context required to read the resource. The server builds the graph once
 * at startup (Wave 3D) and passes the same reference into every read.
 */
export interface GraphResourceContext {
  readonly graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
}

/**
 * Envelope wrapping the serialized graph. We version the envelope from
 * day 1 so future waves can evolve the shape without breaking existing
 * consumers. `nodeCount` and `edgeCount` are convenience fields for
 * consumers that only want a quick sanity check without parsing the full
 * `graph` payload.
 */
interface GraphResourcePayload {
  readonly version: 1;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly graph: ReturnType<DirectedGraph<GraphNodeAttrs, EdgeAttrs>["export"]>;
}

/**
 * Size caps applied before serialization is returned to MCP clients.
 *
 * - `maxNodes`: rejects graphs with `graph.order` strictly greater than
 *   this value. Checked *before* serialization so that a pathological
 *   5000-note vault doesn't pay the `graph.export()` + `JSON.stringify`
 *   cost just to find out the result is over the limit.
 * - `maxBytes`: rejects serialized payloads whose UTF-8 byte length is
 *   strictly greater than this value. Checked *after* serialization
 *   since the exact byte count is only knowable once the string exists.
 *
 * Both caps are configured via `FOAM_GRAPH_MAX_NODES` /
 * `FOAM_GRAPH_MAX_BYTES` env vars in `src/config.ts`; the server layer
 * threads them through on every `resources/read` call. The boundary is
 * strictly greater than: `actual == limit` is allowed, `actual > limit`
 * throws. This matches the natural reading of "max = N" as "up to and
 * including N".
 */
export interface ReadGraphResourceOptions {
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/**
 * Read the `foam://graph` resource. Returns a compact JSON string (no
 * pretty-printing) suitable for machine consumption.
 *
 * Throws {@link GraphResourceTooLargeError} if either size cap in
 * `options` is exceeded. The server layer translates the error into
 * `McpError(InvalidRequest, ...)`; the human-readable `message` names
 * the specific env var and points clients to the six graph tools
 * (`list_backlinks`, `neighbors`, `shortest_path`, `central_notes`,
 * `orphans`, `placeholders`) as targeted alternatives.
 */
export const readGraphResource = async (
  ctx: GraphResourceContext,
  options: ReadGraphResourceOptions,
): Promise<GraphResourceContents> => {
  const nodeCount = ctx.graph.order;
  if (nodeCount > options.maxNodes) {
    throw new GraphResourceTooLargeError(
      `Graph has ${String(nodeCount)} nodes, exceeds FOAM_GRAPH_MAX_NODES=${String(options.maxNodes)}. ` +
        `Use the graph tools (list_backlinks, neighbors, shortest_path, central_notes, orphans, placeholders) for targeted queries.`,
      "nodes",
      nodeCount,
      options.maxNodes,
    );
  }

  const payload: GraphResourcePayload = {
    version: 1,
    nodeCount,
    edgeCount: ctx.graph.size,
    graph: ctx.graph.export(),
  };
  const text = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > options.maxBytes) {
    throw new GraphResourceTooLargeError(
      `Graph serialized to ${String(byteLength)} bytes, exceeds FOAM_GRAPH_MAX_BYTES=${String(options.maxBytes)}. ` +
        `Increase the limit or use graph tools for targeted queries.`,
      "bytes",
      byteLength,
      options.maxBytes,
    );
  }

  return {
    uri: GRAPH_RESOURCE_URI,
    mimeType: "application/json",
    text,
  };
};

/**
 * List the resources exposed by this module. Returned as a function (not a
 * constant) so the server.ts handler (Wave 3D) can treat this as a uniform
 * provider interface alongside other resource-list providers added in
 * future waves.
 */
export const listGraphResources = async (): Promise<GraphResourceDescriptor[]> => {
  return [GRAPH_RESOURCE];
};
