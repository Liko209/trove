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
} from "./db.ts";
import { chunkText } from "./chunk.ts";
import { extractText, classify } from "./extract.ts";
import { makeCatalogCard } from "./catalog.ts";

export type IngestResult =
  | { status: "skipped-unsupported"; path: string; reason: string }
  | { status: "skipped-cached"; path: string }
  | { status: "ingested"; path: string; kind: "text" | "catalog"; chunks: number; ms: number }
  | { status: "error"; path: string; error: string };

export async function ingestFile(
  db: ReturnType<typeof openDb>,
  rawPath: string,
  opts: { force?: boolean } = {},
): Promise<IngestResult> {
  const path = resolve(rawPath);
  const kind = classify(path);
  if (kind === "skip") {
    return { status: "skipped-unsupported", path, reason: "extension not in scope" };
  }

  let mtimeISO: string;
  try {
    const s = await stat(path);
    mtimeISO = s.mtime.toISOString();
  } catch (e) {
    return { status: "error", path, error: `stat: ${(e as Error).message}` };
  }

  // 同 mtime 跳过（除非 --force）
  if (!opts.force) {
    const existing = getSource(db, path);
    if (existing && existing.source_mtime === mtimeISO) {
      return { status: "skipped-cached", path };
    }
  }

  const t0 = Date.now();

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
if (process.env.TROVE_CLI === "ingest") {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
