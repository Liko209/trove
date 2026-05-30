// Manage three child processes:
//   - admin server (Node, port 8770)
//   - llama-server embedding (port 8765)
//   - llama-server reranker (port 8766)
//
// All bound to 127.0.0.1. Health-checked on startup. Killed on app quit.

import { spawn, ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { app } from "electron";
import {
  adminEntry,
  llamaServerBinary,
  modelsDir,
  dbPath,
  uiDistDir,
  summary,
} from "./paths.ts";

// File-based logger so we can see what happens in packaged mode where
// console.log is silently dropped.
let LOG_FILE: string | null = null;
function logPath(): string {
  if (LOG_FILE) return LOG_FILE;
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    LOG_FILE = join(dir, "services.log");
  } catch {
    LOG_FILE = "/tmp/bitrove-services.log";
  }
  return LOG_FILE;
}
function svcLog(name: string, msg: string) {
  const line = `[${new Date().toISOString()}] [${name}] ${msg}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {}
  if (!app.isPackaged) console.log(line.trimEnd());
}

export type ServiceName = "admin" | "embed" | "rerank";

export type ServiceState = {
  name: ServiceName;
  pid?: number;
  status: "starting" | "running" | "stopped" | "crashed" | "missing-dep";
  port: number;
  detail?: string;
  lastError?: string;
};

const PORTS: Record<ServiceName, number> = {
  admin: 8770,
  embed: 8765,
  rerank: 8766,
};

const MODEL_FILES: Record<"embed" | "rerank", string> = {
  embed: "bge-m3-Q4_K_M.gguf",
  rerank: "bge-reranker-v2-m3-Q4_K_M.gguf",
};

const STATE: Record<ServiceName, ServiceState> = {
  admin: { name: "admin", port: PORTS.admin, status: "stopped" },
  embed: { name: "embed", port: PORTS.embed, status: "stopped" },
  rerank: { name: "rerank", port: PORTS.rerank, status: "stopped" },
};

const PROCS: Partial<Record<ServiceName, ChildProcess>> = {};

let listeners: Array<(s: Record<ServiceName, ServiceState>) => void> = [];

function notify() {
  for (const l of listeners) l({ ...STATE });
}

export function subscribe(fn: (s: Record<ServiceName, ServiceState>) => void): () => void {
  listeners.push(fn);
  fn({ ...STATE });
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function getStates(): Record<ServiceName, ServiceState> {
  return { ...STATE };
}

async function healthCheck(port: number, path = "/health", timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(
  name: ServiceName,
  port: number,
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(port, path)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function startAdmin(): Promise<void> {
  STATE.admin.status = "starting";
  notify();

  const { command, args, cwd } = adminEntry();
  const dataDir = join(cwd, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORTS.admin),
    EMBED_URL: `http://127.0.0.1:${PORTS.embed}`,
    RERANK_URL: `http://127.0.0.1:${PORTS.rerank}`,
    KB_DB: dbPath(),
    // admin's __dirname / "../ui/dist" resolution doesn't work in packaged
    // mode because Resources/app/admin/index.mjs is far from the UI bundle
    // (Resources/app/ui-dist/). Tell it explicitly.
    BITROVE_UI_DIST: uiDistDir(),
  };

  // In packaged mode the admin entry runs inside Electron's bundled Node;
  // tell that runtime where to find native modules (better-sqlite3 + sqlite-vec
  // were rebuilt for Electron and live in app.asar.unpacked/node_modules).
  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = "1";
    const unpackedModules = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
    );
    env.NODE_PATH = process.env.NODE_PATH
      ? `${process.env.NODE_PATH}:${unpackedModules}`
      : unpackedModules;
  }

  svcLog("admin", `spawn: ${command} ${args.join(" ")} (cwd=${cwd})`);
  svcLog("admin", `env.PORT=${env.PORT} ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE ?? "(unset)"}`);
  svcLog("admin", `env.NODE_PATH=${env.NODE_PATH ?? "(unset)"}`);

  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  PROCS.admin = child;
  STATE.admin.pid = child.pid;
  svcLog("admin", `child pid=${child.pid}`);

  child.stdout?.on("data", (b) => svcLog("admin", `stdout: ${b.toString().trimEnd()}`));
  child.stderr?.on("data", (b) => svcLog("admin", `stderr: ${b.toString().trimEnd()}`));
  child.on("error", (e) => {
    svcLog("admin", `spawn ERROR: ${e.message}`);
    STATE.admin.status = "crashed";
    STATE.admin.detail = e.message;
    notify();
  });
  child.on("exit", (code, signal) => {
    svcLog("admin", `exit code=${code} signal=${signal}`);
    STATE.admin.status = code === 0 ? "stopped" : "crashed";
    STATE.admin.detail = `exit ${code}`;
    notify();
  });

  const healthy = await waitForHealthy("admin", PORTS.admin, "/api/health", 15000);
  STATE.admin.status = healthy ? "running" : "crashed";
  STATE.admin.detail = healthy ? "OK" : "no /api/health after 15s";
  notify();
}

