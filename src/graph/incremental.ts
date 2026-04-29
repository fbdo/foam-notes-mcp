/**
 * Incremental single-file update for a built graph.
 *
 * Called by the watcher (Wave 5) when a single file changes. Handles three
 * shapes of change:
 *   1. Deletion — file no longer exists.
 *   2. Addition — file exists and was not in the graph.
 *   3. Modification — file exists and was in the graph; wikilinks may have
 *      been added/removed.
 *
 * After any change we also attempt to promote placeholder nodes: if the new
 * vault state now resolves a target that was previously unresolved, we
 * redirect all edges from the placeholder to the real note and drop the
 * placeholder.
 *
 * Layer rules: graph/* may import parse/resolver/cache/errors; no feature
 * siblings, no MCP SDK.
 */

import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import type { DirectedGraph } from "graphology";

import { extractTags } from "../parse/tags.js";
import { extractWikilinks, type Wikilink } from "../parse/wikilink.js";
import { deriveTitle, globToRegex, relativeFolder, safeParseFrontmatter } from "../path-util.js";
import { resolveDirectoryLink, resolveWikilink, type VaultIndex } from "../resolver.js";
import {
  placeholderId,
  type EdgeAttrs,
  type GraphNodeAttrs,
  type NoteNodeAttrs,
} from "./builder.js";

/** Diff counts returned by {@link updateNote}. */
export interface IncrementalDiff {
  edgesAdded: number;
  edgesRemoved: number;
  nodesAdded: number;
  nodesRemoved: number;
}

/** The kind of filesystem event that triggered the update. */
export type ChangeType = "added" | "modified" | "deleted";

/** Canonical prefix for placeholder node ids. */
const PLACEHOLDER_PREFIX = "placeholder:";

/**
 * Apply the single-file change at `changedPath` to `graph`.
 *
 * The caller owns the `vaultIndex` lifecycle. For deletions the caller must
 * have already removed `changedPath` from the index; for additions the
 * caller must have already inserted it. This keeps the update function pure
 * w.r.t. filesystem semantics — it reacts to whatever the caller has
 * committed, rather than racing the filesystem itself.
 *
 * @param mocPattern Glob pattern identifying MOC notes (e.g. `*-MOC.md`).
 *   Used to set `isMoc` on newly added nodes. Modifications preserve the
 *   existing flag — consistent with the builder, which only evaluates the
 *   pattern on the initial scan.
 */
export const updateNote = async (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  vaultPath: string,
  changedPath: string,
  changeType: ChangeType,
  vaultIndex: VaultIndex,
  mocPattern: string,
): Promise<IncrementalDiff> => {
  const diff: IncrementalDiff = {
    edgesAdded: 0,
    edgesRemoved: 0,
    nodesAdded: 0,
    nodesRemoved: 0,
  };
  const abs = resolvePath(changedPath);

  if (changeType === "deleted") {
    handleDelete(graph, abs, diff);
  } else {
    await handleAddOrModify(graph, abs, vaultPath, vaultIndex, diff, mocPattern);
  }

  // Placeholder promotion pass — runs after every change type because a
  // deletion can *also* unstick an ambiguity (e.g. removing one of two
  // same-basename notes leaves a unique resolution for prior-ambiguous
  // links). We keep it unconditional for simplicity.
  promotePlaceholders(graph, vaultPath, vaultIndex, diff);

  return diff;
};

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

const handleDelete = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  path: string,
  diff: IncrementalDiff,
): void => {
  if (!graph.hasNode(path)) return;
  // Count edges that will be removed along with the node. graphology's
  // `dropNode` removes incident edges silently; we tally them up first.
  const outgoing = graph.outEdges(path).length;
  const incoming = graph.inEdges(path).length;
  diff.edgesRemoved += outgoing + incoming;
  graph.dropNode(path);
  diff.nodesRemoved += 1;

  // Clean up orphaned placeholders: a placeholder is only useful while some
  // note still references it.
  for (const nodeId of graph.nodes()) {
    const attrs = graph.getNodeAttributes(nodeId);
    if (attrs.type !== "placeholder") continue;
    if (graph.inEdges(nodeId).length === 0) {
      graph.dropNode(nodeId);
      diff.nodesRemoved += 1;
    }
  }
};

