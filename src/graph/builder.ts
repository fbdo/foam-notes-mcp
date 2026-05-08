/**
 * Graph builder: scan a vault, parse every markdown file, and construct a
 * `graphology` `DirectedGraph` whose nodes are notes (and unresolved
 * wikilink targets represented as `placeholder:<target>` nodes) and whose
 * edges carry the source position of each wikilink occurrence.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import from `parse/`, `resolver.ts`, `cache.ts`, `config.ts`,
 *     `errors.ts`, node built-ins, npm deps.
 *   - MUST NOT import from `keyword/`, `semantic/`, `hybrid/`, `tools/`,
 *     `resources/`, `watcher/`, `server.ts`.
 *   - MUST NOT import from the MCP SDK. Graph modules are SDK-agnostic.
 */

import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import fg from "fast-glob";
import { DirectedGraph } from "graphology";

import { extractTags } from "../parse/tags.js";
import { extractWikilinks, type Wikilink } from "../parse/wikilink.js";
import { deriveTitle, globToRegex, relativeFolder, safeParseFrontmatter } from "../path-util.js";
import {
  buildVaultIndex,
  resolveDirectoryLink,
  resolveWikilink,
  type VaultIndex,
} from "../resolver.js";

/**
 * Default MOC pattern, mirroring `src/config.ts`'s `DEFAULT_MOC_PATTERN`.
 * We re-declare it here (instead of importing `loadConfig`) so this module
 * can be invoked in tests without the config side-effects (ripgrep probe
 * etc.). Keep the two defaults in sync.
 */
const DEFAULT_MOC_PATTERN = "*-MOC.md";

/**
 * Record of a single ambiguous wikilink occurrence on a note. Surfaces the
 * raw link target, every candidate the resolver returned, and the link's
 * source position plus optional alias/heading. Emitted as part of
 * {@link NoteNodeAttrs.ambiguousLinks}; see that field for semantics.
 */
export interface AmbiguousLinkEntry {
  readonly target: string;
  readonly candidates: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly alias?: string;
  readonly heading?: string;
}

/** Node attributes for a real note (resolved file on disk). */
export interface NoteNodeAttrs {
  readonly type: "note";
  readonly title: string;
  readonly basename: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly frontmatter: Record<string, unknown>;
  readonly isMoc: boolean;
  /**
   * Ambiguous wikilinks originating from this note, if any. An ambiguous
   * link resolves to ≥ 2 candidates; we intentionally drop the edge (no
   * placeholder, no arbitrary target) and record the ambiguity here so
   * downstream tools can surface it without conflating ambiguity with
   * broken-link semantics.
   *
   * Semantics: omitted (undefined) when the note has no ambiguous links.
   * Empty arrays are never set — keeps `foam://graph` exports tight.
   */
  readonly ambiguousLinks?: readonly AmbiguousLinkEntry[];
}

/** Node attributes for an unresolved wikilink target. */
export interface PlaceholderNodeAttrs {
  readonly type: "placeholder";
  readonly target: string;
}

/** Edge attributes: one per resolved wikilink occurrence. */
export interface EdgeAttrs {
  readonly line: number;
  readonly column: number;
  readonly alias?: string;
  readonly heading?: string;
}

export type GraphNodeAttrs = NoteNodeAttrs | PlaceholderNodeAttrs;

/** Compute the canonical node id for an unresolved wikilink target. */
export const placeholderId = (target: string): string => `placeholder:${target}`;

/**
 * Build the graphology graph for a vault.
 *
 * @param vaultPath Absolute path to the vault root.
 * @param options.mocPattern Glob for MOC notes; default `*-MOC.md`.
 */
export const buildGraph = async (
  vaultPath: string,
  options?: { readonly mocPattern?: string },
): Promise<DirectedGraph<GraphNodeAttrs, EdgeAttrs>> => {
  const mocPattern = options?.mocPattern ?? DEFAULT_MOC_PATTERN;
  const mocRegex = globToRegex(mocPattern);
  const graph = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();

  const files = await listMarkdownFiles(vaultPath);
  const vaultIndex = buildVaultIndex(files);

  // Pre-read + parse every file once. We reuse the parsed data for both the
  // node attributes and the edge computation below.
  const parsed = await Promise.all(files.map((file) => readAndParseNote(file, vaultPath)));

  // Pass 1: add all note nodes (so edges have a valid target on pass 2).
  for (const note of parsed) {
    graph.addNode(note.path, {
      type: "note",
      title: note.title,
      basename: note.basename,
      folder: note.folder,
      tags: note.tags,
      frontmatter: note.frontmatter,
      isMoc: mocRegex.test(note.basename + ".md"),
    });
  }

  // Pass 2: resolve wikilinks, add edges + placeholders, and collect
  // ambiguous-link entries per note. We apply collected ambiguities to each
  // note node at the end so we can skip the field entirely when empty
  // (keeps the exported graph compact).
  for (const note of parsed) {
    for (const link of note.wikilinks) {
      addEdgeForLink(graph, note.path, link, vaultPath, vaultIndex);
    }
    const ambiguousLinks = collectAmbiguousLinks(note.wikilinks, vaultPath, vaultIndex);
    if (ambiguousLinks.length > 0) {
      const prior = graph.getNodeAttributes(note.path);
      if (prior.type === "note") {
        graph.replaceNodeAttributes(note.path, { ...prior, ambiguousLinks });
      }
    }
  }

  return graph;
};

