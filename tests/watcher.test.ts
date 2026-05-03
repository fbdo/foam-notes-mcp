/**
 * Unit tests for `src/watcher.ts`.
 *
 * Strategy: inject a fake chokidar factory so the watcher never touches
 * the filesystem-watch layer, drive events directly, and use a tight
 * real-time debounce window so assertions settle in tens of milliseconds.
 *
 * Why real timers: the dispatch path reaches into `graph/incremental.ts`
 * and `semantic/index.ts`, both of which do real I/O (`readFile`,
 * `better-sqlite3`). That I/O does not settle inside
 * `vi.advanceTimersByTimeAsync` — it runs on libuv workers whose
 * completion callbacks are regular event-loop ticks, not microtasks.
 * Forcing fake timers here would require stubbing the updaters, which
 * would defeat the integration value of this suite. Using a 10 ms
 * debounce + `waitUntilSettled` gives us deterministic observation of
 * the real code path without a sleep race.
 *
 * Coverage:
 *   1. `add` event dispatches after the debounce window (graph + semantic)
 *   2. Back-to-back events on the same path coalesce into one dispatch
 *   3. Events on different paths flush independently
 *   4. Last-event-wins within the window (add → change → unlink → delete)
 *   5. Semantic errors isolated: graph side still runs, onError invoked
 *   6. Non-`.md` files rejected by the ignore predicate (but directories pass)
 *   7. `stop()` flushes pending debounced events before closing
 *   8. `_applyChange` bypasses both chokidar and the debounce window
 *   9. `isRunning()` toggles across start/stop; start is idempotent
 *  10. Chokidar `error` events surface through `onError` without crashing
 *  11. Graph errors surface through onError without aborting semantic dispatch
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectedGraph } from "graphology";

import {
  createVaultWatcher,
  type VaultWatcher,
  type WatcherChange,
  type WatcherFactory,
  type WatcherLike,
} from "../src/watcher.js";
import type { EdgeAttrs, GraphNodeAttrs } from "../src/graph/builder.js";
import { SemanticStore } from "../src/semantic/store.js";
import type { Embedder } from "../src/semantic/embedder/types.js";
import type { VaultIndex } from "../src/resolver.js";

// --- fake chokidar emitter ---------------------------------------------------

type Listener = (...args: unknown[]) => void;

interface FakeEmitter extends WatcherLike {
  emit(event: "add" | "change" | "unlink" | "error", ...args: unknown[]): void;
  readonly ignored: (path: string, stats?: { isDirectory?: () => boolean }) => boolean;
  readonly closeCalls: number;
  readonly watchedPath: string;
}

interface FakeEmitterHandle {
  readonly factory: WatcherFactory;
  readonly current: () => FakeEmitter | undefined;
}

const makeFakeChokidar = (): FakeEmitterHandle => {
  let current: FakeEmitter | undefined;
  const factory: WatcherFactory = (paths, options) => {
    const listeners = new Map<string, Listener[]>();
    let closeCalls = 0;
    const emitter: FakeEmitter = {
      ignored: options.ignored,
      watchedPath: Array.isArray(paths) ? (paths[0] ?? "") : paths,
      get closeCalls() {
        return closeCalls;
      },
      on(event: string, listener: Listener): FakeEmitter {
        const arr = listeners.get(event) ?? [];
        arr.push(listener);
        listeners.set(event, arr);
        return emitter;
      },
      emit(event: string, ...args: unknown[]): void {
        for (const l of listeners.get(event) ?? []) l(...args);
      },
      async close(): Promise<void> {
        closeCalls += 1;
        return Promise.resolve();
      },
    } as FakeEmitter;
    current = emitter;
    return emitter;
  };
  return {
    factory,
    current: () => current,
  };
};

// --- deterministic 4-dim mock embedder (mirrors tests/semantic/index.test.ts)

const mockEmbedOne = (text: string): Float32Array => {
  const v = new Float32Array(4);
  for (let i = 0; i < text.length; i++) {
    const idx = text.charCodeAt(i) % 4;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  if (mag === 0) {
    v[0] = 1;
  } else {
    for (let i = 0; i < 4; i++) v[i] = (v[i] ?? 0) / mag;
  }
  return v;
};

const makeMockEmbedder = (): Embedder => ({
  info: { provider: "transformers", model: "mock-4d", dims: 4, name: "mock:4d" },
  async embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map(mockEmbedOne));
  },
  async close(): Promise<void> {
    return Promise.resolve();
  },
});

// --- vault scaffolding -------------------------------------------------------

interface VaultHandle {
  readonly dir: string;
  readonly dbPath: string;
  readonly notePath: (rel: string) => string;
  writeNote(rel: string, content: string): string;
}

const makeVault = (): VaultHandle => {
  const dir = mkdtempSync(join(tmpdir(), "foam-watcher-"));
  return {
    dir,
    dbPath: join(dir, "semantic.sqlite"),
    notePath: (rel) => join(dir, rel),
    writeNote(rel, content) {
      const abs = join(dir, rel);
      writeFileSync(abs, content, "utf8");
      return abs;
    },
  };
};

const emptyVaultIndex = (): VaultIndex => ({
  byBasename: new Map(),
  byBasenameLower: new Map(),
  allPaths: [],
});

// --- test harness ------------------------------------------------------------

const DEBOUNCE_MS = 10;
const SETTLE_DEADLINE_MS = 2_000;

interface Harness {
  readonly vault: VaultHandle;
  readonly store: SemanticStore;
  readonly embedder: Embedder;
  readonly graph: DirectedGraph<GraphNodeAttrs, EdgeAttrs>;
  readonly fake: FakeEmitterHandle;
  readonly dispatched: WatcherChange[];
  readonly errors: { err: unknown; change: WatcherChange | undefined }[];
  cleanup(): Promise<void>;
}

const makeHarness = async (): Promise<Harness> => {
  const vault = makeVault();
  const store = new SemanticStore({ path: vault.dbPath, embedderName: "mock:4d", dims: 4 });
  await store.open();
  const embedder = makeMockEmbedder();
  const graph = new DirectedGraph<GraphNodeAttrs, EdgeAttrs>();
  const fake = makeFakeChokidar();
  const dispatched: WatcherChange[] = [];
  const errors: { err: unknown; change: WatcherChange | undefined }[] = [];
  return {
    vault,
    store,
    embedder,
    graph,
    fake,
    dispatched,
    errors,
    async cleanup(): Promise<void> {
      await store.close();
      rmSync(vault.dir, { recursive: true, force: true });
    },
  };
};

const makeWatcher = (
  h: Harness,
  overrides?: Partial<{ debounceMs: number; embedder: Embedder }>,
): VaultWatcher =>
  createVaultWatcher({
    vaultPath: h.vault.dir,
    graph: h.graph,
    vaultIndex: emptyVaultIndex(),
    mocPattern: "*-MOC.md",
    store: h.store,
    embedder: overrides?.embedder ?? h.embedder,
    watcherFactory: h.fake.factory,
    debounceMs: overrides?.debounceMs ?? DEBOUNCE_MS,
    onDispatch: (c) => h.dispatched.push(c),
    onError: (err, change) => h.errors.push({ err, change }),
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll until `cond` is truthy or the deadline elapses. Reads like a real
 * fake timer advance but ties to wall-clock time — our debounce is 10 ms
 * and dispatch is ~1 ms, so this resolves in a couple of polls.
 */
