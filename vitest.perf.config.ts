import { defineConfig } from "vitest/config";

/**
 * Perf test configuration (Wave 6 commit 1).
 *
 * The perf suite asserts p95 wall-clock budgets on a 500-note synthetic
 * vault per PLAN Wave 6:
 *   - keyword tools  <300ms p95
 *   - graph tools    <100ms p95
 *   - semantic search <300ms p95 (warm index, warm model)
 *   - first cold build <60s
 *
 * Runs are slow and sensitive to host machine — keep this config separate
 * from the default so `npm test` remains fast.
 *
 * - `testTimeout` / `hookTimeout`: generous so first-run vault generation
 *   (in a `beforeAll`) and real-model download in the semantic suite don't
 *   flake.
 * - `pool: "forks"`: each test file runs in its own child process so perf
 *   measurements are not contaminated by state left over from a previous
 *   file (e.g. jit warmup of shared modules, sqlite connection caches).
 * - `fileParallelism: false`: run test files sequentially. All three suites
 *   share the synthetic vault at a stable tmpdir path; running them in
 *   parallel would race on the generate-or-reuse step. Sequential runs
 *   also give cleaner, less noisy timing measurements.
 * - `reporters: ["verbose"]`: surfaces the per-it `console.error` lines
 *   that print measured p95/mean, so the CLI output is the report.
 * - `coverage.enabled: false`: instrumentation skews timings.
 */
export default defineConfig({
  test: {
    include: ["tests/perf/**/*.perf.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
    coverage: { enabled: false },
    reporters: ["verbose"],
  },
});
