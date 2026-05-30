// 通过本地 llama-server 调 bge-m3 embedding
//
// 重要：bge-m3 使用 CLS pooling，由 llama-server 启动参数 --pooling cls 保证。
// bge-m3 在 retrieval 任务下 query 和 passage 都不需要 prompt prefix（与 e5 不同）。

const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:8765/v1/embeddings";

export const EMBED_DIM = 1024;

// 替换不成对的 UTF-16 surrogate 为 U+FFFD，避免下游 JSON 解析失败
function sanitizeForJson(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

export async function embed(texts: string[]): Promise<number[][]> {
  const clean = texts.map(sanitizeForJson);
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: clean, model: "bge-m3" }),
  });
  if (!r.ok) {
    throw new Error(`embed failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}
