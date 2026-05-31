// /jobs — full list of every recorded indexing job (active +
// terminal), with filter + click-through to /jobs/:id detail.
//
// Active rows show live progress %; terminal rows show outcome
// counters. All rows link to the detail view; the active card
// inside JobProgress is rendered there, not inline here, so this
// page stays a list, not a dashboard.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useJobs } from "../lib/useJobs.ts";
import type { Job } from "../lib/api.ts";
import { formatDurationSeconds } from "../lib/format.ts";
import { relativeTime } from "../components/JobsWidgets.tsx";

type Filter = "all" | "active" | "done" | "failed" | "stopped";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
  { id: "stopped", label: "Paused" },
];

export default function Jobs() {
  const { jobs } = useJobs(2000);
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return jobs;
    if (filter === "active")
      return jobs.filter((j) => j.status === "running" || j.status === "queued");
    return jobs.filter((j) => j.status === filter);
  }, [jobs, filter]);

  const counts: Record<Filter, number> = {
    all: jobs.length,
    active: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
    done: jobs.filter((j) => j.status === "done").length,
    failed: jobs.filter((j) => j.status === "failed").length,
    stopped: jobs.filter((j) => j.status === "stopped").length,
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <Link
          to="/dashboard"
          className="text-xs text-stone-500 hover:text-stone-900 underline-offset-2 hover:underline"
        >
          ← Back to Dashboard
        </Link>
      </div>
      <div className="flex items-baseline gap-3 mb-6">
        <h1 className="t-display">Jobs</h1>
        <span className="text-stone-500 text-sm">
          {jobs.length.toLocaleString()} recorded
        </span>
      </div>

      <div className="flex gap-1 mb-5 border-b border-stone-200">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition " +
              (filter === f.id
                ? "border-stone-900 text-stone-900"
                : "border-transparent text-stone-500 hover:text-stone-800")
            }
          >
            {f.label}
            <span className={"ml-1.5 tabular-nums text-xs " + (filter === f.id ? "text-stone-500" : "text-stone-400")}>
              {counts[f.id]}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-stone-500 py-12 text-center bg-white border border-stone-200 rounded-xl">
          {filter === "all"
            ? "No jobs recorded yet. Start a scan from the Dashboard."
            : `No jobs match the "${FILTERS.find((f) => f.id === filter)?.label}" filter.`}
        </div>
      ) : (
        <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100 overflow-hidden">
          {filtered.map((j) => (
            <JobListRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobListRow({ job }: { job: Job }) {
  const isActive = job.status === "running" || job.status === "queued";
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const dur = job.finishedAt
    ? (job.finishedAt - job.startedAt) / 1000
    : (Date.now() - job.startedAt) / 1000;
  const dotCls =
    job.status === "running"
      ? "bg-emerald-500"
      : job.status === "queued"
        ? "bg-stone-400"
        : job.status === "done"
          ? "bg-emerald-500"
          : job.status === "failed"
            ? "bg-rose-500"
            : "bg-amber-500";
  const stateLabel: Record<Job["status"], string> = {
    queued: "Queued",
    running: "Running",
    done: "Done",
    failed: "Failed",
    stopped: "Paused",
  };
  const when = job.finishedAt ? relativeTime(job.finishedAt) : relativeTime(job.startedAt);
  return (
    <Link to={`/jobs/${job.id}`} className="block px-4 py-3 hover:bg-stone-50 transition">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="relative inline-block h-2 w-2 shrink-0">
          {isActive && (
            <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-50" />
          )}
          <span className={"absolute inset-0 rounded-full " + dotCls} />
        </span>
        <span className="font-medium text-stone-900 truncate flex-1" title={job.description}>
          {job.description}
        </span>
        <span className="t-section shrink-0">{stateLabel[job.status]}</span>
      </div>
      <div className="flex items-baseline gap-3 text-xs text-stone-500 pl-5 tabular-nums">
        <span>
          {job.done.toLocaleString()} / {job.total.toLocaleString()} files
        </span>
        <span className="text-stone-400">·</span>
        <span>+{job.ingested.toLocaleString()} indexed</span>
        {job.errors > 0 && (
          <>
            <span className="text-stone-400">·</span>
            <span className="text-rose-700">{job.errors} error{job.errors === 1 ? "" : "s"}</span>
          </>
        )}
        <span className="ml-auto">{when}</span>
        <span className="text-stone-400 hidden sm:inline">· {formatDurationSeconds(dur)}</span>
      </div>
      {isActive && (
        <div className="mt-2 ml-5 h-1 bg-stone-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-stone-900 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </Link>
  );
}
