/**
 * Unit tests for the embedder layer.
 *
 * These tests are deliberately **fast**: they never call `embed()`, so no
 * model download is triggered. Real download + inference behaviour is
 * covered by the skip-guarded integration suite (`./integration.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolValidationError } from "../../../src/errors.js";
import { createEmbedder, type EmbedderConfig } from "../../../src/semantic/embedder/index.js";
import {
  TRANSFORMERS_DEFAULT_DIMS,
  TRANSFORMERS_DEFAULT_MODEL,
  TransformersEmbedder,
} from "../../../src/semantic/embedder/transformers.js";

describe("TransformersEmbedder / info", () => {
  it("uses the default MiniLM model when no model is supplied", () => {
    const embedder = new TransformersEmbedder({});
    expect(embedder.info.provider).toBe("transformers");
    expect(embedder.info.model).toBe(TRANSFORMERS_DEFAULT_MODEL);
    expect(embedder.info.dims).toBe(TRANSFORMERS_DEFAULT_DIMS);
    expect(embedder.info.name).toBe(`transformers:${TRANSFORMERS_DEFAULT_MODEL}`);
  });

  it("reflects a custom model string in both `model` and `name`", () => {
    const custom = "Xenova/bge-small-en-v1.5";
    const embedder = new TransformersEmbedder({ model: custom });
    expect(embedder.info.model).toBe(custom);
    expect(embedder.info.name).toBe(`transformers:${custom}`);
    // `dims` is a provider-level constant in v0.1 — we do not probe the
    // model to discover its true dimension. The store enforces it on read.
    expect(embedder.info.dims).toBe(TRANSFORMERS_DEFAULT_DIMS);
  });

  it("treats an empty or whitespace-only model string as the default", () => {
    const empty = new TransformersEmbedder({ model: "" });
    const blank = new TransformersEmbedder({ model: "   " });
    expect(empty.info.model).toBe(TRANSFORMERS_DEFAULT_MODEL);
    expect(blank.info.model).toBe(TRANSFORMERS_DEFAULT_MODEL);
  });

  it("exposes `info` without triggering model load (lazy construction)", () => {
    // If the constructor performed I/O we'd see a noticeable delay or a
    // thrown error on an offline machine. The `info` object is pure data
    // and must be reachable synchronously.
    const embedder = new TransformersEmbedder({});
    expect(embedder.info).toBeDefined();
    expect(embedder.info.dims).toBe(384);
  });
});

describe("createEmbedder / factory", () => {
  it("returns a TransformersEmbedder for provider='transformers'", () => {
    const embedder = createEmbedder({ provider: "transformers" });
    expect(embedder).toBeInstanceOf(TransformersEmbedder);
    expect(embedder.info.provider).toBe("transformers");
  });

  it("forwards model + cacheDir to the TransformersEmbedder", () => {
    const custom = "Xenova/example";
    const embedder = createEmbedder({
      provider: "transformers",
      model: custom,
      cacheDir: join(tmpdir(), "foam-embedder-test-cache"),
    });
    expect(embedder.info.model).toBe(custom);
  });

  it.each(["ollama", "openai", "bedrock"] as const)(
    "throws ToolValidationError for provider='%s' (deferred to v0.2)",
    (provider) => {
      expect(() => createEmbedder({ provider })).toThrow(ToolValidationError);
      // The message must name the provider so the operator knows which
      // `FOAM_EMBEDDER` value triggered the failure.
      try {
        createEmbedder({ provider });
        // istanbul ignore next — unreachable when throw above fires.
        expect.fail("expected createEmbedder to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ToolValidationError);
        expect((err as Error).message).toContain(provider);
        expect((err as Error).message).toContain("v0.2");
      }
    },
  );

  it("throws ToolValidationError for an unknown provider id", () => {
    // Cast through `unknown` to bypass the union — simulates a bad
    // environment-variable value that slipped past a runtime parse.
    const bogus = { provider: "does-not-exist" } as unknown as EmbedderConfig;
    expect(() => createEmbedder(bogus)).toThrow(ToolValidationError);
    try {
      createEmbedder(bogus);
      // istanbul ignore next
      expect.fail("expected createEmbedder to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolValidationError);
      expect((err as Error).message).toContain("does-not-exist");
      expect((err as Error).message).toContain("transformers");
    }
  });
});

describe("TransformersEmbedder / embed() contract", () => {
  it("returns an empty array for zero-length input without loading the pipeline", async () => {
    // Empty input is a fast path: we shouldn't need to download a model
    // just to embed nothing. This also lets callers avoid guarding with
    // `texts.length > 0` at every call site.
    const embedder = new TransformersEmbedder({});
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
    // close() should be a no-op when nothing was loaded.
    await expect(embedder.close()).resolves.toBeUndefined();
  });

  it("throws on embed() after close() (prevents use-after-free)", async () => {
    const embedder = new TransformersEmbedder({});
    await embedder.close();
    // With no texts: close-before-use should still be detected when we
    // actually try to embed non-empty input, so construct a fresh
    // embedder for a non-empty call.
    const freshEmbedder = new TransformersEmbedder({});
    await freshEmbedder.close();
    await expect(freshEmbedder.embed(["x"])).rejects.toThrow(/after close/);
  });

  it("close() is idempotent", async () => {
    const embedder = new TransformersEmbedder({});
    await embedder.close();
    await expect(embedder.close()).resolves.toBeUndefined();
  });
});
