// Slim banner that mounts under the global header.
// Hidden when there is no actionable update state.

import { useUpdater } from "../lib/useUpdater.ts";

function bytes(n: number | undefined): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function speed(bps: number | undefined): string {
  if (!bps) return "";
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export default function UpdateBanner() {
  const { state, download, install } = useUpdater();

  // Only render for actionable phases.
  if (state.phase === "idle" || state.phase === "checking" || state.phase === "up-to-date") {
    return null;
  }

  if (state.phase === "error") {
    return (
      <div className="bg-rose-50 border-b border-rose-200 text-rose-700 text-xs">
        <div className="max-w-7xl mx-auto px-6 py-2 flex items-center gap-3">
          <span className="font-medium">Update check failed.</span>
          <span className="text-rose-600 truncate">{state.message}</span>
        </div>
      </div>
    );
  }

  if (state.phase === "available") {
    return (
      <div className="bg-stone-100 border-b border-stone-200 text-stone-800 text-xs">
        <div className="max-w-7xl mx-auto px-6 py-2 flex items-center gap-3">
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-medium">
            Bitrove {state.info.version} is available.
          </span>
          {state.info.releaseDate && (
            <span className="text-stone-500">
              {new Date(state.info.releaseDate).toLocaleDateString()}
            </span>
          )}
          <button
            onClick={download}
            className="ml-auto px-3 py-1 rounded-md bg-stone-900 text-white font-medium hover:bg-stone-700"
          >
            Download update
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "downloading") {
    const pct = Math.round(state.percent || 0);
    return (
      <div className="bg-stone-100 border-b border-stone-200 text-stone-800 text-xs">
        <div className="max-w-7xl mx-auto px-6 py-2 flex items-center gap-3">
          <div className="shrink-0 w-3 h-3 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
          <span className="font-medium">Downloading Bitrove {state.info.version}…</span>
          <span className="tabular-nums">{pct}%</span>
          <span className="text-stone-500 tabular-nums">
            {bytes(state.transferred)} / {bytes(state.total)} · {speed(state.bytesPerSecond)}
          </span>
          <div className="ml-auto h-1 w-32 bg-stone-200 rounded-full overflow-hidden">
            <div className="h-full bg-stone-900 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "ready") {
    return (
      <div className="bg-stone-100 border-b border-stone-200 text-stone-800 text-xs">
        <div className="max-w-7xl mx-auto px-6 py-2 flex items-center gap-3">
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          <span className="font-medium">
            Bitrove {state.info.version} is ready to install.
          </span>
          {!state.canQuitAndInstall && (
            <span className="text-stone-500 hidden sm:inline">
              Drag the new app into Applications to update.
            </span>
          )}
          <button
            onClick={async () => {
              const r = await install();
              if (r?.method === "revealFile") {
                // Already revealed in Finder; nothing more to do.
              }
            }}
            className="ml-auto px-3 py-1 rounded-md bg-stone-900 text-white font-medium hover:bg-stone-700"
          >
            {state.canQuitAndInstall ? "Restart and install" : "Open downloaded installer"}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
