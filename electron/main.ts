// Bitrove main process.
//
// Lifecycle:
//   1. Single-instance lock
//   2. Check resources (models, binaries). If missing → load /setup view
//      (a built-in HTML file served by the renderer). Once user finishes
//      setup (downloads models, picks folders), main wakes services.
//   3. Else spawn admin + llama-servers, load admin URL.
//   4. Graceful shutdown of children on quit.

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

// Electron uses the package.json `name` field for userData by default, which
// gives us ~/Library/Application Support/local-kb-demo. We want
// ~/Library/Application Support/Bitrove. Setting the app name before app.ready
// fires moves all path lookups to use it.
app.setName("Bitrove");

// One-time migration: this app shipped as "Trove" for v0.0.1–v0.0.3 before
// the bitrove.ai domain was registered. Move the user's models, index,
// logs and config out of ~/Library/Application Support/Trove/ into the
// new Bitrove root so those users don't have to re-download 870 MB.
import { homedir } from "node:os";
import { renameSync, existsSync } from "node:fs";
function migrateFromTrove() {
  try {
    const oldDir = join(homedir(), "Library", "Application Support", "Trove");
    const newDir = join(homedir(), "Library", "Application Support", "Bitrove");
    if (existsSync(oldDir) && !existsSync(newDir)) {
      renameSync(oldDir, newDir);
      bootLog(`migrated ${oldDir} → ${newDir}`);
    }
  } catch (err) {
    bootLog(`Trove → Bitrove migration skipped: ${(err as Error).message}`);
  }
}
migrateFromTrove();

// Boot trace so we can see in packaged mode how far main process got.
function bootLog(msg: string) {
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "boot.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {
    try {
      appendFileSync("/tmp/bitrove-boot.log", `[${new Date().toISOString()}] FALLBACK ${msg}\n`);
    } catch {}
  }
}
bootLog("main.ts module loaded");
import {
  startAll,
  stopAll,
  adminURL,
  subscribe,
  getStates,
} from "./services.ts";
import {
  MODELS,
  allModelsReady,
  refreshModelStatuses,
  getModelStatuses,
  subscribeModels,
  downloadModel,
  pauseDownload,
  cancelDownload,
} from "./setup.ts";
import { readConfig, writeConfig, autodetectSources } from "./config.ts";

// Updater is imported lazily so a CJS interop issue inside electron-updater
// can't take down the whole main bundle on load. We surface the same
// surface area via a small adapter that no-ops until init succeeds.
type UpdaterModule = typeof import("./updater.ts");
let updater: UpdaterModule | null = null;
async function loadUpdater(): Promise<UpdaterModule | null> {
  if (updater) return updater;
  try {
    updater = await import("./updater.ts");
    bootLog("updater module loaded lazily");
    return updater;
  } catch (e) {
    bootLog(`updater load FAILED: ${(e as Error).message}`);
    return null;
  }
}

const isDev = !app.isPackaged;

// ── Single-instance lock ──────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let servicesStarted = false;

function focusMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("second-instance", () => focusMain());

// ── IPC: native dialogs ───────────────────────────────────
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose a folder to index",
  });
  return r.canceled ? null : r.filePaths[0];
});

// Multi-select file picker. Returns metadata for each file so the UI can
// show kind/size and warn about extensions on the user's exclude list
// without a separate round-trip.
ipcMain.handle("dialog:pickFiles", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    title: "Choose files to index",
  });
  if (r.canceled || r.filePaths.length === 0) return [];
  const { stat } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const out: { path: string; name: string; ext: string; size: number }[] = [];
  for (const p of r.filePaths) {
    try {
      const s = await stat(p);
      out.push({
        path: p,
        name: p.slice(p.lastIndexOf("/") + 1),
        ext: extname(p).toLowerCase(),
        size: s.size,
      });
    } catch {
      // Unreadable / vanished — skip, the renderer just won't see it.
    }
  }
  return out;
});

ipcMain.handle("services:state", () => getStates());

