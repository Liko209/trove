// First-run / missing-resource detection + remediation.
//
// Why this exists: services.ts will set status=missing-dep if a model file
// is absent, but that gives the user a bad experience (they see a crashed
// service in the dashboard with no guidance). Instead the main process
// runs setup checks BEFORE starting services and routes the BrowserWindow
// to an onboarding URL when something is missing.

import { existsSync, statSync, readFileSync, createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { app } from "electron";
import { modelsDir } from "./paths.ts";

export type ModelSpec = {
  id: "embed" | "rerank";
  filename: string;
  displayName: string;
  url: string;
  // SHA256 left empty for now; can be filled from HF API. v1 trusts HTTPS.
  sha256?: string;
  approxBytes: number;
  // Embed-only: vector dim + pooling strategy + whether the model expects
  // an "Instruct: ... \nQuery: ..." prefix on query-side embeds.
  dim?: number;
  pooling?: "cls" | "last";
  needsInstruct?: boolean;
};

// ── Model tiers ───────────────────────────────────────────────
// Four embed-model tiers; reranker is fixed across all tiers (bge-
// reranker-v2-m3 is small, stable, and benchmarks within ~2pt of
// every Qwen-Reranker we tested — not worth doubling RAM for).
//
// Tier dim mapping is load-bearing — when a user switches between
// tiers with different dims, db.ts has to drop+recreate chunk_vecs
// and the user has to re-ingest. Light/Standard share 1024 so the
// bge-m3 → Qwen-0.6B move only requires re-embed, not schema rebuild.
//
// All Qwen URLs use the official Qwen GGUF repos on HuggingFace.
// Update the URLs / sha256 as new quants land.

export type Tier = "light" | "standard" | "quality" | "max";

export type TierSpec = {
  id: Tier;
  label: string;
  blurb: string;
  recommendedRamGB: number; // minimum healthy
  estDocsPerSec: number;    // very rough; for time estimates in UI
  embed: ModelSpec;
};

const RERANKER_SPEC: ModelSpec = {
  id: "rerank",
  filename: "bge-reranker-v2-m3-Q4_K_M.gguf",
  displayName: "bge-reranker-v2-m3 (relevance reranker)",
  url: "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf?download=true",
  approxBytes: 438_000_000,
};

export const TIERS: TierSpec[] = [
  {
    id: "light",
    label: "Light",
    blurb: "bge-m3 — battle-tested multilingual baseline. Best for 8 GB Macs.",
    recommendedRamGB: 8,
    estDocsPerSec: 10,
    embed: {
      id: "embed",
      filename: "bge-m3-Q4_K_M.gguf",
      displayName: "bge-m3 (multilingual embeddings)",
      url: "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf?download=true",
      approxBytes: 437_000_000,
      dim: 1024,
      pooling: "cls",
      needsInstruct: false,
    },
  },
  {
    id: "standard",
    label: "Standard",
    blurb: "Qwen3-Embedding-0.6B — same footprint as Light but newer architecture, 32K context.",
    recommendedRamGB: 12,
    estDocsPerSec: 8,
    embed: {
      id: "embed",
      filename: "Qwen3-Embedding-0.6B-Q4_K_M.gguf",
      displayName: "Qwen3-Embedding-0.6B",
      url: "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q4_K_M.gguf?download=true",
      approxBytes: 600_000_000,
      dim: 1024,
      pooling: "last",
      needsInstruct: true,
    },
  },
  {
    id: "quality",
    label: "Quality",
    blurb: "Qwen3-Embedding-4B — best balance of retrieval quality + speed on 16 GB+ Macs.",
    recommendedRamGB: 16,
    estDocsPerSec: 3,
    embed: {
      id: "embed",
      filename: "Qwen3-Embedding-4B-Q4_K_M.gguf",
      displayName: "Qwen3-Embedding-4B",
      url: "https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/main/Qwen3-Embedding-4B-Q4_K_M.gguf?download=true",
      approxBytes: 2_400_000_000,
      dim: 2560,
      pooling: "last",
      needsInstruct: true,
    },
  },
  {
    id: "max",
    label: "Max",
    blurb: "Qwen3-Embedding-8B — top of MTEB. Only worth it on 32 GB+ Pro/Max.",
    recommendedRamGB: 32,
    estDocsPerSec: 1.5,
    embed: {
      id: "embed",
      filename: "Qwen3-Embedding-8B-Q4_K_M.gguf",
      displayName: "Qwen3-Embedding-8B",
      url: "https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q4_K_M.gguf?download=true",
      approxBytes: 6_000_000_000,
      dim: 4096,
      pooling: "last",
      needsInstruct: true,
    },
  },
];

export function tierById(id: Tier): TierSpec {
  return TIERS.find((t) => t.id === id) ?? TIERS[0];
}

// Suggest the tier most appropriate for the user's hardware. The
// rule is intentionally conservative — better to recommend a smaller
// model and let the user opt up than to drop them into a 6 GB
// download that swaps their laptop.
export function recommendTier(totalRamGB: number): Tier {
  if (totalRamGB >= 32) return "quality"; // not "max" — most users don't need it
  if (totalRamGB >= 16) return "quality";
  if (totalRamGB >= 12) return "standard";
  return "light";
}

// Backward-compat shim: legacy code (setup ensureReady, services
// spawnLlama) iterates MODELS as if it were a fixed [embed, rerank].
// Default to Light tier; P1.5/P1.6 will replace these call sites with
// `activeTierSpec().embed` so the active tier drives the model used.
export const MODELS: ModelSpec[] = [TIERS[0].embed, RERANKER_SPEC];

export { RERANKER_SPEC };

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

// activeSpecs() reads the current tier choice from ingest-settings.json
// and returns the matching [embed, reranker] pair. This is the
// load-bearing fix for "first launch after picking Quality keeps
// bouncing me back to onboarding" — `MODELS` is always Light, so any
// check that iterates MODELS will report the active tier's embed file
// as missing even right after the user just downloaded it.
function readActiveTierFromDisk(): Tier {
  try {
    const userData = app.getPath("userData");
    const p = join(userData, "ingest-settings.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (raw.activeModelTier && tierById(raw.activeModelTier as Tier)) {
        return raw.activeModelTier as Tier;
      }
    }
  } catch {}
  return "light";
}
function activeSpecs(): [ModelSpec, ModelSpec] {
  return [tierById(readActiveTierFromDisk()).embed, RERANKER_SPEC];
}

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
  // Iterate the ACTIVE tier's specs, not the legacy MODELS constant,
  // so a user who chose e.g. Quality sees Qwen3-Embedding-4B's
  // readiness instead of bge-m3's.
  const specs = activeSpecs();
  for (const m of specs) {
    const full = join(dir, m.filename);
    // Refresh the display name + filename in STATE too so the
    // onboarding UI / progress widgets don't show "bge-m3" when the
    // active tier is Standard / Quality / Max.
    STATE[m.id] = { ...STATE[m.id], filename: m.filename, displayName: m.displayName };
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
  return activeSpecs().every((m) => STATE[m.id].status === "ready");
}

export function pauseDownload(id: ModelSpec["id"]): void {
  PAUSE_REQ.add(id);
}

export function cancelDownload(id: ModelSpec["id"]): void {
  CANCEL_REQ.add(id);
}

// Download a specific spec (used by tier-switch flow). Tier-aware
// callers should use this directly; downloadModel(id) is preserved
// for the legacy IPC that just expects "embed"/"rerank".
export async function downloadSpec(spec: ModelSpec): Promise<void> {
  return downloadModelInternal(spec);
}

export async function downloadModel(id: ModelSpec["id"]): Promise<void> {
  const spec = MODELS.find((m) => m.id === id)!;
  return downloadModelInternal(spec);
}

async function downloadModelInternal(spec: ModelSpec): Promise<void> {
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
