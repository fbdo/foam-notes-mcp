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

/**
 * Supported embedder providers in v0.1. `ollama`, `openai`, and `bedrock` are
 * deferred to v0.2 (PLAN Decision #10, amended 2026-05-03). Unknown values
 * for `FOAM_EMBEDDER` are rejected at config load time (PLAN Decision #26).
 */
const SUPPORTED_EMBEDDER_PROVIDERS = ["transformers"] as const;
export type SupportedEmbedderProvider = (typeof SUPPORTED_EMBEDDER_PROVIDERS)[number];

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
  /**
   * Embedder provider id. Defaults to `"transformers"`. Any other value is a
   * fatal configuration error in v0.1 — see {@link SUPPORTED_EMBEDDER_PROVIDERS}.
   */
  readonly embedder: SupportedEmbedderProvider;
  /**
   * Whether to start the vault file watcher on server boot. Default `true`.
   * Opt out via `FOAM_WATCHER=0` (accepted: `0`/`false`/`no`). PLAN
   * Decision #12.
   */
  readonly watcher: boolean;
  /**
   * Max node count for the `foam://graph` resource payload. When
   * `graph.order` exceeds this, the resource read throws and the server
   * surfaces `McpError(InvalidRequest, ...)` rather than shipping a
   * multi-megabyte JSON blob over stdio. Default: 5000 (the v0.1 perf
   * ceiling). Override via `FOAM_GRAPH_MAX_NODES`.
   */
  readonly graphResourceMaxNodes: number;
  /**
   * Max UTF-8 byte length of the serialized `foam://graph` JSON payload.
   * Checked *after* serialization (since the byte count is only known
   * once `JSON.stringify` runs). Default: 10 MiB. Override via
   * `FOAM_GRAPH_MAX_BYTES`.
   */
  readonly graphResourceMaxBytes: number;
}

const DEFAULT_CACHE_DIR_REL = "./.foam-mcp/";
const DEFAULT_MOC_PATTERN = "*-MOC.md";
const DEFAULT_EMBEDDER: SupportedEmbedderProvider = "transformers";
const DEFAULT_GRAPH_MAX_NODES = 5000;
const DEFAULT_GRAPH_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Load and validate configuration from environment variables.
 *
 * @throws Error on Windows, missing/invalid `FOAM_VAULT_PATH`, missing ripgrep,
 *         or unsupported `FOAM_EMBEDDER` value.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): FoamConfig => {
  rejectWindows();

  const vaultPath = resolveVaultPath(env.FOAM_VAULT_PATH);
  const cacheDir = resolveCacheDir(env.FOAM_CACHE_DIR);
  const mocPattern = resolveMocPattern(env.VAULT_MOC_PATTERN);
  const ripgrepPath = verifyRipgrep();
  const embedder = resolveEmbedder(env.FOAM_EMBEDDER);
  const watcher = parseBool(env.FOAM_WATCHER, "FOAM_WATCHER", true);
  const graphResourceMaxNodes = parsePositiveInt(
    env.FOAM_GRAPH_MAX_NODES,
    "FOAM_GRAPH_MAX_NODES",
    DEFAULT_GRAPH_MAX_NODES,
  );
  const graphResourceMaxBytes = parsePositiveInt(
    env.FOAM_GRAPH_MAX_BYTES,
    "FOAM_GRAPH_MAX_BYTES",
    DEFAULT_GRAPH_MAX_BYTES,
  );

  return {
    vaultPath,
    cacheDir,
    mocPattern,
    ripgrepPath,
    embedder,
    watcher,
    graphResourceMaxNodes,
    graphResourceMaxBytes,
  };
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

/**
 * Validate and return the embedder provider id. Unknown values are a fatal
 * startup error in v0.1 (PLAN Decision #26) — the server refuses to boot
 * rather than silently falling back to a different provider.
 */
const resolveEmbedder = (raw: string | undefined): SupportedEmbedderProvider => {
  const value = raw && raw.trim() !== "" ? raw.trim() : DEFAULT_EMBEDDER;
  if (!SUPPORTED_EMBEDDER_PROVIDERS.includes(value as SupportedEmbedderProvider)) {
    throw new Error(
      `FOAM_EMBEDDER='${value}' is not supported in v0.1. ` +
        `Only 'transformers' is available. ` +
        `ollama/openai/bedrock are deferred to v0.2 per PLAN Decisions #10 (amended 2026-05-03) and #26.`,
    );
  }
  return value as SupportedEmbedderProvider;
};

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

/**
 * Parse a boolean env var with a fixed set of accepted truthy/falsy values.
 *
 * - Unset, empty, or whitespace-only → `defaultValue`.
 * - Truthy: `1`, `true`, `yes` (case-insensitive).
 * - Falsy: `0`, `false`, `no` (case-insensitive).
 * - Anything else throws with a clear "accepted values" message so users
 *   can't silently typo their way past the opt-out (PLAN Decision #12).
 */
const parseBool = (raw: string | undefined, envName: string, defaultValue: boolean): boolean => {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultValue;
  const lowered = trimmed.toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes") return true;
  if (lowered === "0" || lowered === "false" || lowered === "no") return false;
  throw new Error(
    `${envName}='${raw}' is not a valid boolean. Accepted values: 1/true/yes or 0/false/no.`,
  );
};

/**
 * Parse a positive-integer env var.
 *
 * - Unset, empty, or whitespace-only → `defaultValue`.
 * - Accepts decimal digits only (no leading `+`/`-`, no float, no hex,
 *   no exponent). Rejects `0` — every call site requires a strictly
 *   positive limit, so a zero value is almost certainly a config typo
 *   rather than intentional "disable the cap".
 * - Anything else throws with a clear accepted-values message. We
 *   prefer this over silent coercion to catch typos at startup.
 */
const parsePositiveInt = (
  raw: string | undefined,
  envName: string,
  defaultValue: number,
): number => {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (trimmed === "") return defaultValue;
  // Digits-only guard: rules out `1e9`, `0x10`, `3.14`, `-5`, `+5`, whitespace.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${envName}='${raw}' is not a valid positive integer. Accepted values: a decimal integer >= 1.`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `${envName}='${raw}' is not a valid positive integer. Accepted values: a decimal integer >= 1.`,
    );
  }
  return value;
};
