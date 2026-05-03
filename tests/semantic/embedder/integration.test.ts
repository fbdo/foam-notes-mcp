/**
 * Integration test for the transformers embedder: real model download +
 * real feature extraction.
 *
 * This suite is SKIPPED when:
 *   - `FOAM_SKIP_MODEL_DOWNLOAD=true` is set (opt-out), OR
 *   - no DNS resolution for `huggingface.co` (offline CI, airgap, etc.).
 *
 * The first run downloads ~23 MB of ONNX weights for
 * `Xenova/all-MiniLM-L6-v2` into the transformers module's cache directory
 * (controlled by `env.cacheDir`, which `TransformersEmbedder` sets from
 * `FOAM_CACHE_DIR` by default). Subsequent runs hit disk cache. We give a
 * generous 60-second timeout so the first-run case doesn't flake.
 *
 * We intentionally do NOT share one embedder across `it` blocks — each
 * test constructs its own so the teardown path (`close()`) is exercised.
 */

import { lookup } from "node:dns/promises";

import { describe, expect, it } from "vitest";

import { TransformersEmbedder } from "../../../src/semantic/embedder/transformers.js";

/**
 * Cheap, bounded network availability check. Performs a single DNS lookup
 * for `huggingface.co` with a 2-second timeout. Returns `true` iff the
 * lookup resolved to at least one address within the deadline.
 *
 * We do NOT probe via HTTPS: a DNS A record is sufficient to predict
 * whether the transformers library will be able to reach the hub. If DNS
 * succeeds but HTTPS later fails mid-download, the test will throw — and
 * that's the correct signal (something genuinely broken rather than
 * "offline environment").
 */
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

describe.skipIf(!canDownload)("TransformersEmbedder integration (model download)", () => {
  it("embeds a single text into a 384-dim L2-normalized vector", async () => {
    const embedder = new TransformersEmbedder({});
    try {
      const vectors = await embedder.embed(["hello world"]);
      expect(vectors).toHaveLength(1);
      const [vec] = vectors;
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec).toHaveLength(384);

      // Compute L2 magnitude directly on the typed array. For a properly
      // mean-pooled + normalized embedding this should land in a tight
      // band around 1.0.
      let mag = 0;
      // Safe: we just asserted `vec` has length 384.
      const v = vec as Float32Array;
      for (const component of v) {
        mag += component * component;
      }
      mag = Math.sqrt(mag);
      expect(mag).toBeGreaterThan(0.99);
      expect(mag).toBeLessThan(1.01);
    } finally {
      await embedder.close();
    }
  }, 60_000);

  it("ranks semantically similar texts higher than unrelated texts", async () => {
    const embedder = new TransformersEmbedder({});
    try {
      const [a, b, c] = await embedder.embed([
        "the cat sat on the mat",
        "a cat on a mat",
        "financial markets closed higher today",
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(c).toBeDefined();

      // For L2-normalized vectors, cosine similarity == dot product.
      const dot = (x: Float32Array, y: Float32Array): number => {
        let s = 0;
        for (let i = 0; i < x.length; i++) {
          s += x[i]! * y[i]!;
        }
        return s;
      };
      const simClose = dot(a as Float32Array, b as Float32Array);
      const simFar = dot(a as Float32Array, c as Float32Array);
      expect(simClose).toBeGreaterThan(simFar);
    } finally {
      await embedder.close();
    }
  }, 60_000);
});
