import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Perf tests are expensive (generate a 500-note synthetic vault, load a
    // real embedder in the semantic suite) and assert wall-clock budgets that
    // are sensitive to the host machine. They live under `tests/perf/**` and
    // are run via a separate config (`vitest.perf.config.ts` / `npm run
    // test:perf`) so that `npm test` stays fast and deterministic.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/perf/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts"],
      thresholds: {
        statements: 80,
        // Vitest 4 / coverage-v8 counts branches more strictly than v3 (nullish
        // coalescing, optional chaining, short-circuit operators, default params).
        // The same codebase that reported 86.23% branches on v3.2.4 reports 77.00%
        // on v4.1.5 with zero code changes. Lowered 80 → 75 temporarily.
        // eslint-disable-next-line sonarjs/todo-tag -- intentional follow-up marker for Wave 4+
        // TODO: raise back to 80 once Wave 4+ code lands and branch coverage stabilizes;
        // avoid padding tests purely to raise this metric.
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
