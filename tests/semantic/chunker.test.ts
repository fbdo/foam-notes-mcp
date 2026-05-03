import { describe, it, expect } from "vitest";

import {
  DEFAULT_OVERLAP_TOKENS,
  DEFAULT_WINDOW_TOKENS,
  chunkNote,
} from "../../src/semantic/chunker.js";
import { buildVaultIndex } from "../../src/resolver.js";

/** Produce a body of `n` whitespace-separated word tokens (`w0`, `w1`, ...). */
const manyWords = (n: number): string =>
  Array.from({ length: n }, (_, i) => `w${i.toString()}`).join(" ");

describe("chunker / chunkNote", () => {
  it("returns an empty array for an empty source", () => {
    expect(chunkNote("/v/a.md", "")).toEqual([]);
    expect(chunkNote("/v/a.md", "   \n\n  \t  ")).toEqual([]);
  });

  it("produces a single chunk for a short section (no windowing)", () => {
    const src = "# Title\n\nShort body under the heading.";
    const chunks = chunkNote("/v/note.md", src);
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c?.heading).toBe("Title");
    expect(c?.chunkIndex).toBe(0);
    expect(c?.rawText).toContain("Short body");
    // Text and rawText should match when no title option is provided.
    expect(c?.text).toBe(c?.rawText);
  });

  it("assigns heading: null to content preceding the first heading", () => {
    const src = "Some intro text before any heading.\n\n# Real Heading\n\nBody here.";
    const chunks = chunkNote("/v/n.md", src);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.rawText).toContain("Some intro text");
    const realHeadingChunks = chunks.filter((c) => c.heading === "Real Heading");
    expect(realHeadingChunks.length).toBeGreaterThan(0);
  });

  it("tracks the nearest ancestor heading for nested headings", () => {
    // A section opens at `# A` and extends through `## A.1` until `# B`.
    // Every chunk in that section should have heading = "A" — not "A.1"
    // — because section-level splitting uses same-or-shallower depth.
    const src = `# A

Body of A.

## A.1

Body of A.1.

# B

Body of B.
`;
    const chunks = chunkNote("/v/n.md", src);
    const headings = chunks.map((c) => c.heading);
    // At least one chunk for section A (which includes A.1 content) and one for B.
    expect(headings).toContain("A");
    expect(headings).toContain("B");
    // No chunk should be labelled "A.1" — the sub-heading is absorbed into section A.
    expect(headings).not.toContain("A.1");
  });

  it("splits two top-level sections into independent chunks with correct headings", () => {
    const src = `# Alpha

Alpha body.

# Beta

Beta body.
`;
    const chunks = chunkNote("/v/n.md", src);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.heading).toBe("Alpha");
    expect(chunks[1]?.heading).toBe("Beta");
    expect(chunks[0]?.rawText).toContain("Alpha body");
    expect(chunks[1]?.rawText).toContain("Beta body");
  });

  it("windows a long section with the documented overlap", () => {
    // A single heading with a very long body: 500 "words".
    const body = manyWords(500);
    const src = `# Long\n\n${body}`;
    const chunks = chunkNote("/v/n.md", src, { windowTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should live under the same heading.
    for (const c of chunks) expect(c.heading).toBe("Long");

    // Overlap: the LAST overlapTokens tokens of chunk N should match the
    // FIRST overlapTokens tokens of chunk N+1.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (prev === undefined || next === undefined) continue;
      const prevTokens = prev.rawText.split(/\s+/).filter(Boolean);
      const nextTokens = next.rawText.split(/\s+/).filter(Boolean);
      // The final chunk may be shorter than overlapTokens; only check when both sides have enough.
      if (prevTokens.length < 20 || nextTokens.length < 20) continue;
      const prevTail = prevTokens.slice(-20);
      const nextHead = nextTokens.slice(0, 20);
      expect(nextHead).toEqual(prevTail);
    }
  });

  it("DEFAULT_WINDOW_TOKENS and DEFAULT_OVERLAP_TOKENS expose PLAN defaults", () => {
    expect(DEFAULT_WINDOW_TOKENS).toBe(200);
    expect(DEFAULT_OVERLAP_TOKENS).toBe(40);
  });

  it("prepends `title` to `text` but leaves `rawText` untouched", () => {
    const src = "# H\n\nBody content here.";
    const chunks = chunkNote("/v/n.md", src, { title: "My Note" });
    const [c] = chunks;
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.text.startsWith("My Note\n\n")).toBe(true);
    expect(c.text.includes("Body content here")).toBe(true);
    expect(c.rawText.startsWith("My Note")).toBe(false);
    expect(c.rawText).toContain("Body content here");
  });

  it("substitutes wikilinks with resolved titles when a vaultIndex is supplied", () => {
    const vaultIndex = buildVaultIndex(["/v/Foo Note.md", "/v/bar.md"]);
    const src = "# H\n\nLink to [[Foo Note]] and to [[bar|the bar]].";
    const chunks = chunkNote("/v/n.md", src, { vaultIndex });
    const [c] = chunks;
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.rawText).toContain("Foo Note");
    expect(c.rawText).not.toContain("[[Foo Note]]");
    expect(c.rawText).toContain("bar");
    expect(c.rawText).not.toContain("[[bar|the bar]]");
  });

  it("leaves wikilinks verbatim when no vaultIndex is provided", () => {
    const src = "# H\n\nLink to [[Foo Note]].";
    const chunks = chunkNote("/v/n.md", src);
    const [c] = chunks;
    expect(c?.rawText).toContain("[[Foo Note]]");
  });

  it("leaves unresolvable wikilinks verbatim", () => {
    const vaultIndex = buildVaultIndex(["/v/only.md"]);
    const src = "# H\n\nLink to [[nonexistent]].";
    const chunks = chunkNote("/v/n.md", src, { vaultIndex });
    const [c] = chunks;
    expect(c?.rawText).toContain("[[nonexistent]]");
  });

  it("produces deterministic ids for identical inputs", () => {
    const src = "# A\n\nx\n\n# B\n\ny";
    const first = chunkNote("/v/path.md", src);
    const second = chunkNote("/v/path.md", src);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    // Different notePath → different ids.
    const third = chunkNote("/v/other.md", src);
    expect(first[0]?.id).not.toBe(third[0]?.id);
  });

  it("reports 1-indexed startLine/endLine ordered ascending within the note", () => {
    const src = `# A

line2
line3

# B

line6
line7
`;
    const chunks = chunkNote("/v/n.md", src);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
    // Chunk ordering is monotonically increasing by startLine.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (prev === undefined || next === undefined) continue;
      expect(next.startLine).toBeGreaterThanOrEqual(prev.startLine);
    }
  });

  it("rejects invalid window/overlap options", () => {
    expect(() => chunkNote("/v/n.md", "x", { windowTokens: 0 })).toThrow(RangeError);
    expect(() => chunkNote("/v/n.md", "x", { windowTokens: 10, overlapTokens: 10 })).toThrow(
      RangeError,
    );
    expect(() => chunkNote("/v/n.md", "x", { windowTokens: 10, overlapTokens: -1 })).toThrow(
      RangeError,
    );
  });
});
