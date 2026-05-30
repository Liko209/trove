// 批量扫描目录，按 ingestion 哲学分层处理：
//   - PDF/DOCX/DOC/MD/TXT → 全文索引（kind=text）
//   - PPTX/PPT/KEY/EPUB → 书架卡片（kind=catalog）
//   - 其他 → 跳过
//
// 默认排除规则：
//   - 隐藏文件、.DS_Store
//   - *.icloud (placeholder)
//   - 一些已知噪声路径（如 Java API 镜像）
//
// 用法：
//   tsx src/scan.ts <root_dir> [--exclude <pattern>] [--limit N] [--dry] [--force]

import { resolve, relative } from "node:path";
import { openDb } from "./db.ts";
import { ingestFile } from "./ingest.ts";
import { classify } from "./extract.ts";
import { walkSmart } from "./walker.ts";

const DEFAULT_EXCLUDES = [
  "/Tech/Java/api/",
  "/.git/",
  "/node_modules/",
  "/.next/",
  "/dist/",
  "/build/",
  "/target/",
  "/coverage/",
  "/.cache/",
  "/.pytest_cache/",
  "/.mypy_cache/",
  "/.idea/",
  "/.vscode/",
  "/.venv/",
  "/venv/",
  "/__pycache__/",
  "/conda/envs/",
  "/conda/pkgs/",
  "/conda/lib/",
  "/.conda/",
  "/site-packages/",
  "/data/cleaned/",
  "/data/raw/",
  "/data/processed/",
  "/data/interim/",
  "/.claude/",
  "/CCGS Skill Testing Framework/",
  "/Library/Application Support/",
  "/Library/Caches/",
];

type ScanOpts = {
  exclude: string[];
  limit?: number;
  dry: boolean;
  force: boolean;
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(
      "usage: tsx src/scan.ts <root_dir> [--exclude <substr>]... [--limit N] [--dry] [--force]",
    );
    process.exit(1);
  }
  const opts: ScanOpts = {
    exclude: [...DEFAULT_EXCLUDES],
    dry: false,
    force: false,
  };
  let root = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exclude") opts.exclude.push(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--dry") opts.dry = true;
    else if (a === "--force") opts.force = true;
    else if (!root) root = resolve(a);
  }
  if (!root) {
    console.error("missing root dir");
    process.exit(1);
  }

  console.log(`scanning: ${root}`);
  console.log(`excludes: ${opts.exclude.join(", ")}`);
  if (opts.limit) console.log(`limit:    ${opts.limit}`);
  if (opts.dry) console.log(`mode:     dry run (no DB writes)`);

  // 第一遍：枚举并分类
  const text: string[] = [];
  const catalog: string[] = [];
  let totalSeen = 0;
  for await (const p of walkSmart(root, { excludes: opts.exclude })) {
    totalSeen++;
    const k = classify(p);
    if (k === "text") text.push(p);
    else if (k === "catalog") catalog.push(p);
    if (opts.limit && text.length + catalog.length >= opts.limit) break;
  }
  console.log(`\nfound: ${totalSeen} files total`);
  console.log(`  text:    ${text.length} (PDF/DOCX/DOC/MD/TXT)`);
  console.log(`  catalog: ${catalog.length} (PPTX/PPT/KEY/EPUB)`);
  console.log(`  skipped: ${totalSeen - text.length - catalog.length}`);

  if (opts.dry) {
    console.log("\n--- text files (first 20) ---");
    for (const p of text.slice(0, 20)) console.log(`  ${relative(root, p)}`);
    console.log("\n--- catalog files (first 20) ---");
    for (const p of catalog.slice(0, 20)) console.log(`  ${relative(root, p)}`);
    return;
  }

  const db = openDb();
  const queue = [...text, ...catalog];
  let done = 0,
    ingested = 0,
    skipped = 0,
    errors = 0;
  const t0 = Date.now();

  for (const p of queue) {
    const r = await ingestFile(db, p, { force: opts.force });
    done++;
    if (r.status === "ingested") {
      ingested++;
      const rel = relative(root, p);
      process.stdout.write(
        `\r[${done}/${queue.length}] ✓ ${r.kind === "catalog" ? "[cat]" : "     "} ${rel.slice(0, 70).padEnd(70)}\n`,
      );
    } else if (r.status === "skipped-cached") {
      skipped++;
    } else if (r.status === "error") {
      errors++;
      console.log(`\n[${done}/${queue.length}] ✗ ${relative(root, p)}\n    ${r.error}`);
    }
    if (done % 20 === 0) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = (done / Number(dt)).toFixed(1);
      process.stdout.write(
        `\r  progress: ${done}/${queue.length} (${rate}/s, ${ingested} new, ${skipped} cached, ${errors} err)         \r`,
      );
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\ndone in ${dt}s — ingested ${ingested}, cached ${skipped}, errors ${errors}`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
