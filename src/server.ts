#!/usr/bin/env node
/**
 * foam-notes-mcp server — minimal MCP server over stdio.
 *
 * Responsibilities (PLAN decisions #20/#22/#23):
 *   - Load config via `loadConfig()`; on failure, log to stderr and exit 1.
 *   - Build the vault graph via `buildGraph()` at startup.
 *   - Build a combined `ToolContext` (keyword + graph sub-contexts) from the
 *     config and graph, and pass it to every handler.
 *   - Register `ListTools` / `CallTool` / `ListResources` / `ReadResource`
 *     request handlers on the MCP SDK's low-level `Server` and speak
 *     JSON-RPC over `StdioServerTransport`.
 *   - Wrap every tool invocation so errors become `McpError` with the right
 *     JSON-RPC error code (unknown tool → MethodNotFound; handler throw →
 *     InternalError; caller-side schema mismatch → InvalidParams). Unknown
 *     resource URI → `InvalidRequest`.
 *   - Gracefully handle `SIGINT` / `SIGTERM` by closing the transport.
 *
 * Constraints:
 *   - stdout is reserved for JSON-RPC framing; all logging goes to stderr
 *     via `console.error`.
 *   - This file is the `bin` entry (see `package.json` → `bin`). The
 *     shebang above keeps it directly executable after `tsc` emits it.
 *   - This file must not be imported by anything else (enforced by
 *     dependency-cruiser).
 */

import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type FoamConfig } from "./config.js";
import { ToolValidationError } from "./errors.js";
import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "./graph/builder.js";
import { GRAPH_RESOURCE_URI, listGraphResources, readGraphResource } from "./resources/graph.js";
import { TOOL_DEFINITIONS, TOOL_HANDLERS, type ToolContext } from "./tools/index.js";
import type { DirectedGraph } from "graphology";

const SERVER_NAME = "foam-notes-mcp";
const SERVER_VERSION = "0.0.1";

type AnyHandler = (input: unknown, ctx: ToolContext) => Promise<unknown>;

/**
 * Build a {@link ToolContext} from the loaded runtime config and the
 * prebuilt vault graph.
 *
 * Exposed for testing so that a smoke test can construct a server instance
 * without having to populate every `FoamConfig` field or scan a real vault.
 */
export const buildToolContext = (
  config: FoamConfig,
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
): ToolContext => ({
  keyword: {
    vaultPath: config.vaultPath,
    mocPattern: config.mocPattern,
    ripgrepPath: config.ripgrepPath,
  },
  graph: {
    vaultPath: config.vaultPath,
    graph,
  },
});

/**
 * Construct a fully-configured MCP `Server` with tool and resource request
 * handlers registered. Does NOT connect to a transport — that is the
 * caller's responsibility (and it is deliberate so that tests can inspect
 * the server without any real I/O).
 */
export const buildServer = (ctx: ToolContext): Server => {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = (TOOL_HANDLERS as Record<string, AnyHandler | undefined>)[name];

    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    let result: unknown;
    try {
      result = await handler(args ?? {}, ctx);
    } catch (err) {
      throw wrapToolError(err);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = await listGraphResources();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== GRAPH_RESOURCE_URI) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    const contents = await readGraphResource({ graph: ctx.graph.graph });
    return {
      contents: [
        {
          uri: contents.uri,
          mimeType: contents.mimeType,
          text: contents.text,
        },
      ],
    };
  });

  return server;
};

/**
 * Convert an arbitrary thrown value from a tool handler into a typed
 * `McpError`. Handlers signal caller-side validation failures by throwing
 * {@link ToolValidationError}; those map to `InvalidParams`. Every other
 * `Error` maps to `InternalError`. `McpError`s pass through unchanged. The
 * original message is preserved in `data.cause` so stack traces remain
 * useful during development.
 */
const wrapToolError = (err: unknown): McpError => {
  if (err instanceof McpError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof ToolValidationError ? ErrorCode.InvalidParams : ErrorCode.InternalError;

  return new McpError(code, message, err instanceof Error ? { cause: err.message } : undefined);
};

const logToStderr = (prefix: string, err: unknown): void => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[${SERVER_NAME}] ${prefix}: ${message}`);
};

const main = async (): Promise<void> => {
  let config: FoamConfig;
  try {
    config = loadConfig();
  } catch (err) {
    logToStderr("config error", err);
    process.exit(1);
  }

  let graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
  try {
    graph = await buildGraph(config.vaultPath, { mocPattern: config.mocPattern });
  } catch (err) {
    logToStderr("failed to build graph", err);
    process.exit(1);
  }
  console.error(`Graph built: ${String(graph.order)} nodes, ${String(graph.size)} edges`);

  const ctx = buildToolContext(config, graph);
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[${SERVER_NAME}] received ${signal}, shutting down`);
    server
      .close()
      .catch((err: unknown) => {
        logToStderr("error during shutdown", err);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    console.error(`[${SERVER_NAME}] ready (vault=${config.vaultPath})`);
  } catch (err) {
    logToStderr("failed to start transport", err);
    process.exit(1);
  }
};

/**
 * Decide whether this module is being executed directly by Node, as opposed
 * to being imported. `import.meta.url` is always a `file://` URL; when Node
 * runs a script, `process.argv[1]` is that script's filesystem path. The
 * standard ESM idiom is to convert argv[1] to a file URL and compare.
 */
const isDirectInvocation = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isDirectInvocation()) {
  // Top-level await is permitted in ESM; it only blocks *this* module's
  // evaluation, and we only reach here when the module *is* the entry point.
  await main();
}
