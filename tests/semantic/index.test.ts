/**
 * Unit tests for the semantic indexing orchestrator (`src/semantic/index.ts`).
 *
 * Strategy: build a small fixture vault in `os.tmpdir()`, instantiate a real
 * `SemanticStore` against a sqlite file in that tmpdir, and drive the
 * orchestrator with a deterministic 4-dim mock embedder. No network, no
 * real model, no MCP SDK — the orchestrator is SDK-agnostic by design.
 *
 * Covers:
 *   1. Cold build from empty store
 *   2. Incremental with no file changes (all skipped)
 *   3. Incremental after a file modification (one updated)
 *   4. Incremental after a file deletion (one removed)
 *   5. Incremental after a file addition (one added)
 *   6. Force mode (wipes & rebuilds)
 *   7. Empty-bodied note (skipped + fingerprint recorded)
 *   8. Progress callback emits phases + per-note updates
 *   9. Error isolation: one note throws, others still index
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildIndex, type IndexProgress } from "../../src/semantic/index.js";
import { SemanticStore } from "../../src/semantic/store.js";
import type { Embedder } from "../../src/semantic/embedder/types.js";

// --- deterministic 4-dim mock embedder ---

/**
 * Deterministic 4-dim mock embedder: hashes each text into a unit-normalized
 * 4-vector. Content-sensitive so "same text → same vector" holds and
 * "modified text → different vector" holds with overwhelming probability.
 */
const mockEmbedOne = (text: string): Float32Array => {
  const v = new Float32Array(4);
  for (let i = 0; i < text.length; i++) {
    const idx = text.charCodeAt(i) % 4;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) {
    v[0] = 1;
  } else {
    for (let i = 0; i < 4; i++) v[i] = (v[i] ?? 0) / mag;
  }
  return v;
};

interface MockEmbedderOptions {
  /** If provided, `embed()` throws for any text containing this substring. */
  readonly failOn?: string;
  /** Collects every batch `embed()` receives, for assertions. */
  readonly log?: string[][];
}

const makeMockEmbedder = (opts: MockEmbedderOptions = {}): Embedder => ({
  info: {
    provider: "transformers",
    model: "mock-4d",
    dims: 4,
    name: "mock:4d",
  },
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (opts.log !== undefined) opts.log.push([...texts]);
    if (opts.failOn !== undefined) {
      for (const t of texts) {
        if (t.includes(opts.failOn)) {
          throw new Error(`mock embedder refused text containing "${opts.failOn}"`);
        }
      }
    }
    return Promise.resolve(texts.map(mockEmbedOne));
  },
  async close(): Promise<void> {
    return Promise.resolve();
  },
});

// --- tmpdir vault helpers ---

interface VaultHandle {
  readonly dir: string;
  readonly dbPath: string;
  readonly notePath: (rel: string) => string;
  writeNote(rel: string, content: string): string;
  deleteNote(rel: string): void;
}

