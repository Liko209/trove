// Home — the first thing a user sees after onboarding.
// Goals:
//   1. Tell them what they have (counts).
//   2. Show what's actively happening (live job, if any).
//   3. Surface the next thing they probably want to do.
//   4. Confirm their AI tools are connected.
//
// Deliberately not a technical dashboard.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type Stats,
  type Health,
  type Job,
  type ClaudeConfigInfo,
} from "../lib/api.ts";
import { formatDurationSeconds } from "../lib/format.ts";
import { useJobs } from "../lib/useJobs.ts";
import {
  UpdateAvailableCard,
  AboutBitrove,
} from "../components/UpdateSection.tsx";

type ModelStatus = {
  id: "embed" | "rerank";
  filename: string;
  displayName: string;
  status: "missing" | "downloading" | "verifying" | "ready" | "error";
  totalBytes?: number;
  downloadedBytes?: number;
  error?: string;
};

type ModelCatalogEntry = {
  id: "embed" | "rerank";
  filename: string;
  displayName: string;
  approxBytes: number;
  url: string;
};

declare global {
  interface Window {
    bitrove?: {
      pickFolder: () => Promise<string | null>;
      autodetectSources?: () => Promise<{ path: string; label: string; exists: boolean }[]>;
      listModels?: () => Promise<{
        catalog: ModelCatalogEntry[];
        statuses: Record<string, ModelStatus>;
      }>;
      onModelsUpdate?: (cb: (s: Record<string, ModelStatus>) => void) => () => void;
    };
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <div className="text-[11px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-stone-900 tabular-nums leading-none">
        {value}
      </div>
      {hint && <div className="mt-2 text-xs text-stone-500">{hint}</div>}
    </div>
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
      className="block bg-white rounded-xl border border-stone-200 hover:border-stone-300 hover:shadow-sm transition p-5"
    >
      <div className="flex items-center gap-3 mb-3">
        <span className="relative h-2.5 w-2.5">
          <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
        <div className="text-sm font-medium text-stone-900 truncate flex-1">
          {job.description}
        </div>
        <div className="text-stone-400 text-sm">View →</div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-stone-500">Progress</div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none mt-1">
            {pct}%
          </div>
          <div className="text-xs text-stone-500 mt-1 tabular-nums">
            {job.done.toLocaleString()} / {job.total.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-stone-500">Time left</div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none mt-1">
            {formatDurationSeconds(remaining)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-stone-500">New</div>
          <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none mt-1">
            +{job.ingested}
          </div>
        </div>
      </div>

      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-stone-900 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Link>
  );
}

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [claude, setClaude] = useState<ClaudeConfigInfo | null>(null);
  const [models, setModels] = useState<{
    catalog: ModelCatalogEntry[];
    statuses: Record<string, ModelStatus>;
  } | null>(null);
  const { active } = useJobs(3000);

  useEffect(() => {
    const bridge = window.bitrove;
    if (!bridge?.listModels) return;
    bridge.listModels().then(setModels).catch(() => {});
    return bridge.onModelsUpdate?.((statuses) => {
      setModels((prev) => (prev ? { ...prev, statuses } : prev));
    });
  }, []);

  async function refresh() {
    try {
      const [s, h, c] = await Promise.all([
        api.stats(),
        api.health(),
        api.claudeConfig().catch(() => null),
      ]);
      setStats(s);
      setHealth(h);
      setClaude(c);
    } catch {}
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, []);

  const totalFiles = stats?.total.sources ?? 0;
  const totalChunks = stats?.total.chunks ?? 0;
  const empty = totalFiles === 0;
  const claudeConnected =
    claude?.detected.some((d) => d.exists && d.hasTroveEntry) ?? false;
  const claudeInstalled = claude?.detected.some((d) => d.exists) ?? false;
  const servicesOk = !!(health?.embed && health?.rerank);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold text-stone-900 mb-1">Welcome back</h1>
      <p className="text-stone-600 text-sm mb-8">
        Your private knowledge layer is{" "}
        {servicesOk ? (
          <span className="text-emerald-700 font-medium">running</span>
        ) : (
          <span className="text-amber-700 font-medium">warming up</span>
        )}
        .
      </p>

      {empty ? (
        <EmptyHero />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <StatCard
            label="Documents"
            value={totalFiles.toLocaleString()}
            hint={
              stats
                ? stats.byKind.map((k) => `${k.sources} ${k.kind}`).join(" · ")
                : undefined
            }
          />
          <StatCard
            label="Searchable chunks"
            value={totalChunks.toLocaleString()}
          />
          <StatCard
            label="Library size"
            value={stats ? bytes(stats.dbSize) : "—"}
            hint="On this Mac only"
          />
        </div>
      )}

      <UpdateAvailableCard />

      {active.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
            Happening now
          </h2>
          <div className="space-y-3">
            {active.map((j) => (
              <ActiveJobCard key={j.id} job={j} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            to="/add"
            className="block bg-white rounded-xl border border-stone-200 hover:border-stone-400 hover:shadow-sm transition p-5"
          >
            <div className="flex items-start gap-3">
              <div className="text-2xl">📂</div>
              <div className="flex-1">
                <div className="font-medium text-stone-900">Add more sources</div>
                <div className="text-sm text-stone-500 mt-0.5">
                  Pick a folder for Bitrove to index.
                </div>
              </div>
            </div>
          </Link>

          <Link
            to="/library"
            className="block bg-white rounded-xl border border-stone-200 hover:border-stone-400 hover:shadow-sm transition p-5"
          >
            <div className="flex items-start gap-3">
              <div className="text-2xl">📚</div>
              <div className="flex-1">
                <div className="font-medium text-stone-900">Browse your library</div>
                <div className="text-sm text-stone-500 mt-0.5">
                  See what's indexed, by folder or by topic.
                </div>
              </div>
            </div>
          </Link>
        </div>
      </section>

      {models && models.catalog.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
            On-device models
          </h2>
          <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
            {models.catalog.map((m) => (
              <ModelRow
                key={m.id}
                catalog={m}
                status={models.statuses[m.id]}
                serviceHealthy={
                  m.id === "embed" ? !!health?.embed : !!health?.rerank
                }
              />
            ))}
          </div>
          <p className="text-xs text-stone-500 mt-2">
            All inference runs on this Mac. No model API calls leave the device.
          </p>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          AI tools
        </h2>
        <Link
          to="/agents"
          className="block bg-white rounded-xl border border-stone-200 hover:border-stone-400 hover:shadow-sm transition p-5"
        >
          <div className="flex items-center gap-4">
            <div className="text-2xl">🤖</div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-stone-900">
                {claudeConnected
                  ? "Claude Code is connected"
                  : claudeInstalled
                    ? "Connect Claude Code"
                    : "Set up an AI agent"}
              </div>
              <div className="text-sm text-stone-500 mt-0.5">
                {claudeConnected
                  ? "Ask Claude Code anything about your documents."
                  : "Let AI tools search your library."}
              </div>
            </div>
            <div
              className={
                "shrink-0 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full " +
                (claudeConnected
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-stone-100 text-stone-700")
              }
            >
              <span
                className={
                  "w-1.5 h-1.5 rounded-full " +
                  (claudeConnected ? "bg-emerald-500" : "bg-stone-400")
                }
              />
              {claudeConnected ? "Connected" : "Not connected"}
            </div>
          </div>
        </Link>
      </section>

      <AboutBitrove />
    </div>
  );
}

function ModelRow({
  catalog,
  status,
  serviceHealthy,
}: {
  catalog: ModelCatalogEntry;
  status?: ModelStatus;
  serviceHealthy: boolean;
}) {
  const state = !status
    ? "unknown"
    : status.status === "ready"
      ? serviceHealthy
        ? "running"
        : "loaded"
      : status.status;

  const pill: Record<string, { label: string; dot: string; text: string }> = {
    running: { label: "Running", dot: "bg-emerald-500", text: "text-emerald-700" },
    loaded: { label: "Loaded", dot: "bg-stone-400", text: "text-stone-700" },
    missing: { label: "Not downloaded", dot: "bg-stone-300", text: "text-stone-600" },
    downloading: { label: "Downloading", dot: "bg-sky-500", text: "text-sky-700" },
    verifying: { label: "Verifying", dot: "bg-sky-500", text: "text-sky-700" },
    error: { label: "Error", dot: "bg-rose-500", text: "text-rose-700" },
    unknown: { label: "Unknown", dot: "bg-stone-300", text: "text-stone-600" },
  };
  const p = pill[state];

  return (
    <div className="px-4 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-stone-900">{catalog.displayName}</span>
          <span
            className={
              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 " +
              p.text
            }
          >
            <span className={"w-1.5 h-1.5 rounded-full " + p.dot} />
            {p.label}
          </span>
        </div>
        <div className="text-xs text-stone-500 mt-0.5 font-mono truncate">
          {catalog.filename}
        </div>
        {status?.error && (
          <div className="text-xs text-rose-700 mt-1">{status.error}</div>
        )}
      </div>
      <div className="text-right">
        <div className="text-sm tabular-nums text-stone-700">
          {bytes(catalog.approxBytes)}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-stone-400 mt-0.5">
          Q4_K_M
        </div>
      </div>
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="bg-gradient-to-br from-stone-50 to-stone-100/50 border border-stone-200 rounded-2xl p-8 mb-8">
      <div className="max-w-md">
        <div className="text-4xl mb-3">📚</div>
        <h2 className="text-xl font-semibold text-stone-900 mb-2">
          Your library is empty
        </h2>
        <p className="text-sm text-stone-600 mb-5">
          Add a folder you'd like to make searchable. Bitrove will read the documents
          inside, index them on this Mac, and never send anything to the cloud.
        </p>
        <Link
          to="/add"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-stone-900 text-white text-sm font-medium hover:bg-stone-700"
        >
          Add your first folder →
        </Link>
      </div>
    </div>
  );
}
