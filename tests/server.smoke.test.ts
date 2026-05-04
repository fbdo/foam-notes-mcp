import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DirectedGraph } from "graphology";

import {
  buildServer,
  buildSemanticDeps,
  buildToolContext,
  initVaultWatcher,
  listVaultMarkdown,
  type SemanticDeps,
} from "../src/server.js";
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
    watcher: false,
    graphResourceMaxNodes: 5000,
    graphResourceMaxBytes: 10 * 1024 * 1024,
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

  it("buildToolContext composes ctx.hybrid from the keyword/graph/semantic sub-contexts", async () => {
    const graph = makeGraph();
    const deps = await makeSemanticDeps();
    const ctx = buildToolContext(fakeConfig, graph, deps);
    // Hybrid reuses the same values we verified above — no duplication.
    expect(ctx.hybrid.keyword.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.hybrid.keyword.ripgrepPath).toBe(fakeConfig.ripgrepPath);
    expect(ctx.hybrid.graph.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.hybrid.graph.graph).toBe(graph);
    expect(ctx.hybrid.semantic.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.hybrid.semantic.mocPattern).toBe(fakeConfig.mocPattern);
    expect(ctx.hybrid.semantic.embedder).toBe(deps.embedder);
    expect(ctx.hybrid.semantic.store).toBe(deps.store);
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

  it("TOOL_METADATA exposes exactly 16 tools (6 keyword + 6 graph + 3 semantic + 1 hybrid)", () => {
    expect(Object.keys(TOOL_METADATA).length).toBe(16);
  });

  it("TOOL_HANDLERS includes the 3 semantic tools and the hybrid tool", () => {
    expect(TOOL_HANDLERS).toHaveProperty("semantic_search");
    expect(TOOL_HANDLERS).toHaveProperty("build_index");
    expect(TOOL_HANDLERS).toHaveProperty("index_status");
    expect(TOOL_HANDLERS).toHaveProperty("hybrid_search");
  });

  it("listGraphResources() includes a foam://graph descriptor", async () => {
    const resources = await listGraphResources();
    const found = resources.some((r) => r.uri === "foam://graph");
    expect(found).toBe(true);
  });

  it("listVaultMarkdown returns absolute, sorted .md paths in the vault", async () => {
    // Use the real fixture vault directly (fixtureRoot() in this file
    // resolves one directory too high because the smoke test lives at
    // the `tests/` root, not in a subfolder). Every other test in this
    // file passes VAULT through a config that never actually reads
    // files from it.
    const fixture = fileURLToPath(new URL("./fixtures/vault/", import.meta.url));
    const files = await listVaultMarkdown(fixture);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.endsWith(".md")).toBe(true);
      expect(f.startsWith(fixture)).toBe(true);
    }
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
  });

  it("listVaultMarkdown returns an empty array for a vault with no markdown", async () => {
    const empty = mkdtempSync(join(tmpdir(), "foam-smoke-empty-"));
    try {
      const files = await listVaultMarkdown(empty);
      expect(files).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("buildSemanticDeps opens a SemanticStore and returns an embedder", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "foam-smoke-sem-deps-"));
    const config: FoamConfig = {
      vaultPath: VAULT,
      cacheDir,
      mocPattern: "*-MOC.md",
      ripgrepPath: "/usr/bin/rg",
      embedder: "transformers",
      watcher: false,
      graphResourceMaxNodes: 5000,
      graphResourceMaxBytes: 10 * 1024 * 1024,
    };
    try {
      const deps = await buildSemanticDeps(config);
      expect(deps.embedder.info.provider).toBe("transformers");
      expect(deps.store).toBeDefined();
      await deps.store.close();
      await deps.embedder.close();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("initVaultWatcher returns undefined when config.watcher is false", async () => {
    const deps = await makeSemanticDeps();
    const watcher = await initVaultWatcher({ ...fakeConfig, watcher: false }, makeGraph(), deps);
    expect(watcher).toBeUndefined();
  });

  it("initVaultWatcher starts and returns a live watcher when config.watcher is true", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/vault/", import.meta.url));
    const deps = await makeSemanticDeps();
    const watcher = await initVaultWatcher(
      { ...fakeConfig, vaultPath: fixture, watcher: true },
      makeGraph(),
      deps,
    );
    expect(watcher).toBeDefined();
    expect(watcher!.isRunning()).toBe(true);
    await watcher!.stop();
    expect(watcher!.isRunning()).toBe(false);
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
