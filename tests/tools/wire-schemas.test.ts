/**
 * Wire-level schema regression test.
 *
 * Exercises the actual `tools/list` code path inside `McpServer` via an
 * in-memory transport pair and a real `Client`. For each of the 12
 * registered tools we verify:
 *
 *   - The on-wire `inputSchema` contains no `$ref`, `$defs`, or
 *     `definitions` — the flat-schema invariant that originally motivated
 *     PLAN decision #20. Some MCP clients reject references; zod +
 *     `zod-to-json-schema` previously forced us into hand-written JSON
 *     Schemas. McpServer's derived output from raw shapes is flat, so
 *     this test pins that behaviour.
 *   - `type === 'object'`.
 *   - `required` (possibly absent when empty) matches the set of zod
 *     fields NOT wrapped in `.optional()`.
 *   - `properties` keys match the zod raw shape exactly.
 *   - A happy-path input parses successfully through the same zod shape.
 *
 * Note on `additionalProperties`: McpServer converts raw shapes via
 * `z.object(shape)` (non-strict), so the derived JSON Schema does not
 * emit `additionalProperties: false`. Input validation at `tools/call`
 * still parses through zod, which strips unknown keys by default. The
 * test therefore does NOT assert `additionalProperties: false`.
 *
 * Strategy: in-memory transport (SDK's `InMemoryTransport.createLinkedPair`)
 * wiring a minimal `McpServer` (built with `buildServer`) to a real MCP
 * `Client`, then calling `client.listTools()` — the same call shape an
 * MCP inspector / real client would make.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DirectedGraph } from "graphology";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { buildServer, buildToolContext, type SemanticDeps } from "../../src/server.js";
import type { FoamConfig } from "../../src/config.js";
import type { EdgeAttrs, GraphNodeAttrs } from "../../src/graph/builder.js";
import type { Embedder } from "../../src/semantic/embedder/types.js";
import { SemanticStore } from "../../src/semantic/store.js";
import { TOOL_ZOD_SHAPES } from "../../src/tools/index.js";
import { fixtureRoot } from "../helpers/fixture.js";

interface ListedTool {
  readonly name: string;
  readonly inputSchema: {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

// Valid happy-path inputs per tool, used for the zod-parse assertion.
// Values must satisfy every constraint in the corresponding zod shape.
const VALID_INPUTS: Record<string, Record<string, unknown>> = {
  search_notes: { query: "example" },
  find_by_frontmatter: { key: "tags" },
  find_unchecked_tasks: {},
  resolve_wikilink: { target: "note-a" },
  get_note: { path: "note-a.md" },
  get_vault_stats: {},
  list_backlinks: { note: "note-a.md" },
  neighbors: { note: "note-a.md" },
  shortest_path: { from: "note-a.md", to: "note-b.md" },
  orphans: {},
  placeholders: {},
  central_notes: { algorithm: "pagerank" },
  semantic_search: { query: "example" },
  build_index: {},
  index_status: {},
  hybrid_search: { query: "example" },
};

// Connect once for the whole suite — one round-trip for tools/list drives
// every per-tool assertion.
let client: Client;
let listed: ReadonlyMap<string, ListedTool>;
let storeCleanupDir: string;
let semanticStore: SemanticStore;

beforeAll(async () => {
  const config: FoamConfig = {
    vaultPath: fixtureRoot(import.meta.url),
    cacheDir: join(tmpdir(), "foam-notes-mcp-wire-schemas"),
    mocPattern: "*-MOC.md",
    ripgrepPath: "/usr/bin/rg",
    embedder: "transformers",
    watcher: false,
  };
  const graph = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();

  // Mock embedder + throwaway sqlite store: the wire-schema test only
  // exercises `tools/list` (schema introspection), so no embed/search ever
  // runs. The store still has to be opened to satisfy `ctx.semantic.store`.
  storeCleanupDir = mkdtempSync(join(tmpdir(), "foam-wire-semantic-"));
  const embedder: Embedder = {
    info: { provider: "transformers", model: "mock-4d", dims: 4, name: "mock:4d" },
    embed: async () => Promise.resolve([]),
    close: async () => Promise.resolve(),
  };
  semanticStore = new SemanticStore({
    path: join(storeCleanupDir, "index.sqlite"),
    embedderName: embedder.info.name,
    dims: embedder.info.dims,
  });
  await semanticStore.open();
  const semantic: SemanticDeps = { embedder, store: semanticStore };

  const ctx = buildToolContext(config, graph, semantic);
  const server = buildServer(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "wire-schemas-test", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.listTools();
  listed = new Map((result.tools as ListedTool[]).map((t) => [t.name, t]));
});

afterAll(async () => {
  await client.close();
  try {
    await semanticStore.close();
  } catch {
    // swallow — may already be closed
  }
  try {
    rmSync(storeCleanupDir, { recursive: true, force: true });
  } catch {
    // swallow
  }
});

describe("wire schemas (tools/list)", () => {
  it("server advertises all 16 tools", () => {
    expect(listed.size).toBe(16);
    for (const name of Object.keys(TOOL_ZOD_SHAPES)) {
      expect(listed.has(name), `server should advertise ${name}`).toBe(true);
    }
  });

  const names = Object.keys(TOOL_ZOD_SHAPES) as (keyof typeof TOOL_ZOD_SHAPES)[];

  it.each(names)("%s: inputSchema contains no $ref / $defs / definitions", (name) => {
    const tool = listed.get(name);
    expect(tool, `tool ${name} advertised`).toBeDefined();
    const serialized = JSON.stringify(tool!.inputSchema);
    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain('"$defs"');
    expect(serialized).not.toContain('"definitions"');
  });

  it.each(names)("%s: inputSchema.type is 'object'", (name) => {
    const tool = listed.get(name);
    expect(tool!.inputSchema.type).toBe("object");
  });

  it.each(names)("%s: required array matches non-optional zod fields", (name) => {
    const shape = TOOL_ZOD_SHAPES[name] as Record<string, z.ZodTypeAny>;
    const expectedRequired = Object.entries(shape)
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([field]) => field)
      .sort((a, b) => a.localeCompare(b));

    const tool = listed.get(name);
    const actualRequired = [...(tool!.inputSchema.required ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );

    expect(actualRequired).toEqual(expectedRequired);
  });

  it.each(names)("%s: properties keys match the zod raw shape exactly", (name) => {
    const shape = TOOL_ZOD_SHAPES[name];
    const expectedKeys = Object.keys(shape).sort((a, b) => a.localeCompare(b));

    const tool = listed.get(name);
    const actualKeys = Object.keys(tool!.inputSchema.properties ?? {}).sort((a, b) =>
      a.localeCompare(b),
    );

    expect(actualKeys).toEqual(expectedKeys);
  });

  it.each(names)("%s: zod shape accepts the documented valid input", (name) => {
    const shape = TOOL_ZOD_SHAPES[name];
    const schema = z.object(shape);
    const input = VALID_INPUTS[name];
    expect(input, `VALID_INPUTS missing entry for ${name}`).toBeDefined();
    expect(() => schema.parse(input)).not.toThrow();
  });

  it("hybrid_search: rejects empty query", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.hybrid_search);
    expect(() => schema.parse({ query: "" })).toThrow();
  });

  it("hybrid_search: rejects negative semantic weight", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.hybrid_search);
    expect(() => schema.parse({ query: "x", weights: { sem: -0.1 } })).toThrow();
  });

  it("hybrid_search: rejects negative keyword weight", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.hybrid_search);
    expect(() => schema.parse({ query: "x", weights: { kw: -1 } })).toThrow();
  });

  it("hybrid_search: rejects negative graph weight", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.hybrid_search);
    expect(() => schema.parse({ query: "x", weights: { graph: -0.5 } })).toThrow();
  });

  it("hybrid_search: accepts fully-specified valid input (weights, sources, min_score, limit)", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.hybrid_search);
    const parsed = schema.parse({
      query: "graph",
      limit: 5,
      weights: { sem: 0.7, kw: 0.2, graph: 0.1 },
      min_score: 0.01,
      sources: { semantic: true, keyword: false },
    });
    expect(parsed.query).toBe("graph");
    expect(parsed.limit).toBe(5);
    expect(parsed.weights).toEqual({ sem: 0.7, kw: 0.2, graph: 0.1 });
    expect(parsed.sources).toEqual({ semantic: true, keyword: false });
  });
});
