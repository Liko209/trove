import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../lib/api.ts";
import { splitPath, formatDurationSeconds } from "../lib/format.ts";

type StreamEvent = {
  type: "started" | "item" | "done" | "stopped" | "failed";
  done?: number;
  total?: number;
  current?: string;
  status?: ItemStatus;
  error?: string;
  ingested?: number;
  errors?: number;
};

type ItemStatus = "ingested" | "skipped-cached" | "skipped-unsupported" | "error";

type LogEntry = {
  ts: number;
  status: ItemStatus;
  path: string;
  error?: string;
};

// All chips share the same neutral pill; only the indicator dot carries the
// status hue — so the whole layout stays tonally consistent.
const STATUS_CHIP: Record<Job["status"], { label: string; dot: string }> = {
  queued: { label: "Queued", dot: "bg-stone-400" },
  running: { label: "Running", dot: "bg-emerald-500" },
  done: { label: "Completed", dot: "bg-emerald-500" },
  stopped: { label: "Paused", dot: "bg-amber-500" },
  failed: { label: "Failed", dot: "bg-rose-500" },
};

function StatusChip({ status }: { status: Job["status"] }) {
  const s = STATUS_CHIP[status];
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-700">
      <span className={`relative h-2 w-2 rounded-full ${s.dot}`}>
        {status === "running" && (
          <span className={`absolute inset-0 rounded-full ${s.dot} opacity-60 animate-ping`} />
        )}
      </span>
      {s.label}
    </span>
  );
}

const LOG_ICON: Record<ItemStatus, { ch: string; cls: string }> = {
  ingested: { ch: "+", cls: "text-stone-500" },
  "skipped-cached": { ch: "↻", cls: "text-stone-400" },
  "skipped-unsupported": { ch: "—", cls: "text-stone-400" },
  error: { ch: "✗", cls: "text-rose-600" },
};

function LogLine({ entry }: { entry: LogEntry }) {
  const { name, dir } = splitPath(entry.path);
  const icon = LOG_ICON[entry.status];
  return (
    <div className="px-4 py-0.5 hover:bg-stone-100/60 flex items-baseline gap-2">
      <span className={`shrink-0 w-3 inline-block text-center ${icon.cls}`}>{icon.ch}</span>
      <span className="text-stone-800 truncate" title={entry.path}>{name}</span>
      <span className="text-stone-500 truncate text-[10px]">{dir}</span>
      {entry.error && <span className="text-rose-600 truncate ml-auto pl-2">{entry.error}</span>}
    </div>
  );
}

const MAX_LOG = 200;

