// Renderer-facing surface. Limited to what we actually need.

import { contextBridge, ipcRenderer } from "electron";

type ServiceState = {
  name: "admin" | "embed" | "rerank";
  pid?: number;
  status: "starting" | "running" | "stopped" | "crashed" | "missing-dep";
  port: number;
  detail?: string;
};

type ModelStatus = {
  id: "embed" | "rerank";
  filename: string;
  displayName: string;
  status: "missing" | "downloading" | "verifying" | "ready" | "error";
  downloadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  etaSeconds?: number;
  error?: string;
};

type PickedFile = {
  path: string;
  name: string;
  ext: string;
  size: number;
};

const bitrove = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),
  pickFiles: (): Promise<PickedFile[]> => ipcRenderer.invoke("dialog:pickFiles"),
  getHardware: (): Promise<{
    totalRamGB: number;
    cpuModel: string;
    arch: string;
    cores: number;
    platform: string;
  }> => ipcRenderer.invoke("system:hardware"),
  switchModelTier: (
    tier: "light" | "standard" | "quality" | "max",
  ): Promise<{ tier: string; watchedRootsReingested: boolean }> =>
    ipcRenderer.invoke("setup:switchTier", tier),
  // Onboarding tier picker
  listTiers: (): Promise<{
    tiers: {
      id: "light" | "standard" | "quality" | "max";
      label: string;
      blurb: string;
      recommendedRamGB: number;
      estDocsPerSec: number;
      embed: { displayName: string; approxBytes: number; dim: number };
    }[];
    recommended: "light" | "standard" | "quality" | "max";
    active: string;
    hardware: { totalRamGB: number; cpuModel: string; arch: string };
  }> => ipcRenderer.invoke("setup:listTiers"),
  downloadForTier: (
    tier: "light" | "standard" | "quality" | "max",
  ): Promise<{ ok: true }> => ipcRenderer.invoke("setup:downloadForTier", tier),
  getServicesState: (): Promise<Record<string, ServiceState>> =>
    ipcRenderer.invoke("services:state"),
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke("shell:openExternal", url),
  openInFinder: (path: string): Promise<void> =>
    ipcRenderer.invoke("shell:openInFinder", path),
  onServicesUpdate: (cb: (s: Record<string, ServiceState>) => void): (() => void) => {
    const handler = (_e: unknown, s: Record<string, ServiceState>) => cb(s);
    ipcRenderer.on("services:update", handler);
    return () => ipcRenderer.off("services:update", handler);
  },

  // Setup / first-run
  listModels: (): Promise<{ catalog: unknown[]; statuses: Record<string, ModelStatus> }> =>
    ipcRenderer.invoke("setup:listModels"),
  downloadModel: (id: "embed" | "rerank"): Promise<boolean> =>
    ipcRenderer.invoke("setup:downloadModel", id),
  pauseModel: (id: "embed" | "rerank"): Promise<boolean> =>
    ipcRenderer.invoke("setup:pauseModel", id),
  cancelModel: (id: "embed" | "rerank"): Promise<boolean> =>
    ipcRenderer.invoke("setup:cancelModel", id),
  isSetupReady: (): Promise<boolean> => ipcRenderer.invoke("setup:isReady"),
  autodetectSources: (): Promise<{ path: string; label: string; exists: boolean }[]> =>
    ipcRenderer.invoke("setup:autodetectSources"),
  readConfig: (): Promise<{ sources: string[]; excludes: string[]; onboarded: boolean }> =>
    ipcRenderer.invoke("setup:readConfig"),
  writeConfig: (partial: object): Promise<unknown> =>
    ipcRenderer.invoke("setup:writeConfig", partial),
  startServices: (): Promise<boolean> => ipcRenderer.invoke("setup:startServices"),

  // Updater
  updaterGetState: (): Promise<unknown> => ipcRenderer.invoke("updater:state"),
  updaterCheck: (): Promise<void> => ipcRenderer.invoke("updater:check"),
  updaterDownload: (): Promise<void> => ipcRenderer.invoke("updater:download"),
  updaterInstall: (): Promise<{ method: string }> => ipcRenderer.invoke("updater:install"),
  onUpdaterUpdate: (cb: (s: unknown) => void): (() => void) => {
    const handler = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("updater:update", handler);
    return () => ipcRenderer.off("updater:update", handler);
  },
  onModelsUpdate: (cb: (s: Record<string, ModelStatus>) => void): (() => void) => {
    const handler = (_e: unknown, s: Record<string, ModelStatus>) => cb(s);
    ipcRenderer.on("setup:update", handler);
    return () => ipcRenderer.off("setup:update", handler);
  },

  // macOS file-system permissions. Both methods are no-ops in the browser
  // preview where there is no main process; the renderer guards on
  // `bridge.checkPermission` being defined before using either.
  checkPermission: (
    path: string,
  ): Promise<{
    state: "granted" | "denied" | "not-found" | "not-directory" | "error";
    code?: string;
    message?: string;
  }> => ipcRenderer.invoke("permissions:checkPath", path),
  openPermissionSettings: (section?: string): Promise<void> =>
    ipcRenderer.invoke("permissions:openSettings", section),
};

contextBridge.exposeInMainWorld("bitrove", bitrove);

export type BitroveBridge = typeof bitrove;
