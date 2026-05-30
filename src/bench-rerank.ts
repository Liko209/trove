// 对比 vector-only vs vector+rerank 在挑战查询上的 top-k 命中
//
// 用法：tsx src/bench-rerank.ts

import { embedOne } from "./embed.ts";
import { openDb, search } from "./db.ts";
import { rerank } from "./rerank.ts";

const QUERIES = [
  "PRG pseudorandom generator security proof negligible function",
  "高一物理 圆周运动 教学课件",
  "研究生申请文书 个人陈述写作策略",
  "重疾险 哥哥 保费方案对比",
  "我藏书里有哪些哲学和思想类的书",
];

const K = 3;
const CANDIDATE_K = 12;

function shortName(p: string): string {
  return p.split("/").slice(-2).join("/");
}

const db = openDb();

for (const q of QUERIES) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Q: ${q}`);
  console.log("=".repeat(80));

  const t0 = Date.now();
  const vec = await embedOne(q);
  const tEmbed = Date.now() - t0;

  const t1 = Date.now();
  const candidates = search(db, vec, CANDIDATE_K);
  const tSearch = Date.now() - t1;

  const t2 = Date.now();
  const reranked = await rerank(q, candidates.map((c) => c.text));
  const tRerank = Date.now() - t2;

  const scoreByIdx = new Map(reranked.map((r) => [r.index, r.score]));
  const finalRerank = candidates
    .map((c, i) => ({ ...c, rscore: scoreByIdx.get(i) ?? -Infinity }))
    .sort((a, b) => b.rscore - a.rscore)
    .slice(0, K);

  console.log(
    `\n  timing: embed ${tEmbed}ms / search ${tSearch}ms / rerank ${tRerank}ms (${CANDIDATE_K} candidates)\n`,
  );

  console.log("[VECTOR-ONLY top 3]");
  for (let i = 0; i < K; i++) {
    const c = candidates[i];
    console.log(`  ${i + 1}. [${c.kind}] dist=${c.distance.toFixed(3)}  ${shortName(c.source_path)}#${c.chunk_index}`);
    console.log(`     ${c.text.slice(0, 100).replace(/\s+/g, " ")}…`);
  }

  console.log("\n[+RERANK top 3]");
  for (let i = 0; i < K; i++) {
    const c = finalRerank[i];
    console.log(
      `  ${i + 1}. [${c.kind}] rerank=${c.rscore.toFixed(2)} (was dist=${c.distance.toFixed(3)})  ${shortName(c.source_path)}#${c.chunk_index}`,
    );
    console.log(`     ${c.text.slice(0, 100).replace(/\s+/g, " ")}…`);
  }
}

db.close();
