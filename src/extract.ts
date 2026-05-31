// 文本抽取：PDF / DOCX / DOC / MD / TXT
// DOCX/DOC 使用 macOS 自带的 textutil，零依赖

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname } from "node:path";

const exec = promisify(execFile);

export type ExtractedText = { text: string; warnings?: string[] };

// kind = 'text' 的扩展名
export const TEXT_EXTS = new Set([".pdf", ".docx", ".doc", ".md", ".txt"]);
// kind = 'catalog' 的扩展名（只记录元数据）
export const CATALOG_EXTS = new Set([".pptx", ".ppt", ".key", ".epub"]);

export function classify(path: string): "text" | "catalog" | "skip" {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTS.has(ext)) return "text";
  if (CATALOG_EXTS.has(ext)) return "catalog";
  return "skip";
}

export async function extractText(path: string): Promise<ExtractedText> {
  const ext = extname(path).toLowerCase();

  if (ext === ".md" || ext === ".txt") {
    return { text: await readFile(path, "utf8") };
  }

  if (ext === ".pdf") {
    // unpdf wraps pdfjs-dist for Node/serverless: ships its own
    // polyfills for DOMMatrix / Path2D / ImageData so we don't
    // pollute globalThis ourselves. Dynamic import keeps it lazy
    // (the admin process only pays the cost when a PDF actually
    // shows up in the queue). Aliased because this module also
    // exports a function called extractText.
    const { extractText: unpdfExtractText, getDocumentProxy } = await import("unpdf");
    const buf = await readFile(path);
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await unpdfExtractText(doc, { mergePages: true });
    return { text };
  }

  if (ext === ".docx" || ext === ".doc") {
    // textutil 是 macOS 内置工具，处理 doc/docx/rtf/html 都很稳
    const { stdout } = await exec("textutil", ["-convert", "txt", "-stdout", path], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { text: stdout };
  }

  throw new Error(`unsupported extension: ${ext}`);
}

// Run the bundled bitrove-ocr binary (macOS Vision Framework) on a
// file and return the recognized text. Used by ingest.ts as a
// fallback when a PDF's text layer is empty AND the user has
// opted into OCR in Settings → Models.
//
// The binary path comes from BITROVE_OCR_BIN, which electron's
// services.ts sets when spawning the admin. In a non-electron dev
// run (npx tsx src/admin.ts), it falls back to the repo path so
// you can still exercise the OCR path locally.
export async function extractOcr(path: string): Promise<ExtractedText> {
  const bin =
    process.env.BITROVE_OCR_BIN ??
    new URL("../resources/bin/bitrove-ocr", import.meta.url).pathname;
  // 10 minutes hard cap — at ~1s/page Vision can comfortably handle
  // hundreds of pages, but a stuck process shouldn't block ingest.
  const { stdout } = await exec(bin, [path], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  return { text: stdout };
}
