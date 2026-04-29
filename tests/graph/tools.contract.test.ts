import { describe, it, expect, beforeAll } from "vitest";
import { resolve as resolvePath } from "node:path";
import type { DirectedGraph } from "graphology";

import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "../../src/graph/builder.js";
import {
  centralNotes,
  listBacklinks,
  neighbors,
  orphans,
  placeholders,
  shortestPath,
  type GraphToolContext,
} from "../../src/graph/tools.js";
import { ToolValidationError } from "../../src/errors.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);
const p = (rel: string): string => resolvePath(VAULT, rel);

let ctx: GraphToolContext;

beforeAll(async () => {
  const graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs> = await buildGraph(VAULT);
  ctx = { vaultPath: VAULT, graph };
});

// ---------------------------------------------------------------------------
// list_backlinks
// ---------------------------------------------------------------------------

describe("list_backlinks (contract)", () => {
  it("returns every source note that links to note-a", async () => {
    // note-a is linked to from: 00-Index-MOC, 02-Areas/note-b, project-y, timestamped
    const { locations } = await listBacklinks({ note: "02-Areas/note-a.md" }, ctx);
    const sources = locations.map((l) => l.sourcePath).sort();
    expect(sources).toEqual(
      [
        p("00-Index-MOC.md"),
        p("01-Projects/project-y.md"),
        p("02-Areas/note-b.md"),
        p("03-Resources/202604160900-timestamped.md"),
      ].sort(),
    );
    // Every location exposes a positive line and a non-empty context snippet
    // (the lines all contain a wikilink), plus the alias from note-b.
    for (const loc of locations) {
      expect(loc.line).toBeGreaterThan(0);
      expect(typeof loc.context).toBe("string");
      expect(loc.context).toContain("[[");
    }
    const fromNoteB = locations.find((l) => l.sourcePath.endsWith("02-Areas/note-b.md"));
    expect(fromNoteB?.alias).toBe("alias for A");
  });

  it("returns an empty list for a note with no incoming links", async () => {
    // project-y has out-edges but no one links back to it.
    const { locations } = await listBacklinks({ note: "01-Projects/project-y.md" }, ctx);
    expect(locations).toEqual([]);
  });

  it("accepts absolute paths as well as vault-relative", async () => {
    const { locations } = await listBacklinks({ note: p("02-Areas/note-a.md") }, ctx);
    expect(locations.length).toBeGreaterThan(0);
  });

  it("rejects a missing 'note' field", async () => {
    // @ts-expect-error -- exercising the runtime guard
    await expect(listBacklinks({}, ctx)).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("rejects a nonexistent note path", async () => {
    await expect(listBacklinks({ note: "does-not-exist.md" }, ctx)).rejects.toThrow(
      /not found in graph/,
    );
  });

  it("rejects a path that escapes the vault", async () => {
    await expect(listBacklinks({ note: "../../../etc/passwd" }, ctx)).rejects.toThrow(
      /escapes the vault/,
    );
  });
});

// ---------------------------------------------------------------------------
// neighbors
// ---------------------------------------------------------------------------

describe("neighbors (contract)", () => {
  it("returns depth-1 neighbors in both directions by default", async () => {
    const { neighbors: out } = await neighbors({ note: "02-Areas/note-a.md" }, ctx);
    const paths = new Set(out.map((n) => n.path));
    // Outbound: note-b. Inbound: MOC, project-y, note-b, timestamped.
    expect(paths.has(p("02-Areas/note-b.md"))).toBe(true);
    expect(paths.has(p("00-Index-MOC.md"))).toBe(true);
    expect(paths.has(p("01-Projects/project-y.md"))).toBe(true);
    expect(paths.has(p("03-Resources/202604160900-timestamped.md"))).toBe(true);
    // Every neighbor's distance is exactly 1 at depth=1.
    for (const n of out) expect(n.distance).toBe(1);
  });

  it("restricts the result set when direction is 'out'", async () => {
    const { neighbors: out } = await neighbors(
      { note: "02-Areas/note-a.md", direction: "out" },
      ctx,
    );
    expect(out.map((n) => n.path)).toEqual([p("02-Areas/note-b.md")]);
    expect(out[0]?.direction).toBe("out");
  });

  it("direction 'in' differs from 'out' for the same note", async () => {
    const inbound = await neighbors({ note: "02-Areas/note-a.md", direction: "in" }, ctx);
    const outbound = await neighbors({ note: "02-Areas/note-a.md", direction: "out" }, ctx);
    const inPaths = new Set(inbound.neighbors.map((n) => n.path));
    const outPaths = new Set(outbound.neighbors.map((n) => n.path));
    expect(inPaths).not.toEqual(outPaths);
    expect(inPaths.size).toBeGreaterThan(outPaths.size);
  });

  it("depth=2 returns strictly more (or equal) than depth=1 for the MOC", async () => {
    const d1 = await neighbors({ note: "00-Index-MOC.md", depth: 1, direction: "out" }, ctx);
    const d2 = await neighbors({ note: "00-Index-MOC.md", depth: 2, direction: "out" }, ctx);
    expect(d2.neighbors.length).toBeGreaterThanOrEqual(d1.neighbors.length);
    // At depth=2 from the MOC we pick up note-a (which note-b links to).
    // note-a is not a direct outbound neighbor but it is reachable via note-b.
    const d2Paths = new Set(d2.neighbors.map((n) => n.path));
    expect(d2Paths.has(p("02-Areas/note-a.md"))).toBe(true);
  });

  it("excludes the starting node from the result set", async () => {
    const { neighbors: out } = await neighbors({ note: "02-Areas/note-a.md", depth: 3 }, ctx);
    expect(out.every((n) => n.path !== p("02-Areas/note-a.md"))).toBe(true);
  });

  it("rejects depth=0 and depth=4", async () => {
    await expect(neighbors({ note: "02-Areas/note-a.md", depth: 0 }, ctx)).rejects.toBeInstanceOf(
      ToolValidationError,
    );
    await expect(neighbors({ note: "02-Areas/note-a.md", depth: 4 }, ctx)).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it("rejects an invalid direction value", async () => {
    await expect(
      // @ts-expect-error -- runtime guard
      neighbors({ note: "02-Areas/note-a.md", direction: "upstream" }, ctx),
    ).rejects.toThrow(/direction/);
  });
});

// ---------------------------------------------------------------------------
// shortest_path
// ---------------------------------------------------------------------------

describe("shortest_path (contract)", () => {
  it("finds a single-hop path between directly-linked notes", async () => {
    const res = await shortestPath({ from: "00-Index-MOC.md", to: "02-Areas/note-b.md" }, ctx);
    expect(res.hops).toBe(1);
    expect(res.path).toEqual([p("00-Index-MOC.md"), p("02-Areas/note-b.md")]);
  });

  it("finds a longer path via an intermediate note", async () => {
    // MOC doesn't link to note-a directly in out-direction only? Actually MOC
    // links to note-a directly so hops=1. Use project-y → project-x instead:
    // project-y → project-x is a direct edge, but the bidirectional BFS will
    // find the shortest. Use a path that actually requires > 1 hop: note-a
    // → note-b → placeholder... placeholders aren't "from" candidates.
    // MOC → note-b → note-a is 2 hops (bidirectional sees the direct edge
    // MOC → note-a, so hops=1). We instead exercise a case where we supply
    // max_hops too small: MOC→project-x has no path (project-x only has
    // inbound from project-y), so test the null branch there instead.
    const res = await shortestPath(
      { from: "01-Projects/project-y.md", to: "02-Areas/note-b.md" },
      ctx,
    );
    // project-y → note-a → note-b  OR  project-y → project-x (dead end).
    expect(res.hops).toBe(2);
    expect(res.path?.[0]).toBe(p("01-Projects/project-y.md"));
    expect(res.path?.[res.path.length - 1]).toBe(p("02-Areas/note-b.md"));
  });

  it("returns {path: [from], hops: 0} when from == to", async () => {
    const res = await shortestPath({ from: "02-Areas/note-a.md", to: "02-Areas/note-a.md" }, ctx);
    expect(res.hops).toBe(0);
    expect(res.path).toEqual([p("02-Areas/note-a.md")]);
  });

  it("returns {path: null, hops: null} when no path exists", async () => {
    // archived.md has no outgoing note edges, so no path to note-a.
    const res = await shortestPath(
      { from: "04-Archives/archived.md", to: "02-Areas/note-a.md" },
      ctx,
    );
    expect(res.path).toBeNull();
    expect(res.hops).toBeNull();
  });

  it("returns null when max_hops is too restrictive", async () => {
    // The MOC → note-a path is 1 hop; setting max_hops = 0 should reject
    // everything except from==to. We use project-y → note-b (distance 2)
    // with max_hops = 1 to exercise the guard.
    const res = await shortestPath(
      {
        from: "01-Projects/project-y.md",
        to: "02-Areas/note-b.md",
        max_hops: 1,
      },
      ctx,
    );
    expect(res.path).toBeNull();
    expect(res.hops).toBeNull();
  });

  it("rejects a missing 'to' field", async () => {
    await expect(
      // @ts-expect-error -- runtime guard
      shortestPath({ from: "02-Areas/note-a.md" }, ctx),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("rejects an invalid max_hops", async () => {
    await expect(
      shortestPath({ from: "02-Areas/note-a.md", to: "02-Areas/note-b.md", max_hops: 0 }, ctx),
    ).rejects.toThrow(/max_hops/);
  });
});

// ---------------------------------------------------------------------------
// orphans
// ---------------------------------------------------------------------------

describe("orphans (contract)", () => {
  it("returns exactly the fixture's hand-verified orphans", async () => {
    const { notes } = await orphans({}, ctx);
    // From the 11-file fixture, the notes with zero note-to-note edges are:
    //   - 01-Projects/202604170001-ambiguous.md (no links in or out)
    //   - 03-Resources/no-frontmatter.md         (no frontmatter, no links)
    //   - 04-Archives/archived.md                (no links)
    //   - 202604170000-ambiguous.md              (no links)
    // folder-link-target/index.md is NOT an orphan (the MOC's
    // [[folder-link-target]] resolves to it via the directory-link fallback).
    expect(notes.map((n) => n)).toEqual(
      [
        p("01-Projects/202604170001-ambiguous.md"),
        p("03-Resources/no-frontmatter.md"),
        p("04-Archives/archived.md"),
        p("202604170000-ambiguous.md"),
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// placeholders
// ---------------------------------------------------------------------------

describe("placeholders (contract)", () => {
  it("lists each placeholder with its referencing notes", async () => {
    const { placeholders: ph } = await placeholders({}, ctx);
    // Wave B stats: 1 broken wikilink — `[[placeholder-target]]` from note-b.
    expect(ph).toHaveLength(1);
    expect(ph[0]?.target).toBe("placeholder-target");
    expect(ph[0]?.referenced_by).toEqual([p("02-Areas/note-b.md")]);
  });
});

// ---------------------------------------------------------------------------
// central_notes
// ---------------------------------------------------------------------------

describe("central_notes (contract)", () => {
  it("pagerank returns entries sorted by score descending (notes only)", async () => {
    const { notes } = await centralNotes({ algorithm: "pagerank" }, ctx);
    expect(notes.length).toBeGreaterThan(0);
    // Every path is a note (not a placeholder marker).
    for (const n of notes) {
      expect(n.path.startsWith("placeholder:")).toBe(false);
      expect(ctx.graph.hasNode(n.path)).toBe(true);
      expect(ctx.graph.getNodeAttributes(n.path).type).toBe("note");
    }
    // Sorted desc.
    for (let i = 1; i < notes.length; i += 1) {
      const prev = notes[i - 1]?.score ?? 0;
      const cur = notes[i]?.score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
    // Soft assertion: the MOC or note-a should rank highly; they are the
    // two most-connected nodes in the fixture.
    const topTwo = new Set(notes.slice(0, 2).map((n) => n.path));
    const highSignal = topTwo.has(p("00-Index-MOC.md")) || topTwo.has(p("02-Areas/note-a.md"));
    expect(highSignal).toBe(true);
  });

  it("degree limit=3 returns at most 3 entries, sorted descending", async () => {
    const { notes } = await centralNotes({ algorithm: "degree", limit: 3 }, ctx);
    expect(notes.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < notes.length; i += 1) {
      const prev = notes[i - 1]?.score ?? 0;
      const cur = notes[i]?.score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
    // note-a has the highest degree in the fixture (in=4, out=1 → 5); it
    // should be the top-ranked note.
    expect(notes[0]?.path).toBe(p("02-Areas/note-a.md"));
  });

  it("folder filter reduces the candidate set", async () => {
    const { notes } = await centralNotes({ algorithm: "degree", folder: "01-Projects" }, ctx);
    // Every returned note lives under 01-Projects.
    for (const n of notes) {
      expect(n.path.includes("/01-Projects/")).toBe(true);
    }
    const unfiltered = await centralNotes({ algorithm: "degree" }, ctx);
    expect(notes.length).toBeLessThan(unfiltered.notes.length);
  });

  it("rejects an unknown algorithm", async () => {
    await expect(
      // @ts-expect-error -- runtime guard
      centralNotes({ algorithm: "betweenness" }, ctx),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("rejects a non-positive limit", async () => {
    await expect(centralNotes({ algorithm: "degree", limit: 0 }, ctx)).rejects.toThrow(/limit/);
  });
});
