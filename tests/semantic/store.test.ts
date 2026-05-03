import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SemanticStore, type StoredChunk } from "../../src/semantic/store.js";

/**
 * Deterministic 4-dim mock embedder: hashes a string into four unit-normalized
 * floats. We can craft inputs that produce any of the four one-hot vectors
 * to make similarity comparisons predictable.
 */
const mockEmbed = (text: string): Float32Array => {
  const v = new Float32Array(4);
  for (let i = 0; i < text.length; i++) {
    const idx = text.charCodeAt(i) % 4;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  // L2-normalize so cosine similarity is in [0, 1] for any two inputs
  // with non-negative components.
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

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "foam-semantic-store-"));

const dbPath = (dir: string): string => join(dir, "semantic.sqlite");

const makeStore = (dir: string, embedder = "mock:4dim"): SemanticStore =>
  new SemanticStore({ path: dbPath(dir), embedderName: embedder, dims: 4 });

const makeChunk = (i: number, overrides: Partial<StoredChunk> = {}): StoredChunk => ({
  id: `chunk-${i.toString()}`,
  notePath: `/vault/note-${i.toString()}.md`,
  chunkIndex: 0,
  heading: `Heading ${i.toString()}`,
  text: `text of chunk ${i.toString()}`,
  rawText: `raw text of chunk ${i.toString()}`,
  startLine: 1,
  endLine: 5,
  folder: "notes",
  tags: [],
  ...overrides,
});

