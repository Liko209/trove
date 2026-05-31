// Subscribe to main-process updater events. When Bitrove runs in the browser
// (not Electron), the bridge is undefined and we just stay idle forever.

import { useCallback, useEffect, useMemo, useState } from "react";

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

  // Stabilize the action callbacks. Without useCallback, every render
  // produced fresh function references; consumers that listed e.g.
  // `[check]` in a useEffect dep array would re-fire the effect on
  // every state update — including the "checking" state pushed by
  // their own previous call. UpdateBanner hit this and went into an
  // infinite check loop ("Checking…" flashing). bridge is the only
  // real dependency and it's stable (window.bitrove).
  const check = useCallback(
    async () => bridge?.updaterCheck() ?? Promise.resolve(),
    [bridge],
  );
  const download = useCallback(
    async () => bridge?.updaterDownload() ?? Promise.resolve(),
    [bridge],
  );
  const install = useCallback(
    async () => (bridge ? await bridge.updaterInstall() : null),
    [bridge],
  );

  return useMemo(
    () => ({ state, check, download, install, isElectron: !!bridge }),
    [state, check, download, install, bridge],
  );
}
