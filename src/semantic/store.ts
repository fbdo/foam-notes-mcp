/**
 * Semantic store: persistent sqlite-vec backed chunk + embedding index.
 *
 * Schema (one database file per vault cache):
 *
 *   chunks              — metadata: one row per chunk (primary key = id).
 *   chunk_vectors       — vec0 virtual table, cosine KNN over the embedding.
 *   note_fingerprints   — content hash of the last indexed version of each note.
 *   meta                — embedder identity + build stamp (singleton rows).
 *
 * The embedder name and dimension are written to `meta` on first open. If a
 * later open requests a different embedder or dimension, we throw — switching
 * embedders requires deleting the sqlite file (the old vectors are no longer
 * directly comparable to the new embedder's output).
 *
 * Distance → similarity: sqlite-vec returns COSINE DISTANCE in [0, 2]; we
 * report `score = 1 - distance` which is the standard cosine similarity in
 * [-1, 1]. For typical sentence embedders (MiniLM, mxbai, etc.) identical
 * vectors score ~1.0 and orthogonal vectors ~0.
 *
 * Tag filter (array-contains-all) is applied in JS after KNN: the vec0
 * candidate set is small (`limit * 3`) and this avoids SQLite JSON gymnastics.
 *
 * Layer rules (enforced by dependency-cruiser):
 *   - MAY import `cache.ts`, `errors.ts`, `path-util.ts`, `better-sqlite3`,
 *     `sqlite-vec`, node built-ins.
 *   - MUST NOT import from any sibling feature layer (`keyword/`, `graph/`,
 *     `hybrid/`, `tools/`, `resources/`, `server.ts`).
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** A chunk as stored in sqlite (metadata only; embedding lives in `chunk_vectors`). */
export interface StoredChunk {
  readonly id: string;
  readonly notePath: string;
  readonly chunkIndex: number;
  readonly heading: string | null;
  readonly text: string;
  readonly rawText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly folder: string;
  readonly tags: readonly string[];
}

/** A scored search hit. `score = 1 - cosine_distance`; higher is better. */
export interface SearchHit {
  readonly chunk: StoredChunk;
  readonly score: number;
}

/** Optional filters applied to a {@link SemanticStore.search} query. */
export interface SearchFilter {
  /** Exact folder match (case-sensitive). Compared to `chunks.folder`. */
  readonly folder?: string;
  /** Require every listed tag to be present on the chunk. AND semantics. */
  readonly tags?: readonly string[];
  /** Match chunks whose `notePath` starts with this prefix (exact, not glob). */
  readonly notePathPrefix?: string;
}

/** Singleton metadata row in the `meta` table, plus live counts. */
export interface StoreMeta {
  /** Embedder identity, e.g. `"transformers:Xenova/all-MiniLM-L6-v2"`. */
  readonly embedder: string;
  /** Vector dimension (e.g. 384 for MiniLM-L6). */
  readonly dims: number;
  /** ISO timestamp of the last successful build; `""` if never built. */
  readonly lastBuiltAt: string;
  /** Distinct note count currently indexed. */
  readonly noteCount: number;
  /** Total chunk count currently indexed. */
  readonly chunkCount: number;
}

/** Constructor options. */
export interface SemanticStoreOptions {
  /** Absolute path to the sqlite database file. Parent directory must exist. */
  readonly path: string;
  /** Embedder identity written to meta on first open; compared thereafter. */
  readonly embedderName: string;
  /** Vector dimension written to meta on first open; compared thereafter. */
  readonly dims: number;
}

// Schema DDL — `<DIMS>` is substituted at open time with an integer-validated value.
const SCHEMA_DDL_TEMPLATE = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  folder TEXT NOT NULL,
  tags TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks(note_path);
CREATE INDEX IF NOT EXISTS idx_chunks_folder ON chunks(folder);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[<DIMS>]
);

