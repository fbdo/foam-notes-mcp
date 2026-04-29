import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGraph } from "../../src/graph/builder.js";
import {
  computeVaultFingerprint,
  loadFingerprint,
  loadGraph,
  saveFingerprint,
  saveGraph,
} from "../../src/graph/store.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "foam-graph-store-"));

describe("graph/store", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  it("round-trips a built graph via save + load with identical node/edge counts", async () => {
    const cacheDir = makeTempDir();
    cleanup.push(() => rmSync(cacheDir, { recursive: true, force: true }));

    const original = await buildGraph(VAULT);
    await saveGraph(original, cacheDir);

    const reloaded = await loadGraph(cacheDir);
    expect(reloaded).not.toBeNull();
    if (!reloaded) return;

    expect(reloaded.order).toBe(original.order);
    expect(reloaded.size).toBe(original.size);

    // Verify node attributes survived the round-trip for a known note.
    for (const id of original.nodes()) {
      expect(reloaded.hasNode(id)).toBe(true);
      expect(reloaded.getNodeAttributes(id)).toEqual(original.getNodeAttributes(id));
    }
  });

  it("loadGraph returns null when the graph file is absent", async () => {
    const cacheDir = makeTempDir();
    cleanup.push(() => rmSync(cacheDir, { recursive: true, force: true }));
    const result = await loadGraph(cacheDir);
    expect(result).toBeNull();
  });

  it("persists and re-reads the fingerprint", async () => {
    const cacheDir = makeTempDir();
    cleanup.push(() => rmSync(cacheDir, { recursive: true, force: true }));
    expect(await loadFingerprint(cacheDir)).toBeNull();
    await saveFingerprint("abc123", cacheDir);
    expect(await loadFingerprint(cacheDir)).toBe("abc123");
  });

  it("computeVaultFingerprint changes when a file's mtime changes", async () => {
    // Build a disposable vault with one .md file so we can manipulate mtime.
    const tempVault = makeTempDir();
    cleanup.push(() => rmSync(tempVault, { recursive: true, force: true }));
    const file = join(tempVault, "note.md");
    writeFileSync(file, "# hello", "utf8");

    const first = await computeVaultFingerprint(tempVault);
    // Bump mtime by 1 second in the future.
    const future = new Date(Date.now() + 1000);
    utimesSync(file, future, future);
    const second = await computeVaultFingerprint(tempVault);
    expect(second).not.toBe(first);
  });

  it("computeVaultFingerprint changes when a file's size changes", async () => {
    const tempVault = makeTempDir();
    cleanup.push(() => rmSync(tempVault, { recursive: true, force: true }));
    const file = join(tempVault, "note.md");
    writeFileSync(file, "short", "utf8");
    const first = await computeVaultFingerprint(tempVault);

    // Writing longer content also bumps mtime, but the contract says
    // "mtime or size" — either is sufficient. We assert size-driven change
    // by also asserting the byte length moved.
    writeFileSync(file, "a much longer body than before", "utf8");
    const second = await computeVaultFingerprint(tempVault);
    expect(second).not.toBe(first);
    expect(statSync(file).size).toBeGreaterThan("short".length);
  });

  it("computeVaultFingerprint is stable when nothing changes", async () => {
    const tempVault = makeTempDir();
    cleanup.push(() => rmSync(tempVault, { recursive: true, force: true }));
    writeFileSync(join(tempVault, "a.md"), "aaa", "utf8");
    writeFileSync(join(tempVault, "b.md"), "bbb", "utf8");
    const one = await computeVaultFingerprint(tempVault);
    const two = await computeVaultFingerprint(tempVault);
    expect(two).toBe(one);
  });
});
