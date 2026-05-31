// 通过本地 llama-server 调 bge-reranker-v2-m3
// 输出 relevance_score（logit）：越大越相关，符号无下界（实测中可见 +10 ~ -15 区间）

// Same EMBED_URL story (see embed.ts): services.ts passes the bare
// host so /health probes work. Accept either form here — append
// /v1/rerank when the env value is just the host.
const RERANK_URL_RAW = process.env.RERANK_URL ?? "http://127.0.0.1:8766";
const RERANK_URL = RERANK_URL_RAW.includes("/v1/rerank")
  ? RERANK_URL_RAW
  : `${RERANK_URL_RAW.replace(/\/+$/, "")}/v1/rerank`;

// 与 embed.ts 同款 sanitizer
function sanitizeForJson(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

export type RerankItem = { index: number; score: number };

export async function rerank(query: string, documents: string[]): Promise<RerankItem[]> {
  if (documents.length === 0) return [];
  const cleanQuery = sanitizeForJson(query);
  const cleanDocs = documents.map(sanitizeForJson);
  const r = await fetch(RERANK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "bge-reranker-v2-m3",
      query: cleanQuery,
      documents: cleanDocs,
    }),
  });
  if (!r.ok) {
    throw new Error(`rerank failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { results: { index: number; relevance_score: number }[] };
  return j.results.map((x) => ({ index: x.index, score: x.relevance_score }));
}

// 探测 reranker server 是否可用（用于优雅降级）
export async function rerankerAvailable(): Promise<boolean> {
  try {
    const url = new URL(RERANK_URL);
    const r = await fetch(`${url.protocol}//${url.host}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}
