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
});
