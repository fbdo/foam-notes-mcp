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

import { dirname, relative, resolve as resolvePath, sep as pathSep } from "node:path";

import { parseFrontmatter } from "./parse/frontmatter.js";

/**
 * Return `true` if `candidate` is the vault root itself, or a path nested
 * inside it. Works with relative paths (they are resolved first) and uses
 * the platform-appropriate separator to avoid the `/vault` vs `/vault2`
 * prefix-collision class of bug.
 */
export const isInsideVault = (candidate: string, vaultPath: string): boolean => {
  const c = resolvePath(candidate);
  const v = resolvePath(vaultPath);
  if (c === v) return true;
  return c.startsWith(v + pathSep);
};

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
