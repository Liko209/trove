// "书架卡片"：为非全文索引的文件（演示文档、电子书等）生成元数据 chunk
// 用户原话："就像一个电子书架，第一层只需要记住'有什么书，在什么位置'就好"

import { stat } from "node:fs/promises";
import { basename, extname, dirname } from "node:path";

const TYPE_LABEL: Record<string, string> = {
  ".pptx": "Presentation (PowerPoint)",
  ".ppt": "Presentation (PowerPoint legacy)",
  ".key": "Presentation (Keynote)",
  ".epub": "Book (EPUB)",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function makeCatalogCard(path: string): Promise<string> {
  const s = await stat(path);
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  const parent = dirname(path);
  const label = TYPE_LABEL[ext] ?? ext;
  // 这个文本既是给 agent 看的，也是用来 embedding 的语义载体
  return [
    `[Catalog] ${name}`,
    `Type: ${label}`,
    `Parent folder: ${parent}`,
    `Path: ${path}`,
    `Size: ${humanSize(s.size)}`,
    `Modified: ${s.mtime.toISOString().split("T")[0]}`,
  ].join("\n");
}
