import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../../src/tools/index.js";

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
