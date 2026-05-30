import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type LibraryGroups, type LibraryGroup } from "../lib/api.ts";
import { bytes } from "../lib/format.ts";
import { FileIcon } from "../components/FileIcon.tsx";
import JobProgress from "../components/JobProgress.tsx";

type Mode = "folder" | "topic";

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
      <div className="flex items-baseline flex-wrap gap-3 mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Library</h1>
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
                "px-3 py-1 text-sm " +
                (mode === "folder" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
              }
            >
              📁 By folder
            </button>
            <button
              onClick={() => setMode("topic")}
              className={
                "px-3 py-1 text-sm " +
                (mode === "topic" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
              }
            >
              🏷️ By topic
            </button>
          </div>
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((g) => (
          <CategoryCard key={`${mode}-${g.category}`} g={g} mode={mode} />
        ))}
      </div>

      {data && data.groups.length === 0 && mode === "topic" && (
        <div className="text-center py-12 text-stone-500">
          <div className="text-lg mb-2">No semantic tags yet</div>
          <div className="text-sm">
            Click "Run classification" above to tag all {data.total_files} files.
          </div>
        </div>
      )}
    </div>
  );
}