CREATE TABLE IF NOT EXISTS note_fingerprints (
  note_path TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Raw row shape returned by the JOIN between `chunks` and `chunk_vectors`.
interface RawChunkRow {
  readonly id: string;
  readonly note_path: string;
  readonly chunk_index: number;
  readonly heading: string | null;
  readonly text: string;
  readonly raw_text: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly folder: string;
  readonly tags: string;
}

interface RawSearchRow extends RawChunkRow {
  readonly distance: number;
}

/**
 * sqlite-vec backed persistent chunk+embedding store.
 *
 * Usage:
 *   const store = new SemanticStore({ path, embedderName, dims });
 *   await store.open();
 *   await store.upsertBatch(items);
 *   const hits = await store.search(queryVec, 10, { folder: "05-Resources" });
 *   await store.close();
 *
 * All `async` methods are implemented synchronously under the hood
 * (better-sqlite3 is sync); the promise shape is kept so we can swap in an
 * async driver later without an API break.
 */
export class SemanticStore {
  private readonly path: string;
  private readonly embedderName: string;
  private readonly dims: number;
  private db: Database.Database | undefined;

  constructor(opts: SemanticStoreOptions) {
    if (!Number.isInteger(opts.dims) || opts.dims <= 0) {
      throw new RangeError(
        `SemanticStore: dims must be a positive integer (got ${String(opts.dims)})`,
      );
    }
    if (opts.embedderName === "") {
      throw new RangeError("SemanticStore: embedderName must be non-empty");
    }
    this.path = opts.path;
    this.embedderName = opts.embedderName;
    this.dims = opts.dims;
  }

  /**
   * Open (or create) the database file and initialize the schema.
   *
   * Throws when an existing store was initialized with a different embedder
   * or dimension — the vectors cannot be reused and the caller should
   * delete the sqlite file to proceed with the new embedder.
   */
  async open(): Promise<void> {
    if (this.db !== undefined) return Promise.resolve();
    const db = new Database(this.path);
    // Enable extension loading before calling sqlite-vec.
    sqliteVec.load(db);

    const ddl = SCHEMA_DDL_TEMPLATE.replaceAll("<DIMS>", this.dims.toString());
    db.exec(ddl);

    // Initialize (or validate) the meta singleton.
    const getMeta = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?");
    const setMeta = db.prepare<[string, string]>(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    );

    const existingEmbedder = getMeta.get("embedder")?.value;
    const existingDims = getMeta.get("dims")?.value;

    if (existingEmbedder === undefined) {
      setMeta.run("embedder", this.embedderName);
    } else if (existingEmbedder !== this.embedderName) {
      db.close();
      throw new Error(
        `SemanticStore: embedder mismatch — file was built with "${existingEmbedder}" but current embedder is "${this.embedderName}". Delete the sqlite file to re-index.`,
      );
    }

    if (existingDims === undefined) {
      setMeta.run("dims", this.dims.toString());
    } else if (existingDims !== this.dims.toString()) {
      db.close();
      throw new Error(
        `SemanticStore: dimension mismatch — file was built with dims=${existingDims} but current dims=${this.dims.toString()}. Delete the sqlite file to re-index.`,
      );
    }

    this.db = db;
    return Promise.resolve();
  }

  /** Close the underlying database. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
    return Promise.resolve();
  }

  /** Upsert a single chunk + embedding. */
  async upsertChunk(chunk: StoredChunk, embedding: Float32Array): Promise<void> {
    await this.upsertBatch([{ chunk, embedding }]);
  }

  /**
   * Upsert a batch of chunks + embeddings atomically.
   *
   * vec0 does not support `INSERT OR REPLACE`; we DELETE+INSERT within a
   * transaction to guarantee either all rows commit or none do.
   */
  async upsertBatch(items: { chunk: StoredChunk; embedding: Float32Array }[]): Promise<void> {
    const db = this.requireOpen();
    const deleteChunk = db.prepare<[string]>("DELETE FROM chunks WHERE id = ?");
    const deleteVec = db.prepare<[string]>("DELETE FROM chunk_vectors WHERE id = ?");
    const insertChunk = db.prepare<
      [string, string, number, string | null, string, string, number, number, string, string]
    >(
      `INSERT INTO chunks (id, note_path, chunk_index, heading, text, raw_text, start_line, end_line, folder, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = db.prepare<[string, Buffer]>(
      "INSERT INTO chunk_vectors(id, embedding) VALUES (?, ?)",
    );

    const tx = db.transaction((entries: { chunk: StoredChunk; embedding: Float32Array }[]) => {
      for (const { chunk, embedding } of entries) {
        if (embedding.length !== this.dims) {
          throw new RangeError(
            `SemanticStore.upsert: embedding length ${embedding.length.toString()} does not match store dims ${this.dims.toString()} for chunk ${chunk.id}`,
          );
        }
        deleteVec.run(chunk.id);
        deleteChunk.run(chunk.id);
        insertChunk.run(
          chunk.id,
          chunk.notePath,
          chunk.chunkIndex,
          chunk.heading,
          chunk.text,
          chunk.rawText,
          chunk.startLine,
          chunk.endLine,
          chunk.folder,
          JSON.stringify([...chunk.tags]),
        );
        insertVec.run(chunk.id, bufferFromFloat32(embedding));
      }
    });
    tx(items);
    return Promise.resolve();
  }

  /**
   * Delete every chunk (and vector) associated with a note path.
   *
   * Returns the number of `chunks` rows removed (which equals the number of
   * vectors removed since the two tables are kept in sync).
   */
  async deleteByNotePath(notePath: string): Promise<number> {
    const db = this.requireOpen();
    const idsStmt = db.prepare<[string], { id: string }>(
      "SELECT id FROM chunks WHERE note_path = ?",
    );
    const ids = idsStmt.all(notePath).map((r) => r.id);
    if (ids.length === 0) return Promise.resolve(0);

    const deleteChunk = db.prepare<[string]>("DELETE FROM chunks WHERE id = ?");
    const deleteVec = db.prepare<[string]>("DELETE FROM chunk_vectors WHERE id = ?");
    const tx = db.transaction((list: string[]) => {
      for (const id of list) {
        deleteVec.run(id);
        deleteChunk.run(id);
      }
    });
    tx(ids);
    return Promise.resolve(ids.length);
  }

  /**
   * Run a KNN search. Returns up to `limit` hits ordered by descending score.
   *
   * Folder and path-prefix filters are applied in SQL as `GLOB` patterns.
   * Tag filtering (all-of) is applied in JS over the KNN candidate set; we
   * fetch `limit * 3` candidates first to give the tag filter headroom.
   */
  async search(queryVec: Float32Array, limit: number, filter?: SearchFilter): Promise<SearchHit[]> {
    const db = this.requireOpen();
    if (queryVec.length !== this.dims) {
      throw new RangeError(
        `SemanticStore.search: queryVec length ${queryVec.length.toString()} does not match store dims ${this.dims.toString()}`,
      );
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(
        `SemanticStore.search: limit must be a positive integer (got ${String(limit)})`,
      );
    }

    const hasTagFilter = Array.isArray(filter?.tags) && filter.tags.length > 0;
    const candidateK = hasTagFilter ? limit * 3 : limit;

    const where: string[] = ["chunk_vectors.embedding MATCH ?", "k = ?"];
    const params: (Buffer | number | string)[] = [bufferFromFloat32(queryVec), candidateK];
    if (filter?.folder !== undefined) {
      where.push("chunks.folder GLOB ?");
      params.push(globEscape(filter.folder));
    }
    if (filter?.notePathPrefix !== undefined) {
      where.push("chunks.note_path GLOB ?");
      // Prefix match: escape glob chars in the user-supplied prefix and append a `*`.
      params.push(`${globEscape(filter.notePathPrefix)}*`);
    }

    const sql = `SELECT chunks.id AS id,
                        chunks.note_path AS note_path,
                        chunks.chunk_index AS chunk_index,
                        chunks.heading AS heading,
                        chunks.text AS text,
                        chunks.raw_text AS raw_text,
                        chunks.start_line AS start_line,
                        chunks.end_line AS end_line,
                        chunks.folder AS folder,
                        chunks.tags AS tags,
                        chunk_vectors.distance AS distance
                 FROM chunk_vectors
                 JOIN chunks ON chunks.id = chunk_vectors.id
                 WHERE ${where.join(" AND ")}
                 ORDER BY chunk_vectors.distance`;

    const rows = db.prepare<(Buffer | number | string)[], RawSearchRow>(sql).all(...params);

    let hits: SearchHit[] = rows.map((r) => ({
      chunk: rowToChunk(r),
      score: 1 - r.distance,
    }));

    if (hasTagFilter) {
      const required = filter.tags ?? [];
      hits = hits.filter((h) => required.every((t) => h.chunk.tags.includes(t)));
    }
    if (hits.length > limit) hits = hits.slice(0, limit);
    return Promise.resolve(hits);
  }

  /** Return the combined meta singleton plus live counts. */
  async getMeta(): Promise<StoreMeta> {
    const db = this.requireOpen();
    const getMetaRow = db.prepare<[string], { value: string }>(
      "SELECT value FROM meta WHERE key = ?",
    );
    const embedder = getMetaRow.get("embedder")?.value ?? this.embedderName;
    const dims = Number.parseInt(getMetaRow.get("dims")?.value ?? this.dims.toString(), 10);
    const lastBuiltAt = getMetaRow.get("lastBuiltAt")?.value ?? "";
    const chunkCount = await this.getChunkCount();
    const noteCount = await this.getNoteCount();
    return { embedder, dims, lastBuiltAt, noteCount, chunkCount };
  }

  /**
   * Set one or more mutable meta fields. `embedder` and `dims` are managed by
   * `open()` and not writable here (writing them would risk desyncing from
   * the actual vector geometry).
   */
  async setMeta(partial: Partial<StoreMeta>): Promise<void> {
    const db = this.requireOpen();
    const setMeta = db.prepare<[string, string]>(
      "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
    );
    if (partial.lastBuiltAt !== undefined) setMeta.run("lastBuiltAt", partial.lastBuiltAt);
    // `embedder` and `dims` deliberately ignored: they're write-once at open.
    return Promise.resolve();
  }

  /** Total chunks currently stored. */
  async getChunkCount(): Promise<number> {
    const db = this.requireOpen();
    const row = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks").get();
    return Promise.resolve(row?.c ?? 0);
  }

  /** Distinct notes (by `note_path`) currently represented in the store. */
  async getNoteCount(): Promise<number> {
    const db = this.requireOpen();
    const row = db
      .prepare<[], { c: number }>("SELECT COUNT(DISTINCT note_path) AS c FROM chunks")
      .get();
    return Promise.resolve(row?.c ?? 0);
  }

  /** Distinct note paths currently in the store. */
  async getNotePaths(): Promise<string[]> {
    const db = this.requireOpen();
    const rows = db
      .prepare<
        [],
        { note_path: string }
      >("SELECT DISTINCT note_path FROM chunks ORDER BY note_path")
      .all();
    return Promise.resolve(rows.map((r) => r.note_path));
  }

  /** Read a per-note content-hash fingerprint; returns `null` when absent. */
  async getNoteFingerprint(notePath: string): Promise<string | null> {
    const db = this.requireOpen();
    const row = db
      .prepare<
        [string],
        { fingerprint: string }
      >("SELECT fingerprint FROM note_fingerprints WHERE note_path = ?")
      .get(notePath);
    return Promise.resolve(row?.fingerprint ?? null);
  }

  /** Write a per-note content-hash fingerprint (upsert). */
  async setNoteFingerprint(notePath: string, fingerprint: string): Promise<void> {
    const db = this.requireOpen();
    db.prepare<[string, string]>(
      "INSERT OR REPLACE INTO note_fingerprints(note_path, fingerprint) VALUES (?, ?)",
    ).run(notePath, fingerprint);
    return Promise.resolve();
  }

  // --- internals ---

  private requireOpen(): Database.Database {
    if (this.db === undefined) {
      throw new Error("SemanticStore: not open — call open() first");
    }
    return this.db;
  }
}

// --- helpers ---

const bufferFromFloat32 = (v: Float32Array): Buffer =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/**
 * Escape SQLite GLOB special characters (`*`, `?`, `[`). We use GLOB for
 * case-sensitive exact matches in the filter path; without escaping, a
 * folder name containing `*` would accidentally match siblings. Callers
 * pass literal folder/path strings; this keeps the SQL literal as well.
 */
const globEscape = (literal: string): string => literal.replace(/[*?[]/g, (c) => `[${c}]`);

/** Parse the JSON tags column defensively. */
const parseTags = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through
  }
  return [];
};

const rowToChunk = (r: RawChunkRow): StoredChunk => ({
  id: r.id,
  notePath: r.note_path,
  chunkIndex: r.chunk_index,
  heading: r.heading,
  text: r.text,
  rawText: r.raw_text,
  startLine: r.start_line,
  endLine: r.end_line,
  folder: r.folder,
  tags: parseTags(r.tags),
});
