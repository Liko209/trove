// 单文件 ingest：根据扩展名分派到全文索引 or 书架元数据
//
// 用法：tsx src/ingest.ts <file_path> [<file_path> ...]

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { embed, embedOne } from "./embed.ts";
import {
  openDb,
  insertChunk,
  deleteSource,
  upsertSource,
  getSource,
  findByContentHash,
  clearMissing,
  type SourceMetaRow,
} from "./db.ts";
import { chunkText } from "./chunk.ts";
import { extractText, classify } from "./extract.ts";
import { makeCatalogCard } from "./catalog.ts";
import { hashFile } from "./hash.ts";

export type IngestResult =
  | { status: "skipped-unsupported"; path: string; reason: string }
  | { status: "skipped-cached"; path: string }
  | { status: "skipped-mtime-touched"; path: string }
  | {
      status: "skipped-duplicate";
      path: string;
      duplicateOf: string;
      contentHash: string;
    }
  | { status: "ingested"; path: string; kind: "text" | "catalog"; chunks: number; ms: number }
  | { status: "error"; path: string; error: string };

export type IngestOpts = {
  // Re-index even if (mtime, size) match what's already in DB.
  force?: boolean;
  // When the user explicitly hand-picked a file (e.g. via Pick Files
  // dialog), they've already been warned about duplicate content if the
  // UI surfaced one — let it through regardless. Folder scans should
  // leave this false so dedup-A actually skips redundant files.
  includeDuplicates?: boolean;
  // If this ingest was driven by a watched-root scan, stamp the source
  // row so the watcher's missing-file pass knows which root it belongs
  // to. NULL for one-off picks.
  watchedRoot?: string;
};

