import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import fg from "fast-glob";

import { buildGraph, placeholderId } from "../../src/graph/builder.js";
import { updateNote } from "../../src/graph/incremental.js";
import { buildVaultIndex } from "../../src/resolver.js";
import { fixtureRoot } from "../helpers/fixture.js";

const FIXTURE_VAULT = fixtureRoot(import.meta.url);

const makeTempVault = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "foam-graph-incr-"));
  // Copy the fixture vault into the temp dir so mutations don't leak.
  cpSync(FIXTURE_VAULT, dir, { recursive: true });
  return dir;
};

const listVaultFiles = async (vaultPath: string): Promise<string[]> => {
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    absolute: true,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files.map((f) => resolvePath(f)).sort();
};

describe("graph/incremental updateNote", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  it("deletes a note: drops its node, outgoing edges, and orphaned placeholders", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const noteBPath = resolvePath(vault, "02-Areas/note-b.md");
    const placeholderNodeId = placeholderId("placeholder-target");

    // Sanity: note-b exists, links out to note-a and the placeholder.
    expect(graph.hasNode(noteBPath)).toBe(true);
    expect(graph.hasNode(placeholderNodeId)).toBe(true);
    const outgoingBefore = graph.outEdges(noteBPath).length;
    expect(outgoingBefore).toBeGreaterThanOrEqual(2);

    // Remove the file from disk so the resolver sees the new state, then
    // rebuild the vault index (the caller's responsibility per contract).
    unlinkSync(noteBPath);
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    const diff = await updateNote(graph, vault, noteBPath, "deleted", vaultIndex, "*-MOC.md");

    expect(graph.hasNode(noteBPath)).toBe(false);
    // The placeholder's only inbound edge came from note-b, so it should be
    // garbage-collected.
    expect(graph.hasNode(placeholderNodeId)).toBe(false);
    expect(diff.nodesRemoved).toBeGreaterThanOrEqual(2);
    expect(diff.edgesRemoved).toBeGreaterThanOrEqual(outgoingBefore);
  });

  it("adds a new note whose basename satisfies an existing placeholder: promotes placeholder and redirects edges", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const placeholderNodeId = placeholderId("placeholder-target");
    expect(graph.hasNode(placeholderNodeId)).toBe(true);
    const placeholderIncoming = graph.inEdges(placeholderNodeId).length;
    expect(placeholderIncoming).toBeGreaterThanOrEqual(1);

    // Create a new note that resolves the placeholder's `target`.
    const newNotePath = resolvePath(vault, "02-Areas/placeholder-target.md");
    writeFileSync(
      newNotePath,
      '---\ntitle: "Placeholder Target"\n---\n# Placeholder Target\n',
      "utf8",
    );
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    const diff = await updateNote(graph, vault, newNotePath, "added", vaultIndex, "*-MOC.md");

    // New note is in the graph; placeholder is gone; edges redirected.
    expect(graph.hasNode(newNotePath)).toBe(true);
    expect(graph.hasNode(placeholderNodeId)).toBe(false);
    expect(graph.inEdges(newNotePath).length).toBeGreaterThanOrEqual(placeholderIncoming);

    expect(diff.nodesAdded).toBeGreaterThanOrEqual(1);
    // The placeholder removal registers as a nodesRemoved bump.
    expect(diff.nodesRemoved).toBeGreaterThanOrEqual(1);
  });

  it("modifies a note to remove a wikilink: edgesRemoved >= 1", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const noteAPath = resolvePath(vault, "02-Areas/note-a.md");
    const noteBPath = resolvePath(vault, "02-Areas/note-b.md");

    // Sanity: note-a currently links to note-b.
    expect(graph.hasEdge(noteAPath, noteBPath)).toBe(true);

    // Rewrite note-a to drop the [[note-b]] link.
    const stripped = [
      "---",
      'title: "Note A"',
      "tags: [area, alpha]",
      "---",
      "# Note A",
      "",
      "## Section One",
      "",
      "- [ ] unchecked task in note a",
      "",
      "Inline tag: #alpha",
      "",
    ].join("\n");
    writeFileSync(noteAPath, stripped, "utf8");
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    const diff = await updateNote(graph, vault, noteAPath, "modified", vaultIndex, "*-MOC.md");

    expect(graph.hasEdge(noteAPath, noteBPath)).toBe(false);
    expect(diff.edgesRemoved).toBeGreaterThanOrEqual(1);
  });

  it("modifies a note to add a wikilink: edgesAdded >= 1", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const archivedPath = resolvePath(vault, "04-Archives/archived.md");
    const noteAPath = resolvePath(vault, "02-Areas/note-a.md");

    // Sanity: archived currently has no outgoing edges.
    expect(graph.outEdges(archivedPath).length).toBe(0);

    // Append a link to note-a.
    const original = readFileSync(archivedPath, "utf8");
    writeFileSync(archivedPath, `${original}\n\nSee [[note-a]].\n`, "utf8");
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    const diff = await updateNote(graph, vault, archivedPath, "modified", vaultIndex, "*-MOC.md");

    expect(graph.hasEdge(archivedPath, noteAPath)).toBe(true);
    expect(diff.edgesAdded).toBeGreaterThanOrEqual(1);
  });

  it("adds a new MOC note: isMoc is true when the basename matches the pattern (H2 regression)", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const newMocPath = resolvePath(vault, "02-Areas/00-Foo-MOC.md");
    writeFileSync(newMocPath, '---\ntitle: "Foo MOC"\n---\n# Foo MOC\n', "utf8");
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    await updateNote(graph, vault, newMocPath, "added", vaultIndex, "*-MOC.md");

    expect(graph.hasNode(newMocPath)).toBe(true);
    const attrs = graph.getNodeAttributes(newMocPath);
    expect(attrs.type).toBe("note");
    if (attrs.type === "note") {
      expect(attrs.isMoc).toBe(true);
    }
  });

  it("adds a new non-MOC note: isMoc is false when the basename does not match the pattern (H2 regression)", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const newNotePath = resolvePath(vault, "02-Areas/just-a-note.md");
    writeFileSync(newNotePath, '---\ntitle: "Just A Note"\n---\n# Just A Note\n', "utf8");
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    await updateNote(graph, vault, newNotePath, "added", vaultIndex, "*-MOC.md");

    expect(graph.hasNode(newNotePath)).toBe(true);
    const attrs = graph.getNodeAttributes(newNotePath);
    expect(attrs.type).toBe("note");
    if (attrs.type === "note") {
      expect(attrs.isMoc).toBe(false);
    }
  });

  it("modifies an existing MOC-flagged note: preserves isMoc=true without re-evaluating the pattern (H2 regression)", async () => {
    const vault = makeTempVault();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));

    const graph = await buildGraph(vault);
    const mocPath = resolvePath(vault, "00-Index-MOC.md");

    // Sanity: the builder flagged the fixture's MOC file as isMoc=true.
    const before = graph.getNodeAttributes(mocPath);
    expect(before.type).toBe("note");
    if (before.type === "note") expect(before.isMoc).toBe(true);

    // Modify the MOC: rewrite its body. Pass a deliberately non-matching
    // pattern to prove the modify path does NOT re-evaluate — it must
    // preserve the existing flag.
    writeFileSync(mocPath, '---\ntitle: "Index MOC (edited)"\n---\n# Index MOC\n', "utf8");
    const vaultIndex = buildVaultIndex(await listVaultFiles(vault));

    await updateNote(graph, vault, mocPath, "modified", vaultIndex, "never-matches-xyz.md");

    const after = graph.getNodeAttributes(mocPath);
    expect(after.type).toBe("note");
    if (after.type === "note") expect(after.isMoc).toBe(true);
  });
});
