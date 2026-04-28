import { describe, it, expect } from "vitest";
import { extractTags } from "../../src/parse/tags.js";

describe("extractTags", () => {
  it("extracts inline #tag tokens from the body", () => {
    const src = `# Title\n\nSome #alpha and #beta here.\n`;
    expect(extractTags(src, {})).toEqual(["alpha", "beta"]);
  });

  it("supports hierarchical tags with slashes", () => {
    const src = `Body with #project/ui and #project/backend.\n`;
    expect(extractTags(src, {})).toEqual(["project/ui", "project/backend"]);
  });

  it("merges frontmatter array tags with inline tags and dedupes case-sensitively", () => {
    const src = `Body with #alpha and #gamma.\n`;
    const fm = { tags: ["alpha", "beta"] };
    expect(extractTags(src, fm)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("preserves case-sensitive distinctions (Foo vs foo are different tags)", () => {
    const src = `Body with #Foo and #foo.\n`;
    expect(extractTags(src, {})).toEqual(["Foo", "foo"]);
  });

  it("accepts a single-string frontmatter tags value (space/comma separated)", () => {
    expect(extractTags("body\n", { tags: "alpha, beta  gamma" })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("ignores tags inside fenced code blocks", () => {
    const src = [
      "# Title",
      "",
      "Real tag: #real",
      "",
      "```js",
      "// #fake-in-code should be ignored",
      "```",
      "",
      "~~~",
      "#another-fake-in-tilde-fence",
      "~~~",
    ].join("\n");
    expect(extractTags(src, {})).toEqual(["real"]);
  });

  it("ignores tags inside inline code spans", () => {
    const src = "Real #keeper but `#not-this` is code.";
    expect(extractTags(src, {})).toEqual(["keeper"]);
  });

  it("ignores tags inside HTML comments", () => {
    const src = "Real #keeper\n<!-- hidden #ghost -->\nmore";
    expect(extractTags(src, {})).toEqual(["keeper"]);
  });

  it("does not treat ATX headings (#, ##, ###) as tags", () => {
    const src = "# Title\n\n## Subsection\n\nBody with #tag.\n";
    expect(extractTags(src, {})).toEqual(["tag"]);
  });

  it("rejects URL-fragment style #anchor embedded in a word", () => {
    const src = "Visit example.com#section for info.";
    expect(extractTags(src, {})).toEqual([]);
  });

  it("ignores non-string frontmatter tags values", () => {
    expect(extractTags("body\n", { tags: 42 })).toEqual([]);
    expect(extractTags("body\n", { tags: ["ok", 7, null, "good"] })).toEqual(["ok", "good"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(extractTags("just text, no tags\n", {})).toEqual([]);
  });
});
