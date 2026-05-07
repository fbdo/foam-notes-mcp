import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep as pathSep } from "node:path";
import { loadConfig } from "../src/config.js";

const makeTempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "foam-cfg-")));

describe("loadConfig", () => {
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  it("throws when FOAM_VAULT_PATH is unset", () => {
    expect(() => loadConfig({})).toThrow(/FOAM_VAULT_PATH is required/);
  });

  it("throws when FOAM_VAULT_PATH is empty/whitespace", () => {
    expect(() => loadConfig({ FOAM_VAULT_PATH: "   " })).toThrow(/FOAM_VAULT_PATH is required/);
  });

  it("throws when FOAM_VAULT_PATH points to a non-existent path", () => {
    const missing = join(tmpdir(), "definitely-not-a-real-path-" + Date.now().toString());
    expect(() => loadConfig({ FOAM_VAULT_PATH: missing })).toThrow(/does not exist/);
  });

  it("throws when FOAM_VAULT_PATH points to a file (not a directory)", () => {
    const dir = makeTempDir();
    const file = join(dir, "not-a-dir.md");
    writeFileSync(file, "# hello", "utf8");
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: file })).toThrow(/not a directory/);
  });

  it("returns a resolved absolute vault path and defaults when env is valid", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir });
    expect(cfg.vaultPath).toBe(dir);
    expect(cfg.mocPattern).toBe("*-MOC.md");
    // Default cache dir resolves against cwd but ends in ".foam-mcp"
    expect(cfg.cacheDir.endsWith(".foam-mcp") || cfg.cacheDir.endsWith(".foam-mcp/")).toBe(true);
    expect(cfg.ripgrepPath.length).toBeGreaterThan(0);
  });

  it("honors FOAM_CACHE_DIR when set", () => {
    const dir = makeTempDir();
    // Cache must be disjoint from the vault (M3, Wave 6): place it in a
    // sibling temp dir so the overlap check is satisfied.
    const cacheParent = makeTempDir();
    const cacheOverride = join(cacheParent, "my-cache");
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(() => rmSync(cacheParent, { recursive: true, force: true }));
    const cfg = loadConfig({
      FOAM_VAULT_PATH: dir,
      FOAM_CACHE_DIR: cacheOverride,
    });
    expect(cfg.cacheDir).toBe(cacheOverride);
  });

  it("honors VAULT_MOC_PATTERN when set", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({
      FOAM_VAULT_PATH: dir,
      VAULT_MOC_PATTERN: "!(*-index)-*MOC*.md",
    });
    expect(cfg.mocPattern).toBe("!(*-index)-*MOC*.md");
  });

  it("defaults FOAM_EMBEDDER to 'transformers' when unset", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir });
    expect(cfg.embedder).toBe("transformers");
  });

  it("accepts FOAM_EMBEDDER='transformers' explicitly", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_EMBEDDER: "transformers" });
    expect(cfg.embedder).toBe("transformers");
  });

  it("rejects unsupported FOAM_EMBEDDER values (ollama deferred to v0.2)", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_EMBEDDER: "ollama" })).toThrow(
      /FOAM_EMBEDDER='ollama' is not supported/,
    );
  });

  it("rejects unknown FOAM_EMBEDDER values", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_EMBEDDER: "not-a-provider" })).toThrow(
      /FOAM_EMBEDDER='not-a-provider' is not supported/,
    );
  });

  it("rejects Windows at startup (mocked process.platform)", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    cleanup.push(() => {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    expect(() => loadConfig({ FOAM_VAULT_PATH: dir })).toThrow(/does not support Windows/);
  });

  it("defaults FOAM_WATCHER to true when unset", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir });
    expect(cfg.watcher).toBe(true);
  });

  it("parses FOAM_WATCHER='0' as false", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "0" });
    expect(cfg.watcher).toBe(false);
  });

  it("parses FOAM_WATCHER='1' as true", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "1" });
    expect(cfg.watcher).toBe(true);
  });

  it("parses FOAM_WATCHER='false' (case-insensitive) as false", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "FALSE" });
    expect(cfg.watcher).toBe(false);
  });

  it("parses FOAM_WATCHER='no' as false and 'yes' as true", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "no" }).watcher).toBe(false);
    expect(loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "yes" }).watcher).toBe(true);
  });

  it("throws when FOAM_WATCHER has an invalid value", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_WATCHER: "maybe" })).toThrow(
      /FOAM_WATCHER='maybe' is not a valid boolean/,
    );
  });

  it("defaults FOAM_GRAPH_MAX_NODES to 5000 when unset", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir });
    expect(cfg.graphResourceMaxNodes).toBe(5000);
  });

  it("parses FOAM_GRAPH_MAX_NODES='200' as 200", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_NODES: "200" });
    expect(cfg.graphResourceMaxNodes).toBe(200);
  });

  it("rejects FOAM_GRAPH_MAX_NODES='0' (positive integer required)", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_NODES: "0" })).toThrow(
      /FOAM_GRAPH_MAX_NODES='0' is not a valid positive integer/,
    );
  });

  it("rejects non-numeric FOAM_GRAPH_MAX_NODES", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_NODES: "abc" })).toThrow(
      /FOAM_GRAPH_MAX_NODES='abc' is not a valid positive integer/,
    );
  });

  it("defaults FOAM_GRAPH_MAX_BYTES to 10 MiB (10485760) when unset", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: dir });
    expect(cfg.graphResourceMaxBytes).toBe(10 * 1024 * 1024);
    expect(cfg.graphResourceMaxBytes).toBe(10485760);
  });

  it("parses FOAM_GRAPH_MAX_BYTES and rejects invalid values", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const cfg = loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_BYTES: "2048" });
    expect(cfg.graphResourceMaxBytes).toBe(2048);

    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_BYTES: "0" })).toThrow(
      /FOAM_GRAPH_MAX_BYTES='0' is not a valid positive integer/,
    );
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_BYTES: "-5" })).toThrow(
      /FOAM_GRAPH_MAX_BYTES='-5' is not a valid positive integer/,
    );
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_GRAPH_MAX_BYTES: "1.5" })).toThrow(
      /FOAM_GRAPH_MAX_BYTES='1.5' is not a valid positive integer/,
    );
  });
});

