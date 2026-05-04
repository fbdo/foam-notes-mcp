import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "foam-cfg-"));

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
    const cacheOverride = join(dir, "my-cache");
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
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