ipcMain.handle("shell:openExternal", async (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle("shell:openInFinder", async (_e, path: string) => {
  shell.showItemInFolder(path);
});

// ── IPC: macOS file-system permission diagnostics ─────────
// Probes each path for read access. macOS's TCC subsystem will silently
// reject Bitrove on Documents / Desktop / Downloads / iCloud Drive if
// the corresponding "Files and Folders" toggle is off — fail there now
// so the UI can guide the user to System Settings instead of leaving
// the scan to stall mid-run.
ipcMain.handle("permissions:checkPath", async (_e, p: string) => {
  const { readdir, stat } = await import("node:fs/promises");
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return { state: "not-directory" };
    await readdir(p);
    return { state: "granted" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EACCES" || err.code === "EPERM")
      return { state: "denied", code: err.code };
    if (err.code === "ENOENT") return { state: "not-found" };
    return { state: "error", message: err.message };
  }
});

ipcMain.handle("permissions:openSettings", async (_e, section?: string) => {
  // System Settings deep-links (macOS 13+).
  const urls: Record<string, string> = {
    documents:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder",
    desktop:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder",
    downloads:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_DownloadsFolder",
    icloud:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_NetworkVolumes",
    fda: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    files:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
    privacy:
      "x-apple.systempreferences:com.apple.preference.security?Privacy",
  };
  const url = (section && urls[section]) || urls.privacy;
  await shell.openExternal(url);
});

// ── IPC: switch model tier ────────────────────────────────
// Single orchestrator the renderer calls after the user confirms a
// tier switch (P1.4 modal). Steps:
//   1. Persist activeModelTier in ingest-settings.json
//   2. Download the new tier's embed GGUF (if not on disk)
//   3. Restart llama-server + admin so the new tier takes effect
//      (llama-server reads tier from settings; admin inherits
//      BITROVE_MODEL_TIER env)
//   4. Trigger a re-ingest of every watched root (db.ts auto-
//      rebuilds chunk_vecs on first openDb call after dim change)
//
// Returns once the model is downloaded + services restarted. The
// re-ingest jobs run async on admin; renderer should navigate to
// /jobs to watch.
ipcMain.handle(
  "setup:switchTier",
  async (_e, tier: "light" | "standard" | "quality" | "max") => {
    const { TIERS, tierById, downloadSpec } = await import("./setup.ts");
    const { restartServices } = await import("./services.ts");
    const { writeFile, readFile, mkdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");

    const target = tierById(tier);
    if (!target) throw new Error(`unknown tier ${tier}`);

    // 1. Persist tier into the same ingest-settings.json the admin
    // and src/embed.ts read. Admin may not be reachable mid-restart,
    // so write directly.
    const userData = app.getPath("userData");
    const settingsPath = join(userData, "ingest-settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(await readFile(settingsPath, "utf8"));
      } catch {}
    }
    settings.activeModelTier = tier;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    // 2. Download model if missing. downloadSpec emits progress to
    // the existing setup:update channel so the modal can show it.
    await downloadSpec(target.embed);

    // 3. Restart services. New llama-server boots against the new
    // model; admin inherits the new BITROVE_MODEL_TIER env.
    await restartServices();

    // 4. Trigger re-ingest: hit admin's scan endpoint for each
    //    watched root. Done over HTTP so we don't have to share
    //    db handles across processes.
    try {
      const res = await fetch("http://127.0.0.1:8770/api/watched-roots");
      const data = (await res.json()) as { rows: { path: string }[] };
      for (const row of data.rows) {
        await fetch("http://127.0.0.1:8770/api/ingest/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: row.path, watchAfterScan: true, force: true }),
        });
      }
    } catch (e) {
      console.warn("[switchTier] failed to trigger re-ingest:", (e as Error).message);
    }

    return { tier, watchedRootsReingested: true };
  },
);

// ── IPC: hardware introspection ───────────────────────────
// Surfaces the user's machine specs to the renderer so Settings →
// Models can recommend the right tier. Cheap (os.* calls), called
// once per Settings open.
ipcMain.handle("system:hardware", async () => {
  const os = await import("node:os");
  return {
    totalRamGB: Math.round(os.totalmem() / 1024 ** 3),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    arch: process.arch,
    cores: os.cpus().length,
    platform: process.platform,
  };
});

// ── IPC: model tiers for onboarding ───────────────────────
// Returns the 4 tiers + currently-recommended tier based on the
// machine's RAM + the active selection (if any). setup.html reads
// this to render the tier picker on first launch.
ipcMain.handle("setup:listTiers", async () => {
  const { TIERS, recommendTier } = await import("./setup.ts");
  const os = await import("node:os");
  const totalRamGB = Math.round(os.totalmem() / 1024 ** 3);
  const recommended = recommendTier(totalRamGB);
  // Read currently-selected tier from settings (Light by default).
  let active: string = "light";
  try {
    const { readFile } = await import("node:fs/promises");
    const settingsPath = join(app.getPath("userData"), "ingest-settings.json");
    const raw = await readFile(settingsPath, "utf8");
    const j = JSON.parse(raw);
    if (j.activeModelTier) active = j.activeModelTier;
  } catch {}
  return {
    tiers: TIERS.map((t) => ({
      id: t.id,
      label: t.label,
      blurb: t.blurb,
      recommendedRamGB: t.recommendedRamGB,
      estDocsPerSec: t.estDocsPerSec,
      embed: {
        displayName: t.embed.displayName,
        approxBytes: t.embed.approxBytes,
        dim: t.embed.dim,
      },
    })),
    recommended,
    active,
    hardware: {
      totalRamGB,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      arch: process.arch,
    },
  };
});

// Persists the chosen tier + kicks off the download chain for that
// tier's embed model + the (fixed) reranker. Progress events stream
// through the existing setup:update channel so the UI can show
// the same bars as the single-model flow used to.
ipcMain.handle(
  "setup:downloadForTier",
  async (_e, tier: "light" | "standard" | "quality" | "max") => {
    const { tierById, RERANKER_SPEC, downloadSpec } = await import("./setup.ts");
    const target = tierById(tier);
    const { writeFile, readFile, mkdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    // 1) Persist tier
    const settingsPath = join(app.getPath("userData"), "ingest-settings.json");
    let s: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { s = JSON.parse(await readFile(settingsPath, "utf8")); } catch {}
    }
    s.activeModelTier = tier;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(s, null, 2));
    // 2) Download embed + reranker (parallel). Sequential awaits are
    //    fine — both emit to setup:update so progress shows correctly.
    await Promise.all([
      downloadSpec(target.embed),
      downloadSpec(RERANKER_SPEC),
    ]);
    return { ok: true };
  },
);

