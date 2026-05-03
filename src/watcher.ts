/**
 * Vault file watcher (Wave 5 commit 2).
 *
 * Wraps `chokidar` v4 into an SDK-agnostic per-vault watcher that routes
 * markdown add/change/unlink events to both the graph incremental updater
 * (`graph/incremental.ts::updateNote`) and the semantic incremental
 * updater (`semantic/index.ts::updateNoteSemantic`). The server wires
 * this into its startup path in Wave 5 commit 3 behind the `FOAM_WATCHER`
 * opt-out env var (PLAN Decision #13).
 *
 * Design points:
 *   - **Debounce per-path, last-event-wins, 200ms window** (PLAN Decision
 *     #12). Within the window we remember only the most recent change
 *     type for the path, so a rapid `add → change → unlink` flushes as a
 *     single `delete`. This matches editor save-and-delete patterns and
 *     keeps the downstream dispatch cost proportional to unique notes
 *     rather than raw event count.
 *   - **Ignore non-`.md` files at the chokidar layer**, but let
 *     directories through the ignore predicate so the recursive walker
 *     reaches `.md` descendants. A naive `!p.endsWith(".md")` filter
 *     would prune every directory above the first `.md` file.
 *   - **SDK-agnostic**: no `@modelcontextprotocol/sdk` imports; the server
 *     adapts errors + dispatch outcomes into MCP log / progress events at
 *     the call site.
 *   - **Error isolation per event**: a throw from either `updateNote` or
 *     `updateNoteSemantic` is captured, surfaced via the caller-supplied
 *     `onError` callback, and does not crash the watcher. A later event
 *     for the same path may recover.
 *   - **Event-type translation at the dispatch boundary**: this module's
 *     internal vocabulary is chokidar-facing (`add|modify|delete`). The
 *     graph layer speaks `added|modified|deleted`; translation lives in
 *     `dispatch()` so callers don't have to care.
 *   - **Test seam**: `_applyChange(change)` bypasses both chokidar and
 *     the debounce timer to enable deterministic integration tests. Unit
 *     tests in `tests/watcher.test.ts` inject a fake chokidar factory to
 *     drive the debounce path directly.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - `watcher.ts` lives at the src root, not inside a feature folder, so
 *     it can fan out to both `graph/` and `semantic/` without violating
 *     the sibling-feature ban. Nothing should import from it besides
 *     `server.ts` (arriving in the next commit).
 *   - MAY import `graph/incremental.js`, `semantic/index.js` (via the new
 *     `updateNoteSemantic` export), `semantic/store.js`,
 *     `semantic/embedder/types.js`, `resolver.js`, `chokidar`, and node
 *     built-ins.
 *   - MUST NOT import the MCP SDK — SDK adaptation belongs in `server.ts`.
 */

import { watch } from "chokidar";
import type { Stats } from "node:fs";
import type { DirectedGraph } from "graphology";

import { updateNote, type ChangeType as GraphChangeType } from "./graph/incremental.js";
import type { EdgeAttrs, GraphNodeAttrs } from "./graph/builder.js";
import type { VaultIndex } from "./resolver.js";
import type { Embedder } from "./semantic/embedder/types.js";
import type { SemanticStore } from "./semantic/store.js";
import { updateNoteSemantic } from "./semantic/index.js";

/** Default debounce window in milliseconds. PLAN Decision #12. */
const DEFAULT_DEBOUNCE_MS = 200;

