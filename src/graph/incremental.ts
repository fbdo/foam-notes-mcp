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
import { type VaultIndex } from "../resolver.js";
import {
  collectAmbiguousLinks,
  edgeAttrsFromLink,
  placeholderId,
  resolveLinkTarget,
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

/**
 * Stable per-watcher context for {@link updateNote}.
 *
 * These values are constant across all calls from a single watcher session
 * (i.e. they describe the vault, not the individual file change). Separating
 * them from the per-call params (`changedPath`, `changeType`) makes call
 * sites more readable and reduces the surface of argument-order mistakes.
 */
export interface UpdateNoteContext {
  readonly graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
  readonly vaultPath: string;
  readonly vaultIndex: VaultIndex;
  readonly mocPattern: string;
}

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
 * @param ctx  Stable per-watcher context (graph, vault path, index, MOC pattern).
 * @param changedPath  Absolute path of the file that changed.
 * @param changeType   Kind of filesystem event.
 *
 * The `mocPattern` inside `ctx` is a glob identifying MOC notes (e.g.
 * `*-MOC.md`). It is used to set `isMoc` on newly added nodes; modifications
 * preserve the existing flag — consistent with the builder, which only
 * evaluates the pattern on the initial scan.
 */
export const updateNote = async (
  ctx: UpdateNoteContext,
  changedPath: string,
  changeType: ChangeType,
): Promise<IncrementalDiff> => {
  const { graph, vaultPath, vaultIndex, mocPattern } = ctx;
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

  // Rebuild ambiguousLinks from scratch from the new wikilink set. On
  // modify this naturally clears stale entries (any link that previously
  // produced an ambiguity but is now missing or resolved simply doesn't
  // reappear here). Omit the field when empty so we don't bloat exports.
  const ambiguousLinks = collectAmbiguousLinks(wikilinks, vaultPath, vaultIndex);

  const attrs: NoteNodeAttrs = {
    type: "note",
    title: deriveTitle(frontmatter, base),
    basename: base,
    folder: relativeFolder(path, vaultPath),
    tags,
    frontmatter,
    isMoc,
    ...(ambiguousLinks.length > 0 ? { ambiguousLinks } : {}),
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
 * `builder.ts`'s `hasEdge` short-circuit). Ambiguous links contribute
 * nothing here — they have no edge (see `NoteNodeAttrs.ambiguousLinks`).
 */
const computeDesiredEdges = (
  wikilinks: readonly Wikilink[],
  vaultPath: string,
  vaultIndex: VaultIndex,
): Map<string, EdgeAttrs> => {
  const desired = new Map<string, EdgeAttrs>();
  for (const link of wikilinks) {
    const resolution = resolveLinkTarget(link.target, vaultPath, vaultIndex);
    if (resolution.kind === "ambiguous") continue;
    const targetId =
      resolution.kind === "resolved" ? resolution.target : placeholderId(resolution.target);
    if (desired.has(targetId)) continue;
    desired.set(targetId, edgeAttrsFromLink(link));
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
    const resolution = resolveLinkTarget(attrs.target, vaultPath, vaultIndex);
    // Still unresolved or now ambiguous → leave the placeholder as-is.
    // (Ambiguity is a property of the linking note, not the target node;
    // the linking note re-processes its own `ambiguousLinks` when it's
    // next modified. Dropping the placeholder here would also drop
    // real inbound edges from notes that haven't been re-processed.)
    if (resolution.kind !== "resolved") continue;
    const resolved = resolution.target;
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
// (The local `resolveLinkTarget` helper was removed: builder.ts now exports
// the canonical discriminated-union resolver and both modules share it.)
// ---------------------------------------------------------------------------
