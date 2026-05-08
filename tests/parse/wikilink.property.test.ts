/**
 * Property-based tests for extractWikilinks using fast-check.
 *
 * Invariants tested:
 *   1. Idempotence — two calls on the same source produce identical results
 *   2. Position correctness — line >= 1, column >= 1, positions non-decreasing
 *   3. Code-block safety — wrapping content in a fenced code block suppresses links
 *   4. Count bound — extracted count <= number of `[[` in raw source
 *   5. Target non-empty — every extracted wikilink has a non-empty .target
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractWikilinks } from "../../src/parse/wikilink.js";

describe("extractWikilinks – property-based", () => {
  it("is idempotent: two calls on the same source yield identical results", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          const first = extractWikilinks(src);
          const second = extractWikilinks(src);
          if (first.length !== second.length) return false;
          return first.every(
            (link, i) =>
              link.target === second[i]?.target &&
              link.heading === second[i]?.heading &&
              link.alias === second[i]?.alias &&
              link.line === second[i]?.line &&
              link.column === second[i]?.column,
          );
        }),
      ),
    ).not.toThrow();
  });

  it("position correctness: line >= 1, column >= 1, positions are non-decreasing", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          const links = extractWikilinks(src);
          for (let i = 0; i < links.length; i++) {
            const link = links[i]!;
            if (link.line < 1 || link.column < 1) return false;
            if (i > 0) {
              const prev = links[i - 1]!;
              if (link.line < prev.line) return false;
              if (link.line === prev.line && link.column < prev.column) return false;
            }
          }
          return true;
        }),
      ),
    ).not.toThrow();
  });

  it("code-block safety: wrapping content in a fenced code block produces zero wikilinks", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (content) => {
          // Remove fence-closing sequences and newlines so the block stays intact
          const safe = content.replace(/`{3,}/g, "```").replace(/\n/g, " ");
          const src = "\n```\n" + safe + "\n```\n";
          return extractWikilinks(src).length === 0;
        }),
      ),
    ).not.toThrow();
  });

  it("count bound: extracted link count <= number of [[ in the raw source", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          const links = extractWikilinks(src);
          let doubleBracketCount = 0;
          for (let i = 0; i < src.length - 1; i++) {
            if (src[i] === "[" && src[i + 1] === "[") doubleBracketCount++;
          }
          return links.length <= doubleBracketCount;
        }),
      ),
    ).not.toThrow();
  });

  it("target non-empty: every extracted wikilink has a non-empty .target", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          return extractWikilinks(src).every((link) => link.target.length > 0);
        }),
      ),
    ).not.toThrow();
  });
});
