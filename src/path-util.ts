/**
 * Shared path / string / frontmatter utilities used across the keyword,
 * graph, and resolver layers. This is a LEAF module — it must not import
 * from any feature layer (`keyword/`, `graph/`, `semantic/`, `hybrid/`,
 * `tools/`, `resources/`, `watcher/`, `server.ts`).
 *
 * Every helper here was previously duplicated inline across feature files
 * (Wave 3 review findings L1/L2). Extracting them keeps behavior identical
 * while giving us one place to test and maintain.
 */

import { realpath } from "node:fs/promises";
import { dirname, relative, resolve as resolvePath, sep as pathSep } from "node:path";

import { parseFrontmatter } from "./parse/frontmatter.js";

/**
 * Return `true` if `candidate` is the vault root itself, or a path nested
 * inside it. Works with relative paths (they are resolved first) and uses
 * the platform-appropriate separator to avoid the `/vault` vs `/vault2`
 * prefix-collision class of bug.
 *
 * TRADEOFF (see also {@link isInsideVaultAsync}): this variant performs a
 * textual `resolve()` + `startsWith(vault + sep)` check. It is synchronous
 * and fast, but is vulnerable to a symlink-escape class of bug: a symlink
 * inside the vault that points to an outside directory (e.g.
 * `<vault>/escape -> /etc`) passes the textual check yet, when followed,
 * lands outside the vault on disk.
 *
 * Safe to use for paths that were DISCOVERED by us (fast-glob output,
 * chokidar events scoped by the watcher's `ignored:` predicate) — those
 * have already been traversal-filtered to be inside the vault on disk.
 * For USER-CONTROLLED input (MCP tool params), prefer
 * {@link isInsideVaultAsync}, which canonicalizes via `fs.realpath`.
 */
export const isInsideVault = (candidate: string, vaultPath: string): boolean => {
  const c = resolvePath(candidate);
  const v = resolvePath(vaultPath);
  if (c === v) return true;
  return c.startsWith(v + pathSep);
};

/**
 * Realpath-aware variant of {@link isInsideVault}: resolves both sides via
 * `fs.realpath` before the prefix comparison, so a symlink that LOOKS like
 * it lives inside the vault but resolves outside is correctly rejected.
 *
 * Fallback on ENOENT: when the candidate path does not yet exist on disk
 * (the canonical case is a chokidar `'add'` event fired before the file's
 * parent has been fully flushed, or a caller probing a path it intends to
 * create), we fall back to the textual behavior of the sync variant —
 * comparing `path.resolve(candidate)` against `path.resolve(vaultPath)`.
 * A path that does not exist cannot be a symlink, so this fallback is
 * safe; we match BOTH sides textually so the comparison is well-defined
 * on systems where the tmpdir or home lives behind a system symlink
 * (e.g. macOS `/var -> /private/var`).
 *
 * The VAULT path is realpath'd on the happy path: a legitimate setup
 * where the user points `FOAM_VAULT_PATH` at a symlink
 * (e.g. `~/notes -> ~/Dropbox/notes`) must still have all interior
 * paths recognized as "inside the vault". Canonicalization here absorbs
 * that level of indirection cleanly.
 *
 * Use this at every tool boundary that accepts user-controlled paths.
 */
export async function isInsideVaultAsync(candidate: string, vaultPath: string): Promise<boolean> {
  const vaultResolved = await realpath(resolvePath(vaultPath));
  let candidateResolved: string;
  try {
    candidateResolved = await realpath(resolvePath(candidate));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Path doesn't exist on disk yet — fall back to textual comparison
      // on BOTH sides so the prefix check is well-defined even when the
      // vault lives behind a system-level symlink. A non-existent path
      // can't be a symlink, so this fallback is safe.
      const vaultTextual = resolvePath(vaultPath);
      const candidateTextual = resolvePath(candidate);
      if (candidateTextual === vaultTextual) return true;
      return candidateTextual.startsWith(vaultTextual + pathSep);
    }
    throw err;
  }
  if (candidateResolved === vaultResolved) return true;
  return candidateResolved.startsWith(vaultResolved + pathSep);
}

/**
 * Tiny glob→regex converter. Handles `*` (zero-or-more), `?` (exactly one),
 * and literal-escapes every regex-special character. Deliberately minimal:
 * matches the subset of glob syntax used for MOC-pattern detection
 * (`*-MOC.md` and similar). If richer glob semantics are ever needed,
 * swap this for `micromatch` at the call sites.
 */
export const globToRegex = (glob: string): RegExp => {
  let pattern = "";
  for (const ch of glob) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else if (/[.\\+^$|()[\]{}]/.test(ch)) pattern += "\\" + ch;
    else pattern += ch;
  }
  return new RegExp("^" + pattern + "$");
};

/**
 * Return the POSIX-style relative folder of `absPath` from the vault root.
 * Root-level notes get `"."` (consistent JSON output across platforms).
 * Separators are normalized to `/` so graph-layer output doesn't depend on
 * the host OS.
 */
export const relativeFolder = (absPath: string, vaultPath: string): string => {
  const rel = relative(vaultPath, dirname(absPath));
  return rel === "" ? "." : rel.split(pathSep).join("/");
};

/**
 * Derive a display title for a note. Prefers a non-empty `title` entry in
 * the note's frontmatter; falls back to the supplied basename (typically
 * the filename minus `.md`).
 */
export const deriveTitle = (fm: Record<string, unknown>, fallback: string): string => {
  const raw = fm.title;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return fallback;
};

/**
 * Parse a markdown source's frontmatter defensively: any parse failure
 * (malformed YAML, unexpected content) yields an empty object rather than
 * throwing. Callers that need to distinguish "absent" from "malformed"
 * should use `parseFrontmatter` directly.
 */
export const safeParseFrontmatter = (src: string): { data: Record<string, unknown> } => {
  try {
    return { data: parseFrontmatter(src).data };
  } catch {
    return { data: {} };
  }
};
