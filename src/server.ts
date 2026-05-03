#!/usr/bin/env node
/**
 * foam-notes-mcp server — minimal MCP server over stdio.
 *
 * Responsibilities (PLAN decisions #20/#22/#23/#25):
 *   - Load config via `loadConfig()`; on failure, log to stderr and exit 1.
 *   - Build the vault graph via `buildGraph()` at startup.
 *   - Build a combined `ToolContext` (keyword + graph sub-contexts) from the
 *     config and graph, and pass it to every handler.
 *   - Register each of the 12 tools via `McpServer.registerTool(name,
 *     { description, inputSchema }, handler)` using zod raw shapes from
 *     `TOOL_ZOD_SHAPES`. The SDK derives `tools/list` output from the
 *     registrations and validates `tools/call` input against the zod shape
 *     before invoking the handler.
 *   - Register `foam://graph` via `McpServer.registerResource`; the SDK
 *     auto-handles `resources/list` and `resources/read` dispatch.
 *   - Handler errors: `McpServer` flattens a thrown `Error` into
 *     `{ isError: true, content: [{ type: "text", text: err.message }] }`.
 *     `ToolValidationError` remains thrown by handlers — the message
 *     reaches the client as content text (per amended PLAN #22).
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, type FoamConfig } from "./config.js";
import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "./graph/builder.js";
import { GRAPH_RESOURCE, GRAPH_RESOURCE_URI, readGraphResource } from "./resources/graph.js";
import { TOOL_HANDLERS, TOOL_METADATA, TOOL_ZOD_SHAPES, type ToolContext } from "./tools/index.js";
import type { DirectedGraph } from "graphology";

const SERVER_NAME = "foam-notes-mcp";
const SERVER_VERSION = "0.0.1";

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
 * Construct a fully-configured `McpServer` with tool and resource
 * registrations. Does NOT connect to a transport — that is the caller's
 * responsibility (and it is deliberate so that tests can inspect the
 * server without any real I/O).
 */
export const buildServer = (ctx: ToolContext): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Register all 12 tools via a single loop over TOOL_HANDLERS. Each entry
  // pairs a zod raw shape (from TOOL_ZOD_SHAPES) with a typed handler.
  // TypeScript cannot verify that the zod-inferred input type for tool N
  // matches the declared input type of handler N without generic coupling
  // across the TOOL_HANDLERS map — so we bridge the gap with a single
  // `as never` cast on the input arg inside the dispatch closure. Each
  // handler re-validates its input internally (see keyword/tools.ts and
  // graph/tools.ts), and McpServer validates against the zod shape before
  // the handler runs, so the cast is safe.
  const toolNames = Object.keys(TOOL_HANDLERS) as (keyof typeof TOOL_HANDLERS)[];
  for (const name of toolNames) {
    const description = TOOL_METADATA[name].description;
    const inputSchema = TOOL_ZOD_SHAPES[name];
    const handler = TOOL_HANDLERS[name];

    server.registerTool(name, { description, inputSchema }, async (input: unknown) => {
      const result = await handler(input as never, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    });
  }

  // `foam://graph` is a static URI resource. McpServer auto-dispatches
  // `resources/list` and `resources/read` based on registrations, so we
  // no longer need explicit request handlers for either method.
  // The first positional arg ("foam-graph") is the registration name
  // surfaced in `resources/list` as `name`; `GRAPH_RESOURCE.name` is the
  // human-readable title in the metadata.
  server.registerResource(
    "foam-graph",
    GRAPH_RESOURCE_URI,
    {
      title: GRAPH_RESOURCE.name,
      description: GRAPH_RESOURCE.description,
      mimeType: GRAPH_RESOURCE.mimeType,
    },
    async () => {
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
    },
  );

  return server;
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
