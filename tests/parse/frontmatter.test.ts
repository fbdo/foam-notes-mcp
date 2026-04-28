import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../../src/parse/frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty data and the full source when there is no frontmatter", () => {
    const src = "# Heading\n\nBody only.\n";
    const { data, content } = parseFrontmatter(src);
    expect(data).toEqual({});
    expect(content).toBe(src);
  });

  it("extracts YAML frontmatter with typed values", () => {
    const src = `---
title: "My Note"
tags: [alpha, beta]
published: true
count: 7
---
# Body
`;
    const { data, content } = parseFrontmatter(src);
    expect(data["title"]).toBe("My Note");
    expect(data["tags"]).toEqual(["alpha", "beta"]);
    expect(data["published"]).toBe(true);
    expect(data["count"]).toBe(7);
    expect(content.startsWith("# Body")).toBe(true);
  });

  it("tolerates an empty frontmatter block", () => {
    const src = "---\n---\n\nBody\n";
    const { data, content } = parseFrontmatter(src);
    expect(data).toEqual({});
    expect(content.trim()).toBe("Body");
  });

  it("handles a single-string tags value", () => {
    const src = `---
tags: alpha beta gamma
---
body
`;
    const { data } = parseFrontmatter(src);
    expect(data["tags"]).toBe("alpha beta gamma");
  });

  it("throws on malformed YAML", () => {
    const src = `---
title: "unterminated
---
body
`;
    expect(() => parseFrontmatter(src)).toThrow();
  });
});