/** Minimal surface of a chokidar-like watcher used for test injection. */
export interface WatcherLike {
  on(event: "add" | "change" | "unlink", listener: (path: string) => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
  close(): Promise<void>;
}

/**
 * Factory that produces a chokidar-like watcher. Injecting a fake factory
 * in tests removes the need to touch the filesystem.
 */
export type WatcherFactory = (
  paths: string | readonly string[],
  options: {
    readonly ignored: (path: string, stats?: Stats) => boolean;
    readonly ignoreInitial: boolean;
    readonly persistent: boolean;
  },
) => WatcherLike;

/** Change kinds emitted at the watcher's boundary. */
export type WatcherChangeType = "add" | "modify" | "delete";

/** A single coalesced change flushed after the debounce window. */
export interface WatcherChange {
  readonly path: string;
  readonly type: WatcherChangeType;
}

/** Signature for per-change callbacks surfaced to the caller. */
export type DispatchCallback = (change: WatcherChange) => void;

/** Signature for error callbacks surfaced to the caller. */
export type ErrorCallback = (err: unknown, change: WatcherChange | undefined) => void;

/**
 * Construction-time context for {@link createVaultWatcher}. All refs are
 * borrowed — the watcher never mutates them except via the documented
 * update functions (`updateNote`, `updateNoteSemantic`).
 */
export interface WatcherContext {
  /** Absolute path to the vault root being watched. */
  readonly vaultPath: string;
  /** Live graph mutated by `graph/incremental.ts::updateNote`. */
  readonly graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
  /** Vault index used to resolve wikilinks during graph updates. */
  readonly vaultIndex: VaultIndex;
  /** MOC-matching glob threaded through to the graph updater. */
  readonly mocPattern: string;
  /** Open semantic store. The watcher assumes `open()` has already run. */
  readonly store: SemanticStore;
  /** Configured embedder for semantic re-embeds. */
  readonly embedder: Embedder;
  /**
   * Debounce window in milliseconds. Defaults to `200` (PLAN Decision #12).
   * Exposed for tests that want a tighter / looser window; production
   * callers should leave it unset.
   */
  readonly debounceMs?: number;
  /**
   * Injected chokidar factory. Defaults to the real `chokidar.watch`.
   * Tests swap in a fake emitter to drive events synchronously.
   */
  readonly watcherFactory?: WatcherFactory;
  /**
   * Invoked after each successful dispatch. Useful for log instrumentation
   * in the server and for test observability.
   */
  readonly onDispatch?: DispatchCallback;
  /**
   * Invoked on dispatch failure (graph or semantic throw) and on watcher
   * error events. The watcher continues running; the caller decides
   * whether to escalate.
   */
  readonly onError?: ErrorCallback;
  /** Optional batch size forwarded to the semantic updater. */
  readonly semanticBatchSize?: number;
}

/** Public handle returned by {@link createVaultWatcher}. */
export interface VaultWatcher {
  /** Begin watching the vault. Idempotent. */
  start(): Promise<void>;
  /**
   * Flush pending debounce timers then close the underlying chokidar
   * instance. Idempotent.
   */
  stop(): Promise<void>;
  /** `true` after {@link start} until {@link stop} resolves. */
  isRunning(): boolean;
  /**
   * Integration test seam: bypass chokidar + debounce and dispatch the
   * change immediately. Never calls `onDispatch` / `onError` pathways
   * differently from a real event — the same error isolation applies.
   */
  _applyChange(change: WatcherChange): Promise<void>;
  /**
   * Resolve once every currently in-flight dispatch settles. Unit tests
   * call this after nudging the real debounce window so that the
   * real-time I/O (sqlite, readFile) triggered by each dispatch can
   * complete before assertions run. Production callers never need it.
   */
  _waitIdle(): Promise<void>;
}

/**
 * Construct (but do not start) a vault watcher. Call {@link VaultWatcher.start}
 * to begin watching; call {@link VaultWatcher.stop} on shutdown.
 */
export const createVaultWatcher = (ctx: WatcherContext): VaultWatcher => {
  const debounceMs = ctx.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const factory: WatcherFactory = ctx.watcherFactory ?? defaultWatcherFactory;

  // Debounce state keyed by absolute path. Each entry stores the most
  // recent change type and the pending timer; the last event wins within
  // the window.
  const pending = new Map<string, { type: WatcherChangeType; timer: NodeJS.Timeout }>();
  // In-flight dispatch promises keyed by path, so `stop()` can await
  // them and tests driving the real-timer debounce can observe completion.
  const inflight = new Map<string, Promise<void>>();

  let fsw: WatcherLike | undefined;
  let running = false;

  const flushPath = async (path: string): Promise<void> => {
    const entry = pending.get(path);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(path);
    const p = dispatch({ path, type: entry.type }).finally(() => {
      // Clear the in-flight slot only if it's still us — a follow-up event
      // that scheduled its own dispatch may have replaced it.
      if (inflight.get(path) === p) inflight.delete(path);
    });
    inflight.set(path, p);
    await p;
  };

  const scheduleFlush = (change: WatcherChange): void => {
    const existing = pending.get(change.path);
    if (existing !== undefined) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      // Fire-and-forget: `flushPath` tracks the resulting dispatch
      // promise in `inflight` so `stop()` and `_waitIdle()` can await
      // it. Errors inside dispatch route through `onError`.
      void flushPath(change.path);
    }, debounceMs);
    // `unref` so a lingering watcher timer does not keep the process alive
    // past a clean shutdown; callers who want the watcher to hold the
    // event loop open are responsible for their own lifecycle.
    timer.unref?.();
    pending.set(change.path, { type: change.type, timer });
  };

  const dispatch = async (change: WatcherChange): Promise<void> => {
    // Graph layer first: it owns resolver-visible state, and a failure
    // here is usually easier to diagnose than a semantic failure. We
    // isolate each side so a throw on one doesn't starve the other.
    try {
      await updateNote(
        ctx.graph,
        ctx.vaultPath,
        change.path,
        toGraphChangeType(change.type),
        ctx.vaultIndex,
        ctx.mocPattern,
      );
    } catch (err) {
      ctx.onError?.(err, change);
    }

    try {
      await updateNoteSemantic(change.path, change.type, ctx.vaultPath, ctx.store, ctx.embedder, {
        ...(ctx.semanticBatchSize !== undefined ? { batchSize: ctx.semanticBatchSize } : {}),
      });
    } catch (err) {
      ctx.onError?.(err, change);
    }

    ctx.onDispatch?.(change);
  };

  const handleFsEvent = (type: WatcherChangeType, path: string): void => {
    scheduleFlush({ path, type });
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      const w = factory(ctx.vaultPath, {
        // Directories must pass the ignore predicate so chokidar's
        // recursive walker reaches `.md` descendants. Anything that is
        // definitely a file and not a `.md` file is ignored.
        ignored: (p: string, stats?: Stats): boolean =>
          stats?.isDirectory?.() === true ? false : !p.endsWith(".md"),
        ignoreInitial: true,
        persistent: true,
      });
      w.on("add", (p: string) => {
        handleFsEvent("add", p);
      });
      w.on("change", (p: string) => {
        handleFsEvent("modify", p);
      });
      w.on("unlink", (p: string) => {
        handleFsEvent("delete", p);
      });
      w.on("error", (err: unknown) => {
        ctx.onError?.(err, undefined);
      });
      fsw = w;
      running = true;
      return Promise.resolve();
    },

    async stop(): Promise<void> {
      if (!running) return;
      // Flush any still-pending debounced events so the caller sees a
      // consistent post-stop state. Errors surface through `onError`.
      const paths = [...pending.keys()];
      await Promise.all(paths.map((p) => flushPath(p)));
      // Also await any dispatches that were already in-flight when stop()
      // was called (e.g. a debounce fired just before stop()).
      await Promise.all([...inflight.values()]);
      const w = fsw;
      fsw = undefined;
      running = false;
      if (w !== undefined) await w.close();
    },

    isRunning(): boolean {
      return running;
    },

    async _applyChange(change: WatcherChange): Promise<void> {
      await dispatch(change);
    },

    async _waitIdle(): Promise<void> {
      // Settle every in-flight dispatch. New events scheduled during this
      // await are not tracked here — tests that need a strict fixpoint
      // can loop until the maps are empty.
      while (inflight.size > 0) {
        await Promise.all([...inflight.values()]);
      }
    },
  };
};

// --- internals ---

/**
 * Chokidar v4 default factory. Extracted so the options object is
 * typed exactly once and tests do not accidentally drag chokidar into
 * their import graph.
 */
const defaultWatcherFactory: WatcherFactory = (paths, options) =>
  watch(paths as string | string[], {
    ignored: options.ignored,
    ignoreInitial: options.ignoreInitial,
    persistent: options.persistent,
  }) as unknown as WatcherLike;

/** Map the watcher's change vocabulary to the graph layer's. */
const toGraphChangeType = (t: WatcherChangeType): GraphChangeType => {
  if (t === "add") return "added";
  if (t === "modify") return "modified";
  return "deleted";
};

// Note: the semantic layer already speaks the watcher's `add|modify|delete`
// vocabulary (`SemanticChangeType`), so no translation helper is needed on
// that dispatch edge. The graph layer has its own triple and is translated
// via `toGraphChangeType` above.
