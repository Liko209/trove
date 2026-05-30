// 进程内 job 注册表 — 用于追踪批量 ingest 任务的进度，供 SSE 订阅
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type JobEvent =
  | { type: "started"; total: number }
  | { type: "item"; done: number; total: number; current: string; status: "ingested" | "skipped-cached" | "skipped-unsupported" | "error"; error?: string }
  | { type: "done"; done: number; total: number; ingested: number; errors: number; ms: number }
  | { type: "stopped"; done: number; total: number; ingested: number; errors: number; ms: number }
  | { type: "failed"; error: string };

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
};

const STATES = new Map<string, JobState>();
const EMITTERS = new Map<string, EventEmitter>();
const STOP_REQUESTS = new Set<string>();

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
  return state;
}

export function getJob(id: string): JobState | undefined {
  return STATES.get(id);
}

export function listJobs(limit = 20): JobState[] {
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
    if (ev.status === "error") state.errors++;
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
    STOP_REQUESTS.delete(id);
  }
  EMITTERS.get(id)?.emit("event", ev);
}

export function subscribe(id: string, fn: (ev: JobEvent) => void): () => void {
  const em = EMITTERS.get(id);
  if (!em) return () => {};
  em.on("event", fn);
  return () => em.off("event", fn);
}
