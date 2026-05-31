import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type LibraryGroups, type LibraryGroup, type Health, type ClaudeConfigInfo, type Job } from "../lib/api.ts";
import { bytes, formatDurationSeconds } from "../lib/format.ts";
import { FileIcon } from "../components/FileIcon.tsx";
import JobProgress from "../components/JobProgress.tsx";
import { UpdateFooter } from "../components/UpdateSection.tsx";
import { BookIcon, FolderOpenIcon } from "../components/icons.tsx";
import { useJobs } from "../lib/useJobs.ts";
import FirstRunWizard from "../components/FirstRunWizard.tsx";

type Mode = "folder" | "topic";

/* ── System status strip ──────────────────────────────────────────
   Persistent one-row indicator: MCP server health + agent connection
   state. Lives at the top of Library so the user always sees whether
   their AI tools can reach the library, without having to navigate
   to Agents to check. Click anywhere → /agents. */
function SystemBar() {
  const [health, setHealth] = useState<Health | null>(null);
  const [claude, setClaude] = useState<ClaudeConfigInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [h, c] = await Promise.all([
          api.health(),
          api.claudeConfig().catch(() => null),
        ]);
        if (!alive) return;
        setHealth(h);
        setClaude(c);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const mcpReady = !!(health?.embed && health?.rerank);
  const agentConnected =
    claude?.detected.some((d) => d.exists && d.hasTroveEntry) ?? false;

  return (
    <Link
      to="/agents"
      className="flex items-center gap-6 py-2.5 px-3 -mx-3 rounded-lg hover:bg-white transition mb-2 text-xs"
    >
      <StatusDot
        ok={mcpReady}
        label="MCP server"
        detail={mcpReady ? "Ready" : "Warming up"}
      />
      <span className="text-stone-200">|</span>
      <StatusDot
        ok={agentConnected}
        label="Claude Code"
        detail={agentConnected ? "Connected" : "Not connected"}
      />
      <span className="ml-auto text-stone-400 hover:text-stone-700 transition">Configure →</span>
    </Link>
  );
}

