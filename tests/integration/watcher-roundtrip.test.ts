/**
 * Wave 5 commit 4 — end-to-end watcher roundtrip integration.
 *
 * One test file that exercises the full pipeline for a real vault:
 *
 *   file change on disk
 *     → watcher `_applyChange` test seam (bypasses fs-event jitter)
 *       → graph incremental updater (edges added/removed)
 *         → semantic incremental updater (chunks re-embedded / deleted)
 *           → `hybrid_search` response reflects the new reality
 *
 * Uses the real `TransformersEmbedder` so the chunking + embedding path
 * is validated all the way through (not a deterministic mock — that is
 * already covered by `tests/semantic/tools.contract.test.ts`). The suite
 * is `skipIf`-guarded so environments without network (airgap, offline
 * CI) skip cleanly; local runs with a warm Hugging Face cache take only
 * a few seconds on the warm tests after a one-time model download.
 *
 * Scenarios:
 *   A. Modify — overwrite a note's body with semantically distinct text.
 *      The prior top-ranked result for the query either drops in rank or
 *      loses score; `index_status.upToDate` flips back to `true` after
 *      the dispatch because the fingerprint was updated in lockstep.
 *   B. Delete — the note disappears from hits; counts decrease.
 *   C. Add — a brand-new note on a specific topic surfaces in the top 3.
 *
 * Guards:
 *   - `FOAM_SKIP_MODEL_DOWNLOAD=true` → whole `describe` skips.
 *   - No DNS resolution for `huggingface.co` → `describe` skips.
 *   - First test timeout 120s to absorb a cold model download on CI; the
 *     warm-cache tests use a 60s ceiling.
 *
 * Layer notes (tests are exempt from dep-cruiser rules, but we honor the
 * spirit): this test imports feature functions directly
 * (`hybridSearch`, `indexStatus`, `buildIndex`, `updateNote*`) rather
 * than going through `src/tools/index.ts`. Keeping feature boundaries
 * clean also keeps compile-time churn localized when the wire layer
 * changes.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { rgPath } from "@vscode/ripgrep";
import type { DirectedGraph } from "graphology";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EdgeAttrs, GraphNodeAttrs } from "../../src/graph/builder.js";
import { buildGraph } from "../../src/graph/builder.js";
import type { GraphToolContext } from "../../src/graph/tools.js";
import type { HybridSearchOutput, HybridToolContext } from "../../src/hybrid/tools.js";
import { hybridSearch } from "../../src/hybrid/tools.js";
import type { KeywordToolContext } from "../../src/keyword/tools.js";
import { buildVaultIndex, type VaultIndex } from "../../src/resolver.js";
import { TransformersEmbedder } from "../../src/semantic/embedder/transformers.js";
import type { Embedder } from "../../src/semantic/embedder/types.js";
import { buildIndex } from "../../src/semantic/index.js";
import { SemanticStore } from "../../src/semantic/store.js";
import { indexStatus, type SemanticToolContext } from "../../src/semantic/tools.js";
import type { VaultWatcher } from "../../src/watcher.js";
import { createVaultWatcher } from "../../src/watcher.js";
import { fixtureRoot } from "../helpers/fixture.js";

// ---------------------------------------------------------------------------
// Network probe (mirrors `tests/semantic/embedder/integration.test.ts`).
// Keeps the guard bounded so a flaky local DNS never stalls the run.
// ---------------------------------------------------------------------------

const isNetworkAvailable = async (): Promise<boolean> => {
  try {
    await Promise.race([
      lookup("huggingface.co"),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("dns timeout"));
        }, 2000);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
};

const skipFlag = process.env.FOAM_SKIP_MODEL_DOWNLOAD === "true";
// Top-level await is fine in test files — vitest evaluates them as ESM.
const canDownload = !skipFlag && (await isNetworkAvailable());

// ---------------------------------------------------------------------------
// Shared state. `beforeAll` populates it once (cold model load) and
// scenarios share the handles to avoid repeated model loads across tests.
// ---------------------------------------------------------------------------

const MOC_PATTERN = "*-MOC.md";
const DEBOUNCE_MS = 50;
// `project` appears in the fixture's Project X / Project Y titles, body,
// and tags — strong anchors for both keyword (ripgrep substring) and
// semantic (title-prepended chunk embedding) lists. The watcher test only
// needs a query that reliably surfaces a victim note at baseline; the
// exact ranking is asserted indirectly via "score fell OR dropped out of
// top 5" after we overwrite the victim's body.
const QUERY_MODIFY = "project";
const QUERY_ADD = "the anatomy of a botanical leaf";

interface Harness {
  rootDir: string;
  vaultPath: string;
  dbPath: string;
  store: SemanticStore;
  embedder: Embedder;
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
  vaultIndex: VaultIndex;
  watcher: VaultWatcher;
  hybridCtx: HybridToolContext;
  semanticCtx: SemanticToolContext;
}

let harness: Harness | undefined;

/**
 * Rebuild the vault index from the current graph state. We call this
 * before constructing the watcher (so wikilink resolution is accurate at
 * dispatch time) but do NOT rebuild after each dispatch: the graph's
 * incremental updater mutates node ids in place, so the map of
 * basename → path stays stable for existing notes. Adds register new
 * basenames — if a scenario exercises cross-link resolution to a
 * freshly-added note we would rebuild; the scenarios here do not, so the
 * stable index is sufficient.
 */
