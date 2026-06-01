// Thin API client for the local-kb admin server

export type Health = { embed: boolean; rerank: boolean; embed_url: string; rerank_url: string };

export type Stats = {
  byKind: { kind: string; sources: number; chunks: number }[];
  total: { sources: number; chunks: number };
  dbPath: string;
  dbSize: number;
  indexedBytes: number;
  // Count of indexed files that produced no searchable text — almost
  // always image-only / scanned PDFs without a text layer. Used by
  // the Dashboard and the Settings → Models OCR section.
  ocrPending: number;
};

export type FileBucket =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "slide"
  | "book"
  | "markdown"
  | "text"
  | "other";

export type SourceRow = {
  source_path: string;
  kind: "text" | "catalog";
  chunk_count: number;
  source_mtime: string;
  indexed_at: string;
  name: string;
  ext: string;
  bucket: FileBucket;
  size_bytes: number;
  category: string;
  subcategory?: string;
  // Strategy B aliases — alternate paths whose contents hash to the
  // same xxh3 as this source. Empty for sources with no duplicates.
  aliases?: string[];
  // 1 if the file produced no extractable text (e.g. image-only
  // scanned PDF). UI surfaces an "Image-only" badge and the
  // Settings → Models OCR toggle batches these for Vision OCR.
  needs_ocr?: 0 | 1;
  // Plaintext error from the most recent failed ingest, NULL on
  // success or never tried. UI shows a ⚠ marker with this as the
  // tooltip body so users can see *why* a row is broken without
  // digging through logs.
  last_error?: string | null;
};

export type SourceList = {
  total: number;
  returned: number;
  offset: number;
  rows: SourceRow[];
};

export type LibraryGroup = {
  category: string;
  total: number;
  text: number;
  catalog: number;
  total_size: number;
  latest_mtime: string;
  sample: SourceRow[];
};

export type LibraryGroups = {
  groups: LibraryGroup[];
  total_categories: number;
  total_files: number;
  untagged?: number;
};

export type BrowseEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  indexable: "text" | "catalog" | "skip";
};

export type Browse = { path: string; parent: string | null; entries: BrowseEntry[] };

export type Job = {
  id: string;
  kind: "ingest" | "scan";
  status: "queued" | "running" | "done" | "failed" | "stopped";
  total: number;
  done: number;
  ingested: number;
  errors: number;
  current: string;
  startedAt: number;
  finishedAt?: number;
  description: string;
  // Per-error history bounded at 500 entries. Surfaced in JobProgress
  // so a user opening a finished failed job sees specific reasons,
  // not just the count.
  errorEvents?: { ts: number; path: string; error: string }[];
  // Per-item event history (success + skip + error), capped at 5k
  // entries. Sent inside the SSE snapshot so a late-joining client
  // can render the activity log that already happened — without
  // this, the row count silently lagged `done` by however many
  // events fired before the EventSource connected.
  recentItems?: {
    ts: number;
    path: string;
    status:
      | "ingested"
      | "skipped-cached"
      | "skipped-unsupported"
      | "error"
      | "skipped-mtime-touched"
      | "aliased-duplicate";
    error?: string;
  }[];
  // Fatal error message for jobs that died before processing any
  // per-file events (e.g. permission denied at the root).
  fatalError?: string;
};

