/**
 * Keyword-layer p95 budgets on a 500-note generated vault (Wave 6).
 *
 * Budget: each measured tool call must land under 300ms at p95.
 *
 * Warmup + 10-sample methodology is provided by `measureP95`. Samples are
 * reported via `console.error` so they surface under vitest's verbose
 * reporter regardless of the test's pass/fail state.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { rgPath } from "@vscode/ripgrep";

import {
  findUncheckedTasks,
  getVaultStats,
  searchNotes,
  type KeywordToolContext,
} from "../../src/keyword/tools.js";

import { getOrCreateSyntheticVault, measureP95 } from "./helpers.js";

let ctx: KeywordToolContext;

beforeAll(() => {
  const vaultPath = getOrCreateSyntheticVault(500);
  ctx = { vaultPath, mocPattern: "*-MOC.md", ripgrepPath: rgPath };
});

describe("keyword p95 budgets on 500-note vault", () => {
  it("search_notes p95 < 300ms", async () => {
    // `topic-05` is a tag injected by the synthetic generator into a subset
    // of notes — realistic "common term" query that forces ripgrep to scan
    // most of the vault and return many matches.
    const { p95, mean } = await measureP95(() =>
      searchNotes({ query: "topic-05", limit: 10 }, ctx),
    );
    console.error(`search_notes: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(300);
  });

  it("find_unchecked_tasks p95 < 300ms", async () => {
    const { p95, mean } = await measureP95(() => findUncheckedTasks({}, ctx));
    console.error(`find_unchecked_tasks: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(300);
  });

  it("get_vault_stats p95 < 300ms", async () => {
    const { p95, mean } = await measureP95(() => getVaultStats({}, ctx));
    console.error(`get_vault_stats: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms`);
    expect(p95).toBeLessThan(300);
  });
});