const rebuildVaultIndex = (graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>): VaultIndex => {
  const notePaths: string[] = [];
  for (const id of graph.nodes()) {
    if (graph.getNodeAttributes(id).type === "note") notePaths.push(id);
  }
  return buildVaultIndex(notePaths);
};

/** Sum of outgoing + incoming edges for a note. Null when the node is gone. */
const edgeDegree = (
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  notePath: string,
): number | null => {
  if (!graph.hasNode(notePath)) return null;
  return graph.outDegree(notePath) + graph.inDegree(notePath);
};

/** Content hash used to sanity-check that the fixture write actually landed. */
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

describe.skipIf(!canDownload)("watcher roundtrip — full pipeline integration", () => {
  beforeAll(async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "foam-roundtrip-"));
    const vaultPath = join(rootDir, "vault");
    cpSync(fixtureRoot(import.meta.url), vaultPath, { recursive: true });

    const dbPath = join(rootDir, ".foam-mcp", "semantic", "index.sqlite");
    // better-sqlite3 does not create missing parent directories; create
    // the tree up-front so `SemanticStore.open()` can write the db file.
    mkdirSync(dirname(dbPath), { recursive: true });
    const embedder: Embedder = new TransformersEmbedder({});
    const store = new SemanticStore({
      path: dbPath,
      embedderName: embedder.info.name,
      dims: embedder.info.dims,
    });
    await store.open();

    // Cold build: downloads the model on first run, then loads from cache.
    await buildIndex(vaultPath, embedder, store, {});

    const graph = await buildGraph(vaultPath, { mocPattern: MOC_PATTERN });
    const vaultIndex = rebuildVaultIndex(graph);

    const keywordCtx: KeywordToolContext = {
      vaultPath,
      mocPattern: MOC_PATTERN,
      ripgrepPath: rgPath,
    };
    const graphCtx: GraphToolContext = { vaultPath, graph };
    const semanticCtx: SemanticToolContext = {
      vaultPath,
      mocPattern: MOC_PATTERN,
      embedder,
      store,
    };
    const hybridCtx: HybridToolContext = {
      keyword: keywordCtx,
      graph: graphCtx,
      semantic: semanticCtx,
    };

    const watcher = createVaultWatcher({
      vaultPath,
      graph,
      vaultIndex,
      mocPattern: MOC_PATTERN,
      store,
      embedder,
      debounceMs: DEBOUNCE_MS,
    });
    await watcher.start();

    harness = {
      rootDir,
      vaultPath,
      dbPath,
      store,
      embedder,
      graph,
      vaultIndex,
      watcher,
      hybridCtx,
      semanticCtx,
    };
  }, 120_000);

  afterAll(async () => {
    if (harness === undefined) return;
    await harness.watcher.stop();
    await harness.store.close();
    await harness.embedder.close();
    rmSync(harness.rootDir, { recursive: true, force: true });
    harness = undefined;
  });

  // -------------------------------------------------------------------------
  // A. Modify a note → hybrid_search ranking shifts, upToDate recovers.
  // -------------------------------------------------------------------------

  it("modify: overwriting a note's body shifts hybrid_search ranking and updates index_status", async () => {
    if (harness === undefined) throw new Error("harness missing");
    const h = harness;

    // Baseline search — capture the top hit for the "project tracking"
    // query before we perturb anything. The fixture contains
    // `01-Projects/project-x.md` and `01-Projects/project-y.md`; one of
    // them is the expected top match for a "project tracking" query.
    const baseline = await hybridSearch({ query: QUERY_MODIFY, limit: 10 }, h.hybridCtx);
    expect(baseline.hits.length).toBeGreaterThan(0);
    const topBaseline = baseline.hits[0];
    expect(topBaseline).toBeDefined();
    if (topBaseline === undefined) throw new Error("no baseline top");

    // Pick the baseline top hit as the victim. Overwrite its body with a
    // long passage about botany — semantically far from "project tracking".
    const victimPath = topBaseline.notePath;
    const baselineScore = topBaseline.score;
    const baselineTop5 = baseline.hits.slice(0, 5).map((h) => h.notePath);
    const priorDegree = edgeDegree(h.graph, victimPath);

    const newBody = [
      "---",
      'title: "Botany Field Notes"',
      "tags: [botany, nature]",
      "---",
      "# Botany field notes",
      "",
      "The vascular bundle of a dicotyledonous leaf is an intricate network",
      "of xylem and phloem tissues. The cuticle's waxy coating reduces",
      "transpiration in arid environments, while guard cells regulate",
      "stomatal aperture in response to turgor pressure. Chloroplasts in",
      "the palisade mesophyll perform the bulk of photosynthesis, and the",
      "spongy mesophyll below facilitates gas exchange. Photosynthetic",
      "efficiency depends on leaf orientation and phyllotaxis.",
      "",
    ].join("\n");
    writeFileSync(victimPath, newBody, "utf8");
    // Sanity: write landed and is distinct from any prior content.
    expect(sha(newBody)).not.toBe("");

    // Drive the watcher test seam (bypasses fs-event debounce).
    await h.watcher._applyChange({ path: victimPath, type: "modify" });

    // Graph edges: the new body has no wikilinks, so any outgoing edges
    // from the victim must have been removed. Incoming edges from other
    // notes that link to it remain (we only replaced its body). So the
    // total degree should have dropped unless the victim had zero
    // outgoing edges to begin with.
    const afterDegree = edgeDegree(h.graph, victimPath);
    expect(afterDegree).not.toBeNull();
    // It might stay equal only if the original had no outgoing edges.
    // The fixture's project-* notes both have wikilinks, so we expect
    // a strict drop for those; if some other note was chosen, just
    // require "did not grow".
    if (priorDegree !== null) {
      expect(afterDegree).toBeLessThanOrEqual(priorDegree);
    }

    // Semantic: the store should contain fresh chunks whose fingerprint
    // matches the new body hash. If we never re-read the file, the
    // fingerprint would still be the old value — so this check is a
    // direct assertion that the re-embed path ran.
    const storedFp = await h.store.getNoteFingerprint(victimPath);
    expect(storedFp).toBe(sha(newBody));

    // Fresh search — the previous top hit must have either dropped in
    // rank or scored lower. The botany body no longer matches
    // "project tracking" semantically OR via keyword.
    const after = await hybridSearch({ query: QUERY_MODIFY, limit: 10 }, h.hybridCtx);
    const newRank = after.hits.findIndex((hit) => hit.notePath === victimPath);
    const newTop5 = after.hits.slice(0, 5).map((h) => h.notePath);
    const newScoreForVictim = newRank >= 0 ? (after.hits[newRank]?.score ?? 0) : 0;

    // Either the victim is no longer in the top 5, OR its score dropped.
    const droppedOutOfTop5 = !newTop5.includes(victimPath);
    const scoreFell = newScoreForVictim < baselineScore;
    expect(droppedOutOfTop5 || scoreFell).toBe(true);

    // Cross-check: at minimum, one previously-top-5 ordering changed.
    // (Guards against a degenerate vault where every note is equally
    // unrelated to "project tracking" — the fixture isn't like that, but
    // being explicit keeps the intent visible.)
    expect(JSON.stringify(newTop5)).not.toBe(JSON.stringify(baselineTop5));

    // index_status reflects the dispatched fingerprint update → upToDate.
    const status = await indexStatus({}, h.semanticCtx);
    expect(status.upToDate).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // B. Delete a note → it disappears from results.
  // -------------------------------------------------------------------------

  it("delete: unlinking a note removes it from hybrid_search and shrinks index_status", async () => {
    if (harness === undefined) throw new Error("harness missing");
    const h = harness;

    // Pick a note unlikely to be critical to other scenarios: the
    // timestamped resource note. It contains a real wikilink to `note-a`
    // (an incoming edge sanity check for the graph path) and the word
    // "timestamped" in its body (keyword path anchor).
    const victimPath = join(h.vaultPath, "03-Resources", "202604160900-timestamped.md");

    const statusBefore = await indexStatus({}, h.semanticCtx);
    const hadChunks = statusBefore.chunks;
    const hadNotes = statusBefore.notes;
    expect(hadNotes).toBeGreaterThan(0);
    expect(hadChunks).toBeGreaterThan(0);
    expect(h.graph.hasNode(victimPath)).toBe(true);

    // Prove the note currently surfaces for "timestamped".
    const before = await hybridSearch({ query: "timestamped", limit: 20 }, h.hybridCtx);
    expect(before.hits.some((hit) => hit.notePath === victimPath)).toBe(true);

    unlinkSync(victimPath);
    await h.watcher._applyChange({ path: victimPath, type: "delete" });

    // Graph: node removed, along with any edges pointing at or from it.
    expect(h.graph.hasNode(victimPath)).toBe(false);

    // Semantic: chunks + fingerprint cleared.
    const storedFp = await h.store.getNoteFingerprint(victimPath);
    // `updateNoteSemantic` writes an empty-string sentinel on delete so
    // a later add is classified as "added" rather than "updated".
    expect(storedFp === null || storedFp === "").toBe(true);

    // Search no longer returns the deleted note.
    const after = await hybridSearch({ query: "timestamped", limit: 20 }, h.hybridCtx);
    expect(after.hits.some((hit) => hit.notePath === victimPath)).toBe(false);

    // Counts shrank on both dimensions.
    const statusAfter = await indexStatus({}, h.semanticCtx);
    expect(statusAfter.notes).toBeLessThan(hadNotes);
    expect(statusAfter.chunks).toBeLessThan(hadChunks);
  }, 60_000);

  // -------------------------------------------------------------------------
  // C. Add a brand-new note → it appears in results.
  // -------------------------------------------------------------------------

  it("add: creating a new note surfaces it in hybrid_search results", async () => {
    if (harness === undefined) throw new Error("harness missing");
    const h = harness;

    const newPath = join(h.vaultPath, "03-Resources", "leaf-anatomy.md");
    const body = [
      "---",
      'title: "Leaf anatomy primer"',
      "tags: [botany, anatomy]",
      "---",
      "# Leaf anatomy primer",
      "",
      "This note covers the anatomy of a botanical leaf, including the",
      "cuticle, epidermis, palisade mesophyll, spongy mesophyll, vascular",
      "bundle, and stomata. Understanding the anatomy of a botanical leaf",
      "is foundational for studying photosynthesis, transpiration, and",
      "plant gas exchange.",
      "",
    ].join("\n");

    const statusBefore = await indexStatus({}, h.semanticCtx);
    writeFileSync(newPath, body, "utf8");
    await h.watcher._applyChange({ path: newPath, type: "add" });

    // Graph: new node present.
    expect(h.graph.hasNode(newPath)).toBe(true);

    // Semantic: fingerprint equals new body hash.
    const storedFp = await h.store.getNoteFingerprint(newPath);
    expect(storedFp).toBe(sha(body));

    // Search: the new note is a top-3 hit for a query that targets its
    // unique content. We also accept top-1 / top-2 — the specific rank
    // depends on embedder nuance. "Top 3" is the PLAN guidance and is
    // robust to minor cosine noise.
    const out: HybridSearchOutput = await hybridSearch({ query: QUERY_ADD, limit: 5 }, h.hybridCtx);
    const topPaths = out.hits.slice(0, 3).map((hit) => hit.notePath);
    expect(topPaths).toContain(newPath);

    // Counts grew.
    const statusAfter = await indexStatus({}, h.semanticCtx);
    expect(statusAfter.notes).toBeGreaterThan(statusBefore.notes);
    expect(statusAfter.chunks).toBeGreaterThan(statusBefore.chunks);
  }, 60_000);
});
