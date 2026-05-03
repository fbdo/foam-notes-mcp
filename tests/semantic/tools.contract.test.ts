/**
 * Contract tests for the three semantic tools in `src/semantic/tools.ts`.
 *
 * Strategy: deterministic 4-dim mock embedder (same pattern as the
 * orchestrator tests), throwaway sqlite store in `os.tmpdir()`, per-test
 * copy of the real fixture vault so tests don't mutate each other.
 *
 * Coverage:
 *   - semantic_search: empty-store guard, result ordering, folder/tags/
 *     min_score filters, input validation.
 *   - build_index: cold / incremental / force / onProgress wiring.
 *   - index_status: fresh store, post-build, drift detection.
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolValidationError } from "../../src/errors.js";
import type { Embedder } from "../../src/semantic/embedder/types.js";
import type { IndexProgress } from "../../src/semantic/index.js";
import { SemanticStore } from "../../src/semantic/store.js";
import {
  indexStatus,
  runBuildIndex,
  semanticSearch,
  type SemanticToolContext,
} from "../../src/semantic/tools.js";
import { fixtureRoot } from "../helpers/fixture.js";

// ---------------------------------------------------------------------------
// Deterministic 4-dim mock embedder. Content-sensitive so identical strings
// map to identical vectors and different strings (usually) differ.
// ---------------------------------------------------------------------------

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

const makeMockEmbedder = (): Embedder => ({
  info: { provider: "transformers", model: "mock-4d", dims: 4, name: "mock:4d" },
  embed: async (texts) => Promise.resolve(texts.map(mockEmbedOne)),
  close: async () => Promise.resolve(),
});

// ---------------------------------------------------------------------------
// Test harness: copy the fixture vault into a fresh tmpdir per test and
// stand up a SemanticStore alongside. Every handle registered here is
// torn down in `afterEach` so tests remain isolated.
// ---------------------------------------------------------------------------

interface Harness {
  readonly ctx: SemanticToolContext;
  readonly store: SemanticStore;
  readonly vaultPath: string;
  readonly rootDir: string;
}

const makeHarness = async (): Promise<Harness> => {
  const rootDir = mkdtempSync(join(tmpdir(), "foam-sem-tools-"));
  const vaultPath = join(rootDir, "vault");
  cpSync(fixtureRoot(import.meta.url), vaultPath, { recursive: true });
  const embedder = makeMockEmbedder();
  const store = new SemanticStore({
    path: join(rootDir, "index.sqlite"),
    embedderName: embedder.info.name,
    dims: embedder.info.dims,
  });
  await store.open();
  const ctx: SemanticToolContext = {
    vaultPath,
    mocPattern: "*-MOC.md",
    embedder,
    store,
  };
  return { ctx, store, vaultPath, rootDir };
};

describe("semantic tools", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) fn();
    }
  });

  const register = (h: Harness): void => {
    cleanups.push(() => {
      void h.store.close();
      rmSync(h.rootDir, { recursive: true, force: true });
    });
  };

  // -------------------------------------------------------------------------
  // semantic_search
  // -------------------------------------------------------------------------

  describe("semantic_search", () => {
    it("throws ToolValidationError when the index is empty", async () => {
      const h = await makeHarness();
      register(h);
      await expect(semanticSearch({ query: "hello" }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
    });

    it("throws on empty / whitespace-only query", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      await expect(semanticSearch({ query: "" }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
      await expect(semanticSearch({ query: "   " }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
    });

    it("throws on limit < 1", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      await expect(semanticSearch({ query: "note", limit: 0 }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
    });

    it("throws on min_score outside [-1, 1]", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      await expect(semanticSearch({ query: "note", min_score: 1.5 }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
      await expect(semanticSearch({ query: "note", min_score: -2 }, h.ctx)).rejects.toBeInstanceOf(
        ToolValidationError,
      );
    });

    it("returns hits ordered by score descending with total = hits.length", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      const out = await semanticSearch({ query: "project", limit: 5 }, h.ctx);
      expect(out.hits.length).toBeGreaterThan(0);
      expect(out.total).toBe(out.hits.length);
      for (let i = 1; i < out.hits.length; i++) {
        const prev = out.hits[i - 1];
        const cur = out.hits[i];
        if (prev && cur) expect(cur.score).toBeLessThanOrEqual(prev.score);
      }
    });

    it("respects the default limit (10)", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      const out = await semanticSearch({ query: "note" }, h.ctx);
      expect(out.hits.length).toBeLessThanOrEqual(10);
    });

    it("folder filter reduces results to chunks under that folder", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      const out = await semanticSearch({ query: "note", folder: "01-Projects", limit: 20 }, h.ctx);
      expect(out.hits.length).toBeGreaterThan(0);
      for (const hit of out.hits) expect(hit.folder).toBe("01-Projects");
    });

    it("min_score filter drops low-similarity hits", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      const loose = await semanticSearch({ query: "project", limit: 50 }, h.ctx);
      // Choose a threshold strictly above the lowest-scoring result. If every
      // hit already passes, the test still asserts monotone behaviour by
      // requiring the strict-filter result to be a (possibly equal) subset.
      const lowest = loose.hits.length > 0 ? (loose.hits[loose.hits.length - 1]?.score ?? 0) : 0;
      const threshold = Math.min(1, lowest + 0.01);
      const strict = await semanticSearch(
        { query: "project", limit: 50, min_score: threshold },
        h.ctx,
      );
      expect(strict.hits.length).toBeLessThanOrEqual(loose.hits.length);
      for (const hit of strict.hits) expect(hit.score).toBeGreaterThanOrEqual(threshold);
    });

    it("tags filter requires all listed tags (AND)", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      // Use a tag that no chunk has — result set must be empty, proving the
      // filter actually ran over JS state.
      const out = await semanticSearch(
        { query: "note", tags: ["definitely-not-a-real-tag-xyz123"], limit: 20 },
        h.ctx,
      );
      expect(out.hits).toEqual([]);
      expect(out.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // build_index
  // -------------------------------------------------------------------------

  describe("build_index", () => {
    it("cold build on empty store: adds every fixture note, chunks > 0", async () => {
      const h = await makeHarness();
      register(h);
      const result = await runBuildIndex({}, h.ctx);
      expect(result.added).toBeGreaterThan(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(result.noteCount).toBe(result.added);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.embedder).toBe("mock:4d");
      expect(result.dims).toBe(4);
    });

    it("second call without force: mostly skipped, nothing added or updated", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);
      const second = await runBuildIndex({}, h.ctx);
      expect(second.added).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.removed).toBe(0);
      expect(second.skipped).toBeGreaterThan(0);
    });

    it("force: true wipes and rebuilds all notes", async () => {
      const h = await makeHarness();
      register(h);
      const first = await runBuildIndex({}, h.ctx);
      const forced = await runBuildIndex({ force: true }, h.ctx);
      expect(forced.added).toBe(first.added);
      expect(forced.updated).toBe(0);
      expect(forced.skipped).toBe(0);
      // Force wipes everything first, so `removed` equals the prior note count.
      expect(forced.removed).toBe(first.added);
    });

    it("onProgress callback is invoked multiple times across phases", async () => {
      const h = await makeHarness();
      register(h);
      const events: IndexProgress[] = [];
      await runBuildIndex({}, h.ctx, { onProgress: (p) => events.push(p) });
      expect(events.length).toBeGreaterThan(1);
      const phases = new Set(events.map((e) => e.phase));
      expect(phases.has("discovering")).toBe(true);
      expect(phases.has("indexing")).toBe(true);
      expect(phases.has("finalizing")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // index_status
  // -------------------------------------------------------------------------

  describe("index_status", () => {
    it("fresh store (never built): notes=0, chunks=0, lastBuiltAt=null, upToDate=false", async () => {
      const h = await makeHarness();
      register(h);
      const status = await indexStatus({}, h.ctx);
      expect(status.notes).toBe(0);
      expect(status.chunks).toBe(0);
      expect(status.lastBuiltAt).toBeNull();
      expect(status.embedder).toBe("mock:4d");
      expect(status.dims).toBe(4);
      // Empty store: we report `upToDate: false` so callers treat it as
      // "needs a build" rather than a vacuous affirmative.
      expect(status.upToDate).toBe(false);
    });

    it("after buildIndex: counts match, lastBuiltAt is ISO, upToDate=true", async () => {
      const h = await makeHarness();
      register(h);
      const built = await runBuildIndex({}, h.ctx);
      const status = await indexStatus({}, h.ctx);
      expect(status.notes).toBe(built.noteCount);
      expect(status.chunks).toBe(built.chunkCount);
      expect(status.lastBuiltAt).not.toBeNull();
      // ISO-8601 sanity check.
      expect(() => new Date(status.lastBuiltAt ?? "").toISOString()).not.toThrow();
      expect(status.upToDate).toBe(true);
    });

    it("after modifying a note on disk: upToDate=false", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);

      // Pick any in-vault .md file and append content to it.
      const victim = findFirstMarkdown(h.vaultPath);
      expect(victim).not.toBe(null);
      const contents = readFileSync(victim!, "utf8");
      writeFileSync(victim!, contents + "\n\nUpdated content that changes the fingerprint.\n");

      const status = await indexStatus({}, h.ctx);
      expect(status.upToDate).toBe(false);
    });

    it("after adding a new note on disk: upToDate=false (count mismatch)", async () => {
      const h = await makeHarness();
      register(h);
      await runBuildIndex({}, h.ctx);

      writeFileSync(join(h.vaultPath, "brand-new.md"), "# New\n\nBody.\n");
      const status = await indexStatus({}, h.ctx);
      expect(status.upToDate).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the first `.md` file found anywhere under `root`, or `null`. */
const findFirstMarkdown = (root: string): string | null => {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile() && entry.toLowerCase().endsWith(".md")) return abs;
    }
  }
  return null;
};