const waitUntil = async (
  cond: () => boolean,
  label: string,
  deadlineMs = SETTLE_DEADLINE_MS,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`waitUntil timed out after ${deadlineMs.toString()} ms: ${label}`);
};

/**
 * Let the pending debounce window lapse and every triggered dispatch
 * settle. Uses the watcher's own `_waitIdle` to avoid arbitrary sleeps.
 */
const settle = async (w: VaultWatcher): Promise<void> => {
  await sleep(DEBOUNCE_MS * 3);
  await w._waitIdle();
};

// --- tests -------------------------------------------------------------------

describe("createVaultWatcher", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it("dispatches a single add event to graph + semantic after the debounce window", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const notePath = harness.vault.writeNote("a.md", "# A\n\nBody of note A.\n");
    harness.fake.current()?.emit("add", notePath);

    // Before the window elapses, nothing has dispatched. Observable by
    // the dispatched-list still being empty right after the emit.
    expect(harness.dispatched).toHaveLength(0);

    await settle(w);

    expect(harness.dispatched).toEqual([{ path: notePath, type: "add" }]);
    expect(harness.graph.hasNode(notePath)).toBe(true);
    const fp = await harness.store.getNoteFingerprint(notePath);
    expect(fp).not.toBeNull();
    expect(harness.errors).toEqual([]);

    await w.stop();
  });

  it("coalesces back-to-back events on the same path into a single dispatch", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const notePath = harness.vault.writeNote("b.md", "# B\n\nBody.\n");
    const emitter = harness.fake.current();
    if (emitter === undefined) throw new Error("fake emitter missing");

    // Three events within a single window. Each reschedules the debounce.
    emitter.emit("add", notePath);
    emitter.emit("change", notePath);
    emitter.emit("change", notePath);

    await settle(w);

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]?.type).toBe("modify");

    await w.stop();
  });

  it("flushes per-path independently when different paths receive events", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const a = harness.vault.writeNote("a.md", "# A\n\nA body.\n");
    const b = harness.vault.writeNote("b.md", "# B\n\nB body.\n");
    const emitter = harness.fake.current();
    if (emitter === undefined) throw new Error("fake emitter missing");

    emitter.emit("add", a);
    emitter.emit("add", b);

    await settle(w);

    const paths = harness.dispatched.map((c) => c.path).sort((x, y) => x.localeCompare(y));
    expect(paths).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
    // Each was dispatched exactly once.
    expect(harness.dispatched).toHaveLength(2);

    await w.stop();
  });

  it("applies last-event-wins within the window: add → change → unlink flushes as delete", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    // First, get the note into the graph + store so the subsequent delete
    // has something to remove.
    const notePath = harness.vault.writeNote("c.md", "# C\n\nBody.\n");
    const emitter = harness.fake.current();
    if (emitter === undefined) throw new Error("fake emitter missing");
    emitter.emit("add", notePath);
    await settle(w);
    expect(harness.graph.hasNode(notePath)).toBe(true);
    expect((await harness.store.getNotePaths()).includes(notePath)).toBe(true);

    // Now the burst: add → change → unlink in under the window.
    emitter.emit("add", notePath);
    emitter.emit("change", notePath);
    emitter.emit("unlink", notePath);

    await settle(w);

    expect(harness.dispatched).toHaveLength(2);
    expect(harness.dispatched[1]).toEqual({ path: notePath, type: "delete" });
    expect(harness.graph.hasNode(notePath)).toBe(false);
    expect((await harness.store.getNotePaths()).includes(notePath)).toBe(false);

    await w.stop();
  });

  it("isolates graph errors: semantic side still runs, onError fires", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    // An add event for a file that does not exist makes `updateNote`'s
    // `readFile` throw (graph failure). `updateNoteSemantic` also throws
    // on the same missing file — both sides fail and both errors land in
    // onError.
    const missingPath = harness.vault.notePath("does-not-exist.md");
    harness.fake.current()?.emit("add", missingPath);

    await waitUntil(() => harness!.dispatched.length === 1, "dispatch complete");
    // Two errors expected: one from graph, one from semantic.
    expect(harness.errors.length).toBeGreaterThanOrEqual(2);
    expect(harness.dispatched).toEqual([{ path: missingPath, type: "add" }]);

    await w.stop();
  });

  it("isolates semantic errors: graph side still applies when semantic throws", async () => {
    harness = await makeHarness();
    const failingEmbedder: Embedder = {
      info: { provider: "transformers", model: "fail", dims: 4, name: "mock:4d" },
      async embed(): Promise<Float32Array[]> {
        throw new Error("embedder boom");
      },
      async close(): Promise<void> {
        return Promise.resolve();
      },
    };
    const w = makeWatcher(harness, { embedder: failingEmbedder });
    await w.start();

    const notePath = harness.vault.writeNote("d.md", "# D\n\nBody.\n");
    harness.fake.current()?.emit("add", notePath);

    await waitUntil(() => harness!.dispatched.length === 1, "dispatch complete");

    expect(harness.graph.hasNode(notePath)).toBe(true);
    expect(
      harness.errors.some((e) => e.err instanceof Error && e.err.message.includes("embedder boom")),
    ).toBe(true);

    await w.stop();
  });

  it("ignore predicate rejects non-.md files but passes directories through", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const emitter = harness.fake.current();
    if (emitter === undefined) throw new Error("fake emitter missing");

    expect(emitter.ignored("/some/path/notes.txt")).toBe(true);
    expect(emitter.ignored("/some/path/a.md")).toBe(false);
    expect(emitter.ignored("/some/path/subdir", { isDirectory: () => true })).toBe(false);

    await w.stop();
  });

  it("stop() flushes pending debounced events before closing chokidar", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const notePath = harness.vault.writeNote("e.md", "# E\n\nBody.\n");
    harness.fake.current()?.emit("add", notePath);

    // Do not wait for the window — stop() must flush the pending debounce.
    expect(harness.dispatched).toHaveLength(0);
    await w.stop();

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toEqual({ path: notePath, type: "add" });
    expect(harness.fake.current()?.closeCalls).toBe(1);
    expect(w.isRunning()).toBe(false);
  });

  it("_applyChange bypasses chokidar and the debounce window", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const notePath = harness.vault.writeNote("f.md", "# F\n\nBody.\n");
    await w._applyChange({ path: notePath, type: "add" });

    // No debounce wait — dispatch was awaited synchronously.
    expect(harness.dispatched).toEqual([{ path: notePath, type: "add" }]);
    expect(harness.graph.hasNode(notePath)).toBe(true);

    await w.stop();
  });

  it("isRunning reflects start/stop and start is idempotent", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    expect(w.isRunning()).toBe(false);

    await w.start();
    expect(w.isRunning()).toBe(true);
    const firstFake = harness.fake.current();
    await w.start();
    expect(w.isRunning()).toBe(true);
    expect(harness.fake.current()).toBe(firstFake);

    await w.stop();
    expect(w.isRunning()).toBe(false);
    await w.stop();
    expect(w.isRunning()).toBe(false);
  });

  it("chokidar error events surface through onError without crashing the watcher", async () => {
    harness = await makeHarness();
    const w = makeWatcher(harness);
    await w.start();

    const boom = new Error("chokidar: ENOSPC or similar");
    harness.fake.current()?.emit("error", boom);

    expect(harness.errors).toEqual([{ err: boom, change: undefined }]);
    expect(w.isRunning()).toBe(true);

    // Further events still work afterwards.
    const notePath = harness.vault.writeNote("g.md", "# G\n\nBody.\n");
    harness.fake.current()?.emit("add", notePath);
    await settle(w);
    expect(harness.dispatched).toEqual([{ path: notePath, type: "add" }]);

    await w.stop();
  });
});
