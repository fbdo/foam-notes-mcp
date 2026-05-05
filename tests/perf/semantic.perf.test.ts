/**
 * Semantic-layer p95 budgets on a 500-note generated vault (Wave 6).
 *
 * Budgets:
 *   - first cold build < 60s (PLAN Wave 6)
 *   - `semantic_search` p95 < 300ms (warm index, warm model)
 *
 * Uses the real `TransformersEmbedder`. Model download is ~23 MB on first
 * run; subsequent runs hit the transformers disk cache. The suite is
 * skipped when:
 *   - `FOAM_SKIP_MODEL_DOWNLOAD=true` is set (explicit opt-out), OR
 *   - DNS lookup for `huggingface.co` fails (offline / airgapped).
 *
 * This matches the skip-if pattern used by
 * `tests/semantic/embedder/integration.test.ts` so the suite is safe to run
 * in flaky network environments without producing false failures.
 */

import * as dns from "node:dns/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TransformersEmbedder } from "../../src/semantic/embedder/transformers.js";
import { buildIndex } from "../../src/semantic/index.js";
import { SemanticStore } from "../../src/semantic/store.js";
import { semanticSearch } from "../../src/semantic/tools.js";

import { getOrCreateSyntheticVault, measureP95 } from "./helpers.js";

/**
 * Bounded DNS probe (2s timeout) for huggingface.co. A single A-record
 * lookup is sufficient to predict whether the transformers library can
 * reach the hub. If DNS succeeds but HTTPS later fails mid-download,
 * the test will throw — which is the correct signal for a genuine network
 * break rather than "offline environment".
 */
const isNetworkAvailable = async (): Promise<boolean> => {
  try {
    await Promise.race([
      dns.lookup("huggingface.co"),
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
const canRun = !skipFlag && (await isNetworkAvailable());

describe.skipIf(!canRun)("semantic p95 budgets on 500-note vault (real embedder)", () => {
  let vaultPath: string;
  let storePath: string;
  // Explicit `| undefined` so the afterAll cleanup can guard against a
  // beforeAll failure that left one or both unset.
  let embedder: TransformersEmbedder | undefined;
  let store: SemanticStore | undefined;

  beforeAll(async () => {
    vaultPath = getOrCreateSyntheticVault(500);
    storePath = path.join(vaultPath, ".foam-mcp", "semantic", "index.sqlite");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // Wipe any pre-existing store from a prior perf run so the "first cold
    // build" measurement below is actually cold (no skipped rows from
    // cached fingerprints).
    if (fs.existsSync(storePath)) fs.rmSync(storePath);

    embedder = new TransformersEmbedder({});
    store = new SemanticStore({
      path: storePath,
      embedderName: embedder.info.name,
      dims: embedder.info.dims,
    });
    await store.open();
  }, 180_000);

  afterAll(async () => {
    if (store) await store.close();
    if (embedder) await embedder.close();
  });

  it("first cold build < 60s", async () => {
    if (!embedder || !store) throw new Error("beforeAll did not initialize embedder/store");
    const start = performance.now();
    await buildIndex(vaultPath, embedder, store, { force: true });
    const dur = performance.now() - start;
    console.error(`cold build 500-note: ${dur.toFixed(0)}ms`);
    expect(dur).toBeLessThan(60_000);
  }, 120_000);

  it("semantic_search p95 < 300ms (warm index, warm model)", async () => {
    if (!embedder || !store) throw new Error("beforeAll did not initialize embedder/store");
    const ctx = {
      vaultPath,
      mocPattern: "*-MOC.md",
      embedder,
      store,
    };
    const { p95, mean } = await measureP95(() =>
      semanticSearch({ query: "topic about projects", limit: 10 }, ctx),
    );
    console.error(`semantic_search: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(300);
  }, 60_000);
});
