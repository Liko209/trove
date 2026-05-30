import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EMBED_DIM } from "./embed.ts";

const DB_PATH = process.env.KB_DB ?? resolve(process.cwd(), "data/index.db");

export type ChunkKind = "text" | "catalog";

export type ChunkRow = {
  id: number;
  source_path: string;
  chunk_index: number;
  text: string;
  kind: ChunkKind;
  created_at: string;
};

export type SearchHit = ChunkRow & { distance: number };

export type SourceRow = {
  source_path: string;
  kind: ChunkKind;
  source_mtime: string;
  indexed_at: string;
  chunk_count: number;
};

export function openDb(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL,
      UNIQUE(source_path, chunk_index)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vecs USING vec0(
      embedding float[${EMBED_DIM}]
    );
    CREATE TABLE IF NOT EXISTS sources (
      source_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_mtime TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS source_tags (
      source_path TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      category_label TEXT NOT NULL,
      score REAL NOT NULL,
      alternatives TEXT NOT NULL,
      classified_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_tags_category ON source_tags(category_id);
    CREATE TABLE IF NOT EXISTS watched_roots (
      path TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL,
      last_scanned_at INTEGER,
      last_completed_at INTEGER,
      watch_enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
  // 兼容老库：给 chunks 加 kind 列（idempotent）
  const chunkCols = db.prepare(`PRAGMA table_info(chunks)`).all() as { name: string }[];
  if (!chunkCols.some((c) => c.name === "kind")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
  }
  // Phase 2 migration: incremental-index metadata. Each column added
  // idempotently — re-runs safely on existing libraries.
  const srcCols = db.prepare(`PRAGMA table_info(sources)`).all() as { name: string }[];
  const srcColNames = new Set(srcCols.map((c) => c.name));
  if (!srcColNames.has("mtime_ms")) {
    db.exec(`ALTER TABLE sources ADD COLUMN mtime_ms INTEGER`);
  }
  if (!srcColNames.has("size_bytes")) {
    db.exec(`ALTER TABLE sources ADD COLUMN size_bytes INTEGER`);
  }
  if (!srcColNames.has("content_hash")) {
    db.exec(`ALTER TABLE sources ADD COLUMN content_hash TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_content_hash ON sources(content_hash)`);
  }
  if (!srcColNames.has("missing_since")) {
    db.exec(`ALTER TABLE sources ADD COLUMN missing_since INTEGER`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_missing_since ON sources(missing_since)`);
  }
  if (!srcColNames.has("watched_root")) {
    // Which user-watched root this source belongs under, if any. NULL means
    // the file was added via a one-off pick rather than a watched folder.
    db.exec(`ALTER TABLE sources ADD COLUMN watched_root TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_watched_root ON sources(watched_root)`);
  }
  return db;
}

export function insertChunk(
  db: Database.Database,
  args: {
    source_path: string;
    chunk_index: number;
    text: string;
    embedding: number[];
    kind?: ChunkKind;
  },
): number {
  const now = new Date().toISOString();
  const kind = args.kind ?? "text";
  const row = db
    .prepare(
      `INSERT INTO chunks (source_path, chunk_index, text, kind, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_path, chunk_index) DO UPDATE SET
         text=excluded.text,
         kind=excluded.kind,
         created_at=excluded.created_at
       RETURNING id`,
    )
    .get(args.source_path, args.chunk_index, args.text, kind, now) as { id: number | bigint };
  const id = typeof row.id === "bigint" ? Number(row.id) : row.id;
  const rowid = BigInt(id);
  db.prepare(`DELETE FROM chunk_vecs WHERE rowid = ?`).run(rowid);
  const buf = Buffer.from(new Float32Array(args.embedding).buffer);
  db.prepare(`INSERT INTO chunk_vecs(rowid, embedding) VALUES (?, ?)`).run(rowid, buf);
  return id;
}

export function search(
  db: Database.Database,
  queryVec: number[],
  k: number,
  kinds?: ChunkKind[],
): SearchHit[] {
  const buf = Buffer.from(new Float32Array(queryVec).buffer);
  const kindFilter =
    kinds && kinds.length > 0
      ? `AND c.kind IN (${kinds.map(() => "?").join(",")})`
      : "";
  const sql = `SELECT c.id, c.source_path, c.chunk_index, c.text, c.kind, c.created_at, v.distance
     FROM chunk_vecs v
     JOIN chunks c ON c.id = v.rowid
     WHERE v.embedding MATCH ? AND k = ? ${kindFilter}
     ORDER BY v.distance`;
  const params: unknown[] = [buf, k];
  if (kinds) params.push(...kinds);
  return db.prepare(sql).all(...params) as SearchHit[];
}

export function deleteSource(db: Database.Database, source_path: string): number {
  const rows = db
    .prepare(`SELECT id FROM chunks WHERE source_path = ?`)
    .all(source_path) as { id: number }[];
  const ids = rows.map((r) => r.id);
  const tx = db.transaction(() => {
    for (const id of ids) {
      db.prepare(`DELETE FROM chunk_vecs WHERE rowid = ?`).run(BigInt(id));
    }
    db.prepare(`DELETE FROM chunks WHERE source_path = ?`).run(source_path);
    db.prepare(`DELETE FROM sources WHERE source_path = ?`).run(source_path);
    db.prepare(`DELETE FROM source_tags WHERE source_path = ?`).run(source_path);
  });
  tx();
  return ids.length;
}

export type SourceMetaRow = SourceRow & {
  mtime_ms?: number | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  missing_since?: number | null;
  watched_root?: string | null;
};

export function upsertSource(
  db: Database.Database,
  args: SourceMetaRow,
): void {
  db.prepare(
    `INSERT INTO sources (
        source_path, kind, source_mtime, indexed_at, chunk_count,
        mtime_ms, size_bytes, content_hash, missing_since, watched_root
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       kind=excluded.kind,
       source_mtime=excluded.source_mtime,
       indexed_at=excluded.indexed_at,
       chunk_count=excluded.chunk_count,
       mtime_ms=excluded.mtime_ms,
       size_bytes=excluded.size_bytes,
       content_hash=excluded.content_hash,
       missing_since=excluded.missing_since,
       watched_root=COALESCE(excluded.watched_root, sources.watched_root)`,
  ).run(
    args.source_path,
    args.kind,
    args.source_mtime,
    args.indexed_at,
    args.chunk_count,
    args.mtime_ms ?? null,
    args.size_bytes ?? null,
    args.content_hash ?? null,
    args.missing_since ?? null,
    args.watched_root ?? null,
  );
}

export function getSource(db: Database.Database, source_path: string): SourceMetaRow | undefined {
  return db.prepare(`SELECT * FROM sources WHERE source_path = ?`).get(source_path) as
    | SourceMetaRow
    | undefined;
}

// Dedup-A support: look up sources that share a content hash, excluding the
// caller's own path so we don't flag a file as a duplicate of itself.
export function findByContentHash(
  db: Database.Database,
  hash: string,
  excludePath?: string,
): SourceMetaRow[] {
  if (excludePath) {
    return db
      .prepare(`SELECT * FROM sources WHERE content_hash = ? AND source_path != ?`)
      .all(hash, excludePath) as SourceMetaRow[];
  }
  return db.prepare(`SELECT * FROM sources WHERE content_hash = ?`).all(hash) as SourceMetaRow[];
}

// ── watched_roots helpers ─────────────────────────────────────
export type WatchedRoot = {
  path: string;
  added_at: number;
  last_scanned_at: number | null;
  last_completed_at: number | null;
  watch_enabled: number; // 0 or 1
};

export function listWatchedRoots(db: Database.Database): WatchedRoot[] {
  return db.prepare(`SELECT * FROM watched_roots ORDER BY added_at DESC`).all() as WatchedRoot[];
}

export function addWatchedRoot(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO watched_roots (path, added_at, watch_enabled) VALUES (?, ?, 1)
     ON CONFLICT(path) DO UPDATE SET watch_enabled = 1`,
  ).run(path, Date.now());
}

export function removeWatchedRoot(db: Database.Database, path: string): void {
  db.prepare(`DELETE FROM watched_roots WHERE path = ?`).run(path);
}

export function setWatchEnabled(db: Database.Database, path: string, enabled: boolean): void {
  db.prepare(`UPDATE watched_roots SET watch_enabled = ? WHERE path = ?`).run(
    enabled ? 1 : 0,
    path,
  );
}

export function markScanRun(
  db: Database.Database,
  path: string,
  completed: boolean,
): void {
  const now = Date.now();
  if (completed) {
    db.prepare(
      `UPDATE watched_roots SET last_scanned_at = ?, last_completed_at = ? WHERE path = ?`,
    ).run(now, now, path);
  } else {
    db.prepare(`UPDATE watched_roots SET last_scanned_at = ? WHERE path = ?`).run(now, path);
  }
}

// Find sources under a watched root that we expected to still see but didn't
// during this scan pass. Used by the watcher to mark them missing_since=now().
export function markSourcesMissing(
  db: Database.Database,
  watchedRoot: string,
  seenPaths: Set<string>,
  now: number,
): number {
  // Pull every still-present source under this root.
  const rows = db
    .prepare(
      `SELECT source_path FROM sources
       WHERE watched_root = ? AND missing_since IS NULL`,
    )
    .all(watchedRoot) as { source_path: string }[];
  let n = 0;
  const upd = db.prepare(
    `UPDATE sources SET missing_since = ? WHERE source_path = ?`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!seenPaths.has(r.source_path)) {
        upd.run(now, r.source_path);
        n++;
      }
    }
  });
  tx();
  return n;
}

// When a previously-missing file reappears, clear the marker.
export function clearMissing(db: Database.Database, source_path: string): void {
  db.prepare(`UPDATE sources SET missing_since = NULL WHERE source_path = ?`).run(source_path);
}

export type MissingSourceRow = {
  source_path: string;
  kind: ChunkKind;
  chunk_count: number;
  size_bytes: number | null;
  missing_since: number;
  watched_root: string | null;
};

export function listMissingSources(db: Database.Database): MissingSourceRow[] {
  return db
    .prepare(
      `SELECT source_path, kind, chunk_count, size_bytes, missing_since, watched_root
       FROM sources WHERE missing_since IS NOT NULL ORDER BY missing_since DESC`,
    )
    .all() as MissingSourceRow[];
}

export type ListSourcesOpts = {
  kind?: ChunkKind;
  path_prefix?: string;
  path_contains?: string;
  limit?: number;
  offset?: number;
};

export type ListSourcesResult = {
  total: number;
  returned: number;
  offset: number;
  rows: { source_path: string; kind: ChunkKind; chunk_count: number; source_mtime: string; indexed_at: string }[];
};

export function listSources(db: Database.Database, opts: ListSourcesOpts = {}): ListSourcesResult {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.path_prefix) {
    where.push("source_path LIKE ? ESCAPE '\\'");
    params.push(opts.path_prefix.replace(/[%_\\]/g, "\\$&") + "%");
  }
  if (opts.path_contains) {
    where.push("source_path LIKE ? ESCAPE '\\'");
    params.push("%" + opts.path_contains.replace(/[%_\\]/g, "\\$&") + "%");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) as n FROM sources ${whereSql}`).get(...params) as {
    n: number;
  }).n;

  const rows = db
    .prepare(
      `SELECT source_path, kind, chunk_count, source_mtime, indexed_at FROM sources ${whereSql}
       ORDER BY source_path LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ListSourcesResult["rows"];

  return { total, returned: rows.length, offset, rows };
}

// Fetch ALL sources (used by /api/library/groups for client-side grouping)
export function allSources(db: Database.Database): ListSourcesResult["rows"] {
  return db
    .prepare(
      `SELECT source_path, kind, chunk_count, source_mtime, indexed_at FROM sources ORDER BY source_path`,
    )
    .all() as ListSourcesResult["rows"];
}

// Fetch first-chunk text for a given source (used as classification signal)
export function firstChunkText(
  db: Database.Database,
  source_path: string,
): string {
  const row = db
    .prepare(`SELECT text FROM chunks WHERE source_path = ? AND chunk_index = 0`)
    .get(source_path) as { text: string } | undefined;
  return row?.text ?? "";
}

export type SourceTagRow = {
  source_path: string;
  category_id: string;
  category_label: string;
  score: number;
  alternatives: string; // JSON
  classified_at: string;
};

export function upsertTag(
  db: Database.Database,
  args: {
    source_path: string;
    category_id: string;
    category_label: string;
    score: number;
    alternatives: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO source_tags (source_path, category_id, category_label, score, alternatives, classified_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       category_id = excluded.category_id,
       category_label = excluded.category_label,
       score = excluded.score,
       alternatives = excluded.alternatives,
       classified_at = excluded.classified_at`,
  ).run(
    args.source_path,
    args.category_id,
    args.category_label,
    args.score,
    JSON.stringify(args.alternatives),
    new Date().toISOString(),
  );
}

export function getTag(db: Database.Database, source_path: string): SourceTagRow | undefined {
  return db
    .prepare(`SELECT * FROM source_tags WHERE source_path = ?`)
    .get(source_path) as SourceTagRow | undefined;
}

export function allTags(db: Database.Database): SourceTagRow[] {
  return db.prepare(`SELECT * FROM source_tags`).all() as SourceTagRow[];
}

export function stats(db: Database.Database): { kind: string; sources: number; chunks: number }[] {
  return db
    .prepare(
      `SELECT kind, COUNT(DISTINCT source_path) as sources, SUM(chunk_count) as chunks
       FROM sources GROUP BY kind ORDER BY kind`,
    )
    .all() as { kind: string; sources: number; chunks: number }[];
}