async function j<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const r = await fetch(input, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export type ClaudeConfigInfo = {
  detected: { path: string; exists: boolean; hasBitroveEntry: boolean }[];
  suggested: { command: string; args: string[]; env?: Record<string, string> };
};

export const api = {
  health: () => j<Health>("/api/health"),
  stats: () => j<Stats>("/api/stats"),
  claudeConfig: () => j<ClaudeConfigInfo>("/api/agents/claude-config"),
  installClaudeConfig: (path: string) =>
    j<{ ok: true; backupCreated: boolean }>("/api/agents/claude-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  libraryGroups: () => j<LibraryGroups>("/api/library/groups"),
  libraryTopics: () => j<LibraryGroups>("/api/library/topics"),
  sourcePreview: (path: string) =>
    j<{
      path: string;
      text: number;
      catalog: number;
      skipped: number;
      totalScanned: number;
      cappedAt: number | null;
      totalBytes: number;
      estimatedSeconds: number;
      topExtensions: { ext: string; count: number; indexable: number }[];
      topFolders: { name: string; indexable: number; skipped: number; bytes: number }[];
      sampleFiles: {
        path: string;
        name: string;
        kind: "text" | "catalog";
        size: number;
      }[];
      excludedExts: string[];
      excludedByExt: { ext: string; count: number; indexable: number }[];
    }>(`/api/source-preview?path=${encodeURIComponent(path)}`),
  classify: (onlyMissing = false) =>
    j<{ jobId: string }>("/api/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ only_missing: onlyMissing }),
    }),
  sources: (params: {
    kind?: "text" | "catalog";
    path_contains?: string;
    path_prefix?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return j<SourceList>(`/api/sources?${q.toString()}`);
  },
  deleteSources: (paths: string[]) =>
    j<{ removed: number; chunks_removed: number }>("/api/sources", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    }),
  browse: (path?: string) =>
    j<Browse>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  ingestFiles: (paths: string[], force = false) =>
    j<{ jobId: string }>("/api/ingest/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths, force }),
    }),
  ingestScan: (
    root: string,
    opts: {
      force?: boolean;
      excludes?: string[];
      extraIncludeExts?: string[];
      // Phase 2: register the root with the file-watcher after the
      // initial scan finishes so changes get re-indexed automatically.
      watchAfterScan?: boolean;
    } = {},
  ) =>
    j<{ jobId: string }>("/api/ingest/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root,
        force: opts.force ?? false,
        excludes: opts.excludes ?? [],
        extraIncludeExts: opts.extraIncludeExts ?? [],
        watchAfterScan: opts.watchAfterScan ?? true,
      }),
    }),
  // First-run wizard support — list the top-level subdirs of a path
  // so the user can drill into ~/Documents/Notes instead of indexing
  // all of Documents in one shot.
  listSubdirs: (path: string) =>
    j<{
      root: string;
      subdirs: { name: string; path: string; estimate: number; size: number }[];
      // Immediate (non-subdir) files inside this folder. Already
      // filtered by classify() + the user's excluded extensions. Capped
      // at 500 — `truncated` flips true if the folder has more, with
      // totalImmediateFiles holding the raw count.
      files: { name: string; path: string; size: number; kind: "text" | "catalog" }[];
      truncated: boolean;
      totalImmediateFiles: number;
    }>(`/api/list-subdirs?path=${encodeURIComponent(path)}`),
  // Watched-roots CRUD + missing-file reconciliation.
  listWatchedRoots: () =>
    j<{
      rows: {
        path: string;
        added_at: number;
        last_scanned_at: number | null;
        last_completed_at: number | null;
        watch_enabled: number;
        stats: {
          path: string;
          indexed_files: number;
          total_chunks: number;
          total_size_bytes: number;
          missing_files: number;
          top_subdirs: { name: string; indexed: number; bytes: number }[];
        };
      }[];
      watcher: {
        initialized: boolean;
        active: {
          root: string;
          dirty: number;
          // Sample of dirty file paths (capped server-side at 20) so
          // expanded rows can show "Waiting to ingest: foo.pdf, …".
          dirtyPaths: string[];
          scanning: boolean;
          currentFile: string | null;
        }[];
      };
    }>("/api/watched-roots"),
  setWatchedRootEnabled: (path: string, enabled: boolean) =>
    j<{ ok: true }>("/api/watched-roots", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, enabled }),
    }),
  removeWatchedRoot: (path: string) =>
    j<{ ok: true }>("/api/watched-roots", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  listMissing: () =>
    j<{
      rows: {
        source_path: string;
        kind: "text" | "catalog";
        chunk_count: number;
        size_bytes: number | null;
        missing_since: number;
        watched_root: string | null;
      }[];
    }>("/api/missing-files"),
  deleteMissing: (paths: string[]) =>
    j<{ removed: number }>("/api/missing-files", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    }),
  getIngestSettings: () =>
    j<{
      current: {
        excludedExts: string[];
        excludedFolders: string[];
        watcherScanIntervalMin?: number;
        watcherDebounceMin?: number;
      };
      defaults: { excludedExts: string[]; excludedFolders: string[] };
      supportedTypes: { group: string; description: string; exts: string[] }[];
    }>("/api/settings/ingest"),
  saveIngestSettings: (s: {
    excludedExts: string[];
    excludedFolders: string[];
    watcherScanIntervalMin?: number;
    watcherDebounceMin?: number;
  }) =>
    j<typeof s>("/api/settings/ingest", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }),
  getActiveModelTier: () =>
    j<{ tier: "light" | "standard" | "quality" | "max" }>("/api/models/active"),
  setActiveModelTier: (tier: "light" | "standard" | "quality" | "max") =>
    j<{ tier: string }>("/api/models/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier }),
    }),
  // OCR toggle + batch rerun for image-only PDFs.
  // Index integrity. See admin.ts /api/index/status for the rules.
  indexStatus: () =>
    j<{
      chunkCount: number;
      sourceCount: number;
      chunkBearingSources: number;
      expectedChunkSum: number;
      zeroChunkSources: number;
      // Up to 50 paths whose chunks went missing, with their last
      // failure reason if there was one. Used by the Dashboard
      // retry-stale banner to name what's actually broken.
      staleSources: { source_path: string; last_error: string | null }[];
      activeJobs: number;
      dimMismatch: { stored: number; current: number } | null;
      // Which UI flow to pitch. Rebuild = wipe + re-ingest everything;
      // retry-stale = re-ingest just the named files; null = healthy.
      mode: "rebuild" | "retry-stale" | null;
      needsReingest: boolean;
    }>("/api/index/status"),
  retryStaleIngest: () =>
    j<{ ok: true; jobId: string; fileCount: number }>("/api/index/retry-stale", {
      method: "POST",
    }),
  // Atomic "tear it down and put it back": clears chunk_vecs + chunks
  // AND fires a force re-scan for every watched root. Returns job
  // ids so the UI can route to /jobs immediately. The split
  // rebuildIndex() endpoint still exists internally for the tier-
  // switch flow but is not exposed to the user — calling it from UI
  // would leave the library half-rebuilt.
  resetAndReingest: () =>
    j<{
      ok: true;
      chunksDropped: number;
      watchedRoots: number;
      jobIds: string[];
    }>("/api/index/reset-and-reingest", { method: "POST" }),
  ocrStatus: () => j<{ enabled: boolean; pending: number }>("/api/ocr/status"),
  setOcrEnabled: (enabled: boolean) =>
    j<{ enabled: boolean }>("/api/ocr/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  runOcrBatch: () =>
    j<{ jobId: string; total: number }>("/api/ocr/run-all", { method: "POST" }),
  // Scheduled tasks — deferred scans / ingests fired by the
  // backend scheduler at a wall-clock time.
  listScheduled: () =>
    j<{
      tasks: {
        id: string;
        kind: "scan" | "ingest-files";
        runAt: number;
        createdAt: number;
        params: {
          root?: string;
          paths?: string[];
          watchAfterScan?: boolean;
          excludes?: string[];
          extraIncludeExts?: string[];
          force?: boolean;
        };
      }[];
    }>("/api/scheduled"),
  scheduleScan: (params: {
    root: string;
    runAt: number;
    watchAfterScan?: boolean;
    excludes?: string[];
    extraIncludeExts?: string[];
    force?: boolean;
  }) =>
    j<{ task: { id: string } }>("/api/scheduled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "scan",
        runAt: params.runAt,
        params: {
          root: params.root,
          watchAfterScan: params.watchAfterScan,
          excludes: params.excludes,
          extraIncludeExts: params.extraIncludeExts,
          force: params.force,
        },
      }),
    }),
  cancelScheduled: (id: string) =>
    j<{ ok: true }>(`/api/scheduled/${id}`, { method: "DELETE" }),
  watcherHistory: () =>
    j<{
      events: (
        | { ts: number; kind: "scan-start"; root: string }
        | { ts: number; kind: "scan-done"; root: string; seen: number; missingSources: number; missingAliases: number; ms: number }
        | { ts: number; kind: "drain"; root: string; files: number }
        | { ts: number; kind: "error"; root: string; path?: string; message: string }
      )[];
    }>("/api/watcher/history"),
  listJobs: () => j<{ jobs: Job[] }>("/api/ingest/jobs"),
  // Retry just the errored files of a finished job. Returns the new
  // job id; caller can navigate to /jobs/<newJobId> to watch it.
  retryFailed: (id: string) =>
    j<{ jobId: string; total: number }>(`/api/ingest/retry/${id}`, {
      method: "POST",
    }),
  getJob: (id: string) => j<Job>(`/api/ingest/jobs/${id}`),
  stopJob: (id: string) =>
    j<{ requested: true }>(`/api/ingest/jobs/${id}/stop`, { method: "POST" }),
  streamJob: (
    id: string,
    handlers: {
      onSnapshot: (job: Job) => void;
      onProgress: (ev: unknown) => void;
    },
  ): (() => void) => {
    const es = new EventSource(`/api/ingest/jobs/${id}/stream`);
    es.addEventListener("snapshot", (e) =>
      handlers.onSnapshot(JSON.parse((e as MessageEvent).data) as Job),
    );
    es.addEventListener("progress", (e) =>
      handlers.onProgress(JSON.parse((e as MessageEvent).data)),
    );
    return () => es.close();
  },
};
