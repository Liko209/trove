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
  detected: { path: string; exists: boolean; hasTroveEntry: boolean }[];
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
  ingestScan: (root: string, force = false, excludes: string[] = []) =>
    j<{ jobId: string }>("/api/ingest/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, force, excludes }),
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
