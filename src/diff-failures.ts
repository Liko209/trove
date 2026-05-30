// 重新扫一遍目标目录，对比 sources 表，列出未入库的文件（即上次失败的）
//
// 用法：tsx src/diff-failures.ts <root_dir>

import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { classify } from "./extract.ts";

const DEFAULT_EXCLUDES = [
  "/Tech/Java/api/",
  "/.git/",
  "/node_modules/",
  "/.next/",
  "/dist/",
  "/build/",
  "/Library/Application Support/",
  "/Library/Caches/",
];

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(root, e.name);
    if (DEFAULT_EXCLUDES.some((x) => full.includes(x))) continue;
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && !e.name.endsWith(".icloud")) yield full;
  }
}

const root = resolve(process.argv[2] ?? "");
if (!root) {
  console.error("usage: tsx src/diff-failures.ts <root_dir>");
  process.exit(1);
}

const db = openDb();
const indexed = new Set(
  (db.prepare(`SELECT source_path FROM sources`).all() as { source_path: string }[]).map(
    (r) => r.source_path,
  ),
);

const missing: string[] = [];
let totalText = 0;
let totalCatalog = 0;
for await (const p of walk(root)) {
  const k = classify(p);
  if (k === "skip") continue;
  if (k === "text") totalText++;
  else totalCatalog++;
  if (!indexed.has(p)) missing.push(p);
}

console.log(`scanned: ${totalText} text + ${totalCatalog} catalog = ${totalText + totalCatalog} total`);
console.log(`indexed: ${indexed.size}`);
console.log(`missing: ${missing.length}\n`);

const byExt = new Map<string, string[]>();
for (const p of missing) {
  const ext = (p.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase();
  if (!byExt.has(ext)) byExt.set(ext, []);
  byExt.get(ext)!.push(p);
}

const sorted = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [ext, files] of sorted) {
  console.log(`\n=== ${ext} (${files.length}) ===`);
  for (const f of files.slice(0, 5)) console.log(`  ${f.replace(root, ".")}`);
  if (files.length > 5) console.log(`  ... and ${files.length - 5} more`);
}
db.close();
