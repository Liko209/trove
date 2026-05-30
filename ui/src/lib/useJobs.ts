// Poll /api/ingest/jobs at a fixed interval so any page can react to
// in-flight or recently-finished ingest / classify / scan jobs without
// holding open an SSE stream.

import { useEffect, useRef, useState } from "react";
import { api, type Job } from "./api.ts";

export function useJobs(pollIntervalMs = 2000): { jobs: Job[]; active: Job[]; recent: Job[] } {
  const [jobs, setJobs] = useState<Job[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const r = await api.listJobs();
        if (mountedRef.current) setJobs(r.jobs);
      } catch {
        // swallow — admin server may be restarting
      }
      if (mountedRef.current) {
        timer = setTimeout(tick, pollIntervalMs);
      }
    };
    tick();

    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollIntervalMs]);

  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const recent = jobs
    .filter((j) => j.status === "done" || j.status === "failed")
    .slice(0, 20);
  return { jobs, active, recent };
}
