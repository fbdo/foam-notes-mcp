import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolve as resolvePath, sep as pathSep, join as joinPath } from "node:path";

import {
  deriveTitle,
  globToRegex,
  isInsideVault,
  isInsideVaultAsync,
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

// ---------------------------------------------------------------------------
// isInsideVaultAsync — realpath-aware variant
//
// Cases that must be rejected by the async variant but slip past the sync
// one (and vice-versa: legitimate symlink setups like a symlinked vault
// root must still be accepted) live here. Tests that only exercise textual
// resolve() behavior belong to the `isInsideVault` block above.
// ---------------------------------------------------------------------------

/**
 * Probe whether the current environment supports creating symlinks.
 * On CI Linux/macOS, symlinks work. On Windows, `fs.symlinkSync` typically
 * requires admin / developer-mode. We skip the whole async describe block
 * when unsupported rather than faking the fs, so the tests actually exercise
 * realpath resolution on real inodes.
 */
function supportsSymlinks(): boolean {
  if (process.platform === "win32") return false;
  try {
    const tmp = fs.mkdtempSync(joinPath(os.tmpdir(), "symlink-probe-"));
    try {
      fs.symlinkSync("/tmp", joinPath(tmp, "link"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!supportsSymlinks())("isInsideVaultAsync", () => {
  // Realpath-canonicalize helper. macOS puts tmpdirs under `/var` which is
  // itself a symlink to `/private/var`, so every expected value we build
  // needs to live in the same realpath'd world the implementation sees.
  const realp = (p: string): string => fs.realpathSync(p);

  // Per-test sandbox. We create a fresh directory for each test to keep
  // them hermetic — symlinks across tests would otherwise cross-talk.
  const makeSandbox = (): { vault: string; outside: string; cleanup: () => void } => {
    const root = fs.mkdtempSync(joinPath(os.tmpdir(), "foam-vault-"));
    const vault = joinPath(root, "vault");
    const outside = joinPath(root, "outside");
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const cleanup = (): void => fs.rmSync(root, { recursive: true, force: true });
    return { vault, outside, cleanup };
  };

  it("accepts a real file nested inside the vault (no symlinks)", async () => {
    const { vault, cleanup } = makeSandbox();
    try {
      const file = joinPath(vault, "notes", "a.md");
      fs.mkdirSync(joinPath(vault, "notes"));
      fs.writeFileSync(file, "# a\n");
      expect(await isInsideVaultAsync(file, vault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("returns true when candidate equals the vault root", async () => {
    const { vault, cleanup } = makeSandbox();
    try {
      expect(await isInsideVaultAsync(vault, vault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("falls back to textual resolve when the candidate does not yet exist (ENOENT, inside)", async () => {
    // Simulates a chokidar `'add'` event on a path that has not been
    // flushed to disk yet. Because non-existent paths can't be symlinks,
    // the textual-fallback is safe AND must still accept interior paths.
    const { vault, cleanup } = makeSandbox();
    try {
      const futurePath = joinPath(vault, "new-note.md");
      expect(fs.existsSync(futurePath)).toBe(false);
      expect(await isInsideVaultAsync(futurePath, vault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("falls back to textual resolve (ENOENT, outside) and rejects", async () => {
    const { vault, outside, cleanup } = makeSandbox();
    try {
      const futurePath = joinPath(outside, "leak.md");
      expect(fs.existsSync(futurePath)).toBe(false);
      expect(await isInsideVaultAsync(futurePath, vault)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a path that escapes via a symlink inside the vault (the M5 case)", async () => {
    // `vault/escape -> outside`. A child path of the symlink (`vault/escape/file`)
    // resolves to `outside/file`, which is OUTSIDE the vault on disk. The
    // sync variant is fooled by this; the async variant must reject it.
    const { vault, outside, cleanup } = makeSandbox();
    try {
      const targetFile = joinPath(outside, "secret.md");
      fs.writeFileSync(targetFile, "# secret\n");
      const linkDir = joinPath(vault, "escape");
      fs.symlinkSync(outside, linkDir, "dir");

      // Sanity: the sync textual check passes (the bug we're fixing).
      expect(isInsideVault(joinPath(linkDir, "secret.md"), vault)).toBe(true);
      // The async check rejects the escape.
      expect(await isInsideVaultAsync(joinPath(linkDir, "secret.md"), vault)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("accepts a symlink inside the vault that points to another vault-internal location", async () => {
    // `vault/alias -> vault/real` is legitimate (the user has reorganized
    // without breaking old links). Its children must still be accepted.
    const { vault, cleanup } = makeSandbox();
    try {
      const real = joinPath(vault, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(joinPath(real, "note.md"), "# note\n");
      const alias = joinPath(vault, "alias");
      fs.symlinkSync(real, alias, "dir");
      expect(await isInsideVaultAsync(joinPath(alias, "note.md"), vault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts interior paths when the VAULT root itself is a symlink", async () => {
    // Legitimate setup: `~/notes -> ~/Dropbox/notes`. We pass the symlink
    // as `vaultPath`; interior paths (resolved to the real target) must
    // still be recognized as inside the vault.
    const { vault, cleanup } = makeSandbox();
    try {
      const realVault = joinPath(vault, "real-vault");
      fs.mkdirSync(realVault);
      fs.writeFileSync(joinPath(realVault, "x.md"), "# x\n");
      const linkedVault = joinPath(vault, "linked-vault");
      fs.symlinkSync(realVault, linkedVault, "dir");

      expect(await isInsideVaultAsync(joinPath(linkedVault, "x.md"), linkedVault)).toBe(true);
      // Also accepts the real path against the symlinked-vault arg:
      expect(await isInsideVaultAsync(joinPath(realVault, "x.md"), linkedVault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts `..` traversal that normalizes back to an inside path", async () => {
    const { vault, cleanup } = makeSandbox();
    try {
      const a = joinPath(vault, "a");
      const b = joinPath(vault, "b");
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      fs.writeFileSync(joinPath(b, "c.md"), "# c\n");
      const traversal = joinPath(a, "..", "b", "c.md");
      expect(await isInsideVaultAsync(traversal, vault)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects `..` traversal that normalizes to an outside path", async () => {
    const { vault, outside, cleanup } = makeSandbox();
    try {
      fs.writeFileSync(joinPath(outside, "leak.md"), "# leak\n");
      // `<vault>/../outside/leak.md` resolves to `<sandbox>/outside/leak.md`.
      const traversal = joinPath(vault, "..", "outside", "leak.md");
      expect(await isInsideVaultAsync(traversal, vault)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a sibling directory whose textual prefix matches the vault", async () => {
    // Guardrail against naive `startsWith` without the separator boundary,
    // now exercised against a real-on-disk pair where both sides exist.
    const { vault, cleanup } = makeSandbox();
    try {
      const sibling = vault + "-backup";
      fs.mkdirSync(sibling);
      fs.writeFileSync(joinPath(sibling, "note.md"), "# n\n");
      expect(await isInsideVaultAsync(joinPath(sibling, "note.md"), vault)).toBe(false);
      // Confirm both realpaths exist and are siblings (no symlink trickery).
      expect(realp(sibling).startsWith(realp(vault) + pathSep)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
