/**
 * Typed error classes shared across the codebase.
 *
 * This module is a leaf: it MUST NOT import from any other project module.
 * Other modules may freely import from it (the server layer, keyword layer,
 * etc.) so that validation vs. internal error classification is a type
 * check (`instanceof`) rather than a substring match on `err.message`.
 */

/**
 * Thrown by tool handlers when *caller* input is invalid. The transport
 * layer (`src/server.ts`) maps this to the JSON-RPC `InvalidParams` error
 * code; any other `Error` maps to `InternalError`.
 *
 * Uses `Object.setPrototypeOf` in the constructor to preserve the prototype
 * chain across transpile boundaries (TypeScript's `extends Error` emits a
 * pattern that can break `instanceof` after down-leveling).
 */
export class ToolValidationError extends Error {
  public readonly code = "TOOL_VALIDATION_ERROR" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolValidationError";
    Object.setPrototypeOf(this, ToolValidationError.prototype);
  }
}
