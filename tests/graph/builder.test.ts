import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { resolve as resolvePath } from "node:path";

import { buildGraph, placeholderId } from "../../src/graph/builder.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

const notePath = (rel: string): string => resolvePath(VAULT, rel);

describe("buildGraph", () => {
  it("produces the expected note-node count from the 11-file fixture", async () => {
    const graph = await buildGraph(VAULT);
    const noteNodes = graph.filterNodes((_, attrs) => attrs.type === "note");
    expect(noteNodes).toHaveLength(11);
  });

  it("resolves 9 of the 10 wikilinks into concrete edges", async () => {
    const graph = await buildGraph(VAULT);
    const resolvedEdges = graph.filterEdges((_, __, ___, ____, srcAttrs, tgtAttrs) => {
      return srcAttrs.type === "note" && tgtAttrs.type === "note";
    });
    expect(resolvedEdges).toHaveLength(9);
  });

  it("records exactly 1 placeholder node (the broken wikilink)", async () => {
    const graph = await buildGraph(VAULT);
    const placeholders = graph.filterNodes((_, attrs) => attrs.type === "placeholder");
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toBe(placeholderId("placeholder-target"));
    const pAttrs = graph.getNodeAttributes(placeholders[0] as string);
    expect(pAttrs).toEqual({ type: "placeholder", target: "placeholder-target" });
  });

  it("marks the MOC file with isMoc: true and other notes with isMoc: false", async () => {
    const graph = await buildGraph(VAULT);
    const mocAttrs = graph.getNodeAttributes(notePath("00-Index-MOC.md"));
    expect(mocAttrs.type).toBe("note");
    if (mocAttrs.type === "note") {
      expect(mocAttrs.isMoc).toBe(true);
      expect(mocAttrs.title).toBe("Index");
      expect(mocAttrs.basename).toBe("00-Index-MOC");
      expect(mocAttrs.folder).toBe(".");
    }

    const noteA = graph.getNodeAttributes(notePath("02-Areas/note-a.md"));
    expect(noteA.type).toBe("note");
    if (noteA.type === "note") {
      expect(noteA.isMoc).toBe(false);
      expect(noteA.folder).toBe("02-Areas");
      expect(noteA.tags).toEqual(expect.arrayContaining(["area", "alpha"]));
    }
  });

  it("preserves line and column on edges", async () => {
    const graph = await buildGraph(VAULT);
    // The MOC links to note-a on line 5 (after the frontmatter + title + blank).
    const mocToNoteA = graph.edge(notePath("00-Index-MOC.md"), notePath("02-Areas/note-a.md"));
    expect(mocToNoteA).toBeDefined();
    const attrs = graph.getEdgeAttributes(mocToNoteA as string);
    expect(attrs.line).toBeGreaterThan(0);
    expect(attrs.column).toBeGreaterThan(0);
    expect(typeof attrs.line).toBe("number");
    expect(typeof attrs.column).toBe("number");
  });

  it("captures alias attributes on wikilinks that carry them", async () => {
    const graph = await buildGraph(VAULT);
    // note-b links to note-a with alias `alias for A`.
    const edgeId = graph.edge(notePath("02-Areas/note-b.md"), notePath("02-Areas/note-a.md"));
    expect(edgeId).toBeDefined();
    const attrs = graph.getEdgeAttributes(edgeId as string);
    expect(attrs.alias).toBe("alias for A");
  });

  it("resolves the directory-link fallback (`[[folder-link-target]]` → folder/index.md)", async () => {
    const graph = await buildGraph(VAULT);
    const edgeId = graph.edge(notePath("00-Index-MOC.md"), notePath("folder-link-target/index.md"));
    expect(edgeId).toBeDefined();
  });

  it("builds from the 11-note fixture in under 200ms [perf]", async () => {
    // Warm the module caches by doing one throwaway run first. The perf
    // assertion is about steady-state build time, not first-import overhead
    // (unified/remark plugin loading dominates the very first parse).
    await buildGraph(VAULT);
    const start = performance.now();
    await buildGraph(VAULT);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
