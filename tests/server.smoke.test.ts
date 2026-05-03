import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DirectedGraph } from "graphology";

import { buildServer, buildToolContext } from "../src/server.js";
import type { FoamConfig } from "../src/config.js";
import type { EdgeAttrs, GraphNodeAttrs } from "../src/graph/builder.js";
import { listGraphResources } from "../src/resources/graph.js";
import { fixtureRoot } from "./helpers/fixture.js";
import { TOOL_METADATA } from "../src/tools/index.js";

describe("server (smoke)", () => {
  const VAULT = fixtureRoot(import.meta.url);

  const fakeConfig: FoamConfig = {
    vaultPath: VAULT,
    cacheDir: join(tmpdir(), "foam-notes-mcp-smoke-cache"),
    mocPattern: "*-MOC.md",
    ripgrepPath: "/usr/bin/rg",
  };

  const makeGraph = (): DirectedGraph<GraphNodeAttrs, EdgeAttrs> =>
    new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();

  it("buildToolContext forwards config fields into ctx.keyword", () => {
    const ctx = buildToolContext(fakeConfig, makeGraph());
    expect(ctx.keyword.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.keyword.mocPattern).toBe(fakeConfig.mocPattern);
    expect(ctx.keyword.ripgrepPath).toBe(fakeConfig.ripgrepPath);
  });

  it("buildToolContext wires vaultPath and graph into ctx.graph", () => {
    const graph = makeGraph();
    const ctx = buildToolContext(fakeConfig, graph);
    expect(ctx.graph.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.graph.graph).toBe(graph);
  });

  it("buildServer returns an MCP McpServer instance", () => {
    const ctx = buildToolContext(fakeConfig, makeGraph());
    const server = buildServer(ctx);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("buildServer is idempotent — repeated calls produce distinct servers", () => {
    const ctx = buildToolContext(fakeConfig, makeGraph());
    const a = buildServer(ctx);
    const b = buildServer(ctx);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(McpServer);
    expect(b).toBeInstanceOf(McpServer);
  });

  it("TOOL_METADATA is non-empty (sanity: server would advertise tools)", () => {
    expect(Object.keys(TOOL_METADATA).length).toBeGreaterThan(0);
  });

  it("listGraphResources() includes a foam://graph descriptor", async () => {
    const resources = await listGraphResources();
    const found = resources.some((r) => r.uri === "foam://graph");
    expect(found).toBe(true);
  });
});
