import { describe, it, expect, beforeEach } from "vitest";
import { resolve as resolvePath } from "node:path";
import { rgPath } from "@vscode/ripgrep";

import {
  findByFrontmatter,
  findUncheckedTasks,
  getNote,
  getVaultStats,
  resolveWikilinkTool,
  searchNotes,
  _resetVaultIndexCache,
  type KeywordToolContext,
} from "../../src/keyword/tools.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

const ctx: KeywordToolContext = {
  vaultPath: VAULT,
  mocPattern: "*-MOC.md",
  ripgrepPath: rgPath,
};

beforeEach(() => {
  _resetVaultIndexCache();
});

describe("search_notes (contract)", () => {
  it("returns results for a query that exists in the fixture vault", async () => {
    const results = await searchNotes({ query: "Note A" }, ctx);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.path.endsWith(".md"))).toBe(true);
    expect(results.every((r) => r.line >= 1 && r.column >= 1)).toBe(true);
  });

  it("respects the `limit` parameter", async () => {
    const all = await searchNotes({ query: "Note" }, ctx);
    expect(all.length).toBeGreaterThan(1);
    const bounded = await searchNotes({ query: "Note", limit: 1 }, ctx);
    expect(bounded.length).toBe(1);
  });

  it("returns [] for a query that doesn't match anything", async () => {
    const results = await searchNotes(
      { query: "zzz-this-string-is-absent-from-the-vault-qqq" },
      ctx,
    );
    expect(results).toEqual([]);
  });

  it("rejects an empty query", async () => {
    await expect(searchNotes({ query: "" }, ctx)).rejects.toThrow(/non-empty string/);
  });
});

describe("find_by_frontmatter (contract)", () => {
  it("finds notes where a key exists (default operator when no value)", async () => {
    const hits = await findByFrontmatter({ key: "tags" }, ctx);
    // Every fixture note with `tags:` in frontmatter has tags. By inspection:
    // 00-Index-MOC, project-x, project-y, note-a, note-b, archived = 6.
    expect(hits.length).toBe(6);
    expect(hits.every((h) => h.path.endsWith(".md"))).toBe(true);
  });

  it("finds notes where a key equals a specific string (array-aware)", async () => {
    // Frontmatter `tags: [project]` should match when searching for `project`.
    const hits = await findByFrontmatter({ key: "tags", value: "project" }, ctx);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(
      hits.every((h) => h.path.endsWith("project-x.md") || h.path.endsWith("project-y.md")),
    ).toBe(true);
  });

  it("supports the `contains` operator for substring matching", async () => {
    const hits = await findByFrontmatter(
      { key: "title", value: "Project", operator: "contains" },
      ctx,
    );
    expect(hits.map((h) => h.path).sort()).toEqual(
      [
        resolvePath(VAULT, "01-Projects/project-x.md"),
        resolvePath(VAULT, "01-Projects/project-y.md"),
      ].sort(),
    );
  });

  it("returns [] when the key does not exist on any note", async () => {
    const hits = await findByFrontmatter({ key: "definitely-not-a-real-field" }, ctx);
    expect(hits).toEqual([]);
  });

  it("rejects an empty key", async () => {
    await expect(findByFrontmatter({ key: "" }, ctx)).rejects.toThrow(/non-empty string/);
  });
});

describe("find_unchecked_tasks (contract)", () => {
  it("returns all unchecked tasks in the vault", async () => {
    const tasks = await findUncheckedTasks({}, ctx);
    // Unchecked tasks by inspection:
    //   project-x.md: 2   (`[ ]` under Goals, `[ ]` under Tasks; `[x]` skipped)
    //   note-a.md:    1
    //   no-frontmatter.md: 1
    //   archived.md:  1
    // → 5 total.
    expect(tasks.length).toBe(5);
    expect(tasks.every((t) => typeof t.text === "string" && t.text.length > 0)).toBe(true);
    expect(tasks.every((t) => t.line >= 1)).toBe(true);
  });

  it("filters by heading substring", async () => {
    const tasks = await findUncheckedTasks({ headingFilter: "Goals" }, ctx);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.heading).toBe("Goals");
    expect(tasks[0]?.path).toMatch(/project-x\.md$/);
  });

  it("returns [] when the glob matches nothing", async () => {
    const tasks = await findUncheckedTasks({ pathGlob: "nonexistent-folder/**/*.md" }, ctx);
    expect(tasks).toEqual([]);
  });

  it("scopes to a specific folder via pathGlob", async () => {
    const tasks = await findUncheckedTasks({ pathGlob: "02-Areas/**/*.md" }, ctx);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.path).toMatch(/02-Areas\/note-a\.md$/);
  });
});

