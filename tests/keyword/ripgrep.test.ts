import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

import { runRipgrep } from "../../src/keyword/ripgrep.js";
import { fixtureRoot } from "../helpers/fixture.js";

const VAULT = fixtureRoot(import.meta.url);

const makeTempVault = (): string => mkdtempSync(join(tmpdir(), "foam-rg-"));

describe("runRipgrep", () => {
  it("finds matches across the fixture vault", async () => {
    const matches = await runRipgrep("Note A", { cwd: VAULT, ripgrepPath: rgPath });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.path.endsWith(".md"))).toBe(true);
    expect(matches.every((m) => m.line >= 1 && m.column >= 1)).toBe(true);
  });

  it("returns an empty array when no matches exist (exit code 1)", async () => {
    const matches = await runRipgrep("this-string-should-not-exist-zzz-qqq", {
      cwd: VAULT,
      ripgrepPath: rgPath,
    });
    expect(matches).toEqual([]);
  });

  it("includes context lines when requested", async () => {
    const matches = await runRipgrep("Note A", {
      cwd: VAULT,
      ripgrepPath: rgPath,
      contextLines: 1,
    });
    expect(matches.length).toBeGreaterThan(0);
    const withCtx = matches.find((m) => m.context !== undefined);
    expect(withCtx).toBeDefined();
    // When context is requested we expect at least one side to have a line —
    // the very first/last line of a file only has one side.
    expect(
      (withCtx?.context?.before.length ?? 0) + (withCtx?.context?.after.length ?? 0),
    ).toBeGreaterThan(0);
  });

  it("restricts results via a glob option", async () => {
    const matches = await runRipgrep("Note", {
      cwd: VAULT,
      ripgrepPath: rgPath,
      globs: ["02-Areas/**"],
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.path.includes("/02-Areas/"))).toBe(true);
  });

  it("passes a query starting with `--foo` safely as data, not a flag", async () => {
    const vault = makeTempVault();
    try {
      writeFileSync(join(vault, "a.md"), "hello --foo world\n", "utf8");
      const matches = await runRipgrep("--foo", { cwd: vault, ripgrepPath: rgPath });
      expect(matches.length).toBe(1);
      expect(matches[0]?.match).toContain("--foo");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("passes a query containing shell metacharacters safely (no shell interpretation)", async () => {
    const vault = makeTempVault();
    try {
      writeFileSync(join(vault, "a.md"), "payload; rm -rf / and more\n", "utf8");
      const matches = await runRipgrep("; rm", { cwd: vault, ripgrepPath: rgPath });
      expect(matches.length).toBe(1);
      expect(matches[0]?.match).toContain("; rm");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("honors maxCount to limit per-file matches", async () => {
    const vault = makeTempVault();
    try {
      const many = "needle\n".repeat(10);
      writeFileSync(join(vault, "a.md"), many, "utf8");
      const bounded = await runRipgrep("needle", {
        cwd: vault,
        ripgrepPath: rgPath,
        maxCount: 2,
      });
      // maxCount is per-file in ripgrep; we expect exactly 2 matches.
      expect(bounded.length).toBe(2);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
