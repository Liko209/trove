// Add page — guides the user through choosing what to index.
//
// Three sections from top to bottom:
//   1. Recommended on this Mac (iCloud Drive, Documents, Desktop, Downloads
//      auto-detected) — each card shows count + "Index now" button.
//   2. Custom folder — system folder picker for anything else.
//   3. Currently indexed — what's already in the library + actions.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SourceRow } from "../lib/api.ts";
import { shortPath } from "../lib/format.ts";
import ScanConfirmModal from "../components/ScanConfirmModal.tsx";
import {
  PermissionPill,
  openSettingsFor,
  usePermission,
} from "../components/PermissionStatus.tsx";

type Recommended = { label: string; path: string; icon: string; description: string };

declare global {
  interface Window {
    bitrove?: {
      pickFolder: () => Promise<string | null>;
      autodetectSources?: () => Promise<{ path: string; label: string; exists: boolean }[]>;
    };
  }
}

const FALLBACK_RECOMMENDED: Recommended[] = [
  {
    label: "iCloud Drive",
    icon: "☁",
    path: "~/Library/Mobile Documents/com~apple~CloudDocs",
    description: "Your iCloud Drive — documents that sync across all your Apple devices.",
  },
  {
    label: "Documents folder",
    icon: "📂",
    path: "~/Documents",
    description: "Your local Documents folder.",
  },
  {
    label: "Desktop",
    icon: "🖥",
    path: "~/Desktop",
    description: "Anything sitting on your desktop.",
  },
  {
    label: "Downloads",
    icon: "⬇",
    path: "~/Downloads",
    description: "PDFs and files you've downloaded.",
  },
];

function expandHome(p: string): string {
  // Recommended paths are displayed with ~, but the API and IPC bridge
  // need absolute paths. Electron's IPC autodetect already does this for us
  // when available; this helper is the fallback for browser-mode demos.
  const home = "/Users/leecoor";
  return p.replace(/^~/, home);
}

type IndexedRoot = { rootPath: string; fileCount: number };

