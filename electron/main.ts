// Trove main process.
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
// ~/Library/Application Support/Trove. Setting the app name before app.ready
// fires moves all path lookups to use it.
app.setName("Trove");

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
      appendFileSync("/tmp/trove-boot.log", `[${new Date().toISOString()}] FALLBACK ${msg}\n`);
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
    title: "Trove",
    backgroundColor: "#fafaf9",
    titleBarStyle: "hiddenInset",
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
