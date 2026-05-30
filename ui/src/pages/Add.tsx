import { useEffect, useState } from "react";
import { api, type Browse } from "../lib/api.ts";
import JobProgress from "../components/JobProgress.tsx";

function shortPath(p: string): string {
  const home = "/Users/leecoor";
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export default function Add() {
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<string[]>([]);

  async function loadBrowse(path?: string) {
    try {
      const b = await api.browse(path);
      setBrowse(b);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    loadBrowse();
  }, []);

  const scanThisFolder = async () => {
    if (!browse) return;
    if (!confirm(`Scan all indexable files in:\n${browse.path}\n\nThis may take a while.`)) return;
    try {
      const r = await api.ingestScan(browse.path);
      setJobs((j) => [r.jobId, ...j]);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const ingestFile = async (path: string) => {
    try {
      const r = await api.ingestFiles([path]);
      setJobs((j) => [r.jobId, ...j]);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold text-stone-900 mb-6">Add files</h1>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {/* Browser */}
      <div className="bg-white rounded-lg border border-stone-200 mb-6">
        <div className="flex items-center px-4 py-2 border-b border-stone-200 gap-2 bg-stone-50">
          <button
            onClick={() => loadBrowse(browse?.parent ?? undefined)}
            disabled={!browse?.parent}
            className="px-2 py-0.5 rounded bg-stone-200 hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed text-sm"
          >
            ↑ Up
          </button>
          <code className="text-sm text-stone-700 flex-1 truncate">
            {browse ? shortPath(browse.path) : ""}
          </code>
          <button
            onClick={scanThisFolder}
            className="px-3 py-1 rounded bg-stone-900 text-white text-sm font-medium hover:bg-stone-700"
          >
            Scan this folder
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {browse?.entries.map((e) => (
            <div
              key={e.path}
              className="flex items-center px-4 py-1.5 hover:bg-stone-50 border-b border-stone-100 text-sm"
            >
              <button
                className={
                  "flex-1 text-left flex items-center gap-2 " +
                  (e.kind === "dir" ? "cursor-pointer text-stone-800" : "cursor-default text-stone-700")
                }
                onClick={() => e.kind === "dir" && loadBrowse(e.path)}
              >
                <span>{e.kind === "dir" ? "📁" : e.indexable === "text" ? "📄" : e.indexable === "catalog" ? "📒" : "·"}</span>
                <span className="truncate">{e.name}</span>
              </button>
              {e.kind === "file" && e.indexable !== "skip" && (
                <button
                  onClick={() => ingestFile(e.path)}
                  className="ml-2 px-2 py-0.5 rounded bg-stone-200 hover:bg-stone-300 text-xs"
                >
                  + Index
                </button>
              )}
              {e.kind === "file" && e.indexable === "skip" && (
                <span className="ml-2 text-xs text-stone-400">unsupported</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Active jobs */}
      <div className="space-y-3">
        {jobs.map((id) => (
          <JobProgress key={id} jobId={id} />
        ))}
        {jobs.length === 0 && (
          <div className="text-sm text-stone-500 italic">
            No active ingestion jobs. Browse to a folder and click "Scan" or "+ Index" on a file.
          </div>
        )}
      </div>
    </div>
  );
}