// ── IPC: model setup ──────────────────────────────────────
ipcMain.handle("setup:listModels", () => ({
  catalog: MODELS,
  statuses: getModelStatuses(),
}));
ipcMain.handle("setup:downloadModel", (_e, id: "embed" | "rerank") => {
  // fire-and-forget; renderer subscribes to streams for progress
  downloadModel(id).catch((e) => console.error(`download ${id}:`, e));
  return true;
});
ipcMain.handle("setup:pauseModel", (_e, id: "embed" | "rerank") => {
  pauseDownload(id);
  return true;
});
ipcMain.handle("setup:cancelModel", (_e, id: "embed" | "rerank") => {
  cancelDownload(id);
  return true;
});
ipcMain.handle("setup:isReady", () => allModelsReady());
ipcMain.handle("setup:autodetectSources", () => autodetectSources());
ipcMain.handle("setup:readConfig", () => readConfig());
ipcMain.handle("setup:writeConfig", (_e, partial: unknown) =>
  writeConfig(partial as Record<string, unknown>),
);
// ── IPC: updater ──────────────────────────────────────────
ipcMain.handle("updater:state", async () => {
  const m = await loadUpdater();
  return m?.getUpdaterState() ?? { phase: "idle" };
});
ipcMain.handle("updater:check", async () => {
  const m = await loadUpdater();
  return m?.checkForUpdates();
});
ipcMain.handle("updater:download", async () => {
  const m = await loadUpdater();
  return m?.downloadUpdate();
});
ipcMain.handle("updater:install", async () => {
  const m = await loadUpdater();
  return m?.installUpdate();
});

ipcMain.handle("setup:startServices", async () => {
  if (!servicesStarted && allModelsReady()) {
    servicesStarted = true;
    await startAll();
    await maybeTriggerFirstScan();
    if (mainWindow) await mainWindow.loadURL(adminURL());
  }
  return true;
});