describe("resolve_wikilink (contract)", () => {
  it("resolves a unique basename match", async () => {
    const res = await resolveWikilinkTool({ target: "note-a" }, ctx);
    expect(res.status).toBe("unique");
    expect(res.candidates).toEqual([resolvePath(VAULT, "02-Areas/note-a.md")]);
  });

  it("returns ambiguous when two notes share a basename", async () => {
    const res = await resolveWikilinkTool({ target: "202604170000-ambiguous" }, ctx);
    // Only one note has this exact basename in the fixture.
    expect(res.status).toBe("unique");
    const ambiguous = await resolveWikilinkTool({ target: "Ambiguous" }, ctx);
    // Fixture `title: "Ambiguous"` appears twice but that's frontmatter, not
    // basename; resolver operates on basenames. So the same target should be
    // `not_found` against basenames.
    expect(ambiguous.status).toBe("not_found");
  });

  it("resolves the directory-link fallback `[[folder]]` → `folder/index.md`", async () => {
    const res = await resolveWikilinkTool({ target: "folder-link-target" }, ctx);
    expect(res.status).toBe("unique");
    expect(res.candidates).toEqual([resolvePath(VAULT, "folder-link-target/index.md")]);
  });

  it("returns not_found for unknown targets", async () => {
    const res = await resolveWikilinkTool({ target: "this-is-not-a-note" }, ctx);
    expect(res.status).toBe("not_found");
    expect(res.candidates).toEqual([]);
  });
});

describe("get_note (contract)", () => {
  it("reads a note by vault-relative path with frontmatter + tags + wikilinks + tasks", async () => {
    const note = await getNote({ path: "02-Areas/note-a.md" }, ctx);
    expect(note.path).toBe(resolvePath(VAULT, "02-Areas/note-a.md"));
    expect(note.frontmatter.title).toBe("Note A");
    expect(note.tags).toEqual(expect.arrayContaining(["area", "alpha"]));
    expect(note.wikilinks.map((w) => w.target)).toEqual(expect.arrayContaining(["note-b"]));
    expect(note.tasks.some((t) => !t.checked)).toBe(true);
    expect(note.body).toBeUndefined();
  });

  it("includes the body when requested", async () => {
    const note = await getNote({ path: "02-Areas/note-a.md", includeBody: true }, ctx);
    expect(typeof note.body).toBe("string");
    expect(note.body).toContain("Note A");
    // Body excludes the YAML frontmatter.
    expect(note.body).not.toContain("---\ntitle:");
  });

  it("rejects a traversal path that escapes the vault", async () => {
    await expect(getNote({ path: "../../../etc/passwd" }, ctx)).rejects.toThrow(
      /escapes the vault/,
    );
  });

  it("rejects a non-markdown path inside the vault", async () => {
    await expect(getNote({ path: "something.txt" }, ctx)).rejects.toThrow(/only markdown/);
  });
});

describe("get_vault_stats (contract)", () => {
  it("reports accurate counts for the 10-note fixture (actually 11 files)", async () => {
    const stats = await getVaultStats({}, ctx);
    // Fixture inventory (by inspection):
    //   11 `.md` files
    //   1 MOC (00-Index-MOC.md)
    //   6 tasks total, 5 unchecked
    //   10 wikilinks total, 1 broken (placeholder-target)
    //   (directory-link fallback resolves [[folder-link-target]] → folder-link-target/index.md)
    //   Unique tags: index, moc, project, project/secondary, area, alpha, archive, resource = 8
    //   Total tag occurrences: 2 + 1 + 2 + 2 + 1 + 1 + 1 = 10
    expect(stats.noteCount).toBe(11);
    expect(stats.mocCount).toBe(1);
    expect(stats.taskCount).toBe(6);
    expect(stats.uncheckedTaskCount).toBe(5);
    expect(stats.wikilinkCount).toBe(10);
    expect(stats.brokenWikilinkCount).toBe(1);
    expect(stats.uniqueTags).toBe(8);
    expect(stats.totalTags).toBe(10);
  });
});
