// Simple scheduler for deferred ingest tasks. Built for the "I want
// this big scan to run overnight" case — the user picks "Tonight at
// 1 AM" in the scan-confirm flow, we persist the task, and an admin
// tick fires it at the wall-clock time.
//
// Persistence: {BITROVE_USER_DATA}/scheduled.json. Resumed on admin
// boot so app restart / OS reboot don't lose the queue.
//
// Resolution: 30s tick is plenty for human-scale scheduling. We don't
// aim for second-precision.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ScheduledKind = "scan" | "ingest-files";
export type ScheduledTask = {
  id: string;
  kind: ScheduledKind;
  runAt: number; // ms epoch
  createdAt: number;
  // Free-form params handed to the matching admin handler at fire time.
  params: {
    root?: string;
    paths?: string[];
    watchAfterScan?: boolean;
    excludes?: string[];
    extraIncludeExts?: string[];
    force?: boolean;
    description?: string;
  };
};

const TASKS = new Map<string, ScheduledTask>();
let tickTimer: NodeJS.Timeout | null = null;
let runner: ((t: ScheduledTask) => Promise<void>) | null = null;

function filePath(): string {
  const root = process.env.BITROVE_USER_DATA;
  if (root) return join(root, "scheduled.json");
  return resolve(process.cwd(), "data", "scheduled.json");
}

function persist(): void {
  const p = filePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify([...TASKS.values()], null, 2));
  } catch (e) {
    console.warn("[scheduler] persist failed:", (e as Error).message);
  }
}

function loadFromDisk(): void {
  const p = filePath();
  if (!existsSync(p)) return;
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as ScheduledTask[];
    for (const t of arr) TASKS.set(t.id, t);
  } catch (e) {
    console.warn("[scheduler] load failed:", (e as Error).message);
  }
}

export function initScheduler(
  runFn: (t: ScheduledTask) => Promise<void>,
): void {
  runner = runFn;
  loadFromDisk();
  // Run any tasks that came due while admin was down.
  void tick();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => void tick(), 30_000);
}

async function tick(): Promise<void> {
  if (!runner) return;
  const now = Date.now();
  const due: ScheduledTask[] = [];
  for (const t of TASKS.values()) {
    if (t.runAt <= now) due.push(t);
  }
  for (const t of due) {
    TASKS.delete(t.id);
    persist();
    try {
      await runner(t);
    } catch (e) {
      console.error(`[scheduler] task ${t.id} failed:`, (e as Error).message);
    }
  }
}

export function scheduleTask(args: {
  kind: ScheduledKind;
  runAt: number;
  params: ScheduledTask["params"];
}): ScheduledTask {
  const task: ScheduledTask = {
    id: randomUUID(),
    kind: args.kind,
    runAt: args.runAt,
    createdAt: Date.now(),
    params: args.params,
  };
  TASKS.set(task.id, task);
  persist();
  return task;
}

export function listScheduled(): ScheduledTask[] {
  return [...TASKS.values()].sort((a, b) => a.runAt - b.runAt);
}

export function cancelScheduled(id: string): boolean {
  const ok = TASKS.delete(id);
  if (ok) persist();
  return ok;
}

// Convenience: next 1 AM local time (rolls over if it's already past 1).
export function nextAt1AM(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(1, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
