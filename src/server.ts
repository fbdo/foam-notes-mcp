#!/usr/bin/env node
/**
 * foam-notes-mcp server — minimal MCP server over stdio.
 *
 * Responsibilities (PLAN decisions #20/#22/#23/#25/#26):
 *   - Load config via `loadConfig()`; on failure, log to stderr and exit 1.
 *   - Build the vault graph via `buildGraph()` at startup.
 *   - Construct the semantic embedder + store (lazy: no index build on boot).
 *   - Build a combined `ToolContext` (keyword + graph + semantic sub-contexts)
 *     from the config and graph, and pass it to every handler.
 *   - Register each of the 15 tools via `McpServer.registerTool(name,
 *     { description, inputSchema }, handler)` using zod raw shapes from
 *     `TOOL_ZOD_SHAPES`. The SDK derives `tools/list` output from the
 *     registrations and validates `tools/call` input against the zod shape
 *     before invoking the handler.
 *   - `build_index` is the single SDK touchpoint for the semantic layer:
 *     it is registered out of the generic loop so its handler can adapt
 *     the orchestrator's SDK-agnostic `onProgress` callback into
 *     `notifications/progress` messages, via the `sendNotification` hook
 *     on `RequestHandlerExtra` (MCP SDK 1.x, Option C). All other semantic
 *     tools use the plain generic-loop path.
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

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type FoamConfig } from "./config.js";
import { buildGraph, type EdgeAttrs, type GraphNodeAttrs } from "./graph/builder.js";
import { GRAPH_RESOURCE, GRAPH_RESOURCE_URI, readGraphResource } from "./resources/graph.js";
import { createEmbedder } from "./semantic/embedder/index.js";
import type { Embedder } from "./semantic/embedder/types.js";
import { SemanticStore } from "./semantic/store.js";
import { runBuildIndex, type BuildIndexInput } from "./semantic/tools.js";
import type { IndexProgress } from "./semantic/index.js";
import { TOOL_HANDLERS, TOOL_METADATA, TOOL_ZOD_SHAPES, type ToolContext } from "./tools/index.js";
import type { DirectedGraph } from "graphology";

const SERVER_NAME = "foam-notes-mcp";
const SERVER_VERSION = "0.0.1";

/**
 * Semantic-layer dependencies constructed at server startup. Kept in a
 * dedicated shape so `buildToolContext` has an explicit, narrow parameter
 * (not a wide `{ ... }` bag) — test code can substitute a mock embedder +
 * in-tmpdir store without touching the rest of the config surface.
 */
export interface SemanticDeps {
  readonly embedder: Embedder;
  readonly store: SemanticStore;
}

/**
 * Build a {@link ToolContext} from the loaded runtime config, the prebuilt
 * vault graph, and the pre-opened semantic dependencies.
 *
 * Exposed for testing so that a smoke test can construct a server instance
 * without having to populate every `FoamConfig` field or scan a real vault.
 */
export const buildToolContext = (
  config: FoamConfig,
  graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>,
  semantic: SemanticDeps,
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
  semantic: {
    vaultPath: config.vaultPath,
    mocPattern: config.mocPattern,
    embedder: semantic.embedder,
    store: semantic.store,
  },
});

/**
 * Shape of the extra argument the SDK passes to a registered tool handler.
 * We only consume `_meta.progressToken` and `sendNotification`, so we
 * narrow the import surface by typing it structurally. The full shape is
 * `RequestHandlerExtra<ServerRequest, ServerNotification>` from
 * `@modelcontextprotocol/sdk/shared/protocol.js`. `sendNotification`
 * accepts any member of the `ServerNotification` discriminated union; we
 * only ever emit {@link ProgressNotification}, so we type the parameter
 * precisely rather than widening to the full union.
 */
interface ToolHandlerExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: (notification: ProgressNotification) => Promise<void>;
}

/**
 * Build the progress adapter for `build_index`. Returns `undefined` when
 * the client did not attach a `progressToken`; returns a closure that
 * emits `notifications/progress` for each orchestrator callback otherwise.
 *
 * The returned closure is `void`-returning and swallows any notification
 * error so a transport hiccup mid-build does not abort the actual index
 * work.
 */