describe("SemanticStore", () => {
  const cleanups: (() => void)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) fn();
    }
  });

  it("opens and closes cleanly", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    // A call issued immediately after open() must succeed (db is live).
    expect(await store.getChunkCount()).toBe(0);
    await store.close();
    // Reopening the same file should succeed idempotently.
    await store.open();
    expect(await store.getChunkCount()).toBe(0);
    await store.close();
  });

  it("populates embedder + dims in meta on fresh open", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    const meta = await store.getMeta();
    expect(meta.embedder).toBe("mock:4dim");
    expect(meta.dims).toBe(4);
    expect(meta.noteCount).toBe(0);
    expect(meta.chunkCount).toBe(0);
    await store.close();
  });

  it("upsertChunk increments chunk count to 1", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());
    await store.upsertChunk(makeChunk(0), mockEmbed("hello"));
    expect(await store.getChunkCount()).toBe(1);
  });

  it("upsertBatch stores ten chunks and reports count = 10", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());
    const items = Array.from({ length: 10 }, (_, i) => ({
      chunk: makeChunk(i, { id: `c-${i.toString()}` }),
      embedding: mockEmbed(`body-${i.toString()}`),
    }));
    await store.upsertBatch(items);
    expect(await store.getChunkCount()).toBe(10);
  });

  it("search returns the exact-match chunk as rank 1 with score ~1.0", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    const queryText = "exact-match-body";
    const vec = mockEmbed(queryText);
    await store.upsertBatch([
      { chunk: makeChunk(0, { id: "exact" }), embedding: vec },
      { chunk: makeChunk(1, { id: "other" }), embedding: mockEmbed("totally different content") },
      { chunk: makeChunk(2, { id: "more" }), embedding: mockEmbed("yet more content unrelated") },
    ]);
    const hits = await store.search(vec, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.id).toBe("exact");
    // Cosine score of a vector with itself is ~1.0 (may have minor float drift).
    expect(hits[0]?.score).toBeGreaterThan(0.99);
  });

  it("search with limit=3 returns at most 3 hits, score-ordered descending", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    const items = Array.from({ length: 6 }, (_, i) => ({
      chunk: makeChunk(i, { id: `k-${i.toString()}` }),
      embedding: mockEmbed(`body-${i.toString()}`),
    }));
    await store.upsertBatch(items);
    const hits = await store.search(mockEmbed("body-0"), 3);
    expect(hits.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1];
      const next = hits[i];
      if (prev === undefined || next === undefined) continue;
      expect(prev.score).toBeGreaterThanOrEqual(next.score);
    }
  });

  it("search honors folder filter (only hits in that folder returned)", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    await store.upsertBatch([
      {
        chunk: makeChunk(0, { id: "a", folder: "folder-a" }),
        embedding: mockEmbed("payload"),
      },
      {
        chunk: makeChunk(1, { id: "b", folder: "folder-b" }),
        embedding: mockEmbed("payload"),
      },
    ]);
    const hits = await store.search(mockEmbed("payload"), 5, { folder: "folder-a" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.chunk.folder).toBe("folder-a");
  });

  it("search honors tag filter with AND semantics", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    await store.upsertBatch([
      { chunk: makeChunk(0, { id: "x1", tags: ["a"] }), embedding: mockEmbed("payload x1") },
      { chunk: makeChunk(1, { id: "x2", tags: ["b"] }), embedding: mockEmbed("payload x2") },
      { chunk: makeChunk(2, { id: "x3", tags: ["a", "b"] }), embedding: mockEmbed("payload x3") },
    ]);
    const hitsA = await store.search(mockEmbed("payload"), 10, { tags: ["a"] });
    const idsA = hitsA.map((h) => h.chunk.id).sort((p, q) => p.localeCompare(q));
    expect(idsA).toEqual(["x1", "x3"]);

    const hitsBoth = await store.search(mockEmbed("payload"), 10, { tags: ["a", "b"] });
    const idsBoth = hitsBoth.map((h) => h.chunk.id);
    expect(idsBoth).toEqual(["x3"]);
  });

  it("deleteByNotePath removes chunks + vectors for that note", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    await store.upsertBatch([
      { chunk: makeChunk(0, { id: "n1-0", notePath: "/v/n1.md" }), embedding: mockEmbed("a") },
      { chunk: makeChunk(1, { id: "n1-1", notePath: "/v/n1.md" }), embedding: mockEmbed("b") },
      { chunk: makeChunk(2, { id: "n2-0", notePath: "/v/n2.md" }), embedding: mockEmbed("c") },
    ]);
    expect(await store.getChunkCount()).toBe(3);
    const removed = await store.deleteByNotePath("/v/n1.md");
    expect(removed).toBe(2);
    expect(await store.getChunkCount()).toBe(1);
    // Ensure the remaining chunk is searchable (vectors stayed consistent).
    const hits = await store.search(mockEmbed("c"), 5);
    expect(hits.map((h) => h.chunk.id)).toContain("n2-0");
  });

  it("re-upserting the same chunk id updates in place (no duplication)", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    await store.upsertChunk(makeChunk(0, { id: "same", heading: "v1" }), mockEmbed("payload-1"));
    await store.upsertChunk(makeChunk(0, { id: "same", heading: "v2" }), mockEmbed("payload-2"));
    expect(await store.getChunkCount()).toBe(1);
    const hits = await store.search(mockEmbed("payload-2"), 5);
    expect(hits[0]?.chunk.id).toBe("same");
    expect(hits[0]?.chunk.heading).toBe("v2");
  });

  it("throws when re-opening an existing store with a different embedder name", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = makeStore(dir, "embedder-a");
    await first.open();
    await first.upsertChunk(makeChunk(0), mockEmbed("x"));
    await first.close();

    const second = makeStore(dir, "embedder-b");
    await expect(second.open()).rejects.toThrow(/embedder mismatch/);
  });

  it("setNoteFingerprint / getNoteFingerprint round-trip", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    expect(await store.getNoteFingerprint("/v/n.md")).toBeNull();
    await store.setNoteFingerprint("/v/n.md", "hash-abc123");
    expect(await store.getNoteFingerprint("/v/n.md")).toBe("hash-abc123");
    // Overwrite succeeds.
    await store.setNoteFingerprint("/v/n.md", "hash-def456");
    expect(await store.getNoteFingerprint("/v/n.md")).toBe("hash-def456");
  });

  it("getNotePaths returns distinct paths", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    await store.upsertBatch([
      { chunk: makeChunk(0, { id: "1", notePath: "/v/a.md" }), embedding: mockEmbed("a1") },
      { chunk: makeChunk(1, { id: "2", notePath: "/v/a.md" }), embedding: mockEmbed("a2") },
      { chunk: makeChunk(2, { id: "3", notePath: "/v/b.md" }), embedding: mockEmbed("b1") },
    ]);
    const paths = await store.getNotePaths();
    expect(paths).toEqual(["/v/a.md", "/v/b.md"]);
    expect(await store.getNoteCount()).toBe(2);
  });

  it("setMeta(lastBuiltAt) round-trips", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());

    const stamp = "2025-01-15T12:00:00.000Z";
    await store.setMeta({ lastBuiltAt: stamp });
    const meta = await store.getMeta();
    expect(meta.lastBuiltAt).toBe(stamp);
  });

  it("rejects an embedding whose length does not match dims", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());
    const wrong = new Float32Array(5);
    await expect(store.upsertChunk(makeChunk(0), wrong)).rejects.toThrow(
      /does not match store dims/,
    );
  });

  it("rejects a search query vector whose length does not match dims", async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = makeStore(dir);
    await store.open();
    cleanups.push(() => void store.close());
    await expect(store.search(new Float32Array(3), 5)).rejects.toThrow(/does not match store dims/);
  });

  it("constructor rejects non-positive dims and empty embedder name", () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = dbPath(dir);
    expect(() => new SemanticStore({ path, embedderName: "e", dims: 0 })).toThrow(RangeError);
    expect(() => new SemanticStore({ path, embedderName: "", dims: 4 })).toThrow(RangeError);
  });
});
