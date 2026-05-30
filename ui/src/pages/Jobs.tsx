import { useJobs } from "../lib/useJobs.ts";
import JobProgress from "../components/JobProgress.tsx";
import type { Job } from "../lib/api.ts";

function StatusBadge({ status }: { status: Job["status"] }) {
  const cls =
    status === "done"
      ? "bg-emerald-100 text-emerald-800"
      : status === "failed"
        ? "bg-rose-100 text-rose-800"
        : status === "running"
          ? "bg-sky-100 text-sky-800"
          : "bg-stone-100 text-stone-700";
  return (
    <span className={`text-xs px-2 py-0.5 rounded uppercase font-semibold ${cls}`}>
      {status}
    </span>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

function RecentRow({ j }: { j: Job }) {
  const dur = j.finishedAt ? j.finishedAt - j.startedAt : Date.now() - j.startedAt;
  return (
    <tr className="hover:bg-stone-50">
      <td className="px-3 py-2">
        <StatusBadge status={j.status} />
      </td>
      <td className="px-3 py-2 text-sm text-stone-900">{j.description}</td>
      <td className="px-3 py-2 text-sm text-stone-700 tabular-nums">{j.kind}</td>
      <td className="px-3 py-2 text-sm text-stone-700 tabular-nums">
        {j.done}/{j.total}
      </td>
      <td className="px-3 py-2 text-sm text-stone-700 tabular-nums">{j.ingested ?? 0}</td>
      <td
        className={
          "px-3 py-2 text-sm tabular-nums " + (j.errors > 0 ? "text-rose-700 font-medium" : "text-stone-500")
        }
      >
        {j.errors}
      </td>
      <td className="px-3 py-2 text-sm text-stone-500 tabular-nums">{fmtDuration(dur)}</td>
      <td className="px-3 py-2 text-xs text-stone-400 font-mono">{j.id.slice(0, 8)}</td>
    </tr>
  );
}

export default function Jobs() {
  const { active, recent, jobs } = useJobs(2000);

  return (
    <div>
      <div className="flex items-baseline mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Jobs</h1>
        <span className="ml-3 text-stone-500 text-sm">
          {active.length} active · {recent.length} recent · {jobs.length} total
        </span>
      </div>

      <section className="mb-10">
        <h2 className="text-sm font-semibold text-stone-600 uppercase tracking-wider mb-3">
          Active
        </h2>
        {active.length === 0 ? (
          <div className="bg-white border border-dashed border-stone-300 rounded-lg p-6 text-center text-stone-500 text-sm">
            No active jobs. Start an ingest from the <a className="underline" href="/add">Add</a> page,
            or trigger classification from <a className="underline" href="/">Library → By topic</a>.
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((j) => (
              <JobProgress key={j.id} jobId={j.id} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-stone-600 uppercase tracking-wider mb-3">
          Recent
        </h2>
        {recent.length === 0 ? (
          <div className="text-stone-500 text-sm">(none yet)</div>
        ) : (
          <div className="bg-white rounded-lg border border-stone-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-stone-600 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-left">Kind</th>
                  <th className="px-3 py-2 text-left">Done/Total</th>
                  <th className="px-3 py-2 text-left">Ingested</th>
                  <th className="px-3 py-2 text-left">Errors</th>
                  <th className="px-3 py-2 text-left">Duration</th>
                  <th className="px-3 py-2 text-left">ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recent.map((j) => (
                  <RecentRow key={j.id} j={j} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
