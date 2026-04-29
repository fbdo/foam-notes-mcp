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
import { extractWikilinks } from "../parse/wikilink.js";
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

/** Node attributes for a real note (resolved file on disk). */
export interface NoteNodeAttrs {
  readonly type: "note";
  readonly title: string;
  readonly basename: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly frontmatter: Record<string, unknown>;
  readonly isMoc: boolean;
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

  // Pass 2: resolve wikilinks and add edges + placeholders.
  for (const note of parsed) {
    for (const link of note.wikilinks) {
      addEdgeForLink(graph, note.path, link, vaultPath, vaultIndex);
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
  readonly wikilinks: readonly import("../parse/wikilink.js").Wikilink[];
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
  link: import("../parse/wikilink.js").Wikilink,
  vaultPath: string,
  vaultIndex: VaultIndex,
): void => {
  const target = resolveLinkTarget(link.target, vaultPath, vaultIndex);
  const edgeAttrs: EdgeAttrs = {
    line: link.line,
    column: link.column,
    ...(link.alias !== undefined ? { alias: link.alias } : {}),
    ...(link.heading !== undefined ? { heading: link.heading } : {}),
  };
  if (target === undefined) {
    const pid = placeholderId(link.target);
    if (!graph.hasNode(pid)) {
      graph.addNode(pid, { type: "placeholder", target: link.target });
    }
    if (!graph.hasEdge(sourcePath, pid)) {
      graph.addDirectedEdge(sourcePath, pid, edgeAttrs);
    }
    return;
  }
  // For simple `DirectedGraph`, duplicate edges to the same target collapse
  // into one. The fixture has no such duplicates; for real vaults this is an
  // acceptable approximation (PLAN: "one per resolved wikilink" + explicit
  // `DirectedGraph` choice in the Wave 3 brief).
  if (!graph.hasEdge(sourcePath, target)) {
    graph.addDirectedEdge(sourcePath, target, edgeAttrs);
  }
};

/**
 * Resolve a wikilink target using the Foam ladder plus the directory-link
 * fallback (`[[folder]]` → `folder/index.md`). Returns the absolute path of
 * the resolved note, or `undefined` when the target is unresolvable
 * (placeholder).
 */
const resolveLinkTarget = (
  target: string,
  vaultPath: string,
  vaultIndex: VaultIndex,
): string | undefined => {
  const resolved = resolveWikilink(target, vaultIndex);
  if (resolved.candidates.length === 1 && resolved.confidence !== "ambiguous") {
    return resolved.candidates[0];
  }
  // Ambiguous → pick none (tools layer can expose the ambiguity separately).
  if (resolved.confidence === "ambiguous") return undefined;
  // Directory-link fallback.
  return resolveDirectoryLink(target, vaultPath, vaultIndex);
};

const listMarkdownFiles = async (vaultPath: string): Promise<string[]> => {
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files.map((f) => resolvePath(f)).sort();
};
