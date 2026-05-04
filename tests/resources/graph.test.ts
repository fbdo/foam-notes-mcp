import { describe, it, expect, beforeAll } from "vitest";
import { DirectedGraph } from "graphology";

import { GraphResourceTooLargeError } from "../../src/errors.js";
import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "../../src/graph/builder.js";
import {
  GRAPH_RESOURCE,
  GRAPH_RESOURCE_URI,
  listGraphResources,
  readGraphResource,
  type ReadGraphResourceOptions,
} from "../../src/resources/graph.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

let graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;

/**
 * Generous limits used by the tests that care about the *payload shape*,
 * not the size guard. Keeps the existing 7 assertions unchanged beyond
 * the one-line signature update required by the new `options` argument.
 */
const UNLIMITED: ReadGraphResourceOptions = {
  maxNodes: 1_000_000,
  maxBytes: 100 * 1024 * 1024, // 100 MiB — well above any fixture
};

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
    const result = await readGraphResource({ graph }, UNLIMITED);
    expect(result.uri).toBe("foam://graph");
    expect(result.mimeType).toBe("application/json");
    expect(typeof result.text).toBe("string");

    // `text` is valid JSON (no pretty-printing, no control chars).
    const parsed: unknown = JSON.parse(result.text);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  it("parsed payload has the documented shape", async () => {
    const result = await readGraphResource({ graph }, UNLIMITED);
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
    const result = await readGraphResource({ graph }, UNLIMITED);
    const parsed = JSON.parse(result.text) as { nodeCount: number };
    expect(parsed.nodeCount).toBe(graph.order);
    expect(parsed.nodeCount).toBe(12);
  });

  it("edgeCount equals graph.size (using the observed fixture value, not a guess)", async () => {
    const result = await readGraphResource({ graph }, UNLIMITED);
    const parsed = JSON.parse(result.text) as { edgeCount: number };
    expect(parsed.edgeCount).toBe(graph.size);
    // Sanity: the builder test pins 9 note→note edges + 1 note→placeholder edge = 10 edges.
    expect(parsed.edgeCount).toBe(10);
  });

  it("payload round-trips through DirectedGraph.import() preserving order and size", async () => {
    const result = await readGraphResource({ graph }, UNLIMITED);
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

describe("foam://graph size guards", () => {
  it("succeeds when graph.order is well below maxNodes (12 nodes ≤ 100)", async () => {
    const result = await readGraphResource({ graph }, { maxNodes: 100, maxBytes: 10_000_000 });
    expect(result.uri).toBe("foam://graph");
    expect(typeof result.text).toBe("string");
    const parsed = JSON.parse(result.text) as { nodeCount: number };
    expect(parsed.nodeCount).toBe(12);
  });

  it("throws GraphResourceTooLargeError(kind='nodes') when graph.order exceeds maxNodes", async () => {
    let caught: unknown;
    try {
      await readGraphResource({ graph }, { maxNodes: 10, maxBytes: 10_000_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphResourceTooLargeError);
    const tooLarge = caught as GraphResourceTooLargeError;
    expect(tooLarge.kind).toBe("nodes");
    expect(tooLarge.actual).toBe(12);
    expect(tooLarge.limit).toBe(10);
    expect(tooLarge.message).toMatch(/FOAM_GRAPH_MAX_NODES/);
    // Error message should mention the targeted graph tools to guide callers.
    expect(tooLarge.message).toMatch(/list_backlinks|neighbors|shortest_path/);
  });

  it("throws GraphResourceTooLargeError(kind='bytes') when serialized payload exceeds maxBytes", async () => {
    // A tiny 5-node graph serializes to comfortably more than 100 bytes.
    const tiny = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();
    for (let i = 0; i < 5; i++) {
      tiny.addNode(`note-${String(i)}`, {
        type: "note",
        title: `Note ${String(i)}`,
        basename: `note-${String(i)}`,
        folder: "",
        tags: [],
        frontmatter: {},
        isMoc: false,
      });
    }
    let caught: unknown;
    try {
      await readGraphResource({ graph: tiny }, { maxNodes: 100, maxBytes: 100 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphResourceTooLargeError);
    const tooLarge = caught as GraphResourceTooLargeError;
    expect(tooLarge.kind).toBe("bytes");
    expect(tooLarge.actual).toBeGreaterThan(100);
    expect(tooLarge.limit).toBe(100);
    expect(tooLarge.message).toMatch(/FOAM_GRAPH_MAX_BYTES/);
  });

  it("succeeds when maxBytes is generous (10 MB on a 12-node fixture)", async () => {
    const result = await readGraphResource({ graph }, { maxNodes: 100, maxBytes: 10_000_000 });
    // Just verify we got a well-formed response through the happy path.
    expect(result.uri).toBe("foam://graph");
    const parsed = JSON.parse(result.text) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it("boundary: actual == limit does not throw (strictly greater throws)", async () => {
    // First, measure the actual byte length so we can pin maxBytes to it.
    const baseline = await readGraphResource({ graph }, UNLIMITED);
    const exactBytes = Buffer.byteLength(baseline.text, "utf8");

    // maxBytes == exact length → allowed.
    const atBytesLimit = await readGraphResource(
      { graph },
      { maxNodes: 100, maxBytes: exactBytes },
    );
    expect(atBytesLimit.text.length).toBe(baseline.text.length);

    // maxNodes == graph.order → allowed.
    const atNodesLimit = await readGraphResource(
      { graph },
      { maxNodes: graph.order, maxBytes: 10_000_000 },
    );
    const parsed = JSON.parse(atNodesLimit.text) as { nodeCount: number };
    expect(parsed.nodeCount).toBe(graph.order);

    // One byte fewer → throws (strictly greater wins).
    let caught: unknown;
    try {
      await readGraphResource({ graph }, { maxNodes: 100, maxBytes: exactBytes - 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphResourceTooLargeError);
    expect((caught as GraphResourceTooLargeError).kind).toBe("bytes");

    // One node fewer → throws.
    let caughtNodes: unknown;
    try {
      await readGraphResource({ graph }, { maxNodes: graph.order - 1, maxBytes: 10_000_000 });
    } catch (err) {
      caughtNodes = err;
    }
    expect(caughtNodes).toBeInstanceOf(GraphResourceTooLargeError);
    expect((caughtNodes as GraphResourceTooLargeError).kind).toBe("nodes");
  });
});
