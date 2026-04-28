/**
 * Thin, argv-safe wrapper around the ripgrep binary.
 *
 * We spawn ripgrep directly (NOT via a shell) and pass the query as a
 * positional argument preceded by `--`, so user input cannot be reinterpreted
 * as a ripgrep flag or as shell syntax. Stdout is parsed as newline-delimited
 * JSON (`--json`).
 *
 * Exit semantics:
 *   - 0: at least one match
 *   - 1: zero matches (we return `[]`)
 *   - >=2: actual error; reject with stderr included
 *
 * This module is a leaf of the keyword/ layer: it must not import from any
 * sibling feature layer.
 */

import { spawn } from "node:child_process";

/** A single ripgrep match with optional surrounding context lines. */
export interface RgMatch {
  /** Absolute path of the file containing the match. */
  readonly path: string;
  /** 1-indexed line number where the match starts. */
  readonly line: number;
  /** 1-indexed column number where the match starts. */
  readonly column: number;
  /** The full text of the matched line (without trailing newline). */
  readonly match: string;
  /** Surrounding context lines (populated when `contextLines > 0`). */
  readonly context?: {
    readonly before: readonly string[];
    readonly after: readonly string[];
  };
}

/** Options for {@link runRipgrep}. */
export interface RunRipgrepOptions {
  /** Absolute path of the working directory (the vault). */
  readonly cwd: string;
  /**
   * Absolute path to the ripgrep binary. Threaded from `FoamConfig.ripgrepPath`
   * (which is the single production-code importer of `@vscode/ripgrep`).
   */
  readonly ripgrepPath: string;
  /** Optional glob restrictions passed via `--glob`. */
  readonly globs?: readonly string[];
  /**
   * Number of lines of context to include before and after each match. `0`
   * (the default) disables context.
   */
  readonly contextLines?: number;
  /** Maximum number of matches per file (`--max-count`). */
  readonly maxCount?: number;
}

interface RgEventLineData {
  readonly text?: string;
}

interface RgEventPathData {
  readonly text?: string;
}

interface RgEventMatchData {
  readonly path?: RgEventPathData;
  readonly lines?: RgEventLineData;
  readonly line_number?: number;
  readonly submatches?: readonly {
    readonly start?: number;
  }[];
}

interface RgEventContextData {
  readonly path?: RgEventPathData;
  readonly lines?: RgEventLineData;
  readonly line_number?: number;
}

interface RgEventMatch {
  readonly type: "match";
  readonly data: RgEventMatchData;
}

interface RgEventContext {
  readonly type: "context";
  readonly data: RgEventContextData;
}

/** Discriminated union of ripgrep JSON events we care about. */
type RgEvent =
  | RgEventMatch
  | RgEventContext
  | { readonly type: "begin" | "end" | "summary"; readonly data: unknown };

/**
 * Run ripgrep for `query` inside `cwd`. Returns matches (never throws on
 * zero-match; exit code 1 becomes `[]`). Rejects with a helpful error when
 * ripgrep exits with code >= 2 or when the process fails to spawn.
 */
export const runRipgrep = async (query: string, options: RunRipgrepOptions): Promise<RgMatch[]> => {
  const { cwd, ripgrepPath, globs, contextLines = 0, maxCount } = options;

  const args = buildRipgrepArgs(query, { globs, contextLines, maxCount });

  return new Promise<RgMatch[]>((resolve, reject) => {
    const child = spawn(ripgrepPath, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events: RgEvent[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      // Keep last (possibly incomplete) line for the next chunk.
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = tryParseRgEvent(line);
        if (event !== undefined) events.push(event);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ripgrep (${ripgrepPath}): ${err.message}`));
    });

    child.on("close", (code) => {
      // Flush any trailing buffered line.
      if (stdoutBuffer.length > 0) {
        const event = tryParseRgEvent(stdoutBuffer);
        if (event !== undefined) events.push(event);
      }

      if (code === 1) {
        resolve([]);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`ripgrep exited with code ${String(code)}: ${stderr || "(no stderr)"}`));
        return;
      }
      resolve(assembleMatches(events, cwd));
    });
  });
};

const buildRipgrepArgs = (
  query: string,
  opts: { globs?: readonly string[]; contextLines: number; maxCount?: number },
): string[] => {
  const args: string[] = ["--json", "--smart-case", "--type", "md"];
  if (opts.contextLines > 0) {
    args.push("-C", String(opts.contextLines));
  }
  if (opts.maxCount !== undefined && opts.maxCount > 0) {
    args.push("--max-count", String(opts.maxCount));
  }
  if (opts.globs) {
    for (const g of opts.globs) {
      args.push("--glob", g);
    }
  }
  // `--` separator ensures `query` cannot be parsed as a flag, even if it
  // starts with `-` or `--`.
  args.push("--", query);
  return args;
};

const tryParseRgEvent = (line: string): RgEvent | undefined => {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return undefined;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string") return undefined;
    return parsed as RgEvent;
  } catch {
    // Malformed line — skip; ripgrep occasionally emits partial output on
    // error paths and we prefer resilience over a hard failure.
    return undefined;
  }
};

const assembleMatches = (events: readonly RgEvent[], cwd: string): RgMatch[] => {
  const out: RgMatch[] = [];
  for (let i = 0; i < events.length; i++) {
    // safe: bounded by loop condition
    const ev = events[i] as RgEvent;
    if (ev.type !== "match") continue;

    const data = ev.data;
    const rawPath = data.path?.text ?? "";
    const line = data.line_number ?? 0;
    const rawLines = data.lines?.text ?? "";
    const matchLine = rawLines.replace(/\r?\n$/, "");
    const submatchStart = data.submatches?.[0]?.start ?? 0;
    const column = submatchStart + 1;

    const path = resolveMatchPath(rawPath, cwd);
    const before = collectContextLines(events, i, -1);
    const after = collectContextLines(events, i, 1);
    const hasContext = before.length > 0 || after.length > 0;

    const match: RgMatch = hasContext
      ? { path, line, column, match: matchLine, context: { before, after } }
      : { path, line, column, match: matchLine };

    out.push(match);
  }
  return out;
};

const resolveMatchPath = (raw: string, cwd: string): string => {
  if (raw === "") return cwd;
  // ripgrep emits paths relative to its cwd; normalize to absolute.
  if (raw.startsWith("/")) return raw;
  return `${cwd}/${raw}`.replace(/\/+/g, "/");
};

/**
 * Walk adjacent events of type `context` in the given direction (-1 for
 * before, +1 for after), stopping at the first non-context event.
 */
const collectContextLines = (
  events: readonly RgEvent[],
  matchIdx: number,
  direction: -1 | 1,
): string[] => {
  const collected: string[] = [];
  let i = matchIdx + direction;
  while (i >= 0 && i < events.length) {
    // safe: bounded above
    const ev = events[i] as RgEvent;
    if (ev.type !== "context") break;
    const text = ev.data.lines?.text ?? "";
    collected.push(text.replace(/\r?\n$/, ""));
    i += direction;
  }
  return direction === -1 ? collected.reverse() : collected;
};
