/**
 * Shared helpers for the Wave 6 perf suite.
 *
 * Two primitives:
 *   - {@link measureP95}: warm up, then measure; return p95 + mean + samples.
 *   - {@link getOrCreateSyntheticVault}: generate (or reuse) a deterministic
 *     synthetic vault at a stable tmpdir path, via the existing
 *     `scripts/gen-synthetic-vault.ts` tsx script.
 *
 * The perf tests import from these helpers rather than re-implementing the
 * vault generation / timing plumbing in each test file.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export interface MeasureResult {
  /** 95th-percentile sample in milliseconds. */
  readonly p95: number;
  /** Arithmetic mean of all measured samples, in milliseconds. */
  readonly mean: number;
  /** All measured samples (sorted ascending), in milliseconds. */
  readonly samples: readonly number[];
}

/**
 * Run `fn()` three times as warmup (JIT, module loads, sqlite prepared
 * statement caches), then `iterations` times as measured samples. Returns
 * p95, mean, and the full sorted samples array.
 *
 * We compute p95 index with `Math.ceil(0.95 * N) - 1` — for N=10 this is
 * index 9, the slowest sample. That intentionally biases toward the worst
 * observed case, which is the right signal for a budget assertion.
 */
export const measureP95 = async <T>(
  fn: () => Promise<T>,
  iterations = 10,
): Promise<MeasureResult> => {
  // Warmup.
  await fn();
  await fn();
  await fn();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);

  const p95Index = Math.ceil(0.95 * iterations) - 1;
  // Safe: iterations > 0 ⇒ p95Index ∈ [0, iterations-1].
  const p95 = samples[p95Index] as number;
  const mean = samples.reduce((acc, x) => acc + x, 0) / iterations;
  return { p95, mean, samples };
};

/**
 * Generate or reuse a synthetic vault of the given size at a stable tmpdir
 * path. Keyed by `(size, seed)` so callers can request different shapes
 * without collision.
 *
 * Reuses the vault if a best-effort completeness check passes:
 *   - size = 10  → look for `00-Index-MOC.md` (emitted by `gen10`).
 *   - size ≥ 100 → count `.md` files recursively and require at least 90%
 *     of `size` (the synthetic generator always writes exactly `size`
 *     files, so a partial directory from a crashed prior run fails this
 *     check and triggers a clean regen).
 *
 * Spawns the locally-installed `tsx` binary directly (resolved via
 * `node_modules/.bin/tsx` relative to this file), NOT `npx`, so the
 * command is invoked with an absolute path rather than a PATH lookup.
 * Throws if the generator exits non-zero.
 */
export const getOrCreateSyntheticVault = (size: number, seed = 42): string => {
  const vaultPath = path.join(os.tmpdir(), `foam-perf-vault-${String(size)}-seed${String(seed)}`);

  if (isVaultComplete(vaultPath, size)) {
    return vaultPath;
  }

  const scriptPath = fileURLToPath(
    new URL("../../scripts/gen-synthetic-vault.ts", import.meta.url),
  );
  // Resolve the locally-installed tsx binary relative to this file. Using
  // an absolute path avoids any `PATH` lookup and satisfies the
  // `sonarjs/no-os-command-from-path` rule.
  const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const result = spawnSync(
    tsxBin,
    [scriptPath, "--size", String(size), "--out", vaultPath, "--seed", String(seed)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `gen-synthetic-vault failed for size=${String(size)} seed=${String(seed)} (exit ${String(result.status)})`,
    );
  }
  return vaultPath;
};

/**
 * Best-effort check that a previously-generated vault is intact. For the
 * size-10 fixture we look for a known file; for synthetic vaults we walk
 * the directory tree and require at least 90% of `size` markdown files —
 * this rejects a directory left partially-populated by a crashed prior run.
 */
const isVaultComplete = (vaultPath: string, size: number): boolean => {
  if (!fs.existsSync(vaultPath)) return false;

  if (size === 10) {
    return fs.existsSync(path.join(vaultPath, "00-Index-MOC.md"));
  }

  let mdCount = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        mdCount += 1;
      }
    }
  };
  walk(vaultPath);
  return mdCount >= Math.floor(size * 0.9);
};