async function maybeTriggerFirstScan() {
  // After onboarding, kick off the first scan in the background so the
  // user sees activity right away when the main UI loads.
  const cfg = await readConfig();
  if (cfg.onboarded || cfg.sources.length === 0) return;
  for (const root of cfg.sources) {
    fetch(`${adminURL()}/api/ingest/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, excludes: cfg.excludes }),
    }).catch((e) => console.error(`first scan ${root}:`, e));
  }
  await writeConfig({ onboarded: true });
}

// ── Window ────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 700,
    title: "Bitrove",
    backgroundColor: "#fafaf9",
    titleBarStyle: "hiddenInset",
    // Park the traffic lights so their vertical center sits at y=24px —
    // matching the nav row's center inside the 48px header. macOS bullets
    // are ~12px tall, so y=18 puts their midline at 24. The 20px x offset
    // mirrors Finder / Mail.
    trafficLightPosition: { x: 20, y: 18 },
    show: false,
    webPreferences: {
      // Preload is emitted as CJS with a .cjs extension to side-step the
      // "type": "module" in package.json.
      preload: join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Push service-state updates to renderer as they change
  const unsubServices = subscribe((states) => {
    mainWindow?.webContents.send("services:update", states);
  });
  const unsubModels = subscribeModels((models) => {
    mainWindow?.webContents.send("setup:update", models);
  });
  // Updater subscription is wired up lazily after the module loads.
  let unsubUpdater = () => {};
  loadUpdater().then((m) => {
    if (m && mainWindow) {
      unsubUpdater = m.subscribeUpdater((s) => {
        mainWindow?.webContents.send("updater:update", s);
      });
    }
  });
  mainWindow.on("closed", () => {
    unsubServices();
    unsubModels();
    unsubUpdater();
    mainWindow = null;
  });
}

async function loadAppropriate() {
  if (!mainWindow) return;
  refreshModelStatuses();

  // If models exist, start services and load main UI.
  if (allModelsReady()) {
    servicesStarted = true;
    await startAll();
    const url = isDev ? await pickDevURL() : adminURL();
    console.log(`loading: ${url}`);
    await mainWindow.loadURL(url);
    return;
  }

  // Otherwise show the bundled setup view (no services yet).
  // The renderer's React app handles /setup route.
  // In dev we use admin URL as well because admin server serves the UI.
  // But admin needs to be running to serve UI... so we serve a static HTML
  // for setup mode that's standalone.
  const setupURL = isDev
    ? `file://${join(__dirname, "..", "..", "..", "ui", "dist", "setup.html")}`
    : `file://${join(process.resourcesPath, "app", "ui-dist", "setup.html")}`;
  console.log(`loading setup: ${setupURL}`);
  await mainWindow.loadURL(setupURL);
}

async function pickDevURL(): Promise<string> {
  try {
    const r = await fetch("http://127.0.0.1:5173/", { signal: AbortSignal.timeout(800) });
    if (r.ok) return "http://127.0.0.1:5173/";
  } catch {}
  return adminURL();
}

// ── Lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  bootLog("whenReady fired");
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
      ]),
    );
  }

  bootLog("about to create window");
  try {
    await createWindow();
    bootLog("createWindow done");
  } catch (e) {
    bootLog(`createWindow ERROR: ${(e as Error).message}`);
  }
  try {
    await loadAppropriate();
    bootLog("loadAppropriate done");
  } catch (e) {
    bootLog(`loadAppropriate ERROR: ${(e as Error).message}`);
  }

  // Initialise the updater after the window is ready.
  const m = await loadUpdater();
  if (m) {
    try {
      m.initUpdater();
      bootLog("initUpdater done");
    } catch (e) {
      bootLog(`initUpdater ERROR: ${(e as Error).message}`);
    }
    if (!isDev) {
      setTimeout(() => {
        bootLog("scheduled check fires");
        m.checkForUpdates().catch((e) =>
          bootLog(`check error: ${(e as Error).message}`),
        );
      }, 5000);
      setInterval(() => {
        m.checkForUpdates().catch(() => {});
      }, 6 * 60 * 60 * 1000);
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else focusMain();
});

app.on("before-quit", async (e) => {
  if (!servicesStarted) return; // nothing to shut down
  e.preventDefault();
  await stopAll();
  app.exit(0);
});
