import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { buildServer, buildToolContext } from "../src/server.js";
import type { FoamConfig } from "../src/config.js";
import { fixtureRoot } from "./helpers/fixture.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";

describe("server (smoke)", () => {
  const VAULT = fixtureRoot(import.meta.url);

  const fakeConfig: FoamConfig = {
    vaultPath: VAULT,
    cacheDir: "/tmp/foam-notes-mcp-smoke-cache",
    mocPattern: "*-MOC.md",
    ripgrepPath: "/usr/bin/rg",
  };

  it("buildToolContext forwards vaultPath and mocPattern from config", () => {
    const ctx = buildToolContext(fakeConfig);
    expect(ctx.vaultPath).toBe(fakeConfig.vaultPath);
    expect(ctx.mocPattern).toBe(fakeConfig.mocPattern);
    expect(ctx.ripgrepPath).toBe(fakeConfig.ripgrepPath);
  });

  it("buildServer returns an MCP Server instance", () => {
    const ctx = buildToolContext(fakeConfig);
    const server = buildServer(ctx);
    expect(server).toBeInstanceOf(Server);
  });

  it("buildServer is idempotent — repeated calls produce distinct servers", () => {
    const ctx = buildToolContext(fakeConfig);
    const a = buildServer(ctx);
    const b = buildServer(ctx);
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(Server);
    expect(b).toBeInstanceOf(Server);
  });

  it("TOOL_DEFINITIONS is non-empty (sanity: server would advertise tools)", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
  });
});
