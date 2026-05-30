// Auto-update integration via electron-updater (talks to GitHub Releases).
//
// IMPORTANT: macOS code-signing constraint
//   electron-updater's "restart-to-install" flow uses Squirrel.Mac, which
//   requires a code-signed and notarized .app. While Bitrove is unsigned, the
//   user lifecycle is:
//     1. App checks for updates on startup (and on demand)
//     2. App auto-downloads the new DMG when one is available
//     3. App tells the UI "ready" and on user confirmation:
//          - signed:   autoUpdater.quitAndInstall()  ← real auto-install
//          - unsigned: open the downloaded DMG in Finder, ask user to
//                      drag-replace the app in /Applications.
//   Once you ship a signed build, flip QUIT_AND_INSTALL_AVAILABLE to true
//   and the UI continues to work without changes.

// electron-updater is published as CJS only; we use the default-export form
// to keep ESM/CJS interop predictable across electron-vite + esbuild output.
// electron-updater is pure CJS; in packaged Electron ESM the default-import
// interop sometimes fails to expose the named exports. Pulling it through
// createRequire is the most portable option.
import { createRequire } from "node:module";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import { app, shell } from "electron";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const { autoUpdater } = require_("electron-updater") as {
  autoUpdater: {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowDowngrade: boolean;
    allowPrerelease: boolean;
    logger: unknown;
    on: (event: string, fn: (...args: unknown[]) => void) => void;
    checkForUpdates: () => Promise<unknown>;
    downloadUpdate: () => Promise<unknown>;
    quitAndInstall: () => void;
  };
};

// Packaged Electron apps don't surface console.log to a place a user can
// find; write everything to a known file under userData/logs/. Resolve the
// path lazily because app.getPath('userData') is not reliable before
// `whenReady` fires (and updater.ts is imported much earlier).
let LOG_FILE_PATH: string | null = null;
function logFilePath(): string {
  if (LOG_FILE_PATH) return LOG_FILE_PATH;
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    LOG_FILE_PATH = join(dir, "updater.log");
  } catch {
    // Fall back to /tmp so we at least see something during early boot errors.
    LOG_FILE_PATH = "/tmp/bitrove-updater.log";
  }
  return LOG_FILE_PATH;
}

function logLine(level: string, args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `[${new Date().toISOString()}] ${level} ${msg}\n`;
  try {
    appendFileSync(logFilePath(), line);
  } catch {}
  if (!app.isPackaged) console.log(line.trim());
}

const FILE_LOGGER = {
  info: (...a: unknown[]) => logLine("INFO ", a),
  warn: (...a: unknown[]) => logLine("WARN ", a),
  error: (...a: unknown[]) => logLine("ERROR", a),
  debug: (...a: unknown[]) => logLine("DEBUG", a),
};

// Squirrel.Mac (electron-updater's backend) works on unsigned builds —
// it just extracts the downloaded ZIP next to the running app and swaps
// the bundle on quit. We keep this on so the in-app "Install update"
// button does the right thing; once we add Developer ID signing later,
// the same path becomes Gatekeeper-clean automatically.
const QUIT_AND_INSTALL_AVAILABLE = true;

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date"; checkedAt: number; currentVersion: string }
  | { phase: "available"; info: UpdateInfoLite }
  | { phase: "downloading"; info: UpdateInfoLite; percent: number; bytesPerSecond?: number; transferred?: number; total?: number }
  | { phase: "ready"; info: UpdateInfoLite; downloadedFile?: string; canQuitAndInstall: boolean }
  | { phase: "error"; message: string };

export type UpdateInfoLite = {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
};

let state: UpdaterState = { phase: "idle" };
let listeners: Array<(s: UpdaterState) => void> = [];
let downloadedFilePath: string | null = null;

function notify() {
  for (const l of listeners) l(state);
}

function lite(info: UpdateInfo): UpdateInfoLite {
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes:
      typeof info.releaseNotes === "string"
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note ?? "").join("\n")
          : null,
  };
}

export function initUpdater(): void {
  FILE_LOGGER.info("initUpdater() called");
  // Lighter behaviour: we drive the lifecycle by hand so the UI can show
  // explicit confirm-before-download dialogs.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = QUIT_AND_INSTALL_AVAILABLE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = FILE_LOGGER;

  autoUpdater.on("checking-for-update", () => {
    state = { phase: "checking" };
    notify();
  });
  autoUpdater.on("update-available", (info) => {
    state = { phase: "available", info: lite(info) };
    notify();
  });
  autoUpdater.on("update-not-available", (info) => {
    state = {
      phase: "up-to-date",
      checkedAt: Date.now(),
      currentVersion: info?.version ?? "",
    };
    notify();
  });
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    if (state.phase !== "downloading" && state.phase !== "available") return;
    const info = state.phase === "downloading" ? state.info : state.info;
    state = {
      phase: "downloading",
      info,
      percent: p.percent ?? 0,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    };
    notify();
  });
  autoUpdater.on("update-downloaded", (info) => {
    downloadedFilePath = (info as unknown as { downloadedFile?: string }).downloadedFile ?? null;
    state = {
      phase: "ready",
      info: lite(info),
      downloadedFile: downloadedFilePath ?? undefined,
      canQuitAndInstall: QUIT_AND_INSTALL_AVAILABLE,
    };
    notify();
  });
  autoUpdater.on("error", (err) => {
    state = { phase: "error", message: err?.message ?? String(err) };
    notify();
  });
}

export function subscribeUpdater(fn: (s: UpdaterState) => void): () => void {
  listeners.push(fn);
  fn(state);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

export function getUpdaterState(): UpdaterState {
  return state;
}

// ── User-facing actions ─────────────────────────────────────
export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    state = { phase: "error", message: (e as Error).message };
    notify();
  }
}

export async function downloadUpdate(): Promise<void> {
  if (state.phase !== "available") return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    state = { phase: "error", message: (e as Error).message };
    notify();
  }
}

// "Install" — branches on whether quit-and-install is safe (signed build).
// On unsigned builds we reveal the downloaded DMG in Finder so the user can
// drag-and-replace manually.
export async function installUpdate(): Promise<{ method: "quitAndInstall" | "revealFile" | "noop" }> {
  if (state.phase !== "ready") return { method: "noop" };
  if (QUIT_AND_INSTALL_AVAILABLE) {
    autoUpdater.quitAndInstall();
    return { method: "quitAndInstall" };
  }
  if (downloadedFilePath && existsSync(downloadedFilePath)) {
    shell.showItemInFolder(downloadedFilePath);
    return { method: "revealFile" };
  }
  // Fallback: open the GitHub releases page so the user can grab the DMG.
  const repoUrl = (autoUpdater as unknown as { getFeedURL?: () => string }).getFeedURL?.();
  if (repoUrl) {
    await shell.openExternal(repoUrl);
    return { method: "revealFile" };
  }
  return { method: "noop" };
}
