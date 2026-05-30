// First-run / missing-resource detection + remediation.
//
// Why this exists: services.ts will set status=missing-dep if a model file
// is absent, but that gives the user a bad experience (they see a crashed
// service in the dashboard with no guidance). Instead the main process
// runs setup checks BEFORE starting services and routes the BrowserWindow
// to an onboarding URL when something is missing.

import { existsSync, statSync, createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { modelsDir } from "./paths.ts";

export type ModelSpec = {
  id: "embed" | "rerank";
  filename: string;
  displayName: string;
  url: string;
  // SHA256 left empty for now; can be filled from HF API. v1 trusts HTTPS.
  sha256?: string;
  approxBytes: number;
};

export const MODELS: ModelSpec[] = [
  {
    id: "embed",
    filename: "bge-m3-Q4_K_M.gguf",
    displayName: "bge-m3 (multilingual embeddings)",
    url: "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf?download=true",
    approxBytes: 437_000_000,
  },
  {
    id: "rerank",
    filename: "bge-reranker-v2-m3-Q4_K_M.gguf",
    displayName: "bge-reranker-v2-m3 (relevance reranker)",
    url: "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf?download=true",
    approxBytes: 438_000_000,
  },
];

export type ModelStatus = {
  id: ModelSpec["id"];
  filename: string;
  displayName: string;
  status: "missing" | "downloading" | "verifying" | "ready" | "error";
  downloadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  etaSeconds?: number;
  error?: string;
};

const STATE: Record<ModelSpec["id"], ModelStatus> = {
  embed: { id: "embed", filename: MODELS[0].filename, displayName: MODELS[0].displayName, status: "missing" },
  rerank: { id: "rerank", filename: MODELS[1].filename, displayName: MODELS[1].displayName, status: "missing" },
};

// Pause flags — flipped by IPC, checked between chunks during download.
const PAUSE_REQ = new Set<ModelSpec["id"]>();
const CANCEL_REQ = new Set<ModelSpec["id"]>();

let listeners: Array<(s: Record<string, ModelStatus>) => void> = [];

function notify() {
  for (const l of listeners) l({ ...STATE });
}

export function subscribeModels(fn: (s: Record<string, ModelStatus>) => void): () => void {
  listeners.push(fn);
  fn({ ...STATE });
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function getModelStatuses(): Record<string, ModelStatus> {
  return { ...STATE };
}

export function refreshModelStatuses(): void {
  const dir = modelsDir();
  for (const m of MODELS) {
    const full = join(dir, m.filename);
    if (existsSync(full)) {
      try {
        const sz = statSync(full).size;
        if (sz >= m.approxBytes * 0.95) {
          STATE[m.id] = { ...STATE[m.id], status: "ready", downloadedBytes: sz, totalBytes: sz };
        } else {
          STATE[m.id] = { ...STATE[m.id], status: "missing", downloadedBytes: sz };
        }
      } catch {
        STATE[m.id] = { ...STATE[m.id], status: "missing" };
      }
    } else {
      STATE[m.id] = { ...STATE[m.id], status: "missing" };
    }
  }
  notify();
}

export function allModelsReady(): boolean {
  refreshModelStatuses();
  return MODELS.every((m) => STATE[m.id].status === "ready");
}

export function pauseDownload(id: ModelSpec["id"]): void {
  PAUSE_REQ.add(id);
}

export function cancelDownload(id: ModelSpec["id"]): void {
  CANCEL_REQ.add(id);
}

export async function downloadModel(id: ModelSpec["id"]): Promise<void> {
  const spec = MODELS.find((m) => m.id === id)!;
  const dir = modelsDir();
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, spec.filename);
  const tmpPath = finalPath + ".part";

  // Resume support: if .part exists, send Range header.
  let resumeFrom = 0;
  if (existsSync(tmpPath)) {
    try {
      resumeFrom = statSync(tmpPath).size;
    } catch {}
  }
  if (existsSync(finalPath)) {
    STATE[id] = { ...STATE[id], status: "ready" };
    notify();
    return;
  }

  PAUSE_REQ.delete(id);
  CANCEL_REQ.delete(id);

  STATE[id] = { ...STATE[id], status: "downloading", downloadedBytes: resumeFrom, error: undefined };
  notify();

  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

  let res: Response;
  try {
    res = await fetch(spec.url, { headers });
  } catch (e) {
    STATE[id] = { ...STATE[id], status: "error", error: (e as Error).message };
    notify();
    return;
  }

  // 416 means our resume offset is beyond file end; restart from scratch.
  if (res.status === 416) {
    try {
      await unlink(tmpPath);
    } catch {}
    return downloadModel(id);
  }
  if (!res.ok && res.status !== 206) {
    STATE[id] = {
      ...STATE[id],
      status: "error",
      error: `HTTP ${res.status} ${res.statusText}`,
    };
    notify();
    return;
  }

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  const totalBytes = resumeFrom + contentLength;
  STATE[id] = { ...STATE[id], totalBytes };
  notify();

  const out = createWriteStream(tmpPath, { flags: resumeFrom > 0 ? "a" : "w" });
  const reader = res.body!.getReader();

  let got = resumeFrom;
  let lastReport = Date.now();
  let lastReportBytes = got;
  let aborted = false;

  while (true) {
    if (CANCEL_REQ.has(id)) {
      aborted = true;
      try {
        reader.cancel();
      } catch {}
      break;
    }
    if (PAUSE_REQ.has(id)) {
      try {
        reader.cancel();
      } catch {}
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
    got += value.length;

    const now = Date.now();
    if (now - lastReport > 250) {
      const dt = (now - lastReport) / 1000;
      const dBytes = got - lastReportBytes;
      const speedBps = dBytes / dt;
      const remaining = Math.max(0, (totalBytes || got) - got);
      const etaSeconds = speedBps > 0 ? remaining / speedBps : Infinity;
      STATE[id] = {
        ...STATE[id],
        status: "downloading",
        downloadedBytes: got,
        totalBytes: totalBytes || got,
        speedBps,
        etaSeconds,
      };
      notify();
      lastReport = now;
      lastReportBytes = got;
    }
  }

  out.end();
  await new Promise((res) => out.on("close", res));

  if (aborted) {
    try {
      await unlink(tmpPath);
    } catch {}
    STATE[id] = { ...STATE[id], status: "missing", downloadedBytes: 0 };
    notify();
    return;
  }

  if (PAUSE_REQ.has(id)) {
    STATE[id] = { ...STATE[id], status: "missing" }; // resumable; user clicks Resume
    notify();
    return;
  }

  // Optional integrity check
  if (spec.sha256) {
    STATE[id] = { ...STATE[id], status: "verifying" };
    notify();
    const hash = await sha256File(tmpPath);
    if (hash !== spec.sha256) {
      try {
        await unlink(tmpPath);
      } catch {}
      STATE[id] = { ...STATE[id], status: "error", error: `SHA256 mismatch (got ${hash})` };
      notify();
      return;
    }
  }

  // Atomic rename .part → final
  await rename(tmpPath, finalPath);
  STATE[id] = {
    ...STATE[id],
    status: "ready",
    downloadedBytes: got,
    totalBytes: got,
  };
  notify();
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  return new Promise((res, rej) => {
    createReadStream(path)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}
