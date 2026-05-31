import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  duplicates?: number;
  duplicateSamples?: { path: string; duplicateOf: string }[];
};

type ItemStatus =
  | "ingested"
  | "skipped-cached"
  | "skipped-mtime-touched"
  | "aliased-duplicate"
  | "skipped-unsupported"
  | "error";

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
  "skipped-mtime-touched": { ch: "↻", cls: "text-stone-400" },
  "aliased-duplicate": { ch: "=", cls: "text-sky-600" },
  "skipped-unsupported": { ch: "—", cls: "text-stone-400" },
  error: { ch: "✗", cls: "text-rose-600" },
};

function LogLine({ entry }: { entry: LogEntry }) {
  const { name, dir } = splitPath(entry.path);
  const icon = LOG_ICON[entry.status];
  const isError = entry.status === "error";
  // Error rows render as a two-row block: top is icon + filename +
  // path, bottom is the full error message in its own padded block.
  // Non-error rows stay single-line and compact.
  if (isError) {
    return (
      <div className="px-4 py-2 bg-rose-50/70 hover:bg-rose-50 border-l-2 border-rose-300 my-1">
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className={`shrink-0 w-3 inline-block text-center ${icon.cls}`}>
            {icon.ch}
          </span>
          <span className="text-rose-900 font-medium truncate" title={entry.path}>
            {name}
          </span>
          <span className="text-stone-500 truncate text-[10px]">{dir}</span>
        </div>
        {entry.error && (
          <div className="ml-5 px-3 py-2 rounded bg-white border border-rose-100 text-rose-800 text-[11px] leading-relaxed font-sans break-words whitespace-pre-wrap">
            {entry.error}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="px-4 py-0.5 flex items-baseline gap-2 hover:bg-stone-100/60">
      <span className={`shrink-0 w-3 inline-block text-center ${icon.cls}`}>{icon.ch}</span>
      <span className="text-stone-800 truncate" title={entry.path}>
        {name}
      </span>
      <span className="text-stone-500 truncate text-[10px]">{dir}</span>
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
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [dupSummary, setDupSummary] = useState<{
    count: number;
    samples: { path: string; duplicateOf: string }[];
  } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getJob(jobId)
      .then((j) => {
        setJob(j);
        // Backfill the activity log with persisted error events so a
        // user opening a finished job sees specific failures instead
        // of "(no per-file events captured in this stream)". Successful
        // items aren't persisted (too noisy), but errors are exactly
        // the reason someone opens a failed job after the fact.
        if (j.errorEvents && j.errorEvents.length > 0) {
          setLog(
            j.errorEvents.map((e) => ({
              ts: e.ts,
              status: "error" as const,
              path: e.path,
              error: e.error,
            })),
          );
        }
      })
      .catch(() => {});
    const stop = api.streamJob(jobId, (raw) => {
      const ev = raw as StreamEvent | Job;
      if ("status" in ev && "kind" in ev && "id" in ev) {
        setJob(ev as Job);
        return;
      }
      const e = ev as StreamEvent;
      if ((e.type === "done" || e.type === "stopped") && (e.duplicates ?? 0) > 0) {
        setDupSummary({
          count: e.duplicates ?? 0,
          samples: e.duplicateSamples ?? [],
        });
      }
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

  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const handleRetry = async () => {
    setRetrying(true);
    try {
      const r = await api.retryFailed(jobId);
      navigate(`/jobs/${r.jobId}`);
    } catch (e) {
      alert((e as Error).message);
      setRetrying(false);
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
          {isTerminal && (job.errorEvents?.length ?? 0) > 0 && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-stone-900 hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium border border-stone-900"
              title="Re-ingest only the files that errored. Skips files that no longer exist on disk."
            >
              ↻
              {retrying
                ? "Starting…"
                : `Retry ${job.errorEvents!.length} failed file${job.errorEvents!.length === 1 ? "" : "s"}`}
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
            className="h-full bg-stone-900 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* ── Now-processing strip (only while running) ──────────────────── */}
      {!isTerminal && job.current && (() => {
        const { name, dir } = splitPath(job.current);
        return (
          <div className="px-6 py-3 bg-emerald-50/60 border-b border-emerald-100 flex items-center gap-3">
            <div className="shrink-0 w-4 h-4 border-2 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 shrink-0">
              Now
            </span>
            <span className="text-sm font-medium text-stone-900 truncate" title={job.current}>
              {name}
            </span>
            <span className="text-xs text-stone-500 truncate font-mono">{dir}</span>
          </div>
        );
      })()}

      {/* ── Alias summary (terminal) ───────────────────────────────────── */}
      {isTerminal && dupSummary && dupSummary.count > 0 && (
        <div className="px-6 py-3 bg-sky-50 border-b border-sky-200 text-sm text-sky-900">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-semibold">
              {dupSummary.count.toLocaleString()}{" "}
              file{dupSummary.count === 1 ? "" : "s"} linked as aliases
            </span>
            <span className="text-xs text-sky-700">
              — identical content was already indexed; we point search at this path too
            </span>
          </div>
          {dupSummary.samples.length > 0 && (
            <ul className="text-xs font-mono space-y-0.5 mt-1">
              {dupSummary.samples.slice(0, 3).map((s) => {
                const a = s.path.slice(s.path.lastIndexOf("/") + 1);
                const b = s.duplicateOf.slice(s.duplicateOf.lastIndexOf("/") + 1);
                return (
                  <li key={s.path} className="truncate" title={`${s.path}\n→ ${s.duplicateOf}`}>
                    {a} <span className="text-sky-600">→</span> {b}
                  </li>
                );
              })}
              {dupSummary.count > 3 && (
                <li className="text-sky-700 not-italic">+ {dupSummary.count - 3} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* ── Fatal error (job died before/instead of per-file events) ───── */}
      {job.status === "failed" && job.fatalError && (
        <div className="px-6 py-4 bg-rose-50 border-b border-rose-200 text-sm">
          <div className="t-section text-rose-700 mb-1">Job failed</div>
          <div className="text-rose-900 leading-relaxed whitespace-pre-wrap break-words font-mono text-[12px]">
            {job.fatalError}
          </div>
        </div>
      )}

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
      {(() => {
        const errorCount = log.filter((l) => l.status === "error").length;
        const visibleLog = errorsOnly ? log.filter((l) => l.status === "error") : log;
        return (
          <div className="bg-stone-50">
            <div className="px-4 py-2 border-b border-stone-200 flex items-center text-[11px] gap-3">
              <span className="text-stone-500 uppercase tracking-wider font-medium">
                Activity log
              </span>
              <span className="text-stone-400 tabular-nums">{log.length}</span>
              {errorCount > 0 && (
                <button
                  type="button"
                  onClick={() => setErrorsOnly((v) => !v)}
                  className={
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium tabular-nums transition " +
                    (errorsOnly
                      ? "bg-rose-600 text-white"
                      : "bg-rose-100 text-rose-800 hover:bg-rose-200")
                  }
                  title={errorsOnly ? "Show everything" : "Show only the failed files"}
                >
                  <span>✗</span> {errorCount} error{errorCount === 1 ? "" : "s"}
                  {errorsOnly && <span className="ml-1 opacity-80">× clear</span>}
                </button>
              )}
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
              {visibleLog.map((e, i) => (
                <LogLine key={i} entry={e} />
              ))}
              {visibleLog.length === 0 && (
                <div className="text-stone-500 italic px-4 py-2">
                  {errorsOnly
                    ? "No errors. Nice."
                    : isTerminal
                      ? "(no per-file events captured in this stream)"
                      : "Waiting for first file…"}
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
