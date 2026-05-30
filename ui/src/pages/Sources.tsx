import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type SourceList, type SourceRow } from "../lib/api.ts";
import { bytes, parentDir, relTime } from "../lib/format.ts";
import { FileIcon } from "../components/FileIcon.tsx";

type View = "list" | "grid";

function GridCard({ s, selected, onToggle }: { s: SourceRow; selected: boolean; onToggle: () => void }) {
  return (
    <div
      className={
        "relative bg-white rounded-lg border p-3 hover:shadow-sm transition " +
        (selected ? "border-stone-900 ring-1 ring-stone-900" : "border-stone-200")
      }
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="absolute top-2 right-2 cursor-pointer"
      />
      <div className="flex gap-3 mb-2">
        <FileIcon bucket={s.bucket} size={36} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-stone-900 line-clamp-2" title={s.name}>
            {s.name}
          </div>
          <div className="text-xs text-stone-500 mt-0.5 truncate" title={parentDir(s.source_path, 200)}>
            {parentDir(s.source_path, 32)}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-stone-500 tabular-nums">
        <span>{s.chunk_count} chunks · {bytes(s.size_bytes)}</span>
        <span>{relTime(s.source_mtime)}</span>
      </div>
    </div>
  );
}

export default function Sources() {
  const [params, setParams] = useSearchParams();
  const category = params.get("category") || "";

  const [data, setData] = useState<SourceList | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [kind, setKind] = useState<"" | "text" | "catalog">("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<View>("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const limit = 50;

  async function load() {
    setLoading(true);
    try {
      // We use server-side path_contains for both the user's search box AND
      // the category filter. Category is derived from path, so a contains check
      // catches most cases. For the rare bucket like "Documents" / "Downloads"
      // (scattered files), this may over-include — acceptable for v1.
      const containsParts = [category, q].filter(Boolean);
      const path_contains = containsParts[0]; // server only takes one — combine on client below
      const r = await api.sources({
        kind: kind || undefined,
        path_contains: path_contains || undefined,
        limit,
        offset,
      });
      // Client-side refine: if both category and q are set, filter for the second
      let rows = r.rows;
      if (category && q) {
        rows = rows.filter((row) => row.source_path.toLowerCase().includes(q.toLowerCase()));
      }
      // Also refine to require matching the category bucket exactly when present
      if (category) {
        rows = rows.filter((row) => row.category === category);
      }
      setData({ ...r, rows });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [category, kind, q]);

  useEffect(() => {
    load();
  }, [category, kind, q, offset]);

  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.rows.length) setSelected(new Set());
    else setSelected(new Set(data.rows.map((r) => r.source_path)));
  };

  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} source(s) from the index?`)) return;
    try {
      await api.deleteSources([...selected]);
      setSelected(new Set());
      await load();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  };

  const reingest = async () => {
    if (selected.size === 0) return;
    try {
      const r = await api.ingestFiles([...selected], true);
      alert(`Reingest job started: ${r.jobId}\nWatch progress on the Add page.`);
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    }
  };

  const clearCategory = () => setParams({});

  return (
    <div>
      <div className="flex items-baseline mb-6">
        <Link to="/" className="text-stone-500 hover:text-stone-900 mr-3 text-xl">
          ←
        </Link>
        <h1 className="text-2xl font-semibold text-stone-900">
          {category ? category : "All files"}
        </h1>
        {data && (
          <span className="ml-3 text-stone-500 text-sm">({data.total.toLocaleString()})</span>
        )}
        {category && (
          <button
            onClick={clearCategory}
            className="ml-3 text-xs text-stone-600 underline hover:text-stone-900"
          >
            clear category
          </button>
        )}
        <div className="ml-auto inline-flex rounded border border-stone-300 overflow-hidden bg-white">
          <button
            onClick={() => setView("list")}
            className={
              "px-3 py-1 text-sm " +
              (view === "list" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
            }
          >
            ☰ List
          </button>
          <button
            onClick={() => setView("grid")}
            className={
              "px-3 py-1 text-sm " +
              (view === "grid" ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100")
            }
          >
            ▦ Grid
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <input
          type="search"
          placeholder="Search by name or path…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 min-w-[240px] px-3 py-1.5 rounded border border-stone-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="px-3 py-1.5 rounded border border-stone-300 bg-white text-sm"
        >
          <option value="">All kinds</option>
          <option value="text">text (full content)</option>
          <option value="catalog">catalog (bookshelf)</option>
        </select>
      </div>

      <div className="flex gap-2 mb-3">
        <button
          disabled={selected.size === 0}
          onClick={reingest}
          className="px-3 py-1.5 rounded bg-amber-100 hover:bg-amber-200 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-amber-900"
        >
          Re-ingest ({selected.size})
        </button>
        <button
          disabled={selected.size === 0}
          onClick={deleteSelected}
          className="px-3 py-1.5 rounded bg-rose-100 hover:bg-rose-200 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-rose-900"
        >
          Delete ({selected.size})
        </button>
      </div>

      {loading && <div className="text-stone-500 text-sm">Loading…</div>}
      {!loading && data?.rows.length === 0 && (
        <div className="text-stone-500 text-sm py-8 text-center">No matches</div>
      )}

      {view === "list" && data && data.rows.length > 0 && (
        <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-600 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={data.rows.length > 0 && selected.size === data.rows.length}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left w-1/3">Folder</th>
                <th className="px-3 py-2 text-right">Chunks</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2 text-right">Modified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.rows.map((r) => (
                <tr key={r.source_path} className="hover:bg-stone-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.source_path)}
                      onChange={() => toggle(r.source_path)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileIcon bucket={r.bucket} size={22} />
                      <div className="min-w-0">
                        <div className="text-stone-900 truncate" title={r.name}>
                          {r.name}
                        </div>
                        {r.kind === "catalog" && (
                          <span className="text-[10px] uppercase tracking-wider text-violet-700 bg-violet-100 px-1 py-0.5 rounded">
                            catalog
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-stone-500 font-mono truncate" title={r.source_path}>
                    {parentDir(r.source_path, 60)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{r.chunk_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{bytes(r.size_bytes)}</td>
                  <td className="px-3 py-2 text-right text-stone-500 text-xs tabular-nums" title={r.source_mtime}>
                    {relTime(r.source_mtime)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "grid" && data && data.rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {data.rows.map((r) => (
            <GridCard
              key={r.source_path}
              s={r}
              selected={selected.has(r.source_path)}
              onToggle={() => toggle(r.source_path)}
            />
          ))}
        </div>
      )}

      {data && data.total > limit && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            className="px-3 py-1.5 rounded bg-stone-200 hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            ← Prev
          </button>
          <span className="text-stone-500">
            {offset + 1}–{Math.min(offset + data.returned, data.total)} of {data.total.toLocaleString()}
          </span>
          <button
            disabled={offset + data.returned >= data.total}
            onClick={() => setOffset(offset + limit)}
            className="px-3 py-1.5 rounded bg-stone-200 hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
