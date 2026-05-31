// 通过本地 llama-server 调 bge-m3 embedding
//
// 重要：bge-m3 使用 CLS pooling，由 llama-server 启动参数 --pooling cls 保证。
// bge-m3 在 retrieval 任务下 query 和 passage 都不需要 prompt prefix（与 e5 不同）。

// electron/services.ts passes EMBED_URL as the bare host (no path) so
// admin can also probe `${EMBED_URL}/health`. Accept either form: if
// the env value already names /v1/embeddings, use it as-is; otherwise
// append. This avoided a long-running misery where POSTs went to the
// llama-server root and came back 404 File Not Found.
const EMBED_URL_RAW = process.env.EMBED_URL ?? "http://127.0.0.1:8765";
const EMBED_URL = EMBED_URL_RAW.includes("/v1/embeddings")
  ? EMBED_URL_RAW
  : `${EMBED_URL_RAW.replace(/\/+$/, "")}/v1/embeddings`;

export const EMBED_DIM = 1024;

// 替换不成对的 UTF-16 surrogate 为 U+FFFD，避免下游 JSON 解析失败
function sanitizeForJson(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

// llama-server returns 503 with a "model is loading" body while the
// GGUF mmap is still warming up — that's not actually a failure, just
// "ask again in a second". 502 / 504 happen on cold connect. Retry
// those a handful of times before giving up so a fresh app launch
// doesn't poison every file in the first scan with transient errors.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 6;

export async function embed(texts: string[]): Promise<number[][]> {
  const clean = texts.map(sanitizeForJson);
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let r: Response;
    try {
      r = await fetch(EMBED_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: clean, model: "bge-m3" }),
      });
    } catch (e) {
      // Network-level failure (connection refused while llama-server
      // is still starting up). Treat as retryable.
      lastErr = (e as Error).message;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((res) => setTimeout(res, backoff(attempt)));
        continue;
      }
      throw new Error(`embed connect failed: ${lastErr}`);
    }
    if (r.ok) {
      const j = (await r.json()) as { data: { embedding: number[] }[] };
      return j.data.map((d) => d.embedding);
    }
    const body = await r.text();
    lastErr = `${r.status} ${body.slice(0, 200)}`;
    if (!RETRYABLE_STATUS.has(r.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`embed failed: ${lastErr}`);
    }
    await new Promise((res) => setTimeout(res, backoff(attempt)));
  }
  throw new Error(`embed failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
}

function backoff(attempt: number): number {
  // 1s, 2s, 4s, 4s, 4s — covers the typical 10-30s GGUF warmup.
  return Math.min(1000 * 2 ** (attempt - 1), 4000);
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}