const makeProgressAdapter = (extra: ToolHandlerExtra): ((p: IndexProgress) => void) | undefined => {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (p: IndexProgress): void => {
    const message =
      p.phase === "indexing" && p.currentNote !== undefined
        ? `${p.phase}: ${p.currentNote}`
        : p.phase;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: p.processed,
          total: p.total,
          message,
        },
      })
      .catch((err: unknown) => {
        logToStderr("progress notification failed", err);
      });
  };
};

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

  // Register every tool except `build_index` via the generic dispatch loop.
  // `build_index` is special-cased below because its handler needs access
  // to the MCP `_meta.progressToken` to emit progress notifications —
  // that's the sole SDK touchpoint for the semantic layer, and it doesn't
  // fit the SDK-agnostic `(input, ctx) => result` handler signature used
  // by the other 14 tools.
  const SPECIAL_CASED = new Set<string>(["build_index"]);
  const toolNames = (Object.keys(TOOL_HANDLERS) as (keyof typeof TOOL_HANDLERS)[]).filter(
    (n) => !SPECIAL_CASED.has(n),
  );
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

  // build_index: special-cased so we can adapt the orchestrator's
  // SDK-agnostic `onProgress` callback into MCP `notifications/progress`
  // messages. `RequestHandlerExtra.sendNotification` is the SDK 1.x
  // entry point (see `dist/esm/shared/protocol.d.ts`). When the client
  // did not supply a progress token, we skip the adapter and the handler
  // runs without emitting any progress messages.
  server.registerTool(
    "build_index",
    {
      description: TOOL_METADATA.build_index.description,
      inputSchema: TOOL_ZOD_SHAPES.build_index,
    },
    async (input: unknown, extra: ToolHandlerExtra) => {
      const onProgress = makeProgressAdapter(extra);
      const result = await runBuildIndex(
        input as BuildIndexInput,
        ctx.semantic,
        onProgress ? { onProgress } : undefined,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

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

/**
 * Construct the semantic dependencies for the server. The store is opened
 * eagerly (cheap: just a sqlite file open + schema DDL), but the embedder
 * only touches disk/network on its first `embed()` call — so startup stays
 * fast and `index_status` can be called without paying any model-load cost.
 *
 * The cache subdirectory layout is fixed:
 *   - `<cacheDir>/semantic/index.sqlite`  — sqlite-vec index
 *   - `<cacheDir>/semantic/models/`       — HF model cache (Decision #11)
 */
const buildSemanticDeps = async (config: FoamConfig): Promise<SemanticDeps> => {
  const semanticDir = join(config.cacheDir, "semantic");
  const modelsDir = join(semanticDir, "models");
  const storePath = join(semanticDir, "index.sqlite");

  // Ensure parent directory exists. sqlite-vec / better-sqlite3 won't create
  // missing directories; the embedder also expects `cacheDir` to be creatable.
  mkdirSync(semanticDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  // Also guarantee the sqlite file's parent directory if storePath was set
  // to some deeper layout in the future (defensive; currently same as above).
  mkdirSync(dirname(storePath), { recursive: true });

  const embedder = createEmbedder({ provider: config.embedder, cacheDir: modelsDir });
  const store = new SemanticStore({
    path: storePath,
    embedderName: embedder.info.name,
    dims: embedder.info.dims,
  });
  await store.open();
  return { embedder, store };
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

  let semantic: SemanticDeps;
  try {
    semantic = await buildSemanticDeps(config);
  } catch (err) {
    logToStderr("failed to initialize semantic store", err);
    process.exit(1);
  }
  console.error(
    `Semantic store open: ${semantic.embedder.info.name} (dims=${semantic.embedder.info.dims.toString()})`,
  );

  const ctx = buildToolContext(config, graph, semantic);
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[${SERVER_NAME}] received ${signal}, shutting down`);
    // Best-effort: close the MCP server, then the semantic store, then the
    // embedder. Each step swallows its own failure so a hang in one piece
    // doesn't block the others (we still exit on a fixed deadline below).
    const closeAll = async (): Promise<void> => {
      try {
        await server.close();
      } catch (err) {
        logToStderr("error closing MCP server", err);
      }
      try {
        await semantic.store.close();
      } catch (err) {
        logToStderr("error closing semantic store", err);
      }
      try {
        await semantic.embedder.close();
      } catch (err) {
        logToStderr("error closing embedder", err);
      }
    };
    closeAll().finally(() => {
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
