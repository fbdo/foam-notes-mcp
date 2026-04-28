import { describe, it, expect } from "vitest";
import { buildVaultIndex, resolveWikilink } from "../src/resolver.js";

const VAULT = [
  "/vault/00-Index-MOC.md",
  "/vault/02-Areas/note-a.md",
  "/vault/02-Areas/note-b.md",
  "/vault/03-Resources/202604160900-timestamped.md",
  "/vault/01-Projects/project-x.md",
  "/vault/01-Projects/project-y.md",
  "/vault/folder-link-target/index.md",
  "/vault/202604170000-ambiguous.md",
  "/vault/01-Projects/202604170001-ambiguous.md",
];

describe("resolveWikilink", () => {
  const index = buildVaultIndex(VAULT);

  it("rung a: resolves a unique basename exactly", () => {
    const r = resolveWikilink("note-a", index);
    expect(r.confidence).toBe("exact");
    expect(r.candidates).toEqual(["/vault/02-Areas/note-a.md"]);
  });

  it("rung a: strips an explicit .md suffix on the target before matching", () => {
    const r = resolveWikilink("note-b.md", index);
    expect(r.confidence).toBe("exact");
    expect(r.candidates).toEqual(["/vault/02-Areas/note-b.md"]);
  });

  it("rung b: falls back to a case-insensitive basename match", () => {
    const r = resolveWikilink("Note-A", index);
    expect(r.confidence).toBe("case-insensitive");
    expect(r.candidates).toEqual(["/vault/02-Areas/note-a.md"]);
  });

  it("rung c: resolves by path suffix when basename is non-unique across folders", () => {
    // Build a small index where `doc` is a basename shared by two notes
    // (`a/doc.md` and `b/doc.md`). The multi-segment path suffix `a/doc`
    // should disambiguate via rung c and return exactly one candidate.
    const local = buildVaultIndex(["/vault/a/doc.md", "/vault/b/doc.md", "/vault/c/other.md"]);
    const r = resolveWikilink("a/doc", local);
    expect(r.confidence).toBe("suffix");
    expect(r.candidates).toEqual(["/vault/a/doc.md"]);
  });

  it("rung c: resolves a deeper path suffix (path-prefixed target takes suffix rung)", () => {
    const r = resolveWikilink("02-Areas/note-a", index);
    expect(r.confidence).toBe("suffix");
    expect(r.candidates).toEqual(["/vault/02-Areas/note-a.md"]);
  });

  it("rung d: returns all candidates when basename is ambiguous (multiple paths)", () => {
    const r = resolveWikilink("202604170000-ambiguous", index);
    expect(r.confidence).toBe("exact");
    expect(r.candidates).toEqual(["/vault/202604170000-ambiguous.md"]);
  });

  it("rung d: ambiguous when both basenames collide (forced collision)", () => {
    const colliding = ["/vault/a/duplicate.md", "/vault/b/duplicate.md", "/vault/c/other.md"];
    const r = resolveWikilink("duplicate", buildVaultIndex(colliding));
    expect(r.confidence).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
    expect(new Set(r.candidates)).toEqual(
      new Set(["/vault/a/duplicate.md", "/vault/b/duplicate.md"]),
    );
  });

  it("rung d: ambiguous case-insensitive match across different casings", () => {
    const ci = ["/vault/a/CaseNote.md", "/vault/b/casenote.md"];
    const r = resolveWikilink("CASENOTE", buildVaultIndex(ci));
    expect(r.confidence).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  it("returns none / empty for unknown targets", () => {
    const r = resolveWikilink("completely-missing-note", index);
    expect(r.confidence).toBe("none");
    expect(r.candidates).toEqual([]);
  });

  it("returns none for an empty / whitespace target", () => {
    expect(resolveWikilink("", index).confidence).toBe("none");
    expect(resolveWikilink("   ", index).confidence).toBe("none");
  });

  it("normalizes backslashes in targets (legacy Windows-authored notes)", () => {
    const r = resolveWikilink("02-Areas\\note-a", index);
    expect(r.confidence).toBe("suffix");
    expect(r.candidates).toEqual(["/vault/02-Areas/note-a.md"]);
  });
});
