/**
 * Runtime configuration for foam-notes-mcp.
 *
 * Responsibilities:
 * - Parse required/optional environment variables.
 * - Reject unsupported platforms (Windows) at startup.
 * - Verify ripgrep is available (via `@vscode/ripgrep`), fail fast otherwise.
 * - Resolve cache directory and MOC pattern with sensible defaults.
 *
 * This module is a leaf: it must not import from any feature layer.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";

export interface FoamConfig {
  /** Absolute path to the vault root directory. */
  readonly vaultPath: string;
  /** Absolute path to the cache directory (inside `./.foam-mcp/` by default). */
  readonly cacheDir: string;
  /**
   * Glob pattern used to identify Maps-of-Content notes.
   * Defaults to `*-MOC.md`. Pattern is a micromatch-style glob, not a regex.
   */
  readonly mocPattern: string;
  /** Absolute path to the ripgrep binary. */
  readonly ripgrepPath: string;
}

const DEFAULT_CACHE_DIR_REL = "./.foam-mcp/";
const DEFAULT_MOC_PATTERN = "*-MOC.md";

/**
 * Load and validate configuration from environment variables.
 *
 * @throws Error on Windows, missing/invalid `FOAM_VAULT_PATH`, or missing ripgrep.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): FoamConfig => {
  rejectWindows();

  const vaultPath = resolveVaultPath(env.FOAM_VAULT_PATH);
  const cacheDir = resolveCacheDir(env.FOAM_CACHE_DIR);
  const mocPattern = resolveMocPattern(env.VAULT_MOC_PATTERN);
  const ripgrepPath = verifyRipgrep();

  return { vaultPath, cacheDir, mocPattern, ripgrepPath };
};

const rejectWindows = (): void => {
  if (process.platform === "win32") {
    throw new Error("foam-notes-mcp does not support Windows. Supported platforms: darwin, linux.");
  }
};

const resolveVaultPath = (raw: string | undefined): string => {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "FOAM_VAULT_PATH is required. Set it to an absolute path of your Foam/Markdown vault directory.",
    );
  }
  const vaultPath = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);

  let stat;
  try {
    stat = statSync(vaultPath);
  } catch (err) {
    throw new Error(
      `FOAM_VAULT_PATH does not exist or is not accessible: ${vaultPath} (${(err as Error).message})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`FOAM_VAULT_PATH is not a directory: ${vaultPath}`);
  }
  return vaultPath;
};

const resolveCacheDir = (raw: string | undefined): string => {
  const useRaw = raw && raw.trim() !== "" ? raw : DEFAULT_CACHE_DIR_REL;
  return isAbsolute(useRaw) ? useRaw : resolve(process.cwd(), useRaw);
};

const resolveMocPattern = (raw: string | undefined): string =>
  raw && raw.trim() !== "" ? raw : DEFAULT_MOC_PATTERN;

const verifyRipgrep = (): string => {
  if (!rgPath) {
    throw new Error(
      "ripgrep binary is missing. Reinstall dependencies: `npm install @vscode/ripgrep`.",
    );
  }
  let stat;
  try {
    stat = statSync(rgPath);
  } catch (err) {
    throw new Error(`ripgrep binary is not accessible at ${rgPath}: ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`ripgrep path is not a regular file: ${rgPath}`);
  }
  return rgPath;
};
