import { describe, it, expect } from "vitest";

import { ToolValidationError } from "../src/errors.js";

describe("ToolValidationError", () => {
  it("sets name, message, and code", () => {
    const err = new ToolValidationError("boom");
    expect(err.name).toBe("ToolValidationError");
    expect(err.message).toBe("boom");
    expect(err.code).toBe("TOOL_VALIDATION_ERROR");
  });

  it("is both `instanceof Error` and `instanceof ToolValidationError`", () => {
    const err = new ToolValidationError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ToolValidationError);
  });

  it("survives a throw/catch round-trip and preserves `instanceof`", () => {
    const caught: unknown = (() => {
      try {
        throw new ToolValidationError("thrown");
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(ToolValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as ToolValidationError).message).toBe("thrown");
    expect((caught as ToolValidationError).code).toBe("TOOL_VALIDATION_ERROR");
  });

  it("accepts a `cause` option and exposes it on the instance", () => {
    const root = new Error("root");
    const err = new ToolValidationError("wrapped", { cause: root });
    // Node 20+ sets `cause` on Error from the second argument.
    expect((err as Error & { cause?: unknown }).cause).toBe(root);
  });

  it("has a stack trace", () => {
    const err = new ToolValidationError("has stack");
    expect(typeof err.stack).toBe("string");
    expect(err.stack).toContain("ToolValidationError");
  });
});