function deriveRootsFromSources(rows: SourceRow[]): IndexedRoot[] {
  // Group indexed files by their "top-level shelf" so we can show one row
  // per scan-able root the user has previously added.
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const root = bucketRoot(row.source_path);
    buckets.set(root, (buckets.get(root) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([rootPath, fileCount]) => ({ rootPath, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function bucketRoot(absPath: string): string {
  const home = "/Users/leecoor";
  const cloud = home + "/Library/Mobile Documents/com~apple~CloudDocs";
  if (absPath.startsWith(cloud)) return cloud;
  for (const dir of ["Documents", "Desktop", "Downloads"]) {
    const full = `${home}/${dir}`;
    if (absPath.startsWith(full + "/") || absPath === full) return full;
  }
  // Fall back to the file's parent directory.
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

export default function Add() {
  const navigate = useNavigate();
  const [recommended, setRecommended] = useState<Recommended[]>(FALLBACK_RECOMMENDED);
  const [indexed, setIndexed] = useState<IndexedRoot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const bridge = window.bitrove;

  useEffect(() => {
    // Electron bridge can confirm which of the recommended sources actually
    // exist on this Mac. Falls back to the static list in browser mode.
    if (bridge?.autodetectSources) {
      bridge
        .autodetectSources()
        .then((items) => {
          const map = new Map(FALLBACK_RECOMMENDED.map((r) => [r.label, r]));
          const out: Recommended[] = [];
          for (const r of items) {
            if (!r.exists) continue;
            const tpl = map.get(r.label);
            out.push({
              label: r.label,
              path: r.path, // absolute path from main process
              icon: tpl?.icon ?? "📁",
              description: tpl?.description ?? r.path,
            });
          }
          if (out.length > 0) setRecommended(out);
        })
        .catch(() => {});
    }
    reloadIndexed();
  }, []);

  async function reloadIndexed() {
    try {
      // We just need a roll-up; ask for a generous page to cover small libraries.
      const r = await api.sources({ limit: 500 });
      setIndexed(deriveRootsFromSources(r.rows));
    } catch {}
  }

  async function pickAndScan() {
    if (!bridge) {
      alert("Folder picker is only available inside the Bitrove app.");
      return;
    }
    const folder = await bridge.pickFolder();
    if (folder) setConfirmPath(folder);
  }

  async function confirmStartScan() {
    if (!confirmPath) return;
    setBusy(confirmPath);
    try {
      await api.ingestScan(confirmPath);
      setConfirmPath(null);
      // Send the user where they can see progress
      navigate("/jobs");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const indexedPaths = new Set(indexed.map((i) => i.rootPath));

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold text-stone-900 mb-2">Add to your library</h1>
      <p className="text-stone-600 text-sm mb-8">
        Pick a place on your Mac. Bitrove will read the documents inside, index them locally,
        and make them searchable to your AI agents — nothing leaves this Mac.
      </p>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          Recommended on this Mac
        </h2>
        <div className="space-y-2">
          {recommended.map((r) => {
            const abs = expandHome(r.path);
            const already = indexedPaths.has(abs);
            return (
              <RecommendedCard
                key={r.path}
                rec={r}
                abs={abs}
                already={already}
                busy={busy === abs}
                onAdd={() => setConfirmPath(abs)}
              />
            );
          })}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          Or pick any other folder
        </h2>
        <button
          onClick={pickAndScan}
          disabled={!bridge}
          className="w-full p-4 rounded-xl border border-dashed border-stone-300 hover:border-stone-500 hover:bg-stone-50 transition text-left disabled:opacity-50"
        >
          <div className="flex items-center gap-3">
            <div className="text-2xl shrink-0">📁</div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-stone-900">Choose a folder…</div>
              <div className="text-xs text-stone-500 mt-0.5">
                Pick any folder on your Mac. We'll preview what's inside before indexing.
              </div>
            </div>
            <div className="text-stone-400 text-sm shrink-0">Browse</div>
          </div>
        </button>
        {!bridge && (
          <p className="text-xs text-stone-500 mt-2">
            Folder picker requires the Bitrove app (not the in-browser preview).
          </p>
        )}
      </section>

      {indexed.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
            Already in your library
          </h2>
          <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
            {indexed.map((src) => (
              <div key={src.rootPath} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-stone-900 truncate" title={src.rootPath}>
                    {shortPath(src.rootPath)}
                  </div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    {src.fileCount.toLocaleString()} files indexed
                  </div>
                </div>
                <button
                  onClick={() => setConfirmPath(src.rootPath)}
                  className="text-xs px-2.5 py-1 rounded-md text-stone-700 hover:bg-stone-100"
                >
                  Re-index
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {confirmPath && (
        <ScanConfirmModal
          path={confirmPath}
          onCancel={() => setConfirmPath(null)}
          onConfirm={confirmStartScan}
        />
      )}
    </div>
  );
}

/* ── RecommendedCard ────────────────────────────────────────── */

function RecommendedCard({
  rec,
  abs,
  already,
  busy,
  onAdd,
}: {
  rec: Recommended;
  abs: string;
  already: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  const { perm, recheck } = usePermission(abs);
  const settingsKey = settingsSectionForLabel(rec.label);
  const denied = perm.state === "denied";
  const missing = perm.state === "not-found";

  // Visual mood of the card adapts to the state.
  const tone = denied
    ? "border-rose-200 bg-rose-50/50 hover:bg-rose-50"
    : missing
      ? "border-stone-200 bg-stone-50 opacity-60"
      : "border-stone-200 bg-white hover:border-stone-400 hover:shadow-sm";

  return (
    <div
      className={
        "block w-full text-left p-4 rounded-xl border transition " + tone
      }
    >
      <div className="flex items-center gap-4">
        <div className="text-2xl shrink-0">{rec.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium text-stone-900">{rec.label}</div>
            {already && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Already added
              </span>
            )}
            <PermissionPill perm={perm} />
          </div>
          <div className="text-xs text-stone-500 mt-0.5 truncate">{rec.description}</div>
          <div className="text-[11px] text-stone-400 mt-0.5 font-mono truncate">
            {shortPath(abs)}
          </div>
          {denied && (
            <div className="text-xs text-rose-700 mt-2">
              macOS is blocking Bitrove from reading this folder. Grant access in
              System Settings, then come back here and tap "Re-check".
            </div>
          )}
          {missing && (
            <div className="text-xs text-stone-500 mt-2">
              This folder doesn't exist on this Mac. You can skip it.
            </div>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-stretch gap-1.5">
          {denied ? (
            <>
              <button
                onClick={() => openSettingsFor(settingsKey)}
                className="text-xs px-3 py-1.5 rounded-md font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700"
              >
                Open Settings
              </button>
              <button
                onClick={recheck}
                className="text-xs px-3 py-1 rounded-md font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-50"
              >
                Re-check
              </button>
            </>
          ) : missing ? (
            <button
              onClick={recheck}
              className="text-xs px-3 py-1 rounded-md font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-50"
            >
              Re-check
            </button>
          ) : (
            <button
              onClick={onAdd}
              disabled={busy || perm.state !== "granted"}
              className="text-xs px-3 py-1.5 rounded-md font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {already ? "Re-index" : "Add"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function settingsSectionForLabel(label: string): string | undefined {
  switch (label) {
    case "Documents folder":
      return "documents";
    case "Desktop":
      return "desktop";
    case "Downloads":
      return "downloads";
    case "iCloud Drive":
      return "icloud";
    default:
      return "files";
  }
}
