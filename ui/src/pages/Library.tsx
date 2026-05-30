import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type LibraryGroups, type LibraryGroup, type Health, type ClaudeConfigInfo, type Job } from "../lib/api.ts";
import { bytes, formatDurationSeconds } from "../lib/format.ts";
import { FileIcon } from "../components/FileIcon.tsx";
import JobProgress from "../components/JobProgress.tsx";
import { UpdateFooter } from "../components/UpdateSection.tsx";
import { BookIcon, FolderOpenIcon } from "../components/icons.tsx";
import { useJobs } from "../lib/useJobs.ts";

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
        <div className="h-full bg-stone-900 transition-all" style={{ width: `${pct}%` }} />
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

  async function load(m: Mode) {
    try {
      const d = m === "topic" ? await api.libraryTopics() : await api.libraryGroups();
      setData(d);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

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

  return (
    <div>
      <SystemBar />

      <ActiveJobsBanner jobs={active} />

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
