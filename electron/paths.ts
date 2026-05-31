// Resolve resource locations for both dev (running from source) and packaged
// (running from inside Bitrove.app/Contents/Resources/).
//
// Dev mode:
//   - __dirname points at electron/.dist/main, the compiled output.
//   - Source repo root = three levels up.
//   - admin runs via tsx against repo/src/admin.ts.
//   - models live at <repo>/../models (phase0-spikes/models, shared with CLI).
//
// Packaged mode:
//   - process.resourcesPath = Bitrove.app/Contents/Resources
//   - admin = Resources/app/admin/index.js (bundled by build script).
//   - llama-server = Resources/bin/llama-server (vendored).
//   - models live at userData/models (downloaded on first run).
//   - db lives at userData/data/index.db.

import { app } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const IS_PACKAGED = app.isPackaged;
// In dev, repo root is up 3 levels from electron/.dist/main/index.js.
const REPO_ROOT = IS_PACKAGED ? "" : resolve(__dirname, "..", "..", "..");
const RESOURCES = IS_PACKAGED ? process.resourcesPath : REPO_ROOT;

export function adminEntry(): { command: string; args: string[]; cwd: string } {
  if (IS_PACKAGED) {
    // build-admin.mjs writes admin to dist-app/admin/index.mjs which
    // electron-builder copies into Resources/app/admin/index.mjs via
    // extraResources. We spawn it through the Electron binary itself
    // (services.ts sets ELECTRON_RUN_AS_NODE=1 so it acts as plain Node).
    return {
      command: process.execPath,
      args: [join(RESOURCES, "app", "admin", "index.mjs")],
      cwd: join(RESOURCES, "app"),
    };
  }
  return {
    command: "npx",
    args: ["tsx", join(REPO_ROOT, "src", "admin.ts")],
    cwd: REPO_ROOT,
  };
}

export function llamaServerBinary(): string {
  if (IS_PACKAGED) {
    return join(RESOURCES, "bin", "llama-server");
  }
  try {
    return execSync("which llama-server", { encoding: "utf8" }).trim();
  } catch {
    return "llama-server";
  }
}

// Bundled macOS Vision OCR helper. Dev: reuse the locally-built
// universal binary so `npm run dev` can exercise the OCR path
// without going through release packaging. Packaged: lives next to
// llama-server under Resources/bin/.
export function ocrBinary(): string {
  if (IS_PACKAGED) {
    return join(RESOURCES, "bin", "bitrove-ocr");
  }
  return join(REPO_ROOT, "resources", "bin", "bitrove-ocr");
}

export function modelsDir(): string {
  if (IS_PACKAGED) {
    return join(app.getPath("userData"), "models");
  }
  // Dev: reuse the GGUFs we already downloaded for the CLI demo.
  // phase0-spikes/models lives one level up from this repo (demo/).
  return resolve(REPO_ROOT, "..", "models");
}

export function dbPath(): string {
  if (IS_PACKAGED) {
    return join(app.getPath("userData"), "data", "index.db");
  }
  // Dev: reuse the existing index.db that already has 1006 files indexed.
  return join(REPO_ROOT, "data", "index.db");
}

export function configPath(): string {
  if (IS_PACKAGED) {
    return join(app.getPath("userData"), "config.json");
  }
  return join(REPO_ROOT, "data", "config.json");
}

export function uiDistDir(): string {
  if (IS_PACKAGED) {
    return join(RESOURCES, "app", "ui-dist");
  }
  return join(REPO_ROOT, "ui", "dist");
}

export function summary(): string {
  return [
    `packaged: ${IS_PACKAGED}`,
    `repo: ${REPO_ROOT || "(packaged)"}`,
    `resources: ${RESOURCES}`,
    `admin entry: ${JSON.stringify(adminEntry())}`,
    `llama: ${llamaServerBinary()}`,
    `models: ${modelsDir()} (exists: ${existsSync(modelsDir())})`,
    `db: ${dbPath()}`,
    `ui: ${uiDistDir()}`,
  ].join("\n  ");
}
