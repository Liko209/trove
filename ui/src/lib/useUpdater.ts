// Subscribe to main-process updater events. When Bitrove runs in the browser
// (not Electron), the bridge is undefined and we just stay idle forever.

import { useEffect, useState } from "react";

export type UpdateInfoLite = {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
};

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date"; checkedAt: number; currentVersion: string }
  | { phase: "available"; info: UpdateInfoLite }
  | {
      phase: "downloading";
      info: UpdateInfoLite;
      percent: number;
      bytesPerSecond?: number;
      transferred?: number;
      total?: number;
    }
  | {
      phase: "ready";
      info: UpdateInfoLite;
      downloadedFile?: string;
      canQuitAndInstall: boolean;
    }
  | { phase: "error"; message: string };

type BitroveBridge = {
  updaterGetState: () => Promise<UpdaterState>;
  updaterCheck: () => Promise<void>;
  updaterDownload: () => Promise<void>;
  updaterInstall: () => Promise<{ method: string }>;
  onUpdaterUpdate: (cb: (s: UpdaterState) => void) => () => void;
};

export function useUpdater(): {
  state: UpdaterState;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<{ method: string } | null>;
  isElectron: boolean;
} {
  const [state, setState] = useState<UpdaterState>({ phase: "idle" });
  const bridge = (window as unknown as { bitrove?: BitroveBridge }).bitrove;

  useEffect(() => {
    if (!bridge) return;
    bridge.updaterGetState().then(setState).catch(() => {});
    return bridge.onUpdaterUpdate(setState);
  }, [bridge]);

  return {
    state,
    check: async () => bridge?.updaterCheck() ?? Promise.resolve(),
    download: async () => bridge?.updaterDownload() ?? Promise.resolve(),
    install: async () => (bridge ? await bridge.updaterInstall() : null),
    isElectron: !!bridge,
  };
}
