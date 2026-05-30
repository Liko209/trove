// Pinned in the page header. Hidden when nothing is running.
// Click → navigate to /jobs.

import { Link } from "react-router-dom";
import { useJobs } from "../lib/useJobs.ts";

export function GlobalJobIndicator() {
  const { active } = useJobs(2000);
  if (active.length === 0) return null;

  const j = active[0];
  const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;

  return (
    <Link
      to="/jobs"
      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-stone-900 text-white text-xs font-medium hover:bg-stone-700"
      title={`${j.description}\n${j.done}/${j.total} done · ${j.errors} errors`}
    >
      <span className="relative inline-flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
      </span>
      <span className="truncate max-w-[180px]">{j.description}</span>
      <span className="tabular-nums">{pct}%</span>
      {active.length > 1 && (
        <span className="bg-white/20 px-1.5 py-0.5 rounded">+{active.length - 1}</span>
      )}
    </Link>
  );
}
