/**
 * CI-only regression test for the `.bin` symlink invocation path.
 *
 * Context: v0.1.0 and v0.1.1 shipped with a broken `isDirectInvocation()`
 * in `src/server.ts` that compared `pathToFileURL(process.argv[1]).href`
 * to `import.meta.url`. When Node is launched via a `.bin` symlink — the
 * standard install path used by `npx`, `npm install -g`, and MCP clients
 * (`command: npx`) — `argv[1]` is the symlink path while `import.meta.url`
 * is realpath-resolved. The strings never matched, so `main()` was
 * silently skipped and the process exited 0 with no output.
 *
 * This test exercises the real install path: it packs the repo, installs
 * the tarball into a throwaway dir, and invokes the binary through the
 * `.bin` symlink. If `isDirectInvocation()` is broken, stderr will be
 * empty and the assertions fail. If it's correct, the server boots and
 * logs its startup banner ("Graph built:", "Semantic store open:") on
 * stderr before we send `timeout` via the spawn timeout option.
 *
 * Cost: ~20–30s including a one-time embedder model warm-up if the HF
 * cache is cold. The test is gated behind `CI=true` so local runs skip
 * it by default; set `FOAM_SKIP_BIN_SYMLINK=true` to force-skip it in CI.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CI-only; slow (20–30s). Skipped locally by default.
const isCI = process.env.CI === "true";
const isSkip = process.env.FOAM_SKIP_BIN_SYMLINK === "true";
const shouldRun = isCI && !isSkip;

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);

/**
 * Run a command with a fully-qualified binary path. We resolve `npm`
 * via `process.execPath`'s bin directory to avoid any PATH lookup
 * (matches the `sonarjs/no-os-command-from-path` convention used in
 * `tests/perf/helpers.ts`). `process.execPath` is Node's realpath and
 * its parent directory contains `npm` in every mainstream installation
 * (nvm, Volta, system Node). Arguments are passed as an array so shell
 * metacharacters in paths can't be interpreted.
 */
const runNpm = (
  args: readonly string[],
  options: { cwd: string; stdio?: "inherit" | "ignore" | "pipe" },
): { status: number | null; stdout: string } => {
  const nodeDir = path.dirname(process.execPath);
  const npmBin = path.join(nodeDir, "npm");
  const result = spawnSync(npmBin, args, {
    cwd: options.cwd,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed (exit ${String(result.status)}): ${result.stderr ?? ""}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? "" };
};

interface PackEntry {
  readonly filename: string;
}

describe.skipIf(!shouldRun)("bin symlink invocation (CI-only)", () => {
  let tarballPath = "";
  let installDir = "";
  let fixtureVault = "";

  beforeAll(() => {
    const repoRoot = path.resolve(thisDir, "../..");

    // Ensure dist/ is current.
    runNpm(["run", "build"], { cwd: repoRoot, stdio: "inherit" });

    // Pack and parse the JSON metadata to find the tarball name.
    const packResult = runNpm(["pack", "--json"], { cwd: repoRoot, stdio: "pipe" });
    const packMeta = JSON.parse(packResult.stdout) as readonly PackEntry[];
    const firstEntry = packMeta[0];
    if (!firstEntry) {
      throw new Error(`npm pack --json returned no entries: ${packResult.stdout}`);
    }
    tarballPath = path.join(repoRoot, firstEntry.filename);

    // Install into a throwaway dir. `npm init -y` creates a minimal
    // package.json so `npm install <tarball>` has a target to write into.
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "foam-bin-test-"));
    runNpm(["init", "-y"], { cwd: installDir, stdio: "ignore" });
    runNpm(["install", tarballPath], { cwd: installDir, stdio: "ignore" });

    // Point at the existing fixture vault.
    fixtureVault = path.join(repoRoot, "tests", "fixtures", "vault");
  }, 120_000);

  afterAll(() => {
    // Clean up the tarball and install dir.
    try {
      if (tarballPath) fs.rmSync(tarballPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      if (installDir) fs.rmSync(installDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("boots via .bin symlink and logs expected startup output", () => {
    const binPath = path.join(installDir, "node_modules", ".bin", "foam-notes-mcp");
    expect(fs.existsSync(binPath), `.bin symlink should exist at ${binPath}`).toBe(true);

    // Invoke with a valid vault. Use timeout to kill the server after startup.
    const result = spawnSync(binPath, [], {
      env: { ...process.env, FOAM_VAULT_PATH: fixtureVault, FOAM_WATCHER: "0" },
      input: "{}\n", // send one line of stdin so MCP server doesn't hang indefinitely
      timeout: 30_000,
      encoding: "utf8",
    });

    const stderr = result.stderr ?? "";

    // The server logs "Graph built: N nodes, M edges" and "Semantic store open:"
    // on stderr at startup. If isDirectInvocation() is broken, stderr will be
    // empty and the process exits 0 without output.
    expect(stderr, `stderr should include "Graph built"; got: ${stderr}`).toContain("Graph built");
    expect(stderr).toContain("Semantic store open");
  }, 60_000);
});
