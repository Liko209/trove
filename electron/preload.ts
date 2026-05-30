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

const bitrove = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),
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
};

contextBridge.exposeInMainWorld("bitrove", bitrove);

export type BitroveBridge = typeof bitrove;
