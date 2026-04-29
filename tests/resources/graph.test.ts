import { describe, it, expect, beforeAll } from "vitest";
import { DirectedGraph } from "graphology";

import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "../../src/graph/builder.js";
import {
  GRAPH_RESOURCE,
  GRAPH_RESOURCE_URI,
  listGraphResources,
  readGraphResource,
} from "../../src/resources/graph.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

let graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;

beforeAll(async () => {
  graph = await buildGraph(VAULT);
});

describe("foam://graph resource (SDK-agnostic)", () => {
  it("GRAPH_RESOURCE.uri is the canonical foam://graph URI", () => {
    expect(GRAPH_RESOURCE_URI).toBe("foam://graph");
    expect(GRAPH_RESOURCE.uri).toBe("foam://graph");
    expect(GRAPH_RESOURCE.mimeType).toBe("application/json");
    expect(GRAPH_RESOURCE.name).toBeTruthy();
    expect(GRAPH_RESOURCE.description).toBeTruthy();
  });

  it("listGraphResources() returns exactly one descriptor for foam://graph", async () => {
    const list = await listGraphResources();
    expect(list).toHaveLength(1);
    const [descriptor] = list;
    expect(descriptor).toBeDefined();
    if (descriptor !== undefined) {
      expect(descriptor.uri).toBe("foam://graph");
      expect(descriptor.mimeType).toBe("application/json");
    }
  });

  it("readGraphResource returns a JSON envelope with the correct surface shape", async () => {
    const result = await readGraphResource({ graph });
    expect(result.uri).toBe("foam://graph");
    expect(result.mimeType).toBe("application/json");
    expect(typeof result.text).toBe("string");

    // `text` is valid JSON (no pretty-printing, no control chars).
    const parsed: unknown = JSON.parse(result.text);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  it("parsed payload has the documented shape", async () => {
    const result = await readGraphResource({ graph });
    const parsed = JSON.parse(result.text) as {
      version: unknown;
      nodeCount: unknown;
      edgeCount: unknown;
      graph: { nodes: unknown; edges: unknown };
    };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.nodeCount).toBe("number");
    expect(typeof parsed.edgeCount).toBe("number");
    expect(Array.isArray(parsed.graph.nodes)).toBe(true);
    expect(Array.isArray(parsed.graph.edges)).toBe(true);
  });

  it("nodeCount equals graph.order and matches the fixture (11 notes + 1 placeholder = 12)", async () => {
    const result = await readGraphResource({ graph });
    const parsed = JSON.parse(result.text) as { nodeCount: number };
    expect(parsed.nodeCount).toBe(graph.order);
    expect(parsed.nodeCount).toBe(12);
  });

  it("edgeCount equals graph.size (using the observed fixture value, not a guess)", async () => {
    const result = await readGraphResource({ graph });
    const parsed = JSON.parse(result.text) as { edgeCount: number };
    expect(parsed.edgeCount).toBe(graph.size);
    // Sanity: the builder test pins 9 note→note edges + 1 note→placeholder edge = 10 edges.
    expect(parsed.edgeCount).toBe(10);
  });

  it("payload round-trips through DirectedGraph.import() preserving order and size", async () => {
    const result = await readGraphResource({ graph });
    const parsed = JSON.parse(result.text) as {
      graph: Parameters<DirectedGraph<GraphNodeAttrs, EdgeAttrs>["import"]>[0];
    };
    const rebuilt = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();
    rebuilt.import(parsed.graph);
    expect(rebuilt.order).toBe(graph.order);
    expect(rebuilt.size).toBe(graph.size);

    // Spot-check: every original node id is present in the rebuilt graph.
    for (const nodeId of graph.nodes()) {
      expect(rebuilt.hasNode(nodeId)).toBe(true);
    }
  });
});