const makeVault = (): VaultHandle => {
  const dir = mkdtempSync(join(tmpdir(), "foam-semantic-orchestrator-"));
  return {
    dir,
    dbPath: join(dir, "semantic.sqlite"),
    notePath: (rel) => join(dir, rel),
    writeNote(rel, content) {
      const abs = join(dir, rel);
      const parent = abs.slice(0, Math.max(abs.lastIndexOf("/"), 0));
      if (parent !== "" && parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(abs, content, "utf8");
      return abs;
    },
    deleteNote(rel) {
      unlinkSync(join(dir, rel));
    },
  };
};

const makeStore = (dbPath: string): SemanticStore =>
  new SemanticStore({ path: dbPath, embedderName: "mock:4d", dims: 4 });

// --- shared fixture seeding ---

const seedThreeNotes = (vault: VaultHandle): void => {
  vault.writeNote("note-a.md", "# Note A\n\nBody of note A with some prose to chunk.\n");
  vault.writeNote(
    "note-b.md",
    "---\ntitle: B Override\ntags: [alpha, beta]\n---\n\n# Not used\n\nBody of B.\n",
  );
  mkdirSync(join(vault.dir, "sub"), { recursive: true });
  vault.writeNote("sub/note-c.md", "# Note C\n\nBody in a subfolder.\n");
};

// --- tests ---

describe("buildIndex", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) fn();
    }
  });

  const register = (vault: VaultHandle, store: SemanticStore): void => {
    cleanups.push(() => {
      void store.close();
      rmSync(vault.dir, { recursive: true, force: true });
    });
  };

  it("cold build: indexes every note, records fingerprints, populates meta", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);

    const result = await buildIndex(vault.dir, makeMockEmbedder(), store);

    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.noteCount).toBe(3);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.embedder).toBe("mock:4d");
    expect(result.dims).toBe(4);

    // Fingerprint recorded for each note.
    for (const rel of ["note-a.md", "note-b.md", "sub/note-c.md"]) {
      const fp = await store.getNoteFingerprint(vault.notePath(rel));
      expect(fp).not.toBeNull();
      expect((fp ?? "").length).toBe(64); // sha256 hex
    }

    // `lastBuiltAt` stamped.
    const meta = await store.getMeta();
    expect(meta.lastBuiltAt).not.toBe("");
    expect(meta.noteCount).toBe(3);
  });

  it("incremental no-change: second run skips every note", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);

    await buildIndex(vault.dir, makeMockEmbedder(), store);
    const chunkCountAfterFirst = await store.getChunkCount();

    const second = await buildIndex(vault.dir, makeMockEmbedder(), store);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.skipped).toBe(3);
    expect(await store.getChunkCount()).toBe(chunkCountAfterFirst);
  });

  it("incremental modify: changed note counted as updated, re-embeds chunks", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);
    await buildIndex(vault.dir, makeMockEmbedder(), store);

    // Modify note-a.
    vault.writeNote("note-a.md", "# Note A\n\nUpdated body with different prose entirely.\n");
    const log: string[][] = [];
    const result = await buildIndex(vault.dir, makeMockEmbedder({ log }), store);

    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(2);
    // The embedder was invoked for the modified note.
    const flat = log.flat().join("\n");
    expect(flat).toContain("Updated body");
  });

  it("incremental delete: removed-from-disk note is removed from store", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);
    await buildIndex(vault.dir, makeMockEmbedder(), store);

    const beforeChunkCount = await store.getChunkCount();
    vault.deleteNote("note-b.md");
    const result = await buildIndex(vault.dir, makeMockEmbedder(), store);

    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    const afterChunkCount = await store.getChunkCount();
    expect(afterChunkCount).toBeLessThan(beforeChunkCount);
    // The deleted note's fingerprint is still gone too (via deleteByNotePath).
    // It shouldn't appear in getNotePaths after the run.
    const paths = await store.getNotePaths();
    expect(paths).not.toContain(vault.notePath("note-b.md"));
  });

  it("incremental add: new note on disk is counted as added", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);
    await buildIndex(vault.dir, makeMockEmbedder(), store);

    vault.writeNote("note-d.md", "# Note D\n\nFreshly added content.\n");
    const result = await buildIndex(vault.dir, makeMockEmbedder(), store);

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("force mode: wipes and re-indexes all notes", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);
    await buildIndex(vault.dir, makeMockEmbedder(), store);

    const result = await buildIndex(vault.dir, makeMockEmbedder(), store, { force: true });
    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    // The store's previously-indexed notes show up in `removed` because
    // force wipes them before re-ingest.
    expect(result.removed).toBe(3);
  });

  it("empty note: skipped with fingerprint recorded", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    // Frontmatter-only note: parses but body is empty → chunker returns [].
    vault.writeNote("empty.md", "---\ntitle: Empty\n---\n\n");
    vault.writeNote("not-empty.md", "# Has body\n\nSome prose.\n");

    const result = await buildIndex(vault.dir, makeMockEmbedder(), store);
    // The empty note contributes to `skipped`, the non-empty to `added`.
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);

    // Fingerprint for the empty note IS recorded — re-running the build
    // must not re-process it.
    const fp = await store.getNoteFingerprint(vault.notePath("empty.md"));
    expect(fp).not.toBeNull();

    // Second run: empty note skips via fingerprint match, not via zero-chunk.
    const second = await buildIndex(vault.dir, makeMockEmbedder(), store);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("progress callback fires for every phase and per-note during indexing", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    seedThreeNotes(vault);

    const events: IndexProgress[] = [];
    await buildIndex(vault.dir, makeMockEmbedder(), store, {
      onProgress: (p) => events.push(p),
    });

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("discovering");
    expect(phases).toContain("diffing");
    expect(phases).toContain("indexing");
    expect(phases).toContain("finalizing");

    // First indexing event carries `currentNote`; processed is monotonically
    // non-decreasing across the stream.
    const indexingEvents = events.filter((e) => e.phase === "indexing");
    expect(indexingEvents.length).toBe(3);
    for (let i = 1; i < indexingEvents.length; i++) {
      const prev = indexingEvents[i - 1];
      const next = indexingEvents[i];
      if (prev === undefined || next === undefined) continue;
      expect(next.processed).toBeGreaterThanOrEqual(prev.processed);
    }
    // Final indexing event matches total.
    const last = indexingEvents[indexingEvents.length - 1];
    expect(last?.processed).toBe(3);
    expect(last?.total).toBe(3);
  });

  it("error isolation: a failing embed on one note does not abort the others", async () => {
    const vault = makeVault();
    const store = makeStore(vault.dbPath);
    register(vault, store);
    await store.open();
    vault.writeNote(
      "poison.md",
      "# Poison\n\nThis note contains the POISON_TOKEN that the embedder rejects.\n",
    );
    vault.writeNote("fine-a.md", "# Fine A\n\nPerfectly normal content.\n");
    vault.writeNote("fine-b.md", "# Fine B\n\nAlso perfectly normal.\n");

    const result = await buildIndex(vault.dir, makeMockEmbedder({ failOn: "POISON_TOKEN" }), store);

    // Two notes succeed, one note is captured in errors.
    expect(result.added).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.notePath).toBe("poison.md");
    expect(result.errors[0]?.message).toContain("POISON_TOKEN");
    // The failing note has no chunks in the store.
    const paths = await store.getNotePaths();
    expect(paths).toContain(vault.notePath("fine-a.md"));
    expect(paths).toContain(vault.notePath("fine-b.md"));
    expect(paths).not.toContain(vault.notePath("poison.md"));
  });
});
