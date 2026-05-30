// 文本抽取：PDF / DOCX / DOC / MD / TXT
// DOCX/DOC 使用 macOS 自带的 textutil，零依赖

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname } from "node:path";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

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
    const mod = require("pdf-parse") as {
      PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string }> };
    };
    const buf = await readFile(path);
    const parser = new mod.PDFParse({ data: buf });
    const r = await parser.getText();
    return { text: r.text };
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