export default function JobProgress({
  jobId,
  onDone,
}: {
  jobId: string;
  onDone?: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stopRequested, setStopRequested] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getJob(jobId).then(setJob).catch(() => {});
    const stop = api.streamJob(jobId, (raw) => {
      const ev = raw as StreamEvent | Job;
      if ("status" in ev && "kind" in ev && "id" in ev) {
        setJob(ev as Job);
        return;
      }
      const e = ev as StreamEvent;
      setJob((prev) =>
        prev
          ? {
              ...prev,
              total: e.total ?? prev.total,
              done: e.done ?? prev.done,
              current: e.current ?? prev.current,
              status:
                e.type === "done"
                  ? "done"
                  : e.type === "stopped"
                    ? "stopped"
                    : e.type === "failed"
                      ? "failed"
                      : "running",
              ingested: e.ingested ?? prev.ingested,
              errors: e.errors ?? prev.errors,
              finishedAt:
                e.type === "done" || e.type === "failed" || e.type === "stopped"
                  ? Date.now()
                  : prev.finishedAt,
            }
          : prev,
      );
      if (e.type === "done" || e.type === "failed" || e.type === "stopped") {
        if (onDone) setTimeout(onDone, 600);
      }
      if (e.type === "item" && e.current && e.status) {
        const entry: LogEntry = {
          ts: Date.now(),
          status: e.status,
          path: e.current,
          error: e.error,
        };
        setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), entry]);
      }
    });
    return stop;
  }, [jobId]);

  // Auto-scroll log to bottom on new entries.
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log.length, autoScroll]);

  const handleStop = async () => {
    setStopRequested(true);
    try {
      await api.stopJob(jobId);
    } catch (e) {
      alert((e as Error).message);
      setStopRequested(false);
    }
  };

  if (!job) return <div className="text-sm text-stone-500">Loading job…</div>;

  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const rate = elapsed > 0 ? job.done / elapsed : 0;
  const remaining = rate > 0 ? (job.total - job.done) / rate : Infinity;
  const isTerminal = job.status === "done" || job.status === "failed" || job.status === "stopped";
  const canStop = job.status === "running" || job.status === "queued";
  const cached = Math.max(0, job.done - job.ingested - job.errors);

  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden shadow-sm">
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-4 border-b border-stone-100">
        <div className="flex items-start gap-3 mb-5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-base font-semibold text-stone-900 truncate">
                {job.description}
              </h2>
              <StatusChip status={job.status} />
            </div>
            <div className="text-xs text-stone-500">
              {job.kind === "scan" ? "Recursive folder scan" : "Targeted file ingestion"}
            </div>
          </div>
          {canStop && (
            <button
              onClick={handleStop}
              disabled={stopRequested}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-white hover:bg-stone-50 disabled:opacity-50 disabled:cursor-not-allowed text-stone-700 font-medium border border-stone-300"
              title="Finishes current file then pauses. Re-run the same scan to resume — cached files skip via mtime."
            >
              <svg width="10" height="10" viewBox="0 0 10 10" className="fill-current">
                <rect x="2" y="2" width="2.5" height="6" rx="0.5" />
                <rect x="5.5" y="2" width="2.5" height="6" rx="0.5" />
              </svg>
              {stopRequested ? "Stopping…" : "Pause after current"}
            </button>
          )}
        </div>

        {/* 3-up stat grid */}
        <div className="grid grid-cols-3 gap-6 mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">Progress</div>
            <div className="text-2xl font-semibold text-stone-900 tabular-nums leading-none">
              {pct}<span className="text-base text-stone-400">%</span>
            </div>
            <div className="text-xs text-stone-500 tabular-nums mt-1">
              {job.done.toLocaleString()} / {job.total.toLocaleString()} files
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">
              {isTerminal ? "Total time" : "Time remaining"}
            </div>
            <div className="text-2xl font-semibold text-stone-900 tabular-nums leading-none">
              {isTerminal ? formatDurationSeconds(elapsed) : formatDurationSeconds(remaining)}
            </div>
            <div className="text-xs text-stone-500 tabular-nums mt-1">
              {rate >= 1 ? `${rate.toFixed(1)} files/sec` : `${(rate * 60).toFixed(1)} files/min`}
              {!isTerminal && (
                <span className="text-stone-400"> · {formatDurationSeconds(elapsed)} elapsed</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500 mb-1">Outcome</div>
            <div className="flex items-baseline gap-3 leading-none text-xl font-semibold tabular-nums text-stone-900">
              <span>
                <span className="text-stone-400 font-normal">+</span>
                {job.ingested.toLocaleString()}
              </span>
              <span className="text-stone-500">
                <span className="text-stone-400 font-normal">↻</span>
                {cached.toLocaleString()}
              </span>
              <span className={job.errors > 0 ? "text-rose-700" : "text-stone-300"}>
                <span className={job.errors > 0 ? "" : "font-normal"}>✗</span>
                {job.errors.toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-stone-500 mt-1">new · cached · errors</div>
          </div>
        </div>

        {/* Progress bar — single neutral fill; status conveyed by chip + dot */}
        <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-stone-900 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Now-processing strip (only while running) ──────────────────── */}
      {!isTerminal && job.current && (() => {
        const { name, dir } = splitPath(job.current);
        return (
          <div className="px-6 py-2.5 bg-stone-50 border-b border-stone-100 flex items-center gap-2.5">
            <div className="shrink-0 w-3 h-3 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
            <span className="text-[10px] uppercase tracking-wider text-stone-500 shrink-0">
              Now
            </span>
            <span className="text-sm font-medium text-stone-900 truncate" title={job.current}>
              {name}
            </span>
            <span className="text-xs text-stone-500 truncate font-mono">{dir}</span>
          </div>
        );
      })()}

      {/* ── Stopped help ───────────────────────────────────────────────── */}
      {job.status === "stopped" && (
        <div className="px-6 py-3 bg-stone-50 border-b border-stone-200 text-sm text-stone-700 flex items-start gap-2">
          <span className="shrink-0 text-stone-500">⏸</span>
          <span>
            Paused after current file. <strong>To resume:</strong> run the same scan or ingest
            again — already-indexed files will be skipped automatically (mtime cache).
          </span>
        </div>
      )}

      {/* ── Activity log ─────────────────────────────────────────────── */}
      <div className="bg-stone-50">
        <div className="px-4 py-2 border-b border-stone-200 flex items-center text-[11px]">
          <span className="text-stone-500 uppercase tracking-wider font-medium">
            Activity log
          </span>
          <span className="ml-2 text-stone-400 tabular-nums">{log.length}</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-stone-400 hidden sm:inline">
              <span className="text-stone-500">+</span> new
              <span className="ml-2 text-stone-400">↻</span> cached
              <span className="ml-2 text-rose-600">✗</span> error
            </span>
            <label className="text-stone-500 flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="accent-stone-700"
              />
              Auto-scroll
            </label>
          </span>
        </div>
        <div
          ref={logRef}
          className="overflow-y-auto h-72 font-mono text-[11px] leading-relaxed py-1"
        >
          {log.map((e, i) => (
            <LogLine key={i} entry={e} />
          ))}
          {log.length === 0 && (
            <div className="text-stone-500 italic px-4 py-2">
              {isTerminal
                ? "(no per-file events captured in this stream)"
                : "Waiting for first file…"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
