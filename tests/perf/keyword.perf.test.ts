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

/**
 * 5k-note opt-in scaling tier. Enabled only when `FOAM_PERF_5K=1` (or
 * `=true`) — not run by default `npm run test:perf` or in CI. Purpose:
 * surface scaling behavior on a realistic large vault. Assertions are
 * informational — we log p95 / mean / min / max but do not fail on a
 * budget (PLAN has not set 5k budgets yet). A future PLAN update can
 * promote any stable measurement into a hard budget.
 */
const perf5kEnabled = process.env.FOAM_PERF_5K === "1" || process.env.FOAM_PERF_5K === "true";

let ctx5k: KeywordToolContext;

describe.skipIf(!perf5kEnabled)("keyword p95 budgets on 5000-note vault (informational)", () => {
  beforeAll(() => {
    const vaultPath = getOrCreateSyntheticVault(5000);
    ctx5k = { vaultPath, mocPattern: "*-MOC.md", ripgrepPath: rgPath };
  });

  it("search_notes (informational)", async () => {
    const { p95, mean, samples } = await measureP95(() =>
      searchNotes({ query: "topic-05", limit: 10 }, ctx5k),
    );
    const min = samples[0] ?? 0;
    const max = samples[samples.length - 1] ?? 0;
    console.error(
      `search_notes 5k: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );
    expect(p95).toBeGreaterThan(0);
  });

  it("find_unchecked_tasks (informational)", async () => {
    const { p95, mean, samples } = await measureP95(() => findUncheckedTasks({}, ctx5k));
    const min = samples[0] ?? 0;
    const max = samples[samples.length - 1] ?? 0;
    console.error(
      `find_unchecked_tasks 5k: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );
    expect(p95).toBeGreaterThan(0);
  });

  it("get_vault_stats (informational)", async () => {
    const { p95, mean, samples } = await measureP95(() => getVaultStats({}, ctx5k));
    const min = samples[0] ?? 0;
    const max = samples[samples.length - 1] ?? 0;
    console.error(
      `get_vault_stats 5k: p95=${p95.toFixed(1)}ms mean=${mean.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms`,
    );
    expect(p95).toBeGreaterThan(0);
  });
});
