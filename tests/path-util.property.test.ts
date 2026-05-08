/**
 * Property-based tests for path utilities using fast-check.
 *
 * Invariants tested for isInsideVault, globToRegex, relativeFolder, deriveTitle.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isInsideVault, globToRegex, relativeFolder, deriveTitle } from "../src/path-util.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_".split("") as string[];

/** A single path segment: lowercase alphanumeric, `-`, `_`. No dots or slashes. */
const segment = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 20 })
  .map((arr) => arr.join(""));

/** An absolute POSIX-style path like `/seg1/seg2/...` */
const absPath = fc
  .tuple(segment, fc.array(segment, { minLength: 0, maxLength: 4 }))
  .map(([first, rest]) => "/" + [first, ...rest].join("/"));

// ---------------------------------------------------------------------------
// isInsideVault
// ---------------------------------------------------------------------------

describe("isInsideVault – property-based", () => {
  it("reflexivity: isInsideVault(vault, vault) is always true", () => {
    expect(() =>
      fc.assert(fc.property(absPath, (vault) => isInsideVault(vault, vault) === true)),
    ).not.toThrow();
  });

  it("child containment: vault/child is always inside vault for clean child segments", () => {
    expect(() =>
      fc.assert(
        fc.property(
          absPath,
          segment,
          (vault, child) => isInsideVault(vault + "/" + child, vault) === true,
        ),
      ),
    ).not.toThrow();
  });

  it("prefix collision safety: /a/bc is NOT inside /a/b (no separator collision)", () => {
    expect(() =>
      fc.assert(
        fc.property(absPath, segment, (vault, suffix) => {
          // vault + suffix without a slash is a different node, never inside vault
          const candidate = vault + suffix;
          return isInsideVault(candidate, vault) === false;
        }),
      ),
    ).not.toThrow();
  });

  it("sibling path sharing a prefix is always rejected", () => {
    expect(() =>
      fc.assert(
        fc.property(absPath, segment, (vault, extra) => {
          const sibling = vault + extra + "/note.md";
          return isInsideVault(sibling, vault) === false;
        }),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe("globToRegex – property-based", () => {
  it("every produced regex is anchored (starts with ^ and ends with $)", () => {
    expect(() =>
      fc.assert(
        fc.property(fc.string(), (glob) => {
          const re = globToRegex(glob);
          return re.source.startsWith("^") && re.source.endsWith("$");
        }),
      ),
    ).not.toThrow();
  });

  it("literal passthrough: a string without * or ? matches itself", () => {
    const literalString = fc
      .array(fc.constantFrom(...SAFE_CHARS), { minLength: 0, maxLength: 30 })
      .map((arr) => arr.join(""));
    expect(() =>
      fc.assert(fc.property(literalString, (s) => globToRegex(s).test(s))),
    ).not.toThrow();
  });

  it("star match: *<suffix> matches any <prefix><suffix> where prefix has no /", () => {
    const safePart = fc
      .array(fc.constantFrom(...SAFE_CHARS), { minLength: 0, maxLength: 20 })
      .map((arr) => arr.join(""));
    expect(() =>
      fc.assert(
        fc.property(safePart, safePart, (prefix, suffix) =>
          globToRegex("*" + suffix).test(prefix + suffix),
        ),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// relativeFolder
// ---------------------------------------------------------------------------

describe("relativeFolder – property-based", () => {
  it("output never starts with / (always relative)", () => {
    expect(() =>
      fc.assert(
        fc.property(absPath, absPath, (vaultPath, notePath) => {
          const nested = vaultPath + "/" + notePath.slice(1) + "/note.md";
          return !relativeFolder(nested, vaultPath).startsWith("/");
        }),
      ),
    ).not.toThrow();
  });

  it("output never contains backslashes (always POSIX separators)", () => {
    expect(() =>
      fc.assert(
        fc.property(
          absPath,
          segment,
          fc.array(segment, { minLength: 0, maxLength: 3 }),
          (vault, file, dirs) => {
            const nested = [vault, ...dirs, file + ".md"].join("/");
            return !relativeFolder(nested, vault).includes("\\");
          },
        ),
      ),
    ).not.toThrow();
  });

  it("root-level note yields '.'", () => {
    expect(() =>
      fc.assert(
        fc.property(
          absPath,
          segment,
          (vault, file) => relativeFolder(vault + "/" + file + ".md", vault) === ".",
        ),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

describe("deriveTitle – property-based", () => {
  it("when fm.title is a non-empty string result equals fm.title.trim()", () => {
    const nonEmptyTitle = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);
    expect(() =>
      fc.assert(
        fc.property(
          nonEmptyTitle,
          fc.string(),
          (title, fallback) => deriveTitle({ title }, fallback) === title.trim(),
        ),
      ),
    ).not.toThrow();
  });

  it("when fm.title is absent, result equals the fallback", () => {
    expect(() =>
      fc.assert(fc.property(fc.string(), (fallback) => deriveTitle({}, fallback) === fallback)),
    ).not.toThrow();
  });

  it("when fm.title is an empty or whitespace-only string, result equals the fallback", () => {
    const whitespaceOnly = fc
      .array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 10 })
      .map((arr) => arr.join(""));
    expect(() =>
      fc.assert(
        fc.property(
          whitespaceOnly,
          fc.string(),
          (title, fallback) => deriveTitle({ title }, fallback) === fallback,
        ),
      ),
    ).not.toThrow();
  });

  it("when fm.title is not a string (number, null, array, etc.), result equals the fallback", () => {
    const nonString = fc.oneof(
      fc.integer(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.string()),
      fc.boolean(),
    );
    expect(() =>
      fc.assert(
        fc.property(
          nonString,
          fc.string(),
          (title, fallback) => deriveTitle({ title }, fallback) === fallback,
        ),
      ),
    ).not.toThrow();
  });
});