// ---------------------------------------------------------------------------
// Addition / modification
// ---------------------------------------------------------------------------

const handleAddOrModify = async (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  path: string,
  vaultPath: string,
  vaultIndex: VaultIndex,
  diff: IncrementalDiff,
  mocPattern: string,
): Promise<void> => {
  const src = await readFile(path, "utf8");
  const { data: frontmatter } = safeParseFrontmatter(src);
  const tags = extractTags(src, frontmatter);
  const wikilinks = extractWikilinks(src);
  const base = basename(path, ".md");

  // For adds, derive isMoc from the configured pattern; for modifies,
  // preserve whatever the builder (or a prior add) decided. The builder
  // itself only evaluates the pattern on the initial scan, so we mirror
  // that invariant here.
  const prior = existingIsMoc(graph, path);
  const isMoc = prior ?? globToRegex(mocPattern).test(base + ".md");

  const attrs: NoteNodeAttrs = {
    type: "note",
    title: deriveTitle(frontmatter, base),
    basename: base,
    folder: relativeFolder(path, vaultPath),
    tags,
    frontmatter,
    isMoc,
  };

  if (!graph.hasNode(path)) {
    graph.addNode(path, attrs);
    diff.nodesAdded += 1;
  } else {
    graph.replaceNodeAttributes(path, attrs);
  }

  reconcileOutgoingEdges(graph, path, wikilinks, vaultPath, vaultIndex, diff);
};

const existingIsMoc = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  path: string,
): boolean | undefined => {
  if (!graph.hasNode(path)) return undefined;
  const attrs = graph.getNodeAttributes(path);
  return attrs.type === "note" ? attrs.isMoc : undefined;
};

const reconcileOutgoingEdges = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  sourcePath: string,
  wikilinks: readonly Wikilink[],
  vaultPath: string,
  vaultIndex: VaultIndex,
  diff: IncrementalDiff,
): void => {
  const desired = computeDesiredEdges(wikilinks, vaultPath, vaultIndex);
  removeStaleEdges(graph, sourcePath, desired, diff);
  addMissingEdges(graph, sourcePath, desired, diff);
};

/**
 * Build the desired `(targetId → EdgeAttrs)` map from a file's wikilinks.
 * On duplicate link to the same target, the first occurrence wins (matches
 * `builder.ts`'s `hasEdge` short-circuit).
 */
const computeDesiredEdges = (
  wikilinks: readonly Wikilink[],
  vaultPath: string,
  vaultIndex: VaultIndex,
): Map<string, EdgeAttrs> => {
  const desired = new Map<string, EdgeAttrs>();
  for (const link of wikilinks) {
    const targetId = resolveLinkTarget(link.target, vaultPath, vaultIndex);
    if (desired.has(targetId)) continue;
    const attrs: EdgeAttrs = {
      line: link.line,
      column: link.column,
      ...(link.alias !== undefined ? { alias: link.alias } : {}),
      ...(link.heading !== undefined ? { heading: link.heading } : {}),
    };
    desired.set(targetId, attrs);
  }
  return desired;
};

/**
 * Drop out-edges whose target is not in `desired`. Also garbage-collects
 * placeholder nodes that become unreferenced as a side effect.
 */
const removeStaleEdges = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  sourcePath: string,
  desired: ReadonlyMap<string, EdgeAttrs>,
  diff: IncrementalDiff,
): void => {
  const currentOut = [...graph.outEdges(sourcePath)];
  for (const edgeId of currentOut) {
    const target = graph.target(edgeId);
    if (desired.has(target)) continue;
    graph.dropEdge(edgeId);
    diff.edgesRemoved += 1;
    collectOrphanPlaceholder(graph, target, diff);
  }
};

