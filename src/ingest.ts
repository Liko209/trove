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
  upsertAlias,
  getAlias,
  deleteAlias,
  findAliasByContentHash,
  clearAliasMissing,
} from "./db.ts";
import { chunkText } from "./chunk.ts";
import { extractText, extractOcr, classify } from "./extract.ts";
import { readIngestSettings } from "./settings.ts";
import { makeCatalogCard } from "./catalog.ts";
import { hashFile } from "./hash.ts";

export type IngestResult =
  | { status: "skipped-unsupported"; path: string; reason: string }
  | { status: "skipped-cached"; path: string }
  | { status: "skipped-mtime-touched"; path: string }
  | {
      // Strategy B — same bytes as an existing source, so we recorded
      // this path as an alias instead of re-embedding. Search results
      // for the source will surface this path too.
      status: "aliased-duplicate";
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

  // Layered skip logic (Phase 2 + Option B + Strategy B). Order matters:
  //   1. Path is an existing source AND (mtime, size) match  → cached
  //   2. Path is an existing source, size matches but mtime differs
  //      → hash; match → just sync mtime; mismatch → re-index
  //   3. Path is an existing alias AND (mtime, size) match  → cached
  //   4. Path is an existing alias, size matches mtime differs
  //      → hash; match → sync mtime on alias; mismatch → drop alias,
  //                                                       fall through
  //   5. New / invalidated path → hash + dedup-B:
  //        - hash matches a present source → record as alias
  //        - hash matches a present alias  → record as another alias
  //                                          to the same source
  //        - new content → ingest as source
  const existing = !opts.force ? getSource(db, path) : undefined;
  if (existing) {
    const sameSize = existing.size_bytes === sizeBytes;
    const sameMtime = existing.mtime_ms != null && existing.mtime_ms === mtimeMs;
    if (sameSize && sameMtime) {
      if (existing.missing_since != null) clearMissing(db, path);
      return { status: "skipped-cached", path };
    }
    if (sameSize && !sameMtime && existing.content_hash) {
      const h = await hashFile(path);
      if (h === existing.content_hash) {
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

  // Same cheap path for existing aliases — re-validates without
  // dropping the alias whenever (mtime, size) line up.
  const existingAlias = !opts.force ? getAlias(db, path) : undefined;
  if (existingAlias) {
    const sameSize = existingAlias.size_bytes === sizeBytes;
    const sameMtime = existingAlias.mtime_ms != null && existingAlias.mtime_ms === mtimeMs;
    if (sameSize && sameMtime) {
      if (existingAlias.missing_since != null) clearAliasMissing(db, path);
      return {
        status: "aliased-duplicate",
        path,
        duplicateOf: existingAlias.source_path,
        contentHash: existingAlias.content_hash,
      };
    }
    if (sameSize && !sameMtime) {
      const h = await hashFile(path);
      if (h === existingAlias.content_hash) {
        upsertAlias(db, {
          ...existingAlias,
          mtime_ms: mtimeMs,
          size_bytes: sizeBytes,
          missing_since: null,
        });
        return {
          status: "aliased-duplicate",
          path,
          duplicateOf: existingAlias.source_path,
          contentHash: existingAlias.content_hash,
        };
      }
      // Content changed — drop the alias and fall through to the new-file
      // flow below. The path may belong somewhere else now.
      deleteAlias(db, path);
    } else {
      // Size mismatch → alias is stale, drop it.
      deleteAlias(db, path);
    }
  }

  const t0 = Date.now();

  // Compute hash for the ingest path so we can (a) persist it on the
  // new source / alias row and (b) detect dedup against other files.
  const contentHash = await hashFile(path);

  // Strategy B dedup: if another path already holds these bytes, record
  // *this* path as an alias rather than re-embedding. Caller can opt
  // out by passing includeDuplicates=true (used by the hand-picked
  // ingest flow — if the user said "add this file by name" we honor it
  // as a full source).
  if (!opts.includeDuplicates) {
    // First check the canonical sources, then the existing aliases — if
    // it matches an alias we resolve to whatever that alias points at,
    // keeping a single canonical source per unique content hash.
    const sourceDups = findByContentHash(db, contentHash, path);
    const presentSource = sourceDups.find((d) => d.missing_since == null);
    let canonicalSourcePath: string | null = null;
    if (presentSource) {
      canonicalSourcePath = presentSource.source_path;
    } else {
      const aliasDups = findAliasByContentHash(db, contentHash, path);
      const presentAlias = aliasDups.find((a) => a.missing_since == null);
      if (presentAlias) canonicalSourcePath = presentAlias.source_path;
    }
    if (canonicalSourcePath) {
      upsertAlias(db, {
        path,
        source_path: canonicalSourcePath,
        content_hash: contentHash,
        mtime_ms: mtimeMs,
        size_bytes: sizeBytes,
        added_at: Date.now(),
        missing_since: null,
        watched_root: opts.watchedRoot ?? null,
      });
      return {
        status: "aliased-duplicate",
        path,
        duplicateOf: canonicalSourcePath,
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
    let chunks = chunkText(text);
    if (chunks.length === 0) {
      // Image-only PDF is the common case here: pdfjs returns 0 text
      // because the file is a scan with no text layer. If the user
      // has opted into OCR, run it now and treat the result as the
      // real text. Otherwise flag the file so the UI can show
      // "Image-only · enable OCR" and a later batch can target it.
      if (path.toLowerCase().endsWith(".pdf")) {
        const settings = await readIngestSettings();
        if (settings.ocrEnabled) {
          try {
            const { text: ocrText } = await extractOcr(path);
            chunks = chunkText(ocrText);
          } catch (e) {
            console.warn(`[ingest] OCR failed for ${path}:`, (e as Error).message);
          }
        }
        if (chunks.length === 0) {
          deleteSource(db, path);
          upsertSource(db, {
            source_path: path,
            kind: "text",
            source_mtime: mtimeISO,
            indexed_at: new Date().toISOString(),
            chunk_count: 0,
            mtime_ms: mtimeMs,
            size_bytes: sizeBytes,
            content_hash: contentHash,
            missing_since: null,
            watched_root: opts.watchedRoot ?? null,
            needs_ocr: 1,
          });
          return { status: "ingested", path, kind: "text", chunks: 0, ms: Date.now() - t0 };
        }
        // OCR succeeded — fall through into the normal embed loop
        // below with the OCR'd chunks. The upsertSource at the end
        // will set needs_ocr=0 since we now have real chunks.
      } else {
        return fallbackToCatalog("Empty text content");
      }
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