export async function startLlama(name: "embed" | "rerank"): Promise<void> {
  STATE[name].status = "starting";
  notify();

  const binary = llamaServerBinary();
  const modelFile = join(modelsDir(), MODEL_FILES[name]);
  if (!existsSync(modelFile)) {
    STATE[name].status = "missing-dep";
    STATE[name].detail = `model not found: ${modelFile}`;
    notify();
    return;
  }
  if (!existsSync(binary) && binary !== "llama-server") {
    STATE[name].status = "missing-dep";
    STATE[name].detail = `binary not found: ${binary}`;
    notify();
    return;
  }

  const commonArgs = [
    "-m", modelFile,
    "--port", String(PORTS[name]),
    "--host", "127.0.0.1",
    "-c", "8192",
    "--batch-size", "8192",
    "--ubatch-size", "8192",
    "--log-disable",
  ];
  const specificArgs = name === "embed"
    ? ["--embedding", "--pooling", "cls"]
    : ["--reranking"];

  svcLog(name, `spawn ${binary} (model=${modelFile})`);
  const child = spawn(binary, [...commonArgs, ...specificArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  PROCS[name] = child;
  STATE[name].pid = child.pid;
  svcLog(name, `child pid=${child.pid}`);

  child.stdout?.on("data", (b) => svcLog(name, `stdout: ${b.toString().trimEnd()}`));
  child.stderr?.on("data", (b) => svcLog(name, `stderr: ${b.toString().trimEnd()}`));
  child.on("error", (e) => {
    svcLog(name, `spawn ERROR: ${e.message}`);
    STATE[name].status = "crashed";
    STATE[name].detail = e.message;
    notify();
  });
  child.on("exit", (code, signal) => {
    svcLog(name, `exit code=${code} signal=${signal}`);
    STATE[name].status = code === 0 ? "stopped" : "crashed";
    STATE[name].detail = `exit ${code}`;
    notify();
  });

  const healthy = await waitForHealthy(name, PORTS[name], "/health", 30000);
  STATE[name].status = healthy ? "running" : "crashed";
  STATE[name].detail = healthy ? "OK" : "no /health after 30s";
  notify();
}

export async function startAll(): Promise<void> {
  console.log("starting services...");
  console.log("  " + summary().replace(/\n/g, "\n  "));
  // llama-servers can warm up in parallel
  const llamaP = Promise.all([startLlama("embed"), startLlama("rerank")]);
  // admin server doesn't depend on them at boot (it probes per-request)
  await startAdmin();
  await llamaP;
  console.log("services started:", getStates());
}

export function stopAll(): Promise<void> {
  return new Promise((resolve) => {
    const procs = Object.entries(PROCS).filter(([, p]) => p && !p.killed);
    if (procs.length === 0) return resolve();

    let pending = procs.length;
    const done = () => {
      pending--;
      if (pending <= 0) resolve();
    };

    // SIGTERM first, then SIGKILL after 5s
    for (const [name, p] of procs) {
      if (!p) {
        done();
        continue;
      }
      p.once("exit", done);
      try {
        p.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (!p.killed) {
          try {
            p.kill("SIGKILL");
          } catch {}
        }
      }, 5000);
    }

    // Hard cap: don't block app quit longer than 7s
    setTimeout(() => resolve(), 7000);
  });
}

export function adminURL(): string {
  return `http://127.0.0.1:${PORTS.admin}`;
}
