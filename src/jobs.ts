// 进程内 job 注册表 — 用于追踪批量 ingest 任务的进度，供 SSE 订阅
//
// Persistence: job *state* (counts, status, timestamps) is mirrored to
// disk as JSON so that admin restarts don't erase the user's recent
// activity history — they wouldn't otherwise have any way back to a
// scan that failed before they could read the error. Live SSE
// subscriptions (EMITTERS) remain in-memory only; a restarted admin
// just shows the persisted terminal state.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type JobEvent =
  | { type: "started"; total: number }
  | { type: "item"; done: number; total: number; current: string; status: "ingested" | "skipped-cached" | "skipped-unsupported" | "error"; error?: string }
  | { type: "done"; done: number; total: number; ingested: number; errors: number; ms: number }
  | { type: "stopped"; done: number; total: number; ingested: number; errors: number; ms: number }
  | { type: "failed"; error: string };

export type JobErrorRecord = {
  ts: number;
  path: string;
  error: string;
};

export type JobState = {
  id: string;
  kind: "ingest" | "scan";
  status: "queued" | "running" | "done" | "failed" | "stopped";
  total: number;
  done: number;
  ingested: number;
  errors: number;
  current: string;
  startedAt: number;
  finishedAt?: number;
  description: string;
  // Bounded per-job error log. Successful items are NOT persisted
  // (they're too noisy + recoverable via the chunks table), but
  // errors are the whole reason a user opens a finished job, so we
  // keep up to ERROR_HISTORY_CAP of them inline.
  errorEvents?: JobErrorRecord[];
  // Top-level failure message for jobs that died before processing
  // any individual file (permission denied at root, etc).
  fatalError?: string;
};

const ERROR_HISTORY_CAP = 500;

const STATES = new Map<string, JobState>();
const EMITTERS = new Map<string, EventEmitter>();
const STOP_REQUESTS = new Set<string>();

// Max jobs persisted; older ones get pruned. Keeps the file bounded
// regardless of how long Bitrove has been running.
const PERSIST_LIMIT = 100;
let initialized = false;

function jobsFilePath(): string {
  const root = process.env.BITROVE_USER_DATA;
  if (root) return join(root, "jobs.json");
  return resolve(process.cwd(), "data", "jobs.json");
}

// Load any persisted jobs on first access. Anything we find in
// "running" or "queued" state from a previous run is necessarily
// dead — admin crashed or was killed mid-run — so we mark it
// failed with a clear message. The user can re-run the scan; the
// new (mtime,size,hash) skip logic means already-indexed files
// won't be re-embedded.
function initOnce(): void {
  if (initialized) return;
  initialized = true;
  const p = jobsFilePath();
  if (!existsSync(p)) return;
  try {
    const raw = readFileSync(p, "utf8");
    const arr = JSON.parse(raw) as JobState[];
    if (!Array.isArray(arr)) return;
    for (const j of arr) {
      if (j.status === "running" || j.status === "queued") {
        j.status = "failed";
        j.finishedAt = j.finishedAt ?? Date.now();
        // Re-tag the current file so the UI knows what to say.
        if (!j.current) j.current = "(admin restarted before this run completed)";
      }
      STATES.set(j.id, j);
    }
  } catch (e) {
    console.warn("[jobs] failed to load persisted jobs:", (e as Error).message);
  }
}

// Snapshot the current registry to disk. Debounced so a burst of
// per-item updates doesn't hammer the FS.
let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 250);
}
function persistNow(): void {
  const all = [...STATES.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, PERSIST_LIMIT);
  // Prune in-memory map at the same time so we don't grow without bound
  // either.
  if (all.length < STATES.size) {
    STATES.clear();
    for (const j of all) STATES.set(j.id, j);
  }
  const p = jobsFilePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(all, null, 2));
  } catch (e) {
    console.warn("[jobs] failed to persist:", (e as Error).message);
  }
}

// Co-operative stop: handlers call shouldStop() between items.
// requestStop returns false if job id is unknown or already finished.
export function requestStop(id: string): boolean {
  const s = STATES.get(id);
  if (!s) return false;
  if (s.status !== "running" && s.status !== "queued") return false;
  STOP_REQUESTS.add(id);
  return true;
}

export function shouldStop(id: string): boolean {
  return STOP_REQUESTS.has(id);
}

export function createJob(kind: JobState["kind"], description: string): JobState {
  initOnce();
  const id = randomUUID();
  const state: JobState = {
    id,
    kind,
    status: "queued",
    total: 0,
    done: 0,
    ingested: 0,
    errors: 0,
    current: "",
    startedAt: Date.now(),
    description,
  };
  STATES.set(id, state);
  EMITTERS.set(id, new EventEmitter());
  scheduleSave();
  return state;
}

export function getJob(id: string): JobState | undefined {
  initOnce();
  return STATES.get(id);
}

export function listJobs(limit = 20): JobState[] {
  initOnce();
  return [...STATES.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export function emitJob(id: string, ev: JobEvent): void {
  const state = STATES.get(id);
  if (!state) return;
  // 同步更新 state 以便后续 GET 拿到最新
  if (ev.type === "started") {
    state.status = "running";
    state.total = ev.total;
  } else if (ev.type === "item") {
    state.done = ev.done;
    state.total = ev.total;
    state.current = ev.current;
    if (ev.status === "ingested") state.ingested++;
    if (ev.status === "error") {
      state.errors++;
      // Capture per-error context so a user opening the finished
      // job later can see *why* failures happened, not just how
      // many. Bounded so a million-file disaster doesn't blow up
      // the persisted JSON.
      if (!state.errorEvents) state.errorEvents = [];
      if (state.errorEvents.length < ERROR_HISTORY_CAP) {
        state.errorEvents.push({
          ts: Date.now(),
          path: ev.current,
          error: ev.error ?? "(no error message)",
        });
        // Persist immediately on error events too — these are
        // user-visible and irreplaceable. Done-event debounce is
        // still 250 ms but errors override that.
        scheduleSave();
      }
    }
  } else if (ev.type === "done") {
    state.status = "done";
    state.done = ev.done;
    state.total = ev.total;
    state.ingested = ev.ingested;
    state.errors = ev.errors;
    state.finishedAt = Date.now();
    STOP_REQUESTS.delete(id);
  } else if (ev.type === "stopped") {
    state.status = "stopped";
    state.done = ev.done;
    state.total = ev.total;
    state.ingested = ev.ingested;
    state.errors = ev.errors;
    state.finishedAt = Date.now();
    STOP_REQUESTS.delete(id);
  } else if (ev.type === "failed") {
    state.status = "failed";
    state.finishedAt = Date.now();
    state.fatalError = ev.error;
    STOP_REQUESTS.delete(id);
  }
  EMITTERS.get(id)?.emit("event", ev);
  // Only persist on terminal transitions + when a job starts. Per-item
  // ticks are too noisy and ephemeral to justify the IO cost.
  if (
    ev.type === "started" ||
    ev.type === "done" ||
    ev.type === "stopped" ||
    ev.type === "failed"
  ) {
    scheduleSave();
  }
}

export function subscribe(id: string, fn: (ev: JobEvent) => void): () => void {
  const em = EMITTERS.get(id);
  if (!em) return () => {};
  em.on("event", fn);
  return () => em.off("event", fn);
}
