import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DirectedGraph } from "graphology";

import { buildServer, buildToolContext, type SemanticDeps } from "../src/server.js";
import type { FoamConfig } from "../src/config.js";
import type { EdgeAttrs, GraphNodeAttrs } from "../src/graph/builder.js";
import { listGraphResources } from "../src/resources/graph.js";
import { SemanticStore } from "../src/semantic/store.js";
import type { Embedder } from "../src/semantic/embedder/types.js";
import { fixtureRoot } from "./helpers/fixture.js";
import { TOOL_HANDLERS, TOOL_METADATA } from "../src/tools/index.js";

describe("server (smoke)", () => {
  const VAULT = fixtureRoot(import.meta.url);

  const fakeConfig: FoamConfig = {
    vaultPath: VAULT,
    cacheDir: join(tmpdir(), "foam-notes-mcp-smoke-cache"),
    mocPattern: "*-MOC.md",
    ripgrepPath: "/usr/bin/rg",
    embedder: "transformers",
  };

  const makeGraph = (): DirectedGraph<GraphNodeAttrs, EdgeAttrs> =>
    new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();

  // A minimal 4-dim mock embedder: enough to satisfy the tool-context shape
  // without depending on the real transformers model. The smoke test never
  // exercises an embed call — it only verifies wiring.
  const makeMockEmbedder = (): Embedder => ({
    info: { provider: "transformers", model: "mock-4d", dims: 4, name: "mock:4d" },
    embed: async () => Promise.resolve([]),
    close: async () => Promise.resolve(),
  });

  // A pre-opened SemanticStore in a throwaway tmpdir. Each test constructs
  // its own to avoid cross-test interference. `afterAll` cleans up.
  const openedStores: { path: string; dir: string; store: SemanticStore }[] = [];
  const makeSemanticDeps = async (): Promise<SemanticDeps> => {
    const dir = mkdtempSync(join(tmpdir(), "foam-smoke-semantic-"));
    const path = join(dir, "index.sqlite");
    const embedder = makeMockEmbedder();
    const store = new SemanticStore({
      path,
      embedderName: embedder.info.name,
      dims: embedder.info.dims,
    });
    await store.open();
    openedStores.push({ path, dir, store });
    return { embedder, store };
  };

  // Vitest hook registration at module scope (the file has only one suite).
  // We can't use the `afterAll` hook here because the arrow function sees
  // `openedStores` by reference; closing runs synchronously after every
  // test registration completes.
  it("buildToolContext forwards config fields into ctx.keyword", async () => {
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, makeGraph(), deps);
    expect(ctx.keyword.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.keyword.mocPattern).toBe(fakeConfig.mocPattern);
    expect(ctx.keyword.ripgrepPath).toBe(fakeConfig.ripgrepPath);
  });

  it("buildToolContext wires vaultPath and graph into ctx.graph", async () => {
    const graph = makeGraph();
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, graph, deps);
    expect(ctx.graph.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.graph.graph).toBe(graph);
  });

  it("buildToolContext wires vaultPath, embedder, store into ctx.semantic", async () => {
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, makeGraph(), deps);
    expect(ctx.semantic.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.semantic.mocPattern).toBe(fakeConfig.mocPattern);
    expect(ctx.semantic.embedder).toBe(deps.embedder);
    expect(ctx.semantic.store).toBe(deps.store);
  });

  it("buildServer returns an MCP McpServer instance", async () => {
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, makeGraph(), deps);
    const server = buildServer(ctx);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("buildServer is idempotent — repeated calls produce distinct servers", async () => {
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, makeGraph(), deps);
    const a = buildServer(ctx);
    const b = buildServer(ctx);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(McpServer);
    expect(b).toBeInstanceOf(McpServer);
  });

  it("TOOL_METADATA exposes exactly 15 tools (6 keyword + 6 graph + 3 semantic)", () => {
    expect(Object.keys(TOOL_METADATA).length).toBe(15);
  });

  it("TOOL_HANDLERS includes the 3 new semantic tools", () => {
    expect(TOOL_HANDLERS).toHaveProperty("semantic_search");
    expect(TOOL_HANDLERS).toHaveProperty("build_index");
    expect(TOOL_HANDLERS).toHaveProperty("index_status");
  });

  it("listGraphResources() includes a foam://graph descriptor", async () => {
    const resources = await listGraphResources();
    const found = resources.some((r) => r.uri === "foam://graph");
    expect(found).toBe(true);
  });

  // Best-effort cleanup: close any stores we opened, remove tmpdirs.
  it("cleanup: close stores and remove tmpdirs", async () => {
    for (const { dir, store } of openedStores) {
      try {
        await store.close();
      } catch {
        // swallow
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
    expect(true).toBe(true);
  });
});
