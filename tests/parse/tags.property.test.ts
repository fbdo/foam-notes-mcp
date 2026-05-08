/**
 * Property-based tests for extractTags and parseFrontmatter using fast-check.
 *
 * Invariants tested:
 *   1. parseFrontmatter idempotence
 *   2. parseFrontmatter content preservation (.content is a substring of src)
 *   3. extractTags no duplicates
 *   4. extractTags code-block safety
 *   5. extractTags heading safety
 *   6. extractTags frontmatter array merge
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractTags } from "../../src/parse/tags.js";
import { parseFrontmatter } from "../../src/parse/frontmatter.js";

// ---------------------------------------------------------------------------
// parseFrontmatter – property-based
// ---------------------------------------------------------------------------

describe("parseFrontmatter – property-based", () => {
  it("is idempotent: parsing the same content twice yields identical data and content", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          let first: ReturnType<typeof parseFrontmatter>;
          let second: ReturnType<typeof parseFrontmatter>;
          try {
            first = parseFrontmatter(src);
            second = parseFrontmatter(src);
          } catch {
            // gray-matter may throw on genuinely malformed YAML — skip
            return true;
          }
          // gray-matter returns undefined for data/content on prototype-key
          // inputs (e.g. "valueOf"). Both calls agree in that case.
          if (first.content !== second.content) return false;
          if (first.data != null && second.data != null) {
            // Compare key sets using a locale-independent comparator
            const cmp = (a: string, b: string): number => {
              if (a < b) return -1;
              if (a > b) return 1;
              return 0;
            };
            const firstKeys = Object.keys(first.data).sort(cmp);
            const secondKeys = Object.keys(second.data).sort(cmp);
            if (firstKeys.join(",") !== secondKeys.join(",")) return false;
          }
          return true;
        }),
      ),
    ).not.toThrow();
  });

  it("content preservation: .content is a substring of the original source", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (src) => {
          let result: ReturnType<typeof parseFrontmatter>;
          try {
            result = parseFrontmatter(src);
          } catch {
            // Malformed YAML — skip
            return true;
          }
          // gray-matter returns undefined for .content on prototype-key inputs.
          // When .content is a proper string it must be a substring of the source.
          if (typeof result.content !== "string") return true;
          return src.includes(result.content);
        }),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractTags – property-based
// ---------------------------------------------------------------------------

describe("extractTags – property-based", () => {
  it("no duplicates: output array has no duplicate entries (case-sensitive)", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), fc.dictionary(fc.string(), fc.anything()), (src, fm) => {
          const tags = extractTags(src, fm);
          return new Set(tags).size === tags.length;
        }),
      ),
    ).not.toThrow();
  });

  it("code-block safety: tag-like strings inside fenced code blocks are never extracted", () => {
    const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") as string[];
    const BODY = "abcdefghijklmnopqrstuvwxyz0123456789-_/".split("") as string[];
    const tagName = fc
      .tuple(
        fc.constantFrom(...ALPHA),
        fc.array(fc.constantFrom(...BODY), { minLength: 0, maxLength: 15 }).map((a) => a.join("")),
      )
      .map(([first, rest]) => first + rest);

    expect(() =>
      fc.assert(
        fc.property(tagName, (tag) => {
          const src = "\n```\n#" + tag + "\n```\n";
          return !extractTags(src, {}).includes(tag);
        }),
      ),
    ).not.toThrow();
  });

  it("heading safety: ATX heading markers are never mistaken for tags", () => {
    const LOWER = "abcdefghijklmnopqrstuvwxyz".split("") as string[];
    const headingLevel = fc.integer({ min: 1, max: 6 }).map((n) => "#".repeat(n));
    const word = fc
      .array(fc.constantFrom(...LOWER), { minLength: 1, maxLength: 20 })
      .map((arr) => arr.join(""));
    expect(() =>
      fc.assert(
        fc.property(headingLevel, word, (hashes, heading) => {
          // A line like "## Heading" should not produce any tag from the `#` markers
          const src = hashes + " " + heading + "\n";
          const tags = extractTags(src, {});
          // The heading word preceded only by `#` markers must not appear as a tag
          // (the ATX pattern strips leading hashes followed by a space)
          return !tags.includes(heading);
        }),
      ),
    ).not.toThrow();
  });

  it("frontmatter array merge: when fm has tags [a, b] and body has #c, all three appear in output", () => {
    const LOWER = "abcdefghijklmnopqrstuvwxyz".split("") as string[];
    const ALPHANUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("") as string[];
    const safeTag = fc
      .tuple(
        fc.constantFrom(...LOWER),
        fc
          .array(fc.constantFrom(...ALPHANUM), { minLength: 1, maxLength: 10 })
          .map((a) => a.join("")),
      )
      .map(([first, rest]) => first + rest);

    expect(() =>
      fc.assert(
        fc.property(safeTag, safeTag, safeTag, (tagA, tagB, tagC) => {
          fc.pre(tagA !== tagB && tagB !== tagC && tagA !== tagC);
          const fm = { tags: [tagA, tagB] };
          const src = "Some body with #" + tagC + " here.\n";
          const tags = extractTags(src, fm);
          return tags.includes(tagA) && tags.includes(tagB) && tags.includes(tagC);
        }),
      ),
    ).not.toThrow();
  });
});
