import { useEffect, useState } from "react";
import { api, type Stats, type Health } from "../lib/api.ts";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-stone-200 p-5">
      <div className="text-xs uppercase tracking-wider text-stone-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-stone-900 tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-sm text-stone-500">{sub}</div>}
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={
        "inline-block w-2 h-2 rounded-full mr-2 " + (ok ? "bg-emerald-500" : "bg-rose-500")
      }
    />
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const [s, h] = await Promise.all([api.stats(), api.health()]);
      setStats(s);
      setHealth(h);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-stone-900 mb-6">Dashboard</h1>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card
          label="Indexed files"
          value={stats?.total.sources.toLocaleString() ?? "—"}
          sub={
            stats
              ? stats.byKind
                  .map((k) => `${k.sources} ${k.kind}`)
                  .join(" · ")
              : undefined
          }
        />
        <Card
          label="Total chunks"
          value={stats?.total.chunks.toLocaleString() ?? "—"}
        />
        <Card
          label="DB size"
          value={stats ? bytes(stats.dbSize) : "—"}
          sub={stats?.dbPath.split("/").slice(-3).join("/")}
        />
      </div>

      <h2 className="text-lg font-semibold text-stone-900 mb-3">Inference servers</h2>
      <div className="bg-white rounded-lg border border-stone-200 divide-y divide-stone-200">
        <div className="p-4 flex items-center">
          <StatusDot ok={!!health?.embed} />
          <div className="font-medium">bge-m3 embedding</div>
          <div className="ml-auto text-sm text-stone-500 font-mono">{health?.embed_url}</div>
        </div>
        <div className="p-4 flex items-center">
          <StatusDot ok={!!health?.rerank} />
          <div className="font-medium">bge-reranker-v2-m3</div>
          <div className="ml-auto text-sm text-stone-500 font-mono">{health?.rerank_url}</div>
        </div>
      </div>
      {(health && (!health.embed || !health.rerank)) && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded text-sm">
          Some inference servers are offline. Search will degrade gracefully. To start them:
          <pre className="mt-2 font-mono text-xs bg-white border border-amber-200 rounded p-2 overflow-x-auto">{`cd phase0-spikes
llama-server -m models/bge-m3-Q4_K_M.gguf --embedding --pooling cls --port 8765 --batch-size 8192 --ubatch-size 8192 -c 8192 --log-disable &
llama-server -m models/bge-reranker-v2-m3-Q4_K_M.gguf --reranking --port 8766 --batch-size 8192 --ubatch-size 8192 -c 8192 --log-disable &`}</pre>
        </div>
      )}
    </div>
  );
}
