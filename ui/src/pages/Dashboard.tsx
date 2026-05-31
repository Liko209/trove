// Dashboard — the indexing-task control surface.
//
// Replaces the old Add tab. Concerns, top to bottom:
//   1. What's running right now (ActiveJobsBanner).
//   2. Where the library is at (4-up metric tiles).
//   3. What happened recently (Recent jobs + View all).
//   4. Add more content (quick-add: recommended cards, folder
//      picker, file picker).
//   5. Already-watched roots get a "Re-index" shortcut at the
//      bottom so they're addressable from here too.
//
// Library remains the file-information surface; jobs/metrics live
// here so they don't compete with file browsing.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type SourceRow, type Stats } from "../lib/api.ts";
import { bytes, shortPath } from "../lib/format.ts";
import PickedFilesConfirmModal from "../components/PickedFilesConfirmModal.tsx";
import {
  ActiveJobsBanner,
  RecentJobsRow,
} from "../components/JobsWidgets.tsx";
import { useJobs } from "../lib/useJobs.ts";
import {
  CloudIcon,
  DesktopIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "../components/icons.tsx";
import {
  PermissionPill,
  openSettingsFor,
  usePermission,
} from "../components/PermissionStatus.tsx";

type RecommendedIcon = "cloud" | "folder" | "desktop" | "download";
type Recommended = { label: string; path: string; icon: RecommendedIcon; description: string };

function recommendedIconFor(kind: RecommendedIcon, size = 22, className = "") {
  switch (kind) {
    case "cloud": return <CloudIcon size={size} className={className} />;
    case "folder": return <FolderOpenIcon size={size} className={className} />;
    case "desktop": return <DesktopIcon size={size} className={className} />;
    case "download": return <DownloadIcon size={size} className={className} />;
  }
}

type PickedFile = { path: string; name: string; ext: string; size: number };

declare global {
  interface Window {
    bitrove?: {
      pickFolder: () => Promise<string | null>;
      pickFiles?: () => Promise<PickedFile[]>;
      autodetectSources?: () => Promise<{ path: string; label: string; exists: boolean }[]>;
    };
  }
}

const FALLBACK_RECOMMENDED: Recommended[] = [
  {
    label: "iCloud Drive",
    icon: "cloud",
    path: "~/Library/Mobile Documents/com~apple~CloudDocs",
    description: "Your iCloud Drive — documents that sync across all your Apple devices.",
  },
  {
    label: "Documents folder",
    icon: "folder",
    path: "~/Documents",
    description: "Your local Documents folder.",
  },
  {
    label: "Desktop",
    icon: "desktop",
    path: "~/Desktop",
    description: "Anything sitting on your desktop.",
  },
  {
    label: "Downloads",
    icon: "download",
    path: "~/Downloads",
    description: "PDFs and files you've downloaded.",
  },
];

function expandHome(p: string): string {
  const home = "/Users/leecoor";
  return p.replace(/^~/, home);
}

type IndexedRoot = { rootPath: string; fileCount: number };

function deriveRootsFromSources(rows: SourceRow[]): IndexedRoot[] {
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
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [recommended, setRecommended] = useState<Recommended[]>(FALLBACK_RECOMMENDED);
  const [indexed, setIndexed] = useState<IndexedRoot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickedFiles, setPickedFiles] = useState<PickedFile[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [watchedCount, setWatchedCount] = useState<number | null>(null);
  const { active, recent, jobs } = useJobs(3000);
  const bridge = window.bitrove;

  function goConfigure(abs: string) {
    navigate(`/add/scan?path=${encodeURIComponent(abs)}`);
  }

  useEffect(() => {
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
              path: r.path,
              icon: tpl?.icon ?? "folder",
              description: tpl?.description ?? r.path,
            });
          }
          if (out.length > 0) setRecommended(out);
        })
        .catch(() => {});
    }
    reloadIndexed();
    api.stats().then(setStats).catch(() => {});
    api
      .listWatchedRoots()
      .then((r) => setWatchedCount(r.rows.length))
      .catch(() => setWatchedCount(0));
  }, []);

  async function reloadIndexed() {
    try {
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
    if (folder) goConfigure(folder);
  }

  async function pickAndAddFiles() {
    if (!bridge?.pickFiles) {
      alert("File picker is only available inside the Bitrove app.");
      return;
    }
    const files = await bridge.pickFiles();
    if (files.length > 0) setPickedFiles(files);
  }

  async function confirmAddFiles() {
    if (!pickedFiles) return;
    setBusy("__files");
    try {
      await api.ingestFiles(pickedFiles.map((f) => f.path));
      setPickedFiles(null);
      navigate("/jobs");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Last 7 days of ingest activity, derived from persisted jobs.
  const sevenDayWindow = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last7dIngested = jobs
    .filter((j) => j.finishedAt && j.finishedAt >= sevenDayWindow)
    .reduce((sum, j) => sum + (j.ingested ?? 0), 0);

  const indexedPaths = new Set(indexed.map((i) => i.rootPath));

  return (
    <div className="max-w-4xl mx-auto pb-12">
      <h1 className="t-display mb-2">Dashboard</h1>
      <p className="text-stone-600 text-sm mb-8">
        Add content, watch indexing happen, see what's already in the library.
      </p>

      <IndexHealthBanner />

      <ActiveJobsBanner jobs={active} />

      <ScheduledTasksSection />

      {/* ── Key metrics ──────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="t-section mb-3">At a glance</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricTile
            label="Files indexed"
            value={stats ? stats.total.sources.toLocaleString() : "—"}
            sub={
              stats
                ? stats.byKind.map((k) => `${k.sources} ${k.kind}`).join(" · ")
                : undefined
            }
          />
          <MetricTile
            label="Searchable chunks"
            value={stats ? stats.total.chunks.toLocaleString() : "—"}
            sub="vector embeddings"
          />
          <MetricTile
            label="Library size"
            value={stats ? bytes(stats.indexedBytes) : "—"}
            sub="on this Mac"
          />
          <MetricTile
            label="Watched folders"
            value={watchedCount?.toString() ?? "—"}
            sub={
              last7dIngested > 0
                ? `+${last7dIngested.toLocaleString()} indexed in last 7 days`
                : "kept in sync"
            }
          />
        </div>
      </section>

      <RecentJobsRow jobs={recent} hideWhenActive={active.length > 0} />

      {/* ── Quick add ──────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="t-section mb-3">Recommended on this Mac</h2>
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
                onAdd={() => goConfigure(abs)}
              />
            );
          })}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="t-section mb-3">Or pick something else</h2>
        <div className="space-y-2">
          <button
            onClick={pickAndScan}
            disabled={!bridge}
            className="w-full p-5 rounded-xl border border-dashed border-stone-300 hover:border-stone-500 hover:bg-stone-50 transition text-left disabled:opacity-50"
          >
            <div className="flex items-center gap-4">
              <FolderIcon size={22} className="shrink-0 text-stone-500" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-stone-900">Choose a folder…</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Pick any folder on your Mac. We'll preview what's inside and respect your default filters.
                </div>
              </div>
              <div className="text-stone-400 text-xs shrink-0">Browse</div>
            </div>
          </button>
          <button
            onClick={pickAndAddFiles}
            disabled={!bridge?.pickFiles}
            className="w-full p-5 rounded-xl border border-dashed border-stone-300 hover:border-stone-500 hover:bg-stone-50 transition text-left disabled:opacity-50"
          >
            <div className="flex items-center gap-4">
              <FileIcon size={22} className="shrink-0 text-stone-500" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-stone-900">Pick specific files…</div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Hand-pick one or more files. Default filters don't apply — anything you select is added.
                </div>
              </div>
              <div className="text-stone-400 text-xs shrink-0">Choose</div>
            </div>
          </button>
        </div>
        <p className="text-stone-500 text-xs mt-3">
          Code source files and folders like <code className="font-mono">node_modules</code>{" "}
          are skipped by default.{" "}
          <Link to="/settings" className="underline hover:text-stone-900">
            Adjust filters
          </Link>
          .
        </p>
      </section>

      {indexed.length > 0 && (
        <section>
          <h2 className="t-section mb-3">Already in your library</h2>
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
                  onClick={() => goConfigure(src.rootPath)}
                  className="text-xs px-2.5 py-1 rounded-md text-stone-700 hover:bg-stone-100"
                >
                  Re-index
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {pickedFiles && (
        <PickedFilesConfirmModal
          files={pickedFiles}
          onCancel={() => setPickedFiles(null)}
          onConfirm={confirmAddFiles}
        />
      )}
    </div>
  );
}

function MetricTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4">
      <div className="t-section">{label}</div>
      <div className="font-serif-display text-2xl text-stone-900 leading-none mt-2 tabular-nums">
        {value}
      </div>
      {sub && <div className="text-xs text-stone-500 mt-1.5 truncate">{sub}</div>}
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

  const tone = denied
    ? "border-rose-200 bg-rose-50/50 hover:bg-rose-50"
    : missing
      ? "border-stone-200 bg-stone-50 opacity-60"
      : "border-stone-200 bg-white hover:border-stone-400 hover:shadow-sm";

  return (
    <div className={"block w-full text-left p-4 rounded-xl border transition " + tone}>
      <div className="flex items-center gap-4">
        <span className="shrink-0 text-stone-500">{recommendedIconFor(rec.icon, 24)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium text-stone-900">{rec.label}</div>
            {already && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full label-eyebrow bg-emerald-50 text-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Added
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

/* ── Scheduled tasks ─────────────────────────────────────────────
   Shows pending scheduled scans (e.g. "Tonight at 1 AM"). Polled
   every 30s; ticks at the scheduler's resolution. Each row has a
   Cancel button. */
function ScheduledTasksSection() {
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof api.listScheduled>>["tasks"]>([]);

  async function load() {
    try {
      const r = await api.listScheduled();
      setTasks(r.tasks);
    } catch {}
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (tasks.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="t-section">Scheduled</h2>
        <span className="text-[10px] text-stone-400 tabular-nums">
          {tasks.length} pending
        </span>
      </div>
      <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
        {tasks.map((t) => {
          const when = new Date(t.runAt).toLocaleString();
          const target =
            t.params.root ?? `${(t.params.paths ?? []).length} picked files`;
          const display = typeof target === "string" ? shortPath(target) : target;
          return (
            <div key={t.id} className="px-4 py-3 flex items-center gap-3 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-stone-800 truncate" title={String(target)}>
                  {display}
                </div>
                <div className="text-xs text-stone-500 mt-0.5">
                  Runs {when} · {t.kind === "scan" ? "folder scan" : "file ingest"}
                </div>
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`Cancel scheduled scan?`)) return;
                  await api.cancelScheduled(t.id);
                  load();
                }}
                className="text-xs px-2.5 py-1 rounded-md text-stone-500 hover:text-rose-700 hover:bg-rose-50"
              >
                Cancel
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── Index health banner ──────────────────────────────────────
   Pings /api/index/status periodically and surfaces "you've got
   indexed files but no chunks" or "dim mismatch" right at the top
   of the Dashboard. Renders nothing on a healthy library — we
   don't want a permanent green status panel. */

function IndexHealthBanner() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.indexStatus>> | null>(null);
  // Two-step inline confirm because window.confirm() is unreliable
  // in Electron + contextIsolation. Stays visible until the user
  // either commits or cancels — no silent-fail path.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tick = () => api.indexStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, []);

  if (!status || !status.mode) return null;

  // ── retry-stale branch ──────────────────────────────────────
  // A few specific files failed during ingest — wipe + re-ingest
  // everything is the wrong answer. Show the offending files and
  // offer a targeted retry that only touches those rows.
  if (status.mode === "retry-stale") {
    async function retry() {
      setBusy(true);
      setErr(null);
      try {
        const r = await api.retryStaleIngest();
        navigate(`/jobs/${r.jobId}`);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
    const n = status.zeroChunkSources;
    const sample = status.staleSources.slice(0, 3);
    const remainder = Math.max(0, n - sample.length);
    return (
      <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200">
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-amber-900 mb-1">
              {n} file{n === 1 ? "" : "s"} failed to index
            </div>
            <p className="text-xs text-amber-900/85 leading-relaxed mb-3">
              {n === 1 ? "This file" : "These files"} ingested before but
              the most recent attempt didn't produce any chunks. Retrying
              re-runs ingest only on {n === 1 ? "this row" : "those rows"} —
              your other {status.chunkCount.toLocaleString()} chunks aren't
              touched.
            </p>
            <ul className="text-[11px] text-amber-900/90 mb-3 space-y-1 font-mono">
              {sample.map((s) => (
                <li key={s.source_path} className="truncate" title={s.last_error ?? s.source_path}>
                  <span>{s.source_path.split("/").pop()}</span>
                  {s.last_error && (
                    <span className="ml-2 text-amber-700/80">
                      — {s.last_error.length > 80 ? s.last_error.slice(0, 80) + "…" : s.last_error}
                    </span>
                  )}
                </li>
              ))}
              {remainder > 0 && (
                <li className="text-amber-700/80">+ {remainder} more</li>
              )}
            </ul>
            {err && (
              <div className="mb-3 text-xs text-rose-700">{err}</div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={retry}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md bg-amber-900 text-white hover:bg-amber-800 disabled:opacity-40"
              >
                {busy ? "Starting…" : `Retry ${n} file${n === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                onClick={() => navigate("/sources")}
                className="text-xs px-3 py-1.5 rounded-md text-amber-900 hover:bg-amber-100"
              >
                View in Sources
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── rebuild branch (dim mismatch or > half of chunks gone) ──
  const dimLine = status.dimMismatch
    ? `Stored ${status.dimMismatch.stored}-dim vectors but the active embed model produces ${status.dimMismatch.current}-dim vectors.`
    : `Most of your searchable chunks are missing — only ${status.chunkCount.toLocaleString()} of an expected ${status.expectedChunkSum.toLocaleString()} remain.`;

  async function rebuild() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.resetAndReingest();
      if (r.jobIds.length > 0) {
        navigate(`/jobs/${r.jobIds[0]}`);
      } else {
        await tick();
        setConfirming(false);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 p-4 rounded-xl bg-rose-50 border border-rose-200">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-rose-900 mb-1">
            Search index needs rebuild
          </div>
          <p className="text-xs text-rose-900/85 leading-relaxed mb-3">
            {dimLine} Rebuilding clears the broken vectors and
            immediately re-ingests every watched folder so the index
            is searchable again.
          </p>
          {err && (
            <div className="mb-3 text-xs text-rose-700">{err}</div>
          )}
          {confirming ? (
            <div className="rounded-lg bg-white border border-rose-300 p-3">
              <p className="text-xs text-rose-900 leading-relaxed mb-3">
                <strong>Wipe {status.chunkCount.toLocaleString()} stored chunks and re-scan all watched folders?</strong>{" "}
                Your file list and folders stay. Re-ingesting may take a
                while depending on library size — progress shows on the
                Jobs page.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={rebuild}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-md bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-40"
                >
                  {busy ? "Starting…" : "Yes, rebuild now"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-md text-rose-900 hover:bg-rose-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="text-xs px-3 py-1.5 rounded-md bg-rose-900 text-white hover:bg-rose-800"
              >
                Rebuild index
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
