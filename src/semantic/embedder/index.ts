/**
 * Embedder factory and public API re-exports.
 *
 * Per PLAN Decision #26, `FOAM_EMBEDDER` values other than `"transformers"`
 * are a **fatal configuration error** in v0.1 — we throw instead of silently
 * falling back. The `ollama`, `openai`, and `bedrock` ids parse (they're
 * typed in {@link ProviderId}) so the server can give a clear error, but
 * they are not implemented until v0.2 (Decision #10, amended 2026-05-03).
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import `./types.js`, `./transformers.js`, `../../errors.js`.
 *   - MUST NOT import from any sibling feature layer.
 */

import { ToolValidationError } from "../../errors.js";

import { TransformersEmbedder } from "./transformers.js";
import type { Embedder, EmbedderConfig } from "./types.js";

/**
 * Construct an embedder for the requested provider. v0.1 only supports
 * `"transformers"`; all other ids throw a {@link ToolValidationError}.
 *
 * @throws ToolValidationError when `config.provider` is not `"transformers"`.
 */
export const createEmbedder = (config: EmbedderConfig): Embedder => {
  switch (config.provider) {
    case "transformers":
      return new TransformersEmbedder(config);
    case "ollama":
    case "openai":
    case "bedrock":
      throw new ToolValidationError(
        `Embedder provider '${config.provider}' is not implemented in v0.1. ` +
          `Only 'transformers' is available. ollama/openai/bedrock are deferred to v0.2 ` +
          `per PLAN Decision #10 (amended 2026-05-03).`,
      );
    default:
      throw new ToolValidationError(
        `Unknown embedder provider '${(config as { provider: string }).provider}'. ` +
          `Supported in v0.1: 'transformers'.`,
      );
  }
};

export { TransformersEmbedder } from "./transformers.js";
export type { Embedder, EmbedderConfig, EmbedderInfo, ProviderId } from "./types.js";
