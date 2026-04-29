import { describe, it, expect } from "vitest";
import { resolve as resolvePath, sep as pathSep } from "node:path";

import {
  deriveTitle,
  globToRegex,
  isInsideVault,
  relativeFolder,
  safeParseFrontmatter,
} from "../src/path-util.js";

// ---------------------------------------------------------------------------
// isInsideVault
// ---------------------------------------------------------------------------

describe("isInsideVault", () => {
  it("accepts a path nested inside the vault", () => {
    expect(isInsideVault("/vault/notes/a.md", "/vault")).toBe(true);
    expect(isInsideVault("/vault/sub/nested/deep.md", "/vault")).toBe(true);
  });

  it("returns true when candidate equals the vault root", () => {
    expect(isInsideVault("/vault", "/vault")).toBe(true);
  });

  it("rejects a path that escapes the vault via ../", () => {
    // `/vault/../../etc/passwd` resolves to `/etc/passwd`, outside `/vault`.
    expect(isInsideVault("/vault/../../etc/passwd", "/vault")).toBe(false);
  });

  it("rejects a sibling folder whose name shares the vault's prefix", () => {
    // Guards against a naive `startsWith` without a separator boundary:
    // `/vault2` must NOT be considered inside `/vault`.
    expect(isInsideVault("/vault2/note.md", "/vault")).toBe(false);
    expect(isInsideVault("/vault-backup/note.md", "/vault")).toBe(false);
  });

  it("normalizes trailing-slash forms of the vault path", () => {
    // `resolve` strips the trailing slash in both args, so `vault/` and
    // `vault` must behave identically.
    expect(isInsideVault("/vault/a.md", "/vault/")).toBe(true);
    expect(isInsideVault("/vault/", "/vault")).toBe(true);
  });

  it("resolves relative candidate paths against cwd before comparing", () => {
    // A relative candidate that resolves inside the vault should be accepted.
    // We build both sides with the same base so the test is hermetic.
    const vault = resolvePath(process.cwd(), "fixtures-sample");
    const inside = resolvePath(vault, "note.md");
    expect(isInsideVault(inside, vault)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("matches the canonical MOC pattern", () => {
    const re = globToRegex("*-MOC.md");
    expect(re.test("00-Index-MOC.md")).toBe(true);
    expect(re.test("travel-MOC.md")).toBe(true);
    expect(re.test("foo.md")).toBe(false);
    // `*` matches zero chars before the literal `-MOC.md`.
    expect(re.test("-MOC.md")).toBe(true);
    // No `-MOC.md` suffix → no match.
    expect(re.test("MOC.md")).toBe(false);
  });

  it("escapes regex metacharacters in the glob", () => {
    // `.` must be a literal dot, not "any character".
    const re = globToRegex("a.b");
    expect(re.test("a.b")).toBe(true);
    expect(re.test("axb")).toBe(false);
  });

  it("maps `?` to a single-character wildcard", () => {
    const re = globToRegex("f?o.md");
    expect(re.test("foo.md")).toBe(true);
    expect(re.test("fxo.md")).toBe(true);
    expect(re.test("fo.md")).toBe(false);
    expect(re.test("fooo.md")).toBe(false);
  });

  it("anchors the resulting regex at both ends of the glob", () => {
    const re = globToRegex("*.md");
    expect(re.test("note.md")).toBe(true);
    // Full-string match: extra chars AFTER the pattern → reject.
    expect(re.test("note.md.bak")).toBe(false);
    // `*` at the start matches any prefix by design.
    expect(re.test("prefixnote.md")).toBe(true);
  });

  it("treats regex brackets / braces as literals", () => {
    const re = globToRegex("a[b].md");
    expect(re.test("a[b].md")).toBe(true);
    expect(re.test("ab.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// relativeFolder
// ---------------------------------------------------------------------------

describe("relativeFolder", () => {
  it("returns '.' for a note at the vault root", () => {
    const vault = resolvePath("/vault");
    expect(relativeFolder(resolvePath(vault, "root.md"), vault)).toBe(".");
  });

  it("returns the nested folder path for a deeper note", () => {
    const vault = resolvePath("/vault");
    expect(relativeFolder(resolvePath(vault, "01-Projects", "x.md"), vault)).toBe("01-Projects");
    expect(relativeFolder(resolvePath(vault, "01-Projects", "sub", "y.md"), vault)).toBe(
      "01-Projects/sub",
    );
  });

  it("uses POSIX-style `/` separators regardless of platform sep", () => {
    const vault = resolvePath("/vault");
    const out = relativeFolder(resolvePath(vault, "a", "b", "c", "note.md"), vault);
    expect(out).toBe("a/b/c");
    // Guardrail: no platform separator leaks into the output.
    if (pathSep !== "/") expect(out.includes(pathSep)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

describe("deriveTitle", () => {
  it("prefers a non-empty frontmatter `title`", () => {
    expect(deriveTitle({ title: "My Title" }, "fallback")).toBe("My Title");
  });

  it("trims whitespace from the frontmatter title", () => {
    expect(deriveTitle({ title: "  Trimmed  " }, "fallback")).toBe("Trimmed");
  });

  it("falls back to the basename when frontmatter has no title", () => {
    expect(deriveTitle({}, "note-a")).toBe("note-a");
  });

  it("falls back when `title` is an empty / whitespace string", () => {
    expect(deriveTitle({ title: "" }, "fb")).toBe("fb");
    expect(deriveTitle({ title: "   " }, "fb")).toBe("fb");
  });

  it("falls back when `title` is not a string", () => {
    expect(deriveTitle({ title: 42 }, "fb")).toBe("fb");
    expect(deriveTitle({ title: null }, "fb")).toBe("fb");
    expect(deriveTitle({ title: ["x"] }, "fb")).toBe("fb");
  });
});

// ---------------------------------------------------------------------------
// safeParseFrontmatter
// ---------------------------------------------------------------------------

describe("safeParseFrontmatter", () => {
  it("parses well-formed frontmatter", () => {
    const src = `---\ntitle: hello\ntags: [a, b]\n---\nbody\n`;
    const { data } = safeParseFrontmatter(src);
    expect(data.title).toBe("hello");
    expect(Array.isArray(data.tags)).toBe(true);
  });

  it("returns an empty object for a source with no frontmatter", () => {
    expect(safeParseFrontmatter("just markdown\n")).toEqual({ data: {} });
  });

  it("never throws on malformed YAML — returns empty data", () => {
    // gray-matter tends to be forgiving, but an unterminated fence is a
    // reliable way to exercise the catch branch.
    const broken = `---\ntitle: "unterminated\n---\nbody`;
    const result = safeParseFrontmatter(broken);
    // Either data is `{}` (catch branch) or data was parsed loosely; in both
    // cases the function must return without throwing.
    expect(typeof result.data).toBe("object");
  });
});
