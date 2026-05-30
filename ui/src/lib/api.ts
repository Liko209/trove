// Thin API client for the local-kb admin server

export type Health = { embed: boolean; rerank: boolean; embed_url: string; rerank_url: string };

export type Stats = {
  byKind: { kind: string; sources: number; chunks: number }[];
  total: { sources: number; chunks: number };
  dbPath: string;
  dbSize: number;
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
  // Watched-roots CRUD + missing-file reconciliation.
  listWatchedRoots: () =>
    j<{
      rows: {
        path: string;
        added_at: number;
        last_scanned_at: number | null;
        last_completed_at: number | null;
        watch_enabled: number;
      }[];
      watcher: { initialized: boolean; active: { root: string; dirty: number; scanning: boolean }[] };
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
      current: { excludedExts: string[]; excludedFolders: string[] };
      defaults: { excludedExts: string[]; excludedFolders: string[] };
      supportedTypes: { group: string; description: string; exts: string[] }[];
    }>("/api/settings/ingest"),
  saveIngestSettings: (s: { excludedExts: string[]; excludedFolders: string[] }) =>
    j<{ excludedExts: string[]; excludedFolders: string[] }>("/api/settings/ingest", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    }),
  listJobs: () => j<{ jobs: Job[] }>("/api/ingest/jobs"),
  getJob: (id: string) => j<Job>(`/api/ingest/jobs/${id}`),
  stopJob: (id: string) =>
    j<{ requested: true }>(`/api/ingest/jobs/${id}/stop`, { method: "POST" }),
  streamJob: (id: string, onEvent: (ev: unknown) => void): (() => void) => {
    const es = new EventSource(`/api/ingest/jobs/${id}/stream`);
    es.addEventListener("snapshot", (e) => onEvent(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("progress", (e) => onEvent(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  },
};
