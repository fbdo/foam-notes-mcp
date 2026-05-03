import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOL_DEFINITIONS, TOOL_HANDLERS, TOOL_ZOD_SHAPES } from "../../src/tools/index.js";

const EXPECTED_TOOL_NAMES = [
  "search_notes",
  "find_by_frontmatter",
  "find_unchecked_tasks",
  "resolve_wikilink",
  "get_note",
  "get_vault_stats",
  "list_backlinks",
  "neighbors",
  "shortest_path",
  "orphans",
  "placeholders",
  "central_notes",
] as const;

describe("TOOL_DEFINITIONS", () => {
  it("contains exactly the 12 keyword + graph tools", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort((a, b) => a.localeCompare(b)));
    expect(TOOL_DEFINITIONS.length).toBe(12);
  });

  it("every tool has a non-empty description", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("every inputSchema is a flat object schema with additionalProperties: false", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = tool.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(typeof schema.properties).toBe("object");
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });

  it("no schema contains $ref or definitions (flat schemas only)", () => {
    const serialized = JSON.stringify(TOOL_DEFINITIONS);
    expect(serialized.includes("$ref")).toBe(false);
    expect(serialized.includes('"definitions"')).toBe(false);
  });

  it("each required field is declared in properties", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const props = tool.inputSchema.properties as Record<string, unknown>;
      const required = (tool.inputSchema.required as readonly string[]) ?? [];
      for (const key of required) {
        expect(Object.prototype.hasOwnProperty.call(props, key)).toBe(true);
      }
    }
  });
});

describe("TOOL_HANDLERS", () => {
  it("has an entry for every tool definition", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(TOOL_HANDLERS).toHaveProperty(tool.name);
      const handler = (TOOL_HANDLERS as Record<string, unknown>)[tool.name];
      expect(typeof handler).toBe("function");
    }
  });

  it("has no extra handlers not declared as tool definitions", () => {
    const declared = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const key of Object.keys(TOOL_HANDLERS)) {
      expect(declared.has(key)).toBe(true);
    }
  });
});

describe("TOOL_ZOD_SHAPES", () => {
  it("exports a raw shape for every tool handler (12 total)", () => {
    const handlerKeys = Object.keys(TOOL_HANDLERS).sort((a, b) => a.localeCompare(b));
    const shapeKeys = Object.keys(TOOL_ZOD_SHAPES).sort((a, b) => a.localeCompare(b));
    expect(shapeKeys).toEqual(handlerKeys);
    expect(shapeKeys.length).toBe(12);
  });

  it("every entry is a plain object of zod schemas (raw-shape contract)", () => {
    for (const [name, shape] of Object.entries(TOOL_ZOD_SHAPES)) {
      expect(shape, `${name} must be a plain object (raw shape, not z.object)`).toBeTypeOf(
        "object",
      );
      expect(shape).not.toBeNull();
      // A raw shape is NOT a ZodType instance. Full z.object(...) would have
      // `.safeParse` on itself; a raw shape is just a record.
      expect((shape as { safeParse?: unknown }).safeParse).toBeUndefined();
      for (const [field, schema] of Object.entries(shape as Record<string, unknown>)) {
        expect(
          schema && typeof (schema as { safeParse?: unknown }).safeParse === "function",
          `${name}.${field} must be a zod schema`,
        ).toBe(true);
      }
    }
  });

  it("required-vs-optional parity with the JSON Schema for every tool", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const allShapes = TOOL_ZOD_SHAPES as Record<string, Record<string, z.ZodTypeAny>>;
      const shape = allShapes[tool.name];
      expect(shape, `shape exists for ${tool.name}`).toBeDefined();
      if (shape === undefined) continue;

      const jsonRequired = new Set(
        ((tool.inputSchema.required as readonly string[] | undefined) ?? []).map((k) => String(k)),
      );
      const jsonProperties = Object.keys(
        (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      );

      // Property keys must match 1:1 between the JSON Schema properties and
      // the zod raw shape.
      const shapeKeys = Object.keys(shape).sort((a, b) => a.localeCompare(b));
      expect(shapeKeys).toEqual([...jsonProperties].sort((a, b) => a.localeCompare(b)));

      // Required iff not wrapped in `.optional()`.
      for (const key of shapeKeys) {
        const fieldSchema = shape[key];
        expect(fieldSchema, `${tool.name}.${key} field schema exists`).toBeDefined();
        if (fieldSchema === undefined) continue;
        const isOptional = fieldSchema.safeParse(undefined).success;
        const expectedRequired = jsonRequired.has(key);
        expect(
          isOptional,
          `${tool.name}.${key} optionality mismatch (JSON Schema required=${String(expectedRequired)})`,
        ).toBe(!expectedRequired);
      }
    }
  });

  it("neighbors: parses a minimal valid input", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.neighbors);
    const parsed = schema.parse({ note: "a.md" });
    expect(parsed.note).toBe("a.md");
    expect(parsed.depth).toBeUndefined();
    expect(parsed.direction).toBeUndefined();
  });

  it("neighbors: parses a fully-specified valid input", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.neighbors);
    const parsed = schema.parse({ note: "a.md", depth: 2, direction: "out" });
    expect(parsed).toEqual({ note: "a.md", depth: 2, direction: "out" });
  });

  it("neighbors: rejects depth out of range (depth=5)", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.neighbors);
    expect(() => schema.parse({ note: "a.md", depth: 5 })).toThrow();
  });

  it("neighbors: rejects unknown direction", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.neighbors);
    expect(() => schema.parse({ note: "a.md", direction: "sideways" })).toThrow();
  });

  it("neighbors: rejects empty note string", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.neighbors);
    expect(() => schema.parse({ note: "" })).toThrow();
  });

  it("central_notes: rejects missing required algorithm", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.central_notes);
    expect(() => schema.parse({})).toThrow();
  });

  it("central_notes: accepts algorithm=pagerank and optional fields", () => {
    const schema = z.object(TOOL_ZOD_SHAPES.central_notes);
    const parsed = schema.parse({ algorithm: "pagerank", limit: 5, folder: "01-Projects" });
    expect(parsed).toEqual({ algorithm: "pagerank", limit: 5, folder: "01-Projects" });
  });

  it("get_vault_stats / orphans / placeholders: accept an empty object", () => {
    for (const name of ["get_vault_stats", "orphans", "placeholders"] as const) {
      const schema = z.object(TOOL_ZOD_SHAPES[name]);
      expect(schema.parse({})).toEqual({});
    }
  });
});
