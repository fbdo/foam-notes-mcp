/**
 * Filesystem-facing cache primitives for foam-notes-mcp.
 *
 * Layout (under {@link CACHE_SUBDIRS} of the configured cache root):
 *   <cacheDir>/
 *     keyword/   ripgrep / keyword-layer artifacts
 *     graph/     graphology exports, placeholders, pagerank, etc.
 *     semantic/  sqlite-vec database and embedder manifests
 *     meta/      fingerprints, build stamps, version markers
 *
 * This module is the **only** place in `src/` permitted to write to disk
 * outside stdout/stderr (see PLAN decision #23). It is a leaf: it must not
 * import from any feature layer.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CACHE_SUBDIRS = ["keyword", "graph", "semantic", "meta"] as const;
export type CacheSubdir = (typeof CACHE_SUBDIRS)[number];

/**
 * A fingerprint pairs a content hash with the file's mtime so we can cheaply
 * detect "same file" across sessions without re-hashing every time.
 *
 * `mtimeMs` is a millisecond-precision timestamp from `fs.stat`. `hash` is a
 * hex-encoded SHA-256 of the file body.
 */
export interface Fingerprint {
  readonly hash: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** Ensure a directory exists (recursive). Safe to call on an existing dir. */
export const ensureDir = (absPath: string): void => {
  mkdirSync(absPath, { recursive: true });
};

/**
 * Ensure the full cache layout exists under `cacheDir`. Returns the absolute
 * paths of each subdirectory keyed by name.
 */
export const ensureCacheLayout = (cacheDir: string): Record<CacheSubdir, string> => {
  ensureDir(cacheDir);
  const result = {} as Record<CacheSubdir, string>;
  for (const sub of CACHE_SUBDIRS) {
    const p = join(cacheDir, sub);
    ensureDir(p);
    result[sub] = p;
  }
  return result;
};

/**
 * Compute a stable fingerprint from a file's content + metadata.
 *
 * Content-hashed so renames/moves don't invalidate caches, mtime-included so
 * callers can skip the hash when mtime is unchanged.
 */
export const fingerprint = (absPath: string): Fingerprint => {
  const stat = statSync(absPath);
  const buf = readFileSync(absPath);
  const hash = createHash("sha256").update(buf).digest("hex");
  return {
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
};

/** Compute a fingerprint from in-memory content + a known mtime. */
export const fingerprintBuffer = (buf: Buffer | string, mtimeMs: number): Fingerprint => {
  const asBuf = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  const hash = createHash("sha256").update(asBuf).digest("hex");
  return { hash, mtimeMs, size: asBuf.byteLength };
};

/** Read a cache file as UTF-8. Throws if missing. */
export const readCache = (absPath: string): string => {
  return readFileSync(absPath, "utf8");
};

/** Read a cache file as UTF-8, returning `undefined` when missing. */
export const readCacheIfExists = (absPath: string): string | undefined => {
  if (!existsSync(absPath)) return undefined;
  return readFileSync(absPath, "utf8");
};

/**
 * Atomic write: write to a sibling temp file, then rename into place.
 *
 * `rename` within the same filesystem is atomic on POSIX, which is the
 * guarantee callers rely on when reading partially-written files concurrently.
 * The parent directory is created if needed.
 */
export const atomicWrite = (absPath: string, contents: string | Buffer): void => {
  ensureDir(dirname(absPath));
  const tmp = `${absPath}.tmp-${process.pid.toString()}-${Date.now().toString()}-${randomBytes(5).toString("hex")}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, absPath);
  } catch (err) {
    // Best-effort cleanup of the stray temp file.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // swallow; the original error is what matters.
    }
    throw err;
  }
};
