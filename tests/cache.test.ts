import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_SUBDIRS,
  atomicWrite,
  ensureCacheLayout,
  ensureDir,
  fingerprint,
  fingerprintBuffer,
  readCache,
  readCacheIfExists,
} from "../src/cache.js";

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "foam-cache-"));

describe("cache", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  describe("ensureDir / ensureCacheLayout", () => {
    it("creates the directory recursively if missing", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const deep = join(root, "nested", "deeper");
      ensureDir(deep);
      expect(existsSync(deep)).toBe(true);
    });

    it("is a no-op when the directory already exists", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      ensureDir(root);
      ensureDir(root); // second call must not throw
      expect(existsSync(root)).toBe(true);
    });

    it("ensureCacheLayout creates all four subdirs and returns their paths", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const paths = ensureCacheLayout(root);
      for (const sub of CACHE_SUBDIRS) {
        expect(existsSync(paths[sub])).toBe(true);
        expect(paths[sub].endsWith(sub)).toBe(true);
      }
    });
  });

  describe("fingerprint", () => {
    it("is stable across repeated calls on the same file", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const f = join(root, "a.md");
      writeFileSync(f, "hello world", "utf8");
      const one = fingerprint(f);
      const two = fingerprint(f);
      expect(one.hash).toBe(two.hash);
      expect(one.size).toBe(two.size);
    });

    it("changes hash when content changes", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const f = join(root, "a.md");
      writeFileSync(f, "v1", "utf8");
      const first = fingerprint(f).hash;
      writeFileSync(f, "v2", "utf8");
      const second = fingerprint(f).hash;
      expect(first).not.toBe(second);
    });

    it("fingerprintBuffer produces the same hash for identical content", () => {
      const a = fingerprintBuffer("hello", 123);
      const b = fingerprintBuffer(Buffer.from("hello", "utf8"), 456);
      expect(a.hash).toBe(b.hash);
      expect(a.size).toBe(5);
      expect(a.mtimeMs).toBe(123);
      expect(b.mtimeMs).toBe(456);
    });
  });

  describe("atomicWrite", () => {
    it("writes the content and leaves no temp files behind", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const target = join(root, "out.json");
      atomicWrite(target, '{"ok":true}');
      expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
      // Only the target file should remain.
      const entries = readdirSync(root);
      expect(entries).toEqual(["out.json"]);
    });

    it("creates parent directories as needed", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const target = join(root, "deeply", "nested", "file.bin");
      atomicWrite(target, Buffer.from([1, 2, 3, 4]));
      const read = readFileSync(target);
      expect(Array.from(read)).toEqual([1, 2, 3, 4]);
    });

    it("overwrites an existing file atomically", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const target = join(root, "x.txt");
      atomicWrite(target, "first");
      atomicWrite(target, "second");
      expect(readFileSync(target, "utf8")).toBe("second");
    });
  });

  describe("readCache / readCacheIfExists", () => {
    it("readCache returns file contents", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const f = join(root, "x.txt");
      atomicWrite(f, "payload");
      expect(readCache(f)).toBe("payload");
    });

    it("readCacheIfExists returns undefined for missing files", () => {
      const root = makeTempDir();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      expect(readCacheIfExists(join(root, "nope"))).toBeUndefined();
    });
  });
});