export async function ingestFile(
  db: ReturnType<typeof openDb>,
  rawPath: string,
  opts: IngestOpts = {},
): Promise<IngestResult> {
  const path = resolve(rawPath);
  const kind = classify(path);
  if (kind === "skip") {
    return { status: "skipped-unsupported", path, reason: "extension not in scope" };
  }

  let mtimeISO: string;
  let mtimeMs: number;
  let sizeBytes: number;
  try {
    const s = await stat(path);
    mtimeISO = s.mtime.toISOString();
    mtimeMs = s.mtimeMs;
    sizeBytes = s.size;
  } catch (e) {
    return { status: "error", path, error: `stat: ${(e as Error).message}` };
  }

  // Layered skip logic (Phase 2 + Option B). Order matters:
  //   1. Path + (mtime, size) match what's on disk      → cached
  //   2. mtime differs but size matches → maybe touch    → compare hash
  //        - hash matches → update DB mtime, skip
  //        - hash differs → re-index
  //   3. Anything else (new file / size differs / no DB row) → ingest
  //      In the ingest branch we also do dedup-A: if the file's hash
  //      matches another already-indexed file, skip with skipped-duplicate
  //      (unless caller passed includeDuplicates=true).
  const existing = !opts.force ? getSource(db, path) : undefined;
  if (existing) {
    const sameSize = existing.size_bytes === sizeBytes;
    const sameMtime = existing.mtime_ms != null && existing.mtime_ms === mtimeMs;
    if (sameSize && sameMtime) {
      // If the file had been marked missing on a previous scan but is
      // back now with the same identity, clear the marker.
      if (existing.missing_since != null) clearMissing(db, path);
      return { status: "skipped-cached", path };
    }
    if (sameSize && !sameMtime && existing.content_hash) {
      // Cheap L2 check: only hash if size matches an existing record.
      const h = await hashFile(path);
      if (h === existing.content_hash) {
        // Sync mtime so we don't hash again next pass.
        upsertSource(db, {
          ...(existing as SourceMetaRow),
          source_mtime: mtimeISO,
          mtime_ms: mtimeMs,
          size_bytes: sizeBytes,
          missing_since: null,
        });
        return { status: "skipped-mtime-touched", path };
      }
    }
  }

  const t0 = Date.now();

  // Compute hash up-front for the ingest path so we can (a) persist it
  // and (b) detect dedup against other files.
  const contentHash = await hashFile(path);

  // Dedup-A: if a different path already indexed identical bytes, skip
  // unless the caller said "let it through". The dedup decision happens
  // *before* embedding so we save the costly part. We still record the
  // path's mtime/size/hash so subsequent scans don't keep re-checking.
  if (!opts.includeDuplicates) {
    const dups = findByContentHash(db, contentHash, path);
    const present = dups.find((d) => d.missing_since == null);
    if (present) {
      return {
        status: "skipped-duplicate",
        path,
        duplicateOf: present.source_path,
        contentHash,
      };
    }
  }

  // 文本抽取失败时的软降级：加密 PDF / 损坏文件等，至少入 catalog 留存在感
  async function fallbackToCatalog(reason: string): Promise<IngestResult> {
    const card = await makeCatalogCard(path);
    deleteSource(db, path);
    const vec = await embedOne(card);
    insertChunk(db, {
      source_path: path,
      chunk_index: 0,
      text: `[${reason}]\n${card}`,
      embedding: vec,
      kind: "catalog",
    });
    upsertSource(db, {
      source_path: path,
      kind: "catalog",
      source_mtime: mtimeISO,
      indexed_at: new Date().toISOString(),
      chunk_count: 1,
    });
    return { status: "ingested", path, kind: "catalog", chunks: 1, ms: Date.now() - t0 };
  }

  try {
    if (kind === "catalog") {
      const card = await makeCatalogCard(path);
      // 替换旧索引
      deleteSource(db, path);
      const vec = await embedOne(card);
      insertChunk(db, {
        source_path: path,
        chunk_index: 0,
        text: card,
        embedding: vec,
        kind: "catalog",
      });
      upsertSource(db, {
        source_path: path,
        kind: "catalog",
        source_mtime: mtimeISO,
        indexed_at: new Date().toISOString(),
        chunk_count: 1,
        mtime_ms: mtimeMs,
        size_bytes: sizeBytes,
        content_hash: contentHash,
        missing_since: null,
        watched_root: opts.watchedRoot ?? null,
      });
      return { status: "ingested", path, kind: "catalog", chunks: 1, ms: Date.now() - t0 };
    }

    // kind === 'text'
    let text: string;
    try {
      ({ text } = await extractText(path));
    } catch (e) {
      const msg = (e as Error).message;
      if (/no password|encrypted|password.*required/i.test(msg)) {
        return fallbackToCatalog("Encrypted / inaccessible content");
      }
      throw e;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return fallbackToCatalog("Empty text content");
    }

    deleteSource(db, path);
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const vecs = await embed(batch);
      for (let j = 0; j < batch.length; j++) {
        insertChunk(db, {
          source_path: path,
          chunk_index: i + j,
          text: batch[j],
          embedding: vecs[j],
          kind: "text",
        });
      }
    }
    upsertSource(db, {
      source_path: path,
      kind: "text",
      source_mtime: mtimeISO,
      indexed_at: new Date().toISOString(),
      chunk_count: chunks.length,
      mtime_ms: mtimeMs,
      size_bytes: sizeBytes,
      content_hash: contentHash,
      missing_since: null,
      watched_root: opts.watchedRoot ?? null,
    });
    return { status: "ingested", path, kind: "text", chunks: chunks.length, ms: Date.now() - t0 };
  } catch (e) {
    return { status: "error", path, error: (e as Error).message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: tsx src/ingest.ts <file> [<file> ...]");
    process.exit(1);
  }
  const force = args.includes("--force");
  const files = args.filter((a) => !a.startsWith("--"));
  const db = openDb();
  for (const p of files) {
    const r = await ingestFile(db, p, { force });
    const tag = r.status.toUpperCase().padEnd(20);
    if (r.status === "ingested") {
      console.log(`${tag} [${r.kind}] ${r.chunks} chunks in ${r.ms}ms  ${r.path}`);
    } else if (r.status === "error") {
      console.log(`${tag} ${r.path}\n  ${r.error}`);
    } else {
      console.log(`${tag} ${r.path}`);
    }
  }
  db.close();
}

// Only auto-run the CLI when explicitly invoked via `npm run ingest`.
// This avoids the entry-point guard mis-firing when the module is bundled
// (e.g. inside the packaged admin server, where import.meta.url and
// process.argv[1] both resolve to the bundle path).
if (process.env.BITROVE_CLI === "ingest") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