interface ParsedNote {
  readonly path: string;
  readonly basename: string;
  readonly folder: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly frontmatter: Record<string, unknown>;
  readonly wikilinks: readonly Wikilink[];
}

const readAndParseNote = async (absPath: string, vaultPath: string): Promise<ParsedNote> => {
  const src = await readFile(absPath, "utf8");
  const { data: frontmatter } = safeParseFrontmatter(src);
  const tags = extractTags(src, frontmatter);
  const wikilinks = extractWikilinks(src);
  const base = basename(absPath, ".md");
  const folder = relativeFolder(absPath, vaultPath);
  const title = deriveTitle(frontmatter, base);
  return {
    path: absPath,
    basename: base,
    folder,
    title,
    tags,
    frontmatter,
    wikilinks,
  };
};

const addEdgeForLink = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  sourcePath: string,
  link: Wikilink,
  vaultPath: string,
  vaultIndex: VaultIndex,
): void => {
  const resolution = resolveLinkTarget(link.target, vaultPath, vaultIndex);
  if (resolution.kind === "ambiguous") {
    // Ambiguous → no edge, no placeholder; the pass-2 loop calls
    // collectAmbiguousLinks separately to record the ambiguity on the
    // source note's attributes (conflating ambiguity with broken-link
    // semantics is exactly what this decision avoids).
    return;
  }
  const edgeAttrs = edgeAttrsFromLink(link);
  if (resolution.kind === "unresolved") {
    const pid = placeholderId(resolution.target);
    if (!graph.hasNode(pid)) {
      graph.addNode(pid, { type: "placeholder", target: resolution.target });
    }
    if (!graph.hasEdge(sourcePath, pid)) {
      graph.addDirectedEdge(sourcePath, pid, edgeAttrs);
    }
    return;
  }
  // resolved. For simple `DirectedGraph`, duplicate edges to the same target
  // collapse into one. The fixture has no such duplicates; for real vaults
  // this is an acceptable approximation (PLAN: "one per resolved wikilink"
  // + explicit `DirectedGraph` choice in the Wave 3 brief).
  if (!graph.hasEdge(sourcePath, resolution.target)) {
    graph.addDirectedEdge(sourcePath, resolution.target, edgeAttrs);
  }
};

/** Build an `EdgeAttrs` object from a raw wikilink. Omits optional fields. */
export const edgeAttrsFromLink = (link: Wikilink): EdgeAttrs => ({
  line: link.line,
  column: link.column,
  ...(link.alias !== undefined ? { alias: link.alias } : {}),
  ...(link.heading !== undefined ? { heading: link.heading } : {}),
});

/**
 * Walk a note's wikilinks and return the entries whose resolution is
 * ambiguous (≥ 2 candidates). Shared by the full builder (pass-2 loop) and
 * the incremental updater ({@link updateNote}).
 */
export const collectAmbiguousLinks = (
  wikilinks: readonly Wikilink[],
  vaultPath: string,
  vaultIndex: VaultIndex,
): AmbiguousLinkEntry[] => {
  const out: AmbiguousLinkEntry[] = [];
  for (const link of wikilinks) {
    const resolution = resolveLinkTarget(link.target, vaultPath, vaultIndex);
    if (resolution.kind !== "ambiguous") continue;
    out.push({
      target: link.target,
      candidates: resolution.candidates,
      line: link.line,
      column: link.column,
      ...(link.alias !== undefined ? { alias: link.alias } : {}),
      ...(link.heading !== undefined ? { heading: link.heading } : {}),
    });
  }
  return out;
};

/**
 * Three-way resolution of a wikilink target. Callers pattern-match on `kind`:
 *   - `resolved`   → target is an absolute path; add an edge to it.
 *   - `ambiguous`  → target has ≥ 2 candidates; do NOT add an edge or
 *                    placeholder; the builder records the ambiguity on the
 *                    source note via {@link NoteNodeAttrs.ambiguousLinks}.
 *   - `unresolved` → no candidates; create a placeholder and add an edge.
 *
 * The ambiguity branch intentionally bypasses the directory-link fallback:
 * when the resolver is already confident in multiple matches, the
 * folder/index.md heuristic has no bearing on the author's intent.
 */
export type LinkResolution =
  | { readonly kind: "resolved"; readonly target: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "unresolved"; readonly target: string };

export const resolveLinkTarget = (
  target: string,
  vaultPath: string,
  vaultIndex: VaultIndex,
): LinkResolution => {
  const resolved = resolveWikilink(target, vaultIndex);
  if (resolved.confidence === "ambiguous") {
    return { kind: "ambiguous", candidates: [...resolved.candidates] };
  }
  if (resolved.candidates.length === 1) {
    const only = resolved.candidates[0];
    if (only !== undefined) return { kind: "resolved", target: only };
  }
  // Directory-link fallback is only reached for non-ambiguous, zero-
  // candidate results (i.e. the main ladder returned nothing).
  const dir = resolveDirectoryLink(target, vaultPath, vaultIndex);
  if (dir !== undefined) return { kind: "resolved", target: dir };
  return { kind: "unresolved", target };
};

const listMarkdownFiles = async (vaultPath: string): Promise<string[]> => {
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files.map((f) => resolvePath(f)).sort((a, b) => a.localeCompare(b));
};
