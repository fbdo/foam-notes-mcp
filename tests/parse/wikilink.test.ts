import { describe, it, expect } from "vitest";
import { extractWikilinks } from "../../src/parse/wikilink.js";

describe("extractWikilinks", () => {
  it("extracts a plain [[target]] wikilink", () => {
    const src = "Body with [[note-a]].\n";
    const links = extractWikilinks(src);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "note-a" });
    expect(links[0]?.heading).toBeUndefined();
    expect(links[0]?.alias).toBeUndefined();
  });

  it("extracts [[target|alias]]", () => {
    const src = "See [[note-a|Alpha note]] please.";
    const links = extractWikilinks(src);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "note-a", alias: "Alpha note" });
    expect(links[0]?.heading).toBeUndefined();
  });

  it("extracts [[target#heading]]", () => {
    const src = "Jump to [[note-a#Section One]].";
    const links = extractWikilinks(src);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "note-a", heading: "Section One" });
    expect(links[0]?.alias).toBeUndefined();
  });

  it("extracts [[target#heading|alias]]", () => {
    const src = "[[note-a#Section One|see section]] here.";
    const links = extractWikilinks(src);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "note-a",
      heading: "Section One",
      alias: "see section",
    });
  });

  it("tracks 1-indexed line and column of the opening [[", () => {
    const src = "line1\nline2 [[target]] tail\n";
    const [link] = extractWikilinks(src);
    expect(link?.line).toBe(2);
    expect(link?.column).toBe(7); // "line2 " is 6 chars, then `[[` starts at col 7
  });

  it("extracts multiple wikilinks in one pass and preserves order", () => {
    const src = "[[a]] and [[b]] and [[c|alias]]";
    const links = extractWikilinks(src);
    expect(links.map((l) => l.target)).toEqual(["a", "b", "c"]);
    expect(links[2]?.alias).toBe("alias");
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const src = [
      "Real: [[real]]",
      "",
      "```",
      "fake [[ghost-in-code]] fake",
      "```",
      "",
      "~~~md",
      "another [[tilde-ghost]]",
      "~~~",
    ].join("\n");
    const targets = extractWikilinks(src).map((l) => l.target);
    expect(targets).toEqual(["real"]);
  });

  it("ignores wikilinks inside inline code spans", () => {
    const src = "Real [[keeper]] but `[[inline-ghost]]` no.";
    expect(extractWikilinks(src).map((l) => l.target)).toEqual(["keeper"]);
  });

  it("ignores wikilinks inside HTML comments", () => {
    const src = "Real [[keeper]]\n<!-- hidden [[ghost]] -->\nmore";
    expect(extractWikilinks(src).map((l) => l.target)).toEqual(["keeper"]);
  });

  it("rejects empty targets", () => {
    expect(extractWikilinks("Nothing [[]] here.")).toHaveLength(0);
  });

  it("rejects whitespace-only targets", () => {
    expect(extractWikilinks("Nothing [[   ]] here.")).toHaveLength(0);
  });

  it("trims whitespace around target, heading, and alias", () => {
    const src = "[[  note-a  #  Section One  |  Alias  ]]";
    const [link] = extractWikilinks(src);
    expect(link?.target).toBe("note-a");
    expect(link?.heading).toBe("Section One");
    expect(link?.alias).toBe("Alias");
  });

  it("does not match across newlines", () => {
    const src = "[[broken\nlink]] should not match";
    expect(extractWikilinks(src)).toHaveLength(0);
  });

  it("preserves duplicate links with separate positions", () => {
    const src = "[[same]] and again [[same]]";
    const links = extractWikilinks(src);
    expect(links).toHaveLength(2);
    expect(links[0]?.column).toBeLessThan(links[1]?.column ?? 0);
  });
});
