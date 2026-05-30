// CLI：直接命令行查询，用于不通过 MCP 时验证检索质量
//
// 用法：tsx src/query.ts "你的问题"

import { embedOne } from "./embed.ts";
import { openDb, search, listSources } from "./db.ts";

async function main() {
  const q = process.argv.slice(2).join(" ").trim();
  if (!q) {
    console.error("usage: tsx src/query.ts <query>");
    const db = openDb();
    const r = listSources(db, { limit: 30 });
    console.log(`indexed sources (showing ${r.returned}/${r.total}):`);
    for (const s of r.rows) {
      console.log(`  ${s.kind.padEnd(8)} [${s.chunk_count}] ${s.source_path}`);
    }
    db.close();
    process.exit(1);
  }

  const t0 = Date.now();
  const vec = await embedOne(q);
  const dtEmbed = Date.now() - t0;

  const db = openDb();
  const t1 = Date.now();
  const hits = search(db, vec, 5);
  const dtSearch = Date.now() - t1;

  console.log(`query: ${q}`);
  console.log(`embed: ${dtEmbed}ms, search: ${dtSearch}ms, hits: ${hits.length}\n`);
  for (const h of hits) {
    const file = h.source_path.split("/").pop();
    console.log(`[${h.kind}] #${h.chunk_index} ${file} distance=${h.distance.toFixed(4)}`);
    console.log(`  ${h.text.slice(0, 240).replace(/\n/g, " ")}${h.text.length > 240 ? "…" : ""}`);
    console.log();
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