const collectOrphanPlaceholder = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  nodeId: string,
  diff: IncrementalDiff,
): void => {
  if (!graph.hasNode(nodeId)) return;
  const attrs = graph.getNodeAttributes(nodeId);
  if (attrs.type !== "placeholder") return;
  if (graph.inEdges(nodeId).length !== 0) return;
  graph.dropNode(nodeId);
  diff.nodesRemoved += 1;
};

/** Add any edges in `desired` that don't yet exist, creating placeholders. */
const addMissingEdges = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  sourcePath: string,
  desired: ReadonlyMap<string, EdgeAttrs>,
  diff: IncrementalDiff,
): void => {
  for (const [targetId, attrs] of desired) {
    ensurePlaceholderNode(graph, targetId, diff);
    if (!graph.hasNode(targetId)) {
      // Target note not yet registered (e.g. add-event arrived before its
      // neighbors were indexed). A later update will reconcile.
      continue;
    }
    if (!graph.hasEdge(sourcePath, targetId)) {
      graph.addDirectedEdge(sourcePath, targetId, attrs);
      diff.edgesAdded += 1;
    }
  }
};

const ensurePlaceholderNode = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  targetId: string,
  diff: IncrementalDiff,
): void => {
  if (!targetId.startsWith(PLACEHOLDER_PREFIX)) return;
  if (graph.hasNode(targetId)) return;
  graph.addNode(targetId, {
    type: "placeholder",
    target: targetId.slice(PLACEHOLDER_PREFIX.length),
  });
  diff.nodesAdded += 1;
};

// ---------------------------------------------------------------------------
// Placeholder promotion
// ---------------------------------------------------------------------------

const promotePlaceholders = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  vaultPath: string,
  vaultIndex: VaultIndex,
  diff: IncrementalDiff,
): void => {
  const placeholders: string[] = [];
  for (const nodeId of graph.nodes()) {
    const attrs = graph.getNodeAttributes(nodeId);
    if (attrs.type === "placeholder") placeholders.push(nodeId);
  }

  for (const placeholderNodeId of placeholders) {
    const attrs = graph.getNodeAttributes(placeholderNodeId);
    if (attrs.type !== "placeholder") continue;
    const resolved = resolveLinkTarget(attrs.target, vaultPath, vaultIndex);
    // Unresolvable or still a placeholder target → leave alone.
    if (resolved.startsWith(PLACEHOLDER_PREFIX)) continue;
    // The real target must already be a node in the graph (the caller must
    // have applied the addition before this pass). If not, skip.
    if (!graph.hasNode(resolved)) continue;

    // Redirect every incoming edge from placeholder → real node.
    const incoming = [...graph.inEdges(placeholderNodeId)];
    for (const edgeId of incoming) {
      const src = graph.source(edgeId);
      const edgeAttrs = graph.getEdgeAttributes(edgeId);
      graph.dropEdge(edgeId);
      if (!graph.hasEdge(src, resolved)) {
        graph.addDirectedEdge(src, resolved, edgeAttrs);
      }
      // No diff bump: we traded one edge for an equivalent one.
    }
    graph.dropNode(placeholderNodeId);
    diff.nodesRemoved += 1;
  }
};

// ---------------------------------------------------------------------------
// Shared helpers (small glue specific to this file — broader duplicates live
// in `src/path-util.ts` and `src/resolver.ts`).
// ---------------------------------------------------------------------------

const resolveLinkTarget = (target: string, vaultPath: string, vaultIndex: VaultIndex): string => {
  const resolved = resolveWikilink(target, vaultIndex);
  if (resolved.candidates.length === 1 && resolved.confidence !== "ambiguous") {
    const only = resolved.candidates[0];
    if (only !== undefined) return only;
  }
  if (resolved.confidence !== "ambiguous") {
    const dir = resolveDirectoryLink(target, vaultPath, vaultIndex);
    if (dir !== undefined) return dir;
  }
  return placeholderId(target);
};
