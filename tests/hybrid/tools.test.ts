/**
 * Unit tests for `src/hybrid/tools.ts`.
 *
 * The fusion logic is exercised through the pure {@link fuseHybridResults}
 * function — no fixture vault required. The thin {@link hybridSearch}
 * wrapper's input-validation path is tested separately (and will get full
 * contract coverage in Wave 5 commit 3 once the server layer wires it up).
 */

import { describe, expect, it } from "vitest";

import { ToolValidationError } from "../../src/errors.js";
import {
  fuseHybridResults,
  hybridSearch,
  type HybridKwCandidate,
  type HybridSemCandidate,
  type HybridToolContext,
  type RRFInputs,
} from "../../src/hybrid/tools.js";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const RRF_K = 60;

const makeSem = (notePath: string, score: number): HybridSemCandidate => ({
  notePath,
  score,
  chunk: {
    heading: null,
    text: `sem text for ${notePath}`,
    startLine: 1,
    endLine: 5,
  },
});

const makeKw = (notePath: string, line = 1): HybridKwCandidate => ({
  notePath,
  line,
  match: `kw match for ${notePath}`,
});

const DEFAULT_WEIGHTS = { sem: 0.6, kw: 0.2, graph: 0.2 } as const;

const baseInputs = (overrides: Partial<RRFInputs> = {}): RRFInputs => ({
  semList: [],
  kwList: [],
  pagerank: new Map(),
  weights: DEFAULT_WEIGHTS,
  limit: 10,
  minScore: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// fuseHybridResults — fusion & ranking.
// ---------------------------------------------------------------------------

describe("fuseHybridResults — both source lists populated", () => {
  it("lifts overlapping notes to the top and records both ranks", () => {
    const semList = [makeSem("a.md", 0.9), makeSem("b.md", 0.8), makeSem("c.md", 0.7)];
    const kwList = [makeKw("b.md"), makeKw("c.md"), makeKw("d.md")];
    const out = fuseHybridResults(baseInputs({ semList, kwList }));

    // All four notes appear; total counts pre-limit candidates.
    expect(out.total).toBe(4);
    const top = out.hits[0];
    expect(top).toBeDefined();
    // `b.md` is rank 2 in semantic + rank 1 in keyword — both lists
    // contribute, so it beats notes that appear in only one list.
    expect(top?.notePath).toBe("b.md");
    expect(top?.scoreBreakdown.semRank).toBe(2);
    expect(top?.scoreBreakdown.kwRank).toBe(1);

    // `d.md` only appears in keyword — its sem rank must be null.
    const d = out.hits.find((h) => h.notePath === "d.md");
    expect(d).toBeDefined();
    expect(d?.scoreBreakdown.semRank).toBeNull();
    expect(d?.scoreBreakdown.kwRank).toBe(3);
  });
});

describe("fuseHybridResults — partial-empty source lists", () => {
  it("handles semantic-only input (kwRank null everywhere)", () => {
    const semList = [makeSem("a.md", 0.9), makeSem("b.md", 0.8)];
    const out = fuseHybridResults(baseInputs({ semList }));

    expect(out.hits.map((h) => h.notePath)).toEqual(["a.md", "b.md"]);
    for (const h of out.hits) {
      expect(h.scoreBreakdown.kwRank).toBeNull();
      expect(h.scoreBreakdown.semRank).not.toBeNull();
    }
  });

  it("handles keyword-only input (semRank null everywhere)", () => {
    const kwList = [makeKw("a.md"), makeKw("b.md")];
    const out = fuseHybridResults(baseInputs({ kwList }));

    expect(out.hits.map((h) => h.notePath)).toEqual(["a.md", "b.md"]);
    for (const h of out.hits) {
      expect(h.scoreBreakdown.semRank).toBeNull();
      expect(h.scoreBreakdown.kwRank).not.toBeNull();
    }
  });

  it("returns empty envelope when both source lists are empty (no error)", () => {
    const out = fuseHybridResults(baseInputs());
    expect(out.hits).toEqual([]);
    expect(out.total).toBe(0);
  });
});

describe("fuseHybridResults — tie-break", () => {
  it("breaks ties alphabetically on notePath for deterministic output", () => {
    // Both notes appear at rank 1 in semantic → identical RRF. No PR data.
    // Order of insertion is reversed so we know the sort is doing the work.
    const semList = [makeSem("zeta.md", 0.5)];
    const kwList = [makeKw("alpha.md")];
    // Pick weights so semantic rank-1 and keyword rank-1 yield equal RRF.
    const inputs = baseInputs({
      semList,
      kwList,
      weights: { sem: 0.5, kw: 0.5, graph: 0.2 },
    });
    const out = fuseHybridResults(inputs);
    expect(out.hits.map((h) => h.notePath)).toEqual(["alpha.md", "zeta.md"]);
    // Both scores are equal (sanity).
    expect(out.hits[0]?.score).toBeCloseTo(out.hits[1]?.score ?? -1, 10);
  });
});

describe("fuseHybridResults — PageRank rerank", () => {
  it("moves a low-RRF note up when graph weight is 1.0 and its PR is near 1", () => {
    // Both notes appear only in semantic; `winner.md` is rank 2 (lower RRF),
    // `loser.md` is rank 1 — but `winner.md` has pr=1, `loser.md` has pr=0.
    // With graph=1, winner's multiplier is 2×, loser's is 1×. Choose ranks
    // so the multiplier flips the order.
    const semList = [makeSem("loser.md", 0.9), makeSem("winner.md", 0.8)];
    // RRF(loser)  = 1.0 / (60 + 1) ≈ 0.01639
    // RRF(winner) = 1.0 / (60 + 2) ≈ 0.01613
    // final(loser)  = 0.01639 × (1 + 1 × 0) = 0.01639
    // final(winner) = 0.01613 × (1 + 1 × 1) = 0.03226 → winner moves up.
    const pr = new Map<string, number>([
      ["winner.md", 1.0],
      ["loser.md", 0.0],
    ]);
    const out = fuseHybridResults(
      baseInputs({
        semList,
        pagerank: pr,
        weights: { sem: 1.0, kw: 0.0, graph: 1.0 },
      }),
    );
    expect(out.hits[0]?.notePath).toBe("winner.md");
    expect(out.hits[1]?.notePath).toBe("loser.md");
  });

  it("is a no-op when weights.graph = 0", () => {
    const semList = [makeSem("a.md", 0.9), makeSem("b.md", 0.8)];
    const pr = new Map<string, number>([
      ["a.md", 0.0],
      ["b.md", 1.0],
    ]);
    // With graph=0, the rerank multiplier is always 1 — order follows RRF.
    const out = fuseHybridResults(
      baseInputs({
        semList,
        pagerank: pr,
        weights: { sem: 1.0, kw: 0.0, graph: 0.0 },
      }),
    );
    expect(out.hits.map((h) => h.notePath)).toEqual(["a.md", "b.md"]);
    // `final == rrf` when graph=0 — verify the multiplier collapsed cleanly.
    for (const h of out.hits) {
      expect(h.score).toBeCloseTo(h.scoreBreakdown.rrf, 10);
    }
  });

  it("is a no-op when pagerank map is empty (no graph data)", () => {
    const semList = [makeSem("a.md", 0.9), makeSem("b.md", 0.8)];
    const out = fuseHybridResults(baseInputs({ semList }));
    for (const h of out.hits) {
      expect(h.scoreBreakdown.pagerank).toBe(0);
      expect(h.score).toBeCloseTo(h.scoreBreakdown.rrf, 10);
    }
  });
});

describe("fuseHybridResults — min_score filter & limit", () => {
  it("drops hits whose final score falls below min_score", () => {
    const semList = [makeSem("a.md", 0.9), makeSem("b.md", 0.8), makeSem("c.md", 0.7)];
    const out = fuseHybridResults(
      baseInputs({
        semList,
        // Any strictly positive threshold above the default RRF contribution
        // (≈ 0.6 / 61 ≈ 0.00984 for rank 1) filters everything out.
        minScore: 0.1,
      }),
    );
    expect(out.hits).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("truncates to `limit` but `total` reflects pre-truncation count", () => {
    const semList = [
      makeSem("a.md", 0.9),
      makeSem("b.md", 0.8),
      makeSem("c.md", 0.7),
      makeSem("d.md", 0.6),
    ];
    const out = fuseHybridResults(baseInputs({ semList, limit: 2 }));
    expect(out.hits.length).toBe(2);
    expect(out.total).toBe(4);
  });
});

describe("fuseHybridResults — RRF arithmetic", () => {
  it("sums contributions correctly when a note appears in both lists", () => {
    const semList = [makeSem("shared.md", 0.9)];
    const kwList = [makeKw("shared.md")];
    // Each list contributes weight / (K + rank) where rank=1. Default
    // weights: sem=0.6, kw=0.2. Expected RRF = 0.6/61 + 0.2/61 = 0.8/61.
    const out = fuseHybridResults(baseInputs({ semList, kwList }));
    const hit = out.hits[0];
    expect(hit).toBeDefined();
    const expected = DEFAULT_WEIGHTS.sem / (RRF_K + 1) + DEFAULT_WEIGHTS.kw / (RRF_K + 1);
    expect(hit?.scoreBreakdown.rrf).toBeCloseTo(expected, 10);
    expect(hit?.scoreBreakdown.semRank).toBe(1);
    expect(hit?.scoreBreakdown.kwRank).toBe(1);
  });

  it("accepts non-normalized weights (e.g. {sem: 1, kw: 1, graph: 0})", () => {
    const semList = [makeSem("a.md", 0.9)];
    const kwList = [makeKw("a.md")];
    const out = fuseHybridResults(
      baseInputs({
        semList,
        kwList,
        weights: { sem: 1, kw: 1, graph: 0 },
      }),
    );
    const hit = out.hits[0];
    expect(hit).toBeDefined();
    // Expected RRF = 1/61 + 1/61 = 2/61.
    expect(hit?.scoreBreakdown.rrf).toBeCloseTo(2 / (RRF_K + 1), 10);
  });
});

describe("fuseHybridResults — bestMatch assembly", () => {
  it("prefers semantic bestMatch when the note is in both lists", () => {
    const sem: HybridSemCandidate = {
      notePath: "a.md",
      score: 0.9,
      chunk: { heading: "H", text: "sem body", startLine: 3, endLine: 7 },
    };
    const kw: HybridKwCandidate = {
      notePath: "a.md",
      line: 12,
      match: "kw snippet",
    };
    const out = fuseHybridResults(baseInputs({ semList: [sem], kwList: [kw] }));
    const hit = out.hits[0];
    expect(hit?.bestMatch.text).toBe("sem body");
    expect(hit?.bestMatch.heading).toBe("H");
    expect(hit?.bestMatch.startLine).toBe(3);
    expect(hit?.bestMatch.endLine).toBe(7);
  });

  it("falls back to keyword bestMatch when only keyword has the note", () => {
    const kw: HybridKwCandidate = {
      notePath: "a.md",
      line: 42,
      match: "only-kw snippet",
    };
    const out = fuseHybridResults(baseInputs({ kwList: [kw] }));
    const hit = out.hits[0];
    expect(hit?.bestMatch.text).toBe("only-kw snippet");
    expect(hit?.bestMatch.heading).toBeNull();
    expect(hit?.bestMatch.startLine).toBe(42);
    expect(hit?.bestMatch.endLine).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// hybridSearch wrapper — validation only. Full contract coverage lands in
// Wave 5 commit 3 once the server layer provides real contexts.
// ---------------------------------------------------------------------------

const stubCtx = (): HybridToolContext =>
  // We only exercise the validation path in these tests; handlers never run.
  ({
    keyword: {} as HybridToolContext["keyword"],
    graph: {} as HybridToolContext["graph"],
    semantic: {} as HybridToolContext["semantic"],
  });

describe("hybridSearch — input validation", () => {
  it("throws ToolValidationError on an empty query", async () => {
    await expect(hybridSearch({ query: "   " }, stubCtx())).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it("throws ToolValidationError on a negative weight", async () => {
    await expect(
      hybridSearch({ query: "x", weights: { sem: -0.1 } }, stubCtx()),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("throws ToolValidationError on a non-finite weight", async () => {
    await expect(
      hybridSearch({ query: "x", weights: { graph: Number.POSITIVE_INFINITY } }, stubCtx()),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("throws ToolValidationError on limit < 1", async () => {
    await expect(hybridSearch({ query: "x", limit: 0 }, stubCtx())).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it("throws ToolValidationError on a non-finite min_score", async () => {
    await expect(
      hybridSearch({ query: "x", min_score: Number.NaN }, stubCtx()),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });
});