function StatusDot({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-block h-2 w-2">
        {ok && <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-40" />}
        <span className={"absolute inset-0 rounded-full " + (ok ? "bg-emerald-500" : "bg-stone-300")} />
      </span>
      <span className="text-stone-600">
        <span className="font-medium text-stone-700">{label}</span>{" "}
        <span className="text-stone-400">·</span>{" "}
        <span className={ok ? "text-emerald-700" : "text-stone-500"}>{detail}</span>
      </span>
    </span>
  );
}

/* ── Active jobs banner ──────────────────────────────────────────
   Replaces the old top-level "Activity" tab. Only renders when
   there's at least one running ingest. Clicking jumps to /jobs
   where Stop / Continue lives. */
function ActiveJobsBanner({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="t-section mb-3">Indexing in progress</h2>
      <div className="space-y-3">
        {jobs.map((j) => (
          <ActiveJobCard key={j.id} job={j} />
        ))}
      </div>
    </section>
  );
}

function ActiveJobCard({ job }: { job: Job }) {
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const rate = elapsed > 0 ? job.done / elapsed : 0;
  const remaining = rate > 0 ? (job.total - job.done) / rate : Infinity;
  return (
    <Link
      to="/jobs"
      className="block bg-white rounded-xl border border-stone-200 hover:border-stone-300 transition p-5"
    >
      <div className="flex items-center gap-3 mb-3">
        <span className="relative inline-block h-2.5 w-2.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
          <span className="absolute inset-0 rounded-full bg-emerald-500" />
        </span>
        <div className="text-sm font-medium text-stone-900 truncate flex-1">{job.description}</div>
        <div className="text-stone-400 text-sm">Open job →</div>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-3">
        <Metric label="Progress" value={`${pct}%`} sub={`${job.done.toLocaleString()} / ${job.total.toLocaleString()}`} />
        <Metric label="Time left" value={formatDurationSeconds(remaining)} />
        <Metric label="Indexed" value={`+${job.ingested}`} />
      </div>
      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
        <div className="h-full bg-stone-900 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </Link>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="t-section">{label}</div>
      <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none mt-1">{value}</div>
      {sub && <div className="text-xs text-stone-500 mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

/* ── Watched roots ───────────────────────────────────────────────
   Folders Bitrove is actively keeping in sync with disk. Lives at
   the top of Library so users can see (a) what's being watched and
   (b) when each root was last refreshed. Toggle the switch to pause
   watching without losing the index; click "Remove" to drop the row
   (existing indexed files stay until the user separately deletes
   them or they show up in Missing). */
function WatchedRootsSection() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.listWatchedRoots>> | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api.listWatchedRoots());
    } catch {}
  }
  useEffect(() => {
    load();
    // Faster polling while something is actively scanning so the "Now" file
    // updates without 15s lag. Drops back to the slow tick once idle.
    const anyActive = data?.watcher.active.some((a) => a.scanning || a.dirty > 0);
    const t = setInterval(load, anyActive ? 2000 : 15000);
    return () => clearInterval(t);
  }, [data?.watcher.active]);

  if (!data || data.rows.length === 0) return null;

  const totalIndexed = data.rows.reduce((s, r) => s + r.stats.indexed_files, 0);

  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="t-section">Folders Bitrove is watching</h2>
        <span className="text-xs text-stone-400 tabular-nums">
          {data.rows.length} folder{data.rows.length === 1 ? "" : "s"} ·{" "}
          {totalIndexed.toLocaleString()} files indexed
        </span>
      </div>
      <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100 overflow-hidden">
        {data.rows.map((r) => {
          const live = data.watcher.active.find((a) => a.root === r.path);
          const dirty = live?.dirty ?? 0;
          const isOpen = expanded === r.path;
          const stateLabel = !r.watch_enabled
            ? "Paused"
            : live?.scanning
              ? "Scanning…"
              : dirty > 0
                ? `${dirty} change${dirty === 1 ? "" : "s"} pending`
                : "Watching";
          const stateDot = !r.watch_enabled
            ? "bg-stone-300"
            : live?.scanning
              ? "bg-sky-500"
              : dirty > 0
                ? "bg-amber-500"
                : "bg-emerald-500";
          const lastDone = r.last_completed_at
            ? relativeTime(r.last_completed_at)
            : "never";
          const currentFile = live?.currentFile ?? null;
          return (
            <div key={r.path}>
              <div
                className="px-4 py-3 flex items-center gap-3 text-sm hover:bg-stone-50 cursor-pointer"
                onClick={() => setExpanded(isOpen ? null : r.path)}
              >
                <span className={"relative inline-block h-2 w-2 shrink-0"}>
                  {live?.scanning && (
                    <span className="absolute inset-0 rounded-full bg-sky-500 animate-ping opacity-50" />
                  )}
                  <span className={"absolute inset-0 rounded-full " + stateDot} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-stone-800 truncate" title={r.path}>
                    {r.path}
                  </div>
                  <div className="text-xs text-stone-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="tabular-nums">
                      <strong className="text-stone-700 font-medium">
                        {r.stats.indexed_files.toLocaleString()}
                      </strong>{" "}
                      files
                    </span>
                    {r.stats.total_size_bytes > 0 && (
                      <span className="text-stone-400">· {bytes(r.stats.total_size_bytes)}</span>
                    )}
                    <span className="text-stone-400">·</span>
                    <span>{stateLabel}</span>
                    <span className="text-stone-400">· last sync {lastDone}</span>
                    {r.stats.missing_files > 0 && (
                      <span className="text-amber-700">
                        · {r.stats.missing_files} missing
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-stone-400 text-xs">{isOpen ? "▾" : "▸"}</span>
              </div>

              {isOpen && (
                <div className="px-4 pb-4 pt-1 bg-stone-50/50 border-t border-stone-100">
                  {currentFile && (
                    <div className="mb-3 px-3 py-2 rounded-md bg-white border border-stone-200 flex items-center gap-2.5">
                      <div className="shrink-0 w-3 h-3 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
                      <span className="t-section">Now</span>
                      <span className="text-xs font-mono text-stone-700 truncate" title={currentFile}>
                        {currentFile}
                      </span>
                    </div>
                  )}

                  {r.stats.top_subdirs.length > 0 && (
                    <>
                      <div className="t-section mb-2">Inside this folder</div>
                      <SubdirBars subdirs={r.stats.top_subdirs} />
                    </>
                  )}

                  <div className="flex items-center gap-3 mt-3 text-xs">
                    <Link
                      to={`/sources?prefix=${encodeURIComponent(r.path)}`}
                      className="text-stone-600 hover:text-stone-900 underline-offset-2 hover:underline"
                    >
                      Browse all {r.stats.indexed_files.toLocaleString()} files →
                    </Link>
                    <button
                      onClick={async () => {
                        await api.setWatchedRootEnabled(r.path, !r.watch_enabled);
                        load();
                      }}
                      className="ml-auto px-2.5 py-1 rounded-md text-stone-700 hover:bg-stone-200"
                    >
                      {r.watch_enabled ? "Pause watching" : "Resume watching"}
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Stop watching ${r.path}?\n\nIndexed files stay in the library — they just won't keep updating.`)) return;
                        await api.removeWatchedRoot(r.path);
                        load();
                      }}
                      className="px-2.5 py-1 rounded-md text-stone-500 hover:text-rose-700 hover:bg-rose-50"
                    >
                      Stop watching
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SubdirBars({
  subdirs,
}: {
  subdirs: { name: string; indexed: number; bytes: number }[];
}) {
  const max = Math.max(...subdirs.map((s) => s.indexed), 1);
  return (
    <ul className="space-y-1.5">
      {subdirs.map((s) => {
        const ratio = Math.round((s.indexed / max) * 100);
        return (
          <li key={s.name} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-stone-800 truncate" title={s.name}>
                {s.name === "(root)" ? (
                  <em className="text-stone-500">files at root</em>
                ) : (
                  s.name
                )}
              </span>
              <span className="text-stone-500 tabular-nums shrink-0">
                {s.indexed.toLocaleString()} files
                {s.bytes > 0 && (
                  <span className="text-stone-400"> · {bytes(s.bytes)}</span>
                )}
              </span>
            </div>
            <div className="mt-1 h-1 rounded bg-stone-100 overflow-hidden">
              <div
                className="h-full bg-emerald-500/70"
                style={{ width: `${ratio}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  return new Date(ts).toLocaleDateString();
}

/* ── Missing files ───────────────────────────────────────────────
   Source rows whose underlying files are gone from disk. Surfaces
   as an amber "you may want to clean these up" panel so the user
   can decide whether the deletion was intentional. Bulk-delete via
   one button; nothing auto-deletes. */
function MissingFilesSection() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.listMissing>>["rows"] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await api.listMissing();
      setRows(r.rows);
    } catch {}
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  if (!rows || rows.length === 0) return null;

  const totalChunks = rows.reduce((s, r) => s + r.chunk_count, 0);

  return (
    <section className="mb-8">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="t-h2 text-amber-900">
            {rows.length} indexed file{rows.length === 1 ? "" : "s"} no longer on disk
          </h2>
          <span className="text-xs text-amber-800 tabular-nums">
            {totalChunks.toLocaleString()} chunks
          </span>
        </div>
        <p className="text-xs text-amber-900/80 mb-3 leading-relaxed">
          We kept the index in case you moved them temporarily. If you want
          search results to stop pointing at files that aren't there, clean up.
        </p>
        <details>
          <summary className="text-xs text-amber-900 cursor-pointer hover:underline mb-2">
            Show {Math.min(rows.length, 20)} of {rows.length}
          </summary>
          <ul className="space-y-0.5 mb-3 max-h-48 overflow-y-auto">
            {rows.slice(0, 20).map((r) => (
              <li key={r.source_path} className="text-xs font-mono text-amber-900 truncate" title={r.source_path}>
                {r.source_path}
              </li>
            ))}
          </ul>
        </details>
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Remove ${rows.length} entries from the index?\n\nThe original files are already gone from disk.`)) return;
              setBusy(true);
              try {
                await api.deleteMissing(rows.map((r) => r.source_path));
                await load();
              } catch (e) {
                alert((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className="text-xs px-3 py-1.5 rounded-md font-medium bg-amber-900 text-white hover:bg-amber-800 disabled:opacity-40"
          >
            {busy ? "Cleaning…" : "Clean up all"}
          </button>
        </div>
      </div>
    </section>
  );
}

function LibraryEmpty() {
  return (
    <div className="bg-gradient-to-br from-stone-50 to-stone-100/50 border border-stone-200 rounded-2xl p-10 text-center">
      <div className="inline-flex w-12 h-12 rounded-xl bg-white border border-stone-200 items-center justify-center text-stone-500 mb-4">
        <BookIcon size={24} />
      </div>
      <h2 className="font-serif-display text-2xl text-stone-900 mb-2">
        Your library is empty
      </h2>
      <p className="text-sm text-stone-600 mb-6 max-w-md mx-auto leading-relaxed">
        Add a folder or pick specific files you'd like to make searchable. Bitrove
        reads them on this Mac and nothing leaves the device.
      </p>
      <Link
        to="/add"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-stone-900 text-white text-sm font-medium hover:bg-stone-700"
      >
        Add your first folder →
      </Link>
    </div>
  );
}

function CategoryCard({ g, mode }: { g: LibraryGroup; mode: Mode }) {
  const linkParam = mode === "topic" ? "topic" : "category";
  return (
    <Link
      to={`/sources?${linkParam}=${encodeURIComponent(g.category)}`}
      className="block bg-white rounded-xl border border-stone-200 hover:border-stone-400 hover:shadow-sm transition p-5"
    >
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-semibold text-stone-900 text-lg truncate" title={g.category}>
          {g.category}
        </div>
        <div className="text-stone-400 text-sm">›</div>
      </div>
      <div className="flex gap-3 text-xs text-stone-500 mb-3">
        <span className="tabular-nums font-medium text-stone-700">{g.total}</span>
        {g.text > 0 && <span>· {g.text} text</span>}
        {g.catalog > 0 && <span>· {g.catalog} catalog</span>}
        <span className="ml-auto">{bytes(g.total_size)}</span>
      </div>
      <div className="space-y-1.5">
        {g.sample.map((s) => (
          <div key={s.source_path} className="flex items-center gap-2 text-sm text-stone-700">
            <FileIcon bucket={s.bucket} size={20} />
            <span className="truncate" title={s.name}>
              {s.name}
            </span>
          </div>
        ))}
        {g.total > g.sample.length && (
          <div className="text-xs text-stone-400 pl-7">+ {g.total - g.sample.length} more</div>
        )}
      </div>
    </Link>
  );
}

export default function Library() {
  const [mode, setMode] = useState<Mode>("folder");
  const [data, setData] = useState<LibraryGroups | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [classifyJobId, setClassifyJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const { active } = useJobs(3000);
  const [watchedCount, setWatchedCount] = useState<number | null>(null);
  const [wizardDismissed, setWizardDismissed] = useState(false);

  async function load(m: Mode) {
    try {
      const d = m === "topic" ? await api.libraryTopics() : await api.libraryGroups();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Probe whether any watched roots exist — combined with empty library
  // this is the trigger for the first-run wizard.
  useEffect(() => {
    let alive = true;
    api
      .listWatchedRoots()
      .then((r) => alive && setWatchedCount(r.rows.length))
      .catch(() => alive && setWatchedCount(0));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    load(mode);
  }, [mode]);

  const runClassify = async () => {
    setRunning(true);
    try {
      const r = await api.classify(false);
      setClassifyJobId(r.jobId);
    } catch (e) {
      alert((e as Error).message);
      setRunning(false);
    }
  };

  const filtered =
    data && query
      ? data.groups.filter((g) => g.category.toLowerCase().includes(query.toLowerCase()))
      : data?.groups ?? [];

  // First-run wizard renders only when: no indexed files, no watched
  // roots, no in-flight jobs, and the user hasn't dismissed it this
  // session. Once they kick off a scan it stops rendering naturally
  // because `data` populates and `watchedCount` flips to >0.
  const showWizard =
    !wizardDismissed &&
    data !== null &&
    data.total_files === 0 &&
    watchedCount === 0 &&
    active.length === 0;

  return (
    <div>
      <SystemBar />

      <ActiveJobsBanner jobs={active} />

      {showWizard && (
        <FirstRunWizard
          onSkip={() => setWizardDismissed(true)}
          onLaunched={() => setWizardDismissed(true)}
        />
      )}

      {!showWizard && <WatchedRootsSection />}

      {!showWizard && <MissingFilesSection />}

      <div className="flex items-baseline flex-wrap gap-3 mb-6">
        <h1 className="t-display">Library</h1>
        {data && (
          <span className="text-stone-500 text-sm">
            {data.total_files.toLocaleString()} files · {data.total_categories} {mode === "topic" ? "topics" : "folders"}
            {mode === "topic" && data.untagged ? (
              <span className="text-amber-700"> · {data.untagged} untagged</span>
            ) : null}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex rounded border border-stone-300 overflow-hidden bg-white">
            <button
              onClick={() => setMode("folder")}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1 text-sm " +
                (mode === "folder" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
              }
            >
              <FolderOpenIcon size={14} /> By folder
            </button>
            <button
              onClick={() => setMode("topic")}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1 text-sm " +
                (mode === "topic" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
              }
            >
              <BookIcon size={14} /> By topic
            </button>
          </div>
          <Link
            to="/add"
            className="text-sm px-3 py-1 rounded-md bg-stone-900 text-white font-medium hover:bg-stone-700"
          >
            Add
          </Link>
          <Link
            to="/sources"
            className="text-sm text-stone-600 hover:text-stone-900 underline-offset-2 hover:underline"
          >
            All files →
          </Link>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {mode === "topic" && (
        <div className="mb-4 flex items-center gap-3 text-sm">
          <button
            onClick={runClassify}
            disabled={running}
            className="px-3 py-1.5 rounded bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-50 font-medium"
          >
            {data && data.total_files > 0 ? "Re-classify all" : "Run classification"}
          </button>
          <span className="text-stone-500">
            Zero-shot semantic classification via bge-m3 (~30s for all files).
            Higher-quality LLM tagging in a future version.
          </span>
        </div>
      )}

      {classifyJobId && (
        <div className="mb-5">
          <JobProgress
            jobId={classifyJobId}
            onDone={() => {
              setRunning(false);
              load(mode);
            }}
          />
        </div>
      )}

      <div className="mb-5">
        <input
          type="search"
          placeholder={`Filter ${mode === "topic" ? "topics" : "folders"}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full max-w-sm px-3 py-1.5 rounded border border-stone-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
      </div>

      {!data && !err && <div className="text-stone-500 text-sm">Loading…</div>}

      {data && data.total_files === 0 ? (
        <LibraryEmpty />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((g) => (
            <CategoryCard key={`${mode}-${g.category}`} g={g} mode={mode} />
          ))}
        </div>
      )}

      {data && data.groups.length === 0 && mode === "topic" && (
        <div className="text-center py-12 text-stone-500">
          <div className="text-lg mb-2">No semantic tags yet</div>
          <div className="text-sm">
            Click "Run classification" above to tag all {data.total_files} files.
          </div>
        </div>
      )}

      <UpdateFooter />
    </div>
  );
}
