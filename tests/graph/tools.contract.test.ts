import { describe, it, expect, beforeAll } from "vitest";
import { resolve as resolvePath } from "node:path";
import { DirectedGraph } from "graphology";

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
    const sources = locations.map((l) => l.sourcePath).sort((a, b) => a.localeCompare(b));
    expect(sources).toEqual(
      [
        p("00-Index-MOC.md"),
        p("01-Projects/project-y.md"),
        p("02-Areas/note-b.md"),
        p("03-Resources/202604160900-timestamped.md"),
      ].sort((a, b) => a.localeCompare(b)),
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
      ].sort((a, b) => a.localeCompare(b)),
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

// ---------------------------------------------------------------------------
// Helpers for the in-memory graph regression tests below.
// ---------------------------------------------------------------------------

const makeNote = (path: string, folder: string): GraphNodeAttrs => ({
  type: "note",
  title: path,
  basename: path,
  folder,
  tags: [],
  frontmatter: {},
  isMoc: false,
});

const edgeAttrs = (): EdgeAttrs => ({ line: 1, column: 1 });

// ---------------------------------------------------------------------------
// neighbors — min-distance across directions (M1 regression coverage)
// ---------------------------------------------------------------------------

describe("neighbors — direction='both' uses min-distance across passes (M1)", () => {
  it("reports the smaller of out-distance and in-distance for asymmetric reachability", async () => {
    // Build an in-memory graph where B is:
    //   - reachable from A via out-edges at depth 3 (A → X → Y → B)
    //   - reachable from A via in-edges at depth 1 (B → A)
    // The old implementation would 'claim' B at distance=3 via the out-pass
    // because it ran first; the fix must report distance=1, direction='in'.
    const g: DirectedGraph<GraphNodeAttrs, EdgeAttrs> = new DirectedGraph<
      GraphNodeAttrs,
      EdgeAttrs
    >();
    const VAULT = p(".");
    const A = resolvePath(VAULT, "a.md");
    const X = resolvePath(VAULT, "x.md");
    const Y = resolvePath(VAULT, "y.md");
    const B = resolvePath(VAULT, "b.md");
    g.addNode(A, makeNote(A, "."));
    g.addNode(X, makeNote(X, "."));
    g.addNode(Y, makeNote(Y, "."));
    g.addNode(B, makeNote(B, "."));
    g.addDirectedEdge(A, X, edgeAttrs());
    g.addDirectedEdge(X, Y, edgeAttrs());
    g.addDirectedEdge(Y, B, edgeAttrs()); // out-depth 3 from A
    g.addDirectedEdge(B, A, edgeAttrs()); // in-depth 1 from A

    const local = { vaultPath: VAULT, graph: g };
    const { neighbors: out } = await neighbors({ note: A, depth: 3, direction: "both" }, local);

    const forB = out.find((n) => n.path === B);
    expect(forB).toBeDefined();
    expect(forB?.distance).toBe(1);
    expect(forB?.direction).toBe("in");
  });

  it("ties (out=1, in=1) are resolved deterministically: 'out' wins", async () => {
    // A ↔ B: out and in both reach B at distance 1. Tiebreaker: the 'out'
    // pass runs first and claims the node, so direction should be 'out'.
    const g: DirectedGraph<GraphNodeAttrs, EdgeAttrs> = new DirectedGraph<
      GraphNodeAttrs,
      EdgeAttrs
    >();
    const VAULT = p(".");
    const A = resolvePath(VAULT, "a.md");
    const B = resolvePath(VAULT, "b.md");
    g.addNode(A, makeNote(A, "."));
    g.addNode(B, makeNote(B, "."));
    g.addDirectedEdge(A, B, edgeAttrs());
    g.addDirectedEdge(B, A, edgeAttrs());

    const local = { vaultPath: VAULT, graph: g };
    const { neighbors: out } = await neighbors({ note: A, depth: 1, direction: "both" }, local);

    const forB = out.find((n) => n.path === B);
    expect(forB).toBeDefined();
    expect(forB?.distance).toBe(1);
    expect(forB?.direction).toBe("out");
  });
});

// ---------------------------------------------------------------------------
// central_notes — folder boundary (M4 regression coverage)
// ---------------------------------------------------------------------------

describe("central_notes — folder filter uses '/' boundary (M4)", () => {
  it("does not leak notes from a sibling folder whose name shares the prefix", async () => {
    // Two folders, `01-Projects` and `01-Projects-Archive`, one note each.
    // Asking for folder='01-Projects' must return only the note under
    // `01-Projects`, not the one under `01-Projects-Archive`.
    const g: DirectedGraph<GraphNodeAttrs, EdgeAttrs> = new DirectedGraph<
      GraphNodeAttrs,
      EdgeAttrs
    >();
    const VAULT = p(".");
    const P1 = resolvePath(VAULT, "01-Projects", "p1.md");
    const A1 = resolvePath(VAULT, "01-Projects-Archive", "a1.md");
    g.addNode(P1, makeNote(P1, "01-Projects"));
    g.addNode(A1, makeNote(A1, "01-Projects-Archive"));
    // Give each node a non-zero degree so it appears in the scoring output.
    g.addDirectedEdge(P1, A1, edgeAttrs());
    g.addDirectedEdge(A1, P1, edgeAttrs());

    const local = { vaultPath: VAULT, graph: g };
    const { notes } = await centralNotes({ algorithm: "degree", folder: "01-Projects" }, local);
    const paths = notes.map((n) => n.path);
    expect(paths).toContain(P1);
    expect(paths).not.toContain(A1);
  });

  it("accepts the folder itself (exact match, no trailing slash required)", async () => {
    // Edge case: a note living directly in `folder` (not in a sub-folder).
    const g: DirectedGraph<GraphNodeAttrs, EdgeAttrs> = new DirectedGraph<
      GraphNodeAttrs,
      EdgeAttrs
    >();
    const VAULT = p(".");
    const P1 = resolvePath(VAULT, "01-Projects", "p1.md");
    const P2 = resolvePath(VAULT, "01-Projects", "sub", "p2.md");
    g.addNode(P1, makeNote(P1, "01-Projects"));
    g.addNode(P2, makeNote(P2, "01-Projects/sub"));
    g.addDirectedEdge(P1, P2, edgeAttrs());

    const local = { vaultPath: VAULT, graph: g };
    const { notes } = await centralNotes({ algorithm: "degree", folder: "01-Projects" }, local);
    const paths = notes.map((n) => n.path);
    // Both notes live under (or in) `01-Projects`; both must be returned.
    expect(paths).toContain(P1);
    expect(paths).toContain(P2);
  });
});
