/**
 * Wikilink resolution — Foam-inspired resolution ladder.
 *
 * Given a wikilink `target` (e.g. `note-a`, `02-Areas/note-b`, `Note A`) and
 * a pre-built {@link VaultIndex}, we resolve using these rungs:
 *
 *   c-prime. If `target` contains a `/` (an explicit path prefix written by
 *            the author), try the path-suffix match FIRST. This matches
 *            authorial intent: `[[02-Areas/note-a]]` was written to
 *            disambiguate, so we honor that disambiguation.
 *   a.       exact basename match (case-sensitive)
 *   b.       basename match (case-insensitive)
 *   c.       path-suffix match (for `target` without a `/`, this rung is
 *            skipped — basename rungs already cover that case).
 *   d.       ambiguous → return all candidates with `confidence: "ambiguous"`
 *
 * This file is pure logic: no filesystem access. The `VaultIndex` is built
 * by callers (typically the keyword/graph layer) from the vault's note set.
 * It must not import from any feature layer.
 *
 * Target normalization rules:
 *   - A trailing `.md` extension (if present) is stripped before comparison.
 *   - A leading `./` is stripped.
 *   - Backslashes are normalized to forward slashes (handles legacy notes
 *     migrated from Windows vaults).
 *   - `#heading` and `#^anchor` suffixes must be stripped by the CALLER
 *     (wikilink parse already separates heading from target).
 */

import { basename, resolve as resolvePath } from "node:path";

import { isInsideVault } from "./path-util.js";

/**
 * Fast lookup structure. `byBasename` maps basename (with `.md` stripped,
 * case-preserved) to all absolute paths sharing that basename. `allPaths` is
 * the flat list of known notes, used for the path-suffix rung.
 */
export interface VaultIndex {
  /** basename (no `.md`) → absolute paths with that basename. */
  readonly byBasename: ReadonlyMap<string, readonly string[]>;
  /** lowercase basename (no `.md`) → absolute paths with that basename. */
  readonly byBasenameLower: ReadonlyMap<string, readonly string[]>;
  /** Every absolute path in the vault. */
  readonly allPaths: readonly string[];
}

export type ResolveConfidence = "exact" | "case-insensitive" | "suffix" | "ambiguous" | "none";

export interface ResolveResult {
  /**
   * All candidate absolute paths matching the target. Empty when no rung
   * matched. When `confidence === "ambiguous"`, length is ≥ 2.
   */
  readonly candidates: readonly string[];
  /** Which rung produced the match. `"none"` when nothing matched. */
  readonly confidence: ResolveConfidence;
}

/**
 * Build a `VaultIndex` from a list of absolute paths.
 * Convenience helper so callers don't re-implement the same indexing logic.
 */
export const buildVaultIndex = (paths: readonly string[]): VaultIndex => {
  const byBasename = new Map<string, string[]>();
  const byBasenameLower = new Map<string, string[]>();
  for (const p of paths) {
    const base = stripMdExtension(basename(p));
    pushToMap(byBasename, base, p);
    pushToMap(byBasenameLower, base.toLowerCase(), p);
  }
  return {
    byBasename: freezeMap(byBasename),
    byBasenameLower: freezeMap(byBasenameLower),
    allPaths: [...paths],
  };
};

/**
 * Resolve a wikilink `target` against a vault index using the Foam-inspired
 * ladder. See module docstring.
 */
export const resolveWikilink = (target: string, vaultIndex: VaultIndex): ResolveResult => {
  const normalized = normalizeTarget(target);
  if (normalized === "") return { candidates: [], confidence: "none" };

  const normBase = stripMdExtension(basename(normalized));
  const hasPathSegments = normalized.includes("/");

  // When the target specifies a path prefix (e.g. `a/doc` or `02-Areas/note-a`),
  // try the suffix rung FIRST — the author wrote a disambiguated target on
  // purpose. We fall back to basename rungs only if the suffix doesn't hit.
  if (hasPathSegments) {
    const suffixHits = matchBySuffix(normalized, vaultIndex.allPaths);
    if (suffixHits.length === 1) {
      return { candidates: suffixHits, confidence: "suffix" };
    }
    if (suffixHits.length > 1) {
      return { candidates: suffixHits, confidence: "ambiguous" };
    }
  }

  // Rung a: exact basename match (case-sensitive).
  const exact = vaultIndex.byBasename.get(normBase);
  if (exact && exact.length === 1) {
    return { candidates: [...exact], confidence: "exact" };
  }
  if (exact && exact.length > 1) {
    return { candidates: [...exact], confidence: "ambiguous" };
  }

  // Rung b: case-insensitive basename match.
  const ci = vaultIndex.byBasenameLower.get(normBase.toLowerCase());
  if (ci && ci.length === 1) {
    return { candidates: [...ci], confidence: "case-insensitive" };
  }
  if (ci && ci.length > 1) {
    return { candidates: [...ci], confidence: "ambiguous" };
  }

  return { candidates: [], confidence: "none" };
};

// --- helpers ---

const stripMdExtension = (name: string): string =>
  name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;

const normalizeTarget = (raw: string): string => {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("./")) t = t.slice(2);
  // Strip a trailing `.md` if explicitly included in the link.
  if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3);
  return t;
};

/**
 * Return all paths whose trailing path segments match the target, split on
 * `/`. Exact-basename hits are excluded from this rung (they would have been
 * caught by rungs a/b); we're here looking for multi-segment suffixes like
 * `02-Areas/note-a`.
 */
const matchBySuffix = (target: string, paths: readonly string[]): string[] => {
  const targetSegments = target.split("/").filter((s) => s.length > 0);
  if (targetSegments.length <= 1) return [];
  const targetSuffix = "/" + targetSegments.join("/");
  const targetSuffixMd = targetSuffix + ".md";
  const out: string[] = [];
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/");
    if (normalized.endsWith(targetSuffix) || normalized.endsWith(targetSuffixMd)) {
      out.push(p);
    }
  }
  return out;
};

const pushToMap = <K, V>(m: Map<K, V[]>, key: K, value: V): void => {
  const arr = m.get(key);
  if (arr) arr.push(value);
  else m.set(key, [value]);
};

const freezeMap = (m: Map<string, string[]>): ReadonlyMap<string, readonly string[]> => {
  const frozen = new Map<string, readonly string[]>();
  for (const [k, v] of m.entries()) frozen.set(k, Object.freeze([...v]));
  return frozen;
};

/**
 * Directory-link fallback: `[[folder]]` → `folder/index.md`, provided the
 * target resolves to an `index.md` inside the vault that actually exists in
 * the supplied index. Returns the absolute path of that `index.md`, or
 * `undefined` when no such file is known to the vault.
 *
 * This is a separate rung below the wikilink ladder because it is opt-in
 * (Foam supports it but not every vault uses folder-as-note). Consumers
 * that care — keyword tools and the graph builder — call
 * `resolveWikilink` first and fall through to this helper only when the
 * main ladder returns no candidates.
 */
export const resolveDirectoryLink = (
  target: string,
  vaultPath: string,
  vaultIndex: VaultIndex,
): string | undefined => {
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "") return undefined;
  const candidate = resolvePath(vaultPath, normalized, "index.md");
  if (!isInsideVault(candidate, vaultPath)) return undefined;
  return vaultIndex.allPaths.find((p) => resolvePath(p) === candidate);
};