// M2 (Wave 6 security): FOAM_VAULT_PATH is canonicalized via fs.realpathSync
// at load, so symlink-based escapes are resolved once up-front. Downstream
// `isInsideVaultAsync` compares against the canonical path; without this
// step a well-placed symlink could let callers walk outside the intended
// vault tree.
describe("loadConfig: vault path canonicalization (M2)", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  it("resolves a symlinked vault to the canonical target", () => {
    const realTarget = makeTempDir();
    const parent = makeTempDir();
    const symlinkPath = join(parent, "vault-link");
    symlinkSync(realTarget, symlinkPath, "dir");
    cleanup.push(() => rmSync(realTarget, { recursive: true, force: true }));
    cleanup.push(() => rmSync(parent, { recursive: true, force: true }));

    const cfg = loadConfig({ FOAM_VAULT_PATH: symlinkPath });
    expect(cfg.vaultPath).toBe(realTarget);
    expect(cfg.vaultPath).not.toBe(symlinkPath);
  });

  it("throws with a clear message when the vault does not exist", () => {
    const missing = join(tmpdir(), "definitely-not-a-real-path-m2-" + Date.now().toString());
    expect(() => loadConfig({ FOAM_VAULT_PATH: missing })).toThrow(/does not exist/);
  });

  it("still accepts a relative path resolved against cwd (backward compat)", () => {
    // A relative path like "." resolves to cwd. The canonicalized output
    // must equal realpath(cwd). We override FOAM_CACHE_DIR to a disjoint
    // temp dir so the M3 overlap check doesn't trip on the default
    // `<cwd>/.foam-mcp` cache landing inside the vault (= cwd).
    const cache = makeTempDir();
    cleanup.push(() => rmSync(cache, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: ".", FOAM_CACHE_DIR: cache });
    expect(cfg.vaultPath).toBe(realpathSync(process.cwd()));
  });
});

// M3 (Wave 6 security): FOAM_CACHE_DIR and FOAM_VAULT_PATH must not overlap.
// A cache inside the vault makes the watcher re-fire on cache writes
// (livelock risk + cache files appear as notes); a vault inside the cache
// would let vault writes clobber cache state. Both are config footguns.
describe("loadConfig: cache/vault overlap rejection (M3)", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      if (fn) fn();
    }
  });

  it("throws when cache is inside the vault", () => {
    const vault = makeTempDir();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
    expect(() =>
      loadConfig({
        FOAM_VAULT_PATH: vault,
        FOAM_CACHE_DIR: join(vault, "cache"),
      }),
    ).toThrow(/FOAM_CACHE_DIR must not overlap FOAM_VAULT_PATH/);
  });

  it("throws when the vault is inside the cache", () => {
    const cache = makeTempDir();
    const vault = join(cache, "vault");
    mkdirSync(vault);
    cleanup.push(() => rmSync(cache, { recursive: true, force: true }));
    expect(() =>
      loadConfig({
        FOAM_VAULT_PATH: vault,
        FOAM_CACHE_DIR: cache,
      }),
    ).toThrow(/FOAM_CACHE_DIR must not overlap FOAM_VAULT_PATH/);
  });

  it("throws when cache and vault are the same directory", () => {
    const dir = makeTempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(() => loadConfig({ FOAM_VAULT_PATH: dir, FOAM_CACHE_DIR: dir })).toThrow(
      /FOAM_CACHE_DIR must not overlap FOAM_VAULT_PATH/,
    );
  });

  it("accepts disjoint vault and cache directories", () => {
    const vault = makeTempDir();
    const cacheParent = makeTempDir();
    const cache = join(cacheParent, "my-cache");
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
    cleanup.push(() => rmSync(cacheParent, { recursive: true, force: true }));
    const cfg = loadConfig({ FOAM_VAULT_PATH: vault, FOAM_CACHE_DIR: cache });
    expect(cfg.vaultPath).toBe(vault);
    expect(cfg.cacheDir).toBe(cache);
  });

  it("accepts the default cache dir (./.foam-mcp) with a vault elsewhere", () => {
    const vault = makeTempDir();
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
    // Default cache resolves to `<cwd>/.foam-mcp`; under `npm test` cwd is the
    // repo root, which is disjoint from a tmpdir-based vault.
    const cfg = loadConfig({ FOAM_VAULT_PATH: vault });
    expect(cfg.vaultPath).toBe(vault);
    // Sanity: cache path ends with ".foam-mcp" (with or without trailing slash).
    expect(/\.foam-mcp\/?$/.test(cfg.cacheDir)).toBe(true);
    // And it must not overlap the vault.
    expect(cfg.cacheDir.startsWith(vault + pathSep)).toBe(false);
    expect(vault.startsWith(cfg.cacheDir + pathSep)).toBe(false);
    expect(cfg.cacheDir).not.toBe(vault);
  });
});
