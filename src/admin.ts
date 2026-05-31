// Local KB admin HTTP server
// 绑 127.0.0.1，仅本地访问；提供 REST API + 静态前端
//
// 用法：tsx src/admin.ts [--port 3001]

import express, { Request, Response } from "express";
import { readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
// extname / basename imported below alongside category helpers
import { fileURLToPath } from "node:url";
import {
  openDb,
  listSources,
  deleteSource,
  stats,
  allSources,
  firstChunkText,
  upsertTag,
  getTag,
  allTags,
  countOcrPending,
  listOcrPending,
  dimMismatch,
  rebuildChunkVecsForCurrentDim,
} from "./db.ts";
import { ingestFile } from "./ingest.ts";
import { classify } from "./extract.ts";
import {
  createJob,
  emitJob,
  subscribe,
  getJob,
  listJobs,
  requestStop,
  shouldStop,
} from "./jobs.ts";
import { walkSmart } from "./walker.ts";
import {
  readIngestSettings,
  writeIngestSettings,
  foldersToWalkerExcludes,
  SUPPORTED_TYPES,
  DEFAULT_EXCLUDED_EXTS,
  DEFAULT_EXCLUDED_FOLDERS,
} from "./settings.ts";
import {
  addWatchedRoot,
  removeWatchedRoot,
  setWatchEnabled,
  listWatchedRoots,
  listMissingSources,
  watchedRootStats,
  aliasesForSources,
  dropIndexedUnderPrefixes,
  promoteAliasToSource,
} from "./db.ts";
import {
  initWatchers,
  startWatching,
  stopWatching,
  watcherStatus,
  getWatcherHistory,
} from "./watcher.ts";
import {
  initScheduler,
  scheduleTask,
  listScheduled,
  cancelScheduled,
  type ScheduledTask,
} from "./scheduler.ts";
import { deriveCategory, fileTypeBucket } from "./category.ts";
import {
  CATEGORIES as TAG_CATEGORIES,
  classifyOne,
  precomputePromptVecs,
} from "./classify.ts";
import { extname, basename } from "node:path";

const PORT = Number(process.env.PORT ?? 8770);
const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:8765";
const RERANK_URL = process.env.RERANK_URL ?? "http://127.0.0.1:8766";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In packaged mode the bundled admin sits at Resources/app/admin/index.mjs
// while the UI is at Resources/app/ui-dist, so the relative "../ui/dist"
// path doesn't apply. services.ts passes the absolute path in BITROVE_UI_DIST.
const UI_DIST = process.env.BITROVE_UI_DIST ?? resolve(__dirname, "../ui/dist");

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS — 仅本地开发用
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── /api/source-preview ───────────────────────────────────
// Fast pre-scan to tell the user what will happen if they index a folder.
// Returns counts (text / catalog / skipped) + total bytes + time estimate.
// Capped at 200k entries so accidentally pointing at $HOME doesn't hang.
app.get("/api/source-preview", async (req, res) => {
  const path = (req.query.path as string) || "";
  if (!path) return res.status(400).json({ error: "missing path" });
  if (!existsSync(path)) return res.status(404).json({ error: "path not found" });

  // Preview always shows the *complete* picture — i.e. it deliberately
  // does NOT pre-apply the user's ext exclusion list. The UI overlays
  // those exclusions on top and lets the user toggle them per-scan.
  // We do still honor the folder excludes because those are universally
  // unwanted (node_modules, .venv, …) and skipping them is a perf win.
  const settings = await readIngestSettings();
  const excludes = [
    ...DEFAULT_EXCLUDES,
    ...foldersToWalkerExcludes(settings.excludedFolders),
  ];
  let text = 0;
  let catalog = 0;
  let skipped = 0;
  let totalBytes = 0;
  // For each extension we track both how many files we found AND how
  // many of those would actually get indexed (text or catalog). That
  // lets the UI compute the delta accurately when the user toggles an
  // extension on or off in the modal.
  const byExt: Record<string, { count: number; indexable: number }> = {};
  const HARD_CAP = 200000;
  let seen = 0;

  // For the "From these folders" breakdown and the sample preview we
  // build two extra structures while walking — both bounded so the
  // response stays small even for huge libraries.
  const SAMPLE_LIMIT = 12;
  const TOP_FOLDERS_LIMIT = 6;
  type Sample = { path: string; name: string; kind: "text" | "catalog"; size: number };
  type FolderStat = { name: string; indexable: number; skipped: number; bytes: number };
  const samples: Sample[] = [];
  const folderStats = new Map<string, FolderStat>();
  const rootWithSep = path.endsWith("/") ? path : path + "/";

  try {
    for await (const p of walkSmart(path, { excludes })) {
      seen++;
      if (seen > HARD_CAP) break;
      const ext = extname(p).toLowerCase() || "(noext)";
      const kind = classify(p);
      let size = 0;
      try {
        size = statSync(p).size;
        totalBytes += size;
      } catch {}
      const extBucket = byExt[ext] ?? { count: 0, indexable: 0 };
      extBucket.count++;
      if (kind === "text" || kind === "catalog") extBucket.indexable++;
      byExt[ext] = extBucket;
      if (kind === "text") text++;
      else if (kind === "catalog") catalog++;
      else skipped++;

      // Folder breakdown: bucket by the first path segment under the root.
      // Files directly in the root land under "(root)".
      const rel = p.startsWith(rootWithSep) ? p.slice(rootWithSep.length) : p;
      const seg = rel.split("/")[0] || "(root)";
      const bucket = folderStats.get(seg) ?? { name: seg, indexable: 0, skipped: 0, bytes: 0 };
      if (kind === "skip") bucket.skipped++;
      else bucket.indexable++;
      bucket.bytes += size;
      folderStats.set(seg, bucket);

      // Sample preview: grab the first SAMPLE_LIMIT actually-indexable files
      // so the user can sanity-check what Bitrove will read.
      if (samples.length < SAMPLE_LIMIT && (kind === "text" || kind === "catalog")) {
        const name = p.slice(p.lastIndexOf("/") + 1);
        samples.push({ path: p, name, kind, size });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }

  // Per-tier throughput estimate. The constants below mirror
  // electron/setup.ts TIERS[].estDocsPerSec for the embed side;
  // catalog-only entries cost roughly 1/20th of a real embed because
  // they're a single short string. Was previously hard-coded to bge-m3
  // numbers, which made Quality/Max scans estimate 2-6x too fast.
  const tier = (process.env.BITROVE_MODEL_TIER ?? "light") as
    | "light"
    | "standard"
    | "quality"
    | "max";
  const SEC_PER_DOC: Record<typeof tier, number> = {
    light: 0.1,     // ~10 docs/s
    standard: 0.125, // ~8 docs/s
    quality: 0.33,  // ~3 docs/s
    max: 0.67,      // ~1.5 docs/s
  };
  const perDoc = SEC_PER_DOC[tier] ?? SEC_PER_DOC.light;
  const estimatedSeconds = Math.max(
    5,
    Math.round(text * perDoc + catalog * (perDoc / 20)),
  );
  const topExtensions = Object.entries(byExt)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([ext, v]) => ({ ext, count: v.count, indexable: v.indexable }));
  // Per-extension summary restricted to the user's default-excluded set, so
  // the UI can compute the *effective* indexable count after the user
  // toggles any of them back on without having to wait for the top-12 cap
  // to include every excluded ext.
  const excludedByExt = settings.excludedExts
    .map((ext) => ({
      ext,
      count: byExt[ext]?.count ?? 0,
      indexable: byExt[ext]?.indexable ?? 0,
    }))
    .filter((e) => e.count > 0);
  const topFolders = [...folderStats.values()]
    .sort((a, b) => b.indexable - a.indexable || b.bytes - a.bytes)
    .slice(0, TOP_FOLDERS_LIMIT);

  res.json({
    path,
    text,
    catalog,
    skipped,
    totalScanned: seen,
    cappedAt: seen >= HARD_CAP ? HARD_CAP : null,
    totalBytes,
    estimatedSeconds,
    topExtensions,
    topFolders,
    sampleFiles: samples,
    // Echo the user's current default-exclude list so the UI can dim the
    // corresponding chips without a second round-trip.
    excludedExts: settings.excludedExts,
    excludedByExt,
  });
});

// ── /api/settings/ingest ──────────────────────────────────
app.get("/api/settings/ingest", async (_req, res) => {
  const current = await readIngestSettings();
  res.json({
    current,
    defaults: {
      excludedExts: DEFAULT_EXCLUDED_EXTS,
      excludedFolders: DEFAULT_EXCLUDED_FOLDERS,
    },
    supportedTypes: SUPPORTED_TYPES,
  });
});

app.put("/api/settings/ingest", async (req, res) => {
  try {
    const next = req.body as {
      excludedExts?: string[];
      excludedFolders?: string[];
      watcherScanIntervalMin?: number;
      watcherDebounceMin?: number;
    };
    // Settings page only edits Filters + Watcher fields, but
    // writeIngestSettings rewrites the whole file. Without spreading
    // the current state first, activeModelTier (set elsewhere by the
    // tier picker) silently resets to "light" every save — and on
    // the next launch, light's bge-m3 isn't on disk for users who
    // installed Quality/Standard/Max, so they get bounced back to
    // onboarding even though their model is sitting in models/.
    const current = await readIngestSettings();
    const saved = await writeIngestSettings({
      ...current,
      excludedExts: Array.isArray(next.excludedExts) ? next.excludedExts : current.excludedExts,
      excludedFolders: Array.isArray(next.excludedFolders) ? next.excludedFolders : current.excludedFolders,
      watcherScanIntervalMin: next.watcherScanIntervalMin ?? current.watcherScanIntervalMin,
      watcherDebounceMin: next.watcherDebounceMin ?? current.watcherDebounceMin,
    });
    res.json(saved);
    // Restart watchers so they pick up new cadence values.
    initWatchers().catch((e) => console.error("[watcher] reinit failed:", e));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── /api/ingest/retry/:id ─────────────────────────────────
// Re-runs only the files that errored in a previous job. Reads
// errorEvents from the persisted JobState (v0.0.41+), filters out
// any path that no longer exists on disk, and starts a new ingest
// job with the filtered list. New job's description references the
// original so the activity feed is traceable. Caller follows the
// returned jobId into /jobs/:id to watch progress.
app.post("/api/ingest/retry/:id", async (req, res) => {
  const id = req.params.id;
  const original = getJob(id);
  if (!original) return res.status(404).json({ error: "job not found" });
  if (!original.errorEvents || original.errorEvents.length === 0) {
    return res.status(400).json({ error: "no recorded errors to retry" });
  }
  // Dedupe + keep only files still present on disk; vanished files
  // would just error again the same way.
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const e of original.errorEvents) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    if (!existsSync(e.path)) continue;
    paths.push(e.path);
  }
  if (paths.length === 0) {
    return res.status(400).json({
      error: "none of the failed files still exist on disk",
    });
  }

  const job = createJob(
    "ingest",
    `Retry ${paths.length} failed file${paths.length === 1 ? "" : "s"} from ${original.description}`,
  );
  res.json({ jobId: job.id, total: paths.length });

  (async () => {
    const t0 = Date.now();
    emitJob(job.id, { type: "started", total: paths.length });
    const db = openDb();
    let done = 0;
    let stoppedEarly = false;
    try {
      for (const p of paths) {
        if (shouldStop(job.id)) {
          stoppedEarly = true;
          break;
        }
        // includeDuplicates=true: this is a remediation pass, the user
        // already accepted these files implicitly by adding them.
        // force=true: bypass the (mtime,size) skip — the file might
        // genuinely be unchanged but we still want to retry it.
        const r = await ingestFile(db, p, {
          force: true,
          includeDuplicates: true,
          watchedRoot: original.kind === "scan" ? undefined : undefined,
        });
        done++;
        emitJob(job.id, {
          type: "item",
          done,
          total: paths.length,
          current: p,
          status: r.status,
          error: r.status === "error" ? r.error : undefined,
        });
      }
    } finally {
      db.close();
    }
    const finalState = getJob(job.id)!;
    emitJob(job.id, {
      type: stoppedEarly ? "stopped" : "done",
      done,
      total: paths.length,
      ingested: finalState.ingested,
      errors: finalState.errors,
      ms: Date.now() - t0,
    });
  })().catch((e) => {
    emitJob(job.id, { type: "failed", error: (e as Error).message });
  });
});

// ── /api/models/active ─────────────────────────────────────
// Reads the user's chosen model tier from ingest-settings.json.
// Returned to Settings → Models for the "Currently active" display.
// PUT just rewrites the tier field — actual model download +
// llama-server restart + index rebuild is orchestrated by electron's
// switch-tier IPC chain (P1.5 / P1.6), not by this endpoint, so the
// admin can stay stateless about model lifecycle.
app.get("/api/models/active", async (_req, res) => {
  const s = await readIngestSettings();
  res.json({ tier: s.activeModelTier ?? "light" });
});

app.put("/api/models/active", async (req, res) => {
  const tier = (req.body?.tier as string) ?? "";
  if (!["light", "standard", "quality", "max"].includes(tier)) {
    return res.status(400).json({ error: "invalid tier" });
  }
  const current = await readIngestSettings();
  await writeIngestSettings({ ...current, activeModelTier: tier as "light" | "standard" | "quality" | "max" });
  res.json({ tier });
});

// ── /api/ocr ──────────────────────────────────────────────
// Get / set the OCR toggle. extract.ts/ingest.ts read it via
// readIngestSettings() on the next ingest. Existing needs_ocr=1
// rows are untouched until the user clicks "Run OCR on N files"
// which kicks off the batch endpoint below.
app.get("/api/ocr/status", (_req, res) => {
  const db = openDb();
  const pending = countOcrPending(db);
  db.close();
  readIngestSettings().then((s) => {
    res.json({ enabled: !!s.ocrEnabled, pending });
  });
});

// ── /api/index ────────────────────────────────────────────
// Surface chunk_vecs / chunks integrity to the UI so the user (not
// the process) decides whether to wipe + repopulate the index.
//
// HOW WE DECIDE THE INDEX IS BROKEN (and why each check is here):
//
//   1. dimMismatch — meta.embed_dim on disk doesn't match the
//      EMBED_DIM the admin process was started with. Next search
//      will fail with a dimension error; surface it.
//
//   2. orphanedSources — TWO sub-cases. activeJobs === 0 gates
//      both, because chunk counts move during a live scan.
//
//      (a) Partial wipe: sources.chunk_count says "I produced
//          N chunks total" but the chunks table has fewer rows.
//          Some chunks were dropped but the bookkeeping wasn't.
//
//      (b) Full wipe (the 51-files / 1-chunk shape the user hit):
//          chunk_bearing sources still exist but ALL their
//          chunk_count fields are 0. That's the user-visible
//          shape of an old openDb()-auto-rebuild having reset
//          everything in lockstep — SUM=0, COUNT=0 looks
//          "consistent" but isn't actually populated. Detected
//          via `chunkBearingSources > 0 && expectedChunkSum == 0`
//          (using a chunkBearingSources count that excludes
//          image-only PDFs, missing files, and untracked rows).
//
// Why we do NOT use these (avoiding false positives):
//
//   - "chunkCount < chunkBearingSources * 0.5" — a 5-file library
//     with short text files could have a 1:1 ratio legitimately.
//   - "no chunks at all" without the chunkBearingSources>0 guard
//     — true of a fresh install mid-first-scan. Also true of
//     someone whose only files are image-only PDFs without OCR.
//   - "while a scan is running" — chunk counts move during ingest;
//     activeJobs gate prevents that race.
app.get("/api/index/status", (_req, res) => {
  const db = openDb();
  const mismatch = dimMismatch(db);
  const chunkCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM chunks`)
    .get() as { n: number }).n;
  // Sources that should have chunks: still on disk, not flagged
  // image-only-pdf (those are needs_ocr=1 with chunk_count=0 by
  // design and shouldn't make the index look broken).
  const chunkBearingSources = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0`,
    )
    .get() as { n: number }).n;
  const expectedChunkSum = (db
    .prepare(
      `SELECT COALESCE(SUM(chunk_count), 0) AS n FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0`,
    )
    .get() as { n: number }).n;
  const sourceCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM sources WHERE missing_since IS NULL`)
    .get() as { n: number }).n;
  const zeroChunkSources = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0 AND chunk_count = 0`,
    )
    .get() as { n: number }).n;
  // Name the actual offenders for the UI. Cap at 50; that's enough
  // for the banner's "+N more" affordance and keeps the JSON small.
  const staleSources = db
    .prepare(
      `SELECT source_path, last_error FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0 AND chunk_count = 0
       ORDER BY source_path
       LIMIT 50`,
    )
    .all() as { source_path: string; last_error: string | null }[];
  db.close();
  const activeJobs = listJobs(10).filter((j) => j.status === "running").length;
  // Decide which fix flow the UI should pitch.
  //
  //   - rebuild: the WHOLE index is hosed. Either the dim doesn't
  //     match (every search will fail), or more than half of the
  //     expected chunks are missing. User needs to wipe + re-ingest
  //     everything — the all-or-nothing path.
  //
  //   - retry-stale: a small set of specific sources never made it
  //     through ingest (zero chunks, no needs_ocr flag). Each one
  //     usually has a last_error explaining why. User shouldn't have
  //     to wipe 50 working files because 1 PDF tripped pdfjs.
  //
  // We pick at most one mode. Rebuild wins when both are true so the
  // user doesn't fire a retry against a structurally broken store.
  const heavyWipe =
    expectedChunkSum > 0 && chunkCount < expectedChunkSum / 2;
  const noChunksAtAll =
    chunkBearingSources > 0 && expectedChunkSum === 0;
  const needsRebuild =
    mismatch != null || (activeJobs === 0 && (heavyWipe || noChunksAtAll));
  const needsRetryStale =
    !needsRebuild && activeJobs === 0 && zeroChunkSources > 0;
  const mode: "rebuild" | "retry-stale" | null = needsRebuild
    ? "rebuild"
    : needsRetryStale
      ? "retry-stale"
      : null;
  res.json({
    chunkCount,
    sourceCount,
    chunkBearingSources,
    expectedChunkSum,
    zeroChunkSources,
    staleSources,
    activeJobs,
    dimMismatch: mismatch,
    mode,
    // Kept for callers that haven't migrated to `mode`.
    needsReingest: needsRebuild || needsRetryStale,
  });
});

// Destructive: drops chunk_vecs, clears chunks, resets sources.
// Returns the count we just nuked so the UI can confirm + the user
// can audit. Caller is responsible for showing a confirm dialog —
// admin/server-side blindly trusts the request because the only
// callers should be (a) Settings → Models "Rebuild index" button
// and (b) the tier-switch flow after the user accepted the warning
// modal.
// Low-level "just clear the vector table" endpoint. Used internally
// by the tier-switch flow (electron/main.ts) which then triggers its
// own re-ingest. The UI never calls this — exposing it would split
// the rebuild flow into two steps that look identical to the user.
app.post("/api/index/rebuild", (req, res) => {
  const db = openDb();
  const before = (db
    .prepare(`SELECT COUNT(*) AS n FROM chunks`)
    .get() as { n: number }).n;
  rebuildChunkVecsForCurrentDim(db);
  db.close();
  res.json({ ok: true, chunksDropped: before });
});

// The user-facing "Rebuild" endpoint. Atomic: clears chunk_vecs +
// chunks AND fires a force re-scan for every watched root, PLUS a
// catch-up ingest for any sources that exist outside the watched
// roots (Picked Files imports, or historical rows whose root was
// later removed). Without the catch-up step those rows stay at
// chunk_count=0 forever — the watched-root scans wouldn't visit
// them — and the per-source health check on /api/index/status keeps
// firing the banner. Returns the list of new job ids so the UI can
// navigate straight to /jobs.
app.post("/api/index/reset-and-reingest", async (_req, res) => {
  // Clear first so the new ingests don't fight with stale chunks.
  const db = openDb();
  const chunksDropped = (db
    .prepare(`SELECT COUNT(*) AS n FROM chunks`)
    .get() as { n: number }).n;
  rebuildChunkVecsForCurrentDim(db);
  const roots = listWatchedRoots(db).map((r) => r.path);
  // Pick up every active chunk-bearing source whose path isn't
  // covered by any watched root. Using endsWith/startsWith over
  // the root path so files inside a watched folder still belong
  // to that root (the scan will hit them). Anything that doesn't
  // belong gets its own ingest-files job.
  const allActivePaths = db
    .prepare(
      `SELECT source_path FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0`,
    )
    .all() as { source_path: string }[];
  db.close();
  const orphanPaths = allActivePaths
    .map((r) => r.source_path)
    .filter((p) => !roots.some((root) => p === root || p.startsWith(root + "/")));

  // Enqueue one scan job per watched root + (optionally) one
  // ingest-files job covering the orphans. We use the existing
  // HTTP endpoints internally so they reuse all permission / stop
  // / progress wiring.
  const jobIds: string[] = [];
  for (const root of roots) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ingest/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root,
          watchAfterScan: true,
          force: true,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as { jobId: string };
        jobIds.push(j.jobId);
      }
    } catch {
      // best effort — partial result is surfaced below
    }
  }
  if (orphanPaths.length > 0) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ingest/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paths: orphanPaths,
          force: true,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as { jobId: string };
        jobIds.push(j.jobId);
      }
    } catch {}
  }

  res.json({
    ok: true,
    chunksDropped,
    watchedRoots: roots.length,
    orphanFiles: orphanPaths.length,
    jobIds,
  });
});

// Targeted re-ingest. For when 1-N specific sources got stuck (PDF
// parse failure, transient embed error, ...) and we don't want to
// nuke the whole vector store. Pulls every chunk_bearing source
// with chunk_count=0 and fires one /api/ingest/files job against
// them with force=true. last_error gets re-stamped (or cleared on
// success) by ingest.ts's catch / upsertSource path.
app.post("/api/index/retry-stale", async (_req, res) => {
  const db = openDb();
  const stalePaths = (db
    .prepare(
      `SELECT source_path FROM sources
       WHERE missing_since IS NULL AND needs_ocr = 0 AND chunk_count = 0`,
    )
    .all() as { source_path: string }[]).map((r) => r.source_path);
  db.close();
  if (stalePaths.length === 0) {
    return res.status(404).json({ error: "no stale sources to retry" });
  }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/ingest/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: stalePaths, force: true }),
    });
    if (!r.ok) {
      return res.status(500).json({ error: await r.text() });
    }
    const j = (await r.json()) as { jobId: string };
    res.json({ ok: true, jobId: j.jobId, fileCount: stalePaths.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.put("/api/ocr/enabled", async (req, res) => {
  const enabled = !!req.body?.enabled;
  const current = await readIngestSettings();
  await writeIngestSettings({ ...current, ocrEnabled: enabled });
  res.json({ enabled });
});

// Batch-rerun ingest on every file currently marked needs_ocr=1.
// Reuses the existing ingest job pipeline so progress streams
// through the same JobProgress UI.
app.post("/api/ocr/run-all", async (_req, res) => {
  const settings = await readIngestSettings();
  if (!settings.ocrEnabled) {
    return res.status(400).json({ error: "OCR is disabled — enable it in Settings → Models first" });
  }
  const db = openDb();
  const pending = listOcrPending(db);
  db.close();
  if (pending.length === 0) {
    return res.status(404).json({ error: "no files awaiting OCR" });
  }
  const paths = pending.map((r) => r.source_path);
  const job = createJob("ingest", `OCR ${paths.length} image-only PDF${paths.length === 1 ? "" : "s"}`);
  res.json({ jobId: job.id, total: paths.length });

  (async () => {
    const t0 = Date.now();
    emitJob(job.id, { type: "started", total: paths.length });
    const db2 = openDb();
    let done = 0;
    let stoppedEarly = false;
    try {
      for (const p of paths) {
        if (shouldStop(job.id)) {
          stoppedEarly = true;
          break;
        }
        // force=true so the mtime/hash skip doesn't kick in — the
        // text content "changed" in the sense that OCR can now
        // extract it, even though bytes are identical.
        const r = await ingestFile(db2, p, {
          force: true,
          includeDuplicates: true,
        });
        done++;
        emitJob(job.id, {
          type: "item",
          done,
          total: paths.length,
          current: p,
          status: r.status,
          error: r.status === "error" ? r.error : undefined,
        });
      }
    } finally {
      db2.close();
    }
    const finalState = getJob(job.id)!;
    emitJob(job.id, {
      type: stoppedEarly ? "stopped" : "done",
      done,
      total: paths.length,
      ingested: finalState.ingested,
      errors: finalState.errors,
      ms: Date.now() - t0,
    });
  })().catch((e) => {
    emitJob(job.id, { type: "failed", error: (e as Error).message });
  });
});

// ── /api/watcher/history ───────────────────────────────────
// Recent (last 200) events from every watched root: scan start /
// complete, debounce drains, ingest errors. Used by the Settings
// page to show "what has Bitrove been doing for me?".
app.get("/api/watcher/history", (_req, res) => {
  res.json({ events: getWatcherHistory() });
});

// ── /api/agents/claude-config ─────────────────────────────
// Detect Claude Code config files & report whether Bitrove MCP is wired up.
// Used by the Connect page in the UI.
const HOME = process.env.HOME ?? "";
const CLAUDE_CONFIG_PATHS = [
  `${HOME}/.claude.json`,
  `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`,
];

function mcpServerSpec(): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  // The MCP server file location depends on whether we're packaged or dev.
  // Dev: src/server.ts via tsx. Packaged: bundled .mjs reached through
  // the Electron binary with ELECTRON_RUN_AS_NODE=1 (Bitrove ships
  // Electron, not a standalone Node, so the MCP client has to launch
  // Electron-as-Node — same trick services.ts uses for the admin).
  const isPackagedAdmin = process.env.BITROVE_PACKAGED === "1";
  if (isPackagedAdmin) {
    const adminRoot = process.env.BITROVE_APP_ROOT;
    if (!adminRoot) throw new Error("BITROVE_APP_ROOT not set in packaged admin");
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: "1",
      EMBED_URL: process.env.EMBED_URL ?? "http://127.0.0.1:8765",
      RERANK_URL: process.env.RERANK_URL ?? "http://127.0.0.1:8766",
      KB_DB: process.env.KB_DB ?? join(adminRoot, "data", "index.db"),
    };
    // CRITICAL: pass the model tier + user-data dir to the MCP child.
    // Without these the MCP process reads a default "light" tier from
    // a settings.json it can't find, computes EMBED_DIM=1024, and on
    // openDb() decides the existing chunk_vecs table (sized for the
    // user's actual tier, e.g. 2560 for Quality) is "wrong" — drops
    // it and recreates at 1024. That wipes every chunk the admin had
    // just written and is what produced the "Expected 1024, received
    // 2560" -32603 errors users were seeing from /mcp.
    if (process.env.BITROVE_MODEL_TIER) {
      env.BITROVE_MODEL_TIER = process.env.BITROVE_MODEL_TIER;
    }
    if (process.env.BITROVE_USER_DATA) {
      env.BITROVE_USER_DATA = process.env.BITROVE_USER_DATA;
    }
    return {
      command: process.execPath,
      args: [join(adminRoot, "mcp", "index.mjs")],
      env,
    };
  }
  // Dev fallback
  return {
    command: "npx",
    args: ["tsx", resolve(__dirname, "server.ts")],
  };
}

app.get("/api/agents/claude-config", async (_req, res) => {
  const detected: { path: string; exists: boolean; hasBitroveEntry: boolean }[] = [];
  for (const p of CLAUDE_CONFIG_PATHS) {
    let exists = false;
    let hasBitroveEntry = false;
    if (existsSync(p)) {
      exists = true;
      try {
        const raw = await import("node:fs/promises").then((m) => m.readFile(p, "utf8"));
        const j = JSON.parse(raw);
        hasBitroveEntry = Boolean(j?.mcpServers?.bitrove || j?.mcpServers?.["local-kb"]);
      } catch {}
    }
    detected.push({ path: p, exists, hasBitroveEntry });
  }
  res.json({ detected, suggested: mcpServerSpec() });
});

app.post("/api/agents/claude-install", async (req, res) => {
  const fs = await import("node:fs/promises");
  const targetPath = (req.body?.path as string) || CLAUDE_CONFIG_PATHS[0];
  let config: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      config = JSON.parse(await fs.readFile(targetPath, "utf8"));
    } catch (e) {
      return res.status(400).json({
        error: `Existing config is not valid JSON: ${(e as Error).message}`,
      });
    }
  }
  const mcpServers = ((config.mcpServers as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  mcpServers.bitrove = mcpServerSpec();
  config.mcpServers = mcpServers;
  // backup
  if (existsSync(targetPath)) {
    await fs.copyFile(targetPath, targetPath + ".bitrove.bak");
  } else {
    await fs.mkdir(targetPath.split("/").slice(0, -1).join("/"), { recursive: true });
  }
  await fs.writeFile(targetPath, JSON.stringify(config, null, 2));
  res.json({ ok: true, backupCreated: existsSync(targetPath + ".bitrove.bak") });
});

// ── /api/health ───────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  async function probe(url: string) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }
  const [embed, rerank] = await Promise.all([probe(EMBED_URL), probe(RERANK_URL)]);
  res.json({ embed, rerank, embed_url: EMBED_URL, rerank_url: RERANK_URL });
});

// Reusable: poll embed /health until it returns ok, or maxMs elapses.
// Used by /api/ingest/scan + the file watcher so they don't kick off
// work while the GGUF is still being loaded into RAM.
async function waitForEmbedReady(maxMs: number): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
    attempt++;
    const delay = Math.min(500 + attempt * 250, 3000);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`embed server not ready after ${maxMs} ms`);
}

// ── /api/stats ────────────────────────────────────────────
app.get("/api/stats", (_req, res) => {
  const db = openDb();
  const s = stats(db);
  const dbPath = (db.pragma("database_list") as { file: string }[]).find(Boolean)?.file ?? "";
  let dbSize = 0;
  try {
    dbSize = statSync(dbPath).size;
  } catch {}
  // Sum the bytes of the actual indexed files (not the DB file
  // itself). The Dashboard's "Library size" tile shows this so a
  // fresh install reads 0 instead of ~108 KB of empty schema /
  // sqlite-vec scaffolding.
  const indexedBytes = (db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sources
       WHERE missing_since IS NULL`,
    )
    .get() as { n: number }).n;
  const ocrPending = countOcrPending(db);
  db.close();
  const total = s.reduce(
    (acc, r) => ({ sources: acc.sources + r.sources, chunks: acc.chunks + r.chunks }),
    { sources: 0, chunks: 0 },
  );
  res.json({ byKind: s, total, dbPath, dbSize, indexedBytes, ocrPending });
});

// ── /api/sources (list) ───────────────────────────────────
app.get("/api/sources", (req, res) => {
  const db = openDb();
  const r = listSources(db, {
    kind: req.query.kind as "text" | "catalog" | undefined,
    path_prefix: req.query.path_prefix as string | undefined,
    path_contains: req.query.path_contains as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : 50,
    offset: req.query.offset ? Number(req.query.offset) : 0,
    includeMissing: req.query.include_missing === "1",
  });
  const aliasMap = aliasesForSources(
    db,
    r.rows.map((row) => row.source_path),
  );
  db.close();
  // enrich with size/ext/category/bucket + alias paths
  const enriched = r.rows.map((row) => {
    let size_bytes = 0;
    try {
      size_bytes = statSync(row.source_path).size;
    } catch {}
    const ext = extname(row.source_path).toLowerCase();
    const cat = deriveCategory(row.source_path);
    const aliases = aliasMap.get(row.source_path) ?? [];
    return {
      ...row,
      name: basename(row.source_path),
      ext,
      bucket: fileTypeBucket(row.source_path),
      size_bytes,
      category: cat.category,
      subcategory: cat.subcategory,
      aliases,
    };
  });
  res.json({ ...r, rows: enriched });
});

// ── /api/library/groups ───────────────────────────────────
// Aggregate all sources by derived category, sorted by count desc.
// Each group includes a sample of recent files for the card preview.
app.get("/api/library/groups", (_req, res) => {
  const db = openDb();
  const all = allSources(db);
  db.close();
  type EnrichedRow = (typeof all)[number] & {
    name: string;
    ext: string;
    bucket: ReturnType<typeof fileTypeBucket>;
    size_bytes: number;
    category: string;
    subcategory?: string;
  };
  const groups = new Map<
    string,
    {
      category: string;
      total: number;
      text: number;
      catalog: number;
      total_size: number;
      latest_mtime: string;
      sample: EnrichedRow[];
    }
  >();
  for (const row of all) {
    const { category, subcategory } = deriveCategory(row.source_path);
    let size_bytes = 0;
    try {
      size_bytes = statSync(row.source_path).size;
    } catch {}
    const enriched: EnrichedRow = {
      ...row,
      name: basename(row.source_path),
      ext: extname(row.source_path).toLowerCase(),
      bucket: fileTypeBucket(row.source_path),
      size_bytes,
      category,
      subcategory,
    };
    let g = groups.get(category);
    if (!g) {
      g = {
        category,
        total: 0,
        text: 0,
        catalog: 0,
        total_size: 0,
        latest_mtime: enriched.source_mtime,
        sample: [],
      };
      groups.set(category, g);
    }
    g.total++;
    if (enriched.kind === "text") g.text++;
    else g.catalog++;
    g.total_size += size_bytes;
    if (enriched.source_mtime > g.latest_mtime) g.latest_mtime = enriched.source_mtime;
    g.sample.push(enriched);
  }
  // Sort sample by mtime desc, keep top 4
  for (const g of groups.values()) {
    g.sample.sort((a, b) => (b.source_mtime > a.source_mtime ? 1 : -1));
    g.sample = g.sample.slice(0, 4);
  }
  const out = [...groups.values()].sort((a, b) => b.total - a.total);
  res.json({ groups: out, total_categories: out.length, total_files: all.length });
});

// ── /api/sources (delete) ─────────────────────────────────
app.delete("/api/sources", (req, res) => {
  const paths = (req.body?.paths ?? []) as string[];
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: "body.paths must be non-empty array" });
  }
  const db = openDb();
  let totalChunksRemoved = 0;
  for (const p of paths) totalChunksRemoved += deleteSource(db, p);
  db.close();
  res.json({ removed: paths.length, chunks_removed: totalChunksRemoved });
});

// ── /api/browse (服务端文件浏览，给 Add 页用) ────────────────────
app.get("/api/browse", async (req, res) => {
  const path = (req.query.path as string) || process.env.HOME || "/";
  const abs = resolve(path);
  if (!existsSync(abs)) return res.status(404).json({ error: "not found" });
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    return res.status(403).json({ error: (e as Error).message });
  }
  const list = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      path: join(abs, e.name),
      kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
      indexable: e.isFile() ? classify(join(abs, e.name)) : "skip",
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  res.json({ path: abs, parent: abs === "/" ? null : dirname(abs), entries: list });
});

// ── /api/ingest/files (ingest specific files) ─────────────
app.post("/api/ingest/files", async (req, res) => {
  const paths = (req.body?.paths ?? []) as string[];
  const force = Boolean(req.body?.force);
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: "body.paths must be non-empty array" });
  }
  const job = createJob("ingest", `Ingest ${paths.length} file(s)`);
  res.json({ jobId: job.id });

  // 异步执行
  (async () => {
    const t0 = Date.now();
    emitJob(job.id, { type: "started", total: paths.length });
    const db = openDb();
    let done = 0;
    let stoppedEarly = false;
    for (const p of paths) {
      if (shouldStop(job.id)) {
        stoppedEarly = true;
        break;
      }
      // Hand-picked files bypass dedup: the user explicitly chose this
      // file by name, that's an unambiguous "yes, add this".
      const r = await ingestFile(db, p, { force, includeDuplicates: true });
      done++;
      emitJob(job.id, {
        type: "item",
        done,
        total: paths.length,
        current: p,
        status: r.status,
        error: r.status === "error" ? r.error : undefined,
      });
    }
    db.close();
    const finalState = getJob(job.id)!;
    emitJob(job.id, {
      type: stoppedEarly ? "stopped" : "done",
      done,
      total: paths.length,
      ingested: finalState.ingested,
      errors: finalState.errors,
      ms: Date.now() - t0,
    });
  })().catch((e) => {
    emitJob(job.id, { type: "failed", error: (e as Error).message });
  });
});

// ── /api/ingest/scan (recursive folder scan) ──────────────
const DEFAULT_EXCLUDES = [
  "/Tech/Java/api/",
  // VCS / 构建产物
  "/.git/",
  "/node_modules/",
  "/.next/",
  "/dist/",
  "/build/",
  "/target/",
  "/coverage/",
  "/.cache/",
  "/.pytest_cache/",
  "/.mypy_cache/",
  "/.idea/",
  "/.vscode/",
  // Python 环境
  "/.venv/",
  "/venv/",
  "/__pycache__/",
  "/conda/envs/",
  "/conda/pkgs/",
  "/conda/lib/",
  "/.conda/",
  "/site-packages/",
  // 数据项目内的"清洗数据 / 原始数据"
  "/data/cleaned/",
  "/data/raw/",
  "/data/processed/",
  "/data/interim/",
  // Claude Code 内置
  "/.claude/",
  "/CCGS Skill Testing Framework/",
  // 系统/缓存
  "/Library/Application Support/",
  "/Library/Caches/",
];

app.post("/api/ingest/scan", async (req, res) => {
  const root = req.body?.root as string;
  const force = Boolean(req.body?.force);
  const extraExcludes = (req.body?.excludes ?? []) as string[];
  // Per-scan override: "include these extensions even though Settings has
  // them on the exclude list". Used by the scan-confirm modal when the
  // user toggles an excluded chip back on.
  const includeExtsRaw = (req.body?.extraIncludeExts ?? []) as string[];
  const includeExts = new Set(
    includeExtsRaw.map((s) => s.trim().toLowerCase()).map((s) => (s.startsWith(".") ? s : "." + s)),
  );
  // Phase 2: persistent watch. When true, we register this root in the
  // watched_roots table and the file-watcher starts monitoring it after
  // the initial scan. Default true mirrors the Add-page UX — most users
  // adding a folder probably want it kept fresh.
  const watchAfterScan = req.body?.watchAfterScan !== false;
  if (!root || !existsSync(root)) {
    return res.status(400).json({ error: "body.root must be an existing directory" });
  }
  const job = createJob("scan", `Scan ${root}`);
  res.json({ jobId: job.id });

  (async () => {
    const t0 = Date.now();
    const settings = await readIngestSettings();
    const excludes = [
      ...DEFAULT_EXCLUDES,
      ...foldersToWalkerExcludes(settings.excludedFolders),
      ...extraExcludes,
    ];
    // Apply ext exclusions minus whatever the user explicitly re-enabled
    // for this scan via extraIncludeExts.
    const excludeExts = settings.excludedExts.filter((e) => !includeExts.has(e));
    // 第一遍枚举(git-aware: 仓库内只保留 README + docs/)
    const queue: string[] = [];
    for await (const p of walkSmart(root, { excludes, excludeExts })) {
      if (classify(p) !== "skip") queue.push(p);
    }
    emitJob(job.id, { type: "started", total: queue.length });

    const db = openDb();
    if (watchAfterScan) {
      // Persist the user's per-scan excludes so the file watcher
      // honors them on subsequent passes — otherwise the watcher
      // would happily re-index files in folders the user just
      // deselected. extraExcludes is the union of the modal's
      // subdir checkbox unchecks + any caller-supplied excludes.
      addWatchedRoot(db, root, extraExcludes);
    }
    // If the user excluded sub-trees that were previously indexed
    // under this root, drop the stale rows so search stops pointing
    // at files we'll no longer maintain. Safe for fresh roots (no
    // matches) and for non-watched scans (the caller still may want
    // a one-off cleanup).
    const cleaned =
      extraExcludes.length > 0
        ? dropIndexedUnderPrefixes(db, root, extraExcludes)
        : { sources: 0, aliases: 0 };
    if (cleaned.sources + cleaned.aliases > 0) {
      console.log(
        `[scan] excluded subtree cleanup: ${cleaned.sources} sources + ${cleaned.aliases} aliases removed under ${root}`,
      );
    }
    // Wait up to 90s for the embed server to be ready before
    // hammering it. Fixes the "first run after launch fails for every
    // file with 503: model is loading" pattern.
    await waitForEmbedReady(90_000).catch((e) => {
      console.warn(`[scan] embed not ready, scanning anyway:`, (e as Error).message);
    });
    let done = 0;
    let stoppedEarly = false;
    let duplicateCount = 0;
    const duplicateSamples: { path: string; duplicateOf: string }[] = [];
    for (const p of queue) {
      if (shouldStop(job.id)) {
        stoppedEarly = true;
        break;
      }
      const r = await ingestFile(db, p, {
        force,
        watchedRoot: watchAfterScan ? root : undefined,
      });
      if (r.status === "aliased-duplicate") {
        duplicateCount++;
        // Sample shown to the user as "added as alias of …". Aliases are
        // counted as duplicates for the summary because they didn't cost
        // an embed, but the file is still findable in search.
        if (duplicateSamples.length < 5) {
          duplicateSamples.push({ path: r.path, duplicateOf: r.duplicateOf });
        }
      }
      done++;
      emitJob(job.id, {
        type: "item",
        done,
        total: queue.length,
        current: p,
        status: r.status,
        error: r.status === "error" ? r.error : undefined,
      });
    }
    db.close();
    const finalState = getJob(job.id)!;
    emitJob(job.id, {
      type: stoppedEarly ? "stopped" : "done",
      done,
      total: queue.length,
      ingested: finalState.ingested,
      errors: finalState.errors,
      duplicates: duplicateCount,
      duplicateSamples,
      ms: Date.now() - t0,
    });
    // After the initial scan finishes (success or otherwise), bring the
    // watcher up for this root so subsequent changes get picked up
    // incrementally. initWatchers() is idempotent.
    if (watchAfterScan) {
      initWatchers().catch((e) => console.error("[watcher] post-scan init failed:", e));
    }
  })().catch((e) => {
    emitJob(job.id, { type: "failed", error: (e as Error).message });
  });
});

// ── /api/classify ─────────────────────────────────────────
// Run zero-shot semantic classification on all sources (or only those missing tags).
// Returns jobId; progress streams over /api/ingest/jobs/:id/stream (reused).
app.post("/api/classify", async (req, res) => {
  const onlyMissing = Boolean(req.body?.only_missing);
  const job = createJob("ingest", `Classify (${onlyMissing ? "missing" : "all"})`);
  res.json({ jobId: job.id });

  (async () => {
    const t0 = Date.now();
    let promptVecs: number[][];
    try {
      promptVecs = await precomputePromptVecs();
    } catch (e) {
      emitJob(job.id, { type: "failed", error: `prompt embed: ${(e as Error).message}` });
      return;
    }
    const db = openDb();
    const all = allSources(db);
    const queue = onlyMissing ? all.filter((s) => !getTag(db, s.source_path)) : all;
    emitJob(job.id, { type: "started", total: queue.length });

    let done = 0;
    let stoppedEarly = false;
    for (const src of queue) {
      if (shouldStop(job.id)) {
        stoppedEarly = true;
        break;
      }
      try {
        const head = firstChunkText(db, src.source_path);
        const result = await classifyOne({
          source_path: src.source_path,
          firstChunkText: head,
          promptVecs,
        });
        upsertTag(db, {
          source_path: src.source_path,
          category_id: result.category_id,
          category_label: result.category_label,
          score: result.score,
          alternatives: result.alternatives,
        });
        done++;
        emitJob(job.id, {
          type: "item",
          done,
          total: queue.length,
          current: `${result.category_label}  ←  ${basename(src.source_path)}`,
          status: "ingested",
        });
      } catch (e) {
        done++;
        emitJob(job.id, {
          type: "item",
          done,
          total: queue.length,
          current: src.source_path,
          status: "error",
          error: (e as Error).message,
        });
      }
    }
    db.close();
    const finalState = getJob(job.id)!;
    emitJob(job.id, {
      type: stoppedEarly ? "stopped" : "done",
      done,
      total: queue.length,
      ingested: finalState.ingested,
      errors: finalState.errors,
      ms: Date.now() - t0,
    });
  })().catch((e) => emitJob(job.id, { type: "failed", error: (e as Error).message }));
});

// ── /api/library/topics ────────────────────────────────────
// Same shape as /api/library/groups but bucketed by classifier output (semantic tag).
app.get("/api/library/topics", (_req, res) => {
  const db = openDb();
  const all = allSources(db);
  const tags = new Map<string, ReturnType<typeof getTag>>();
  for (const t of allTags(db)) tags.set(t!.source_path, t);
  db.close();

  type EnrichedRow = (typeof all)[number] & {
    name: string;
    ext: string;
    bucket: ReturnType<typeof fileTypeBucket>;
    size_bytes: number;
    category: string; // here = semantic tag label
    category_id: string;
    score: number;
  };

  const groups = new Map<
    string,
    {
      category: string;
      category_id: string;
      total: number;
      text: number;
      catalog: number;
      total_size: number;
      latest_mtime: string;
      sample: EnrichedRow[];
    }
  >();

  let untagged = 0;
  for (const row of all) {
    const tag = tags.get(row.source_path);
    if (!tag) {
      untagged++;
      continue;
    }
    let size_bytes = 0;
    try {
      size_bytes = statSync(row.source_path).size;
    } catch {}
    const enriched: EnrichedRow = {
      ...row,
      name: basename(row.source_path),
      ext: extname(row.source_path).toLowerCase(),
      bucket: fileTypeBucket(row.source_path),
      size_bytes,
      category: tag.category_label,
      category_id: tag.category_id,
      score: tag.score,
    };
    let g = groups.get(tag.category_id);
    if (!g) {
      g = {
        category: tag.category_label,
        category_id: tag.category_id,
        total: 0,
        text: 0,
        catalog: 0,
        total_size: 0,
        latest_mtime: enriched.source_mtime,
        sample: [],
      };
      groups.set(tag.category_id, g);
    }
    g.total++;
    if (enriched.kind === "text") g.text++;
    else g.catalog++;
    g.total_size += size_bytes;
    if (enriched.source_mtime > g.latest_mtime) g.latest_mtime = enriched.source_mtime;
    g.sample.push(enriched);
  }
  for (const g of groups.values()) {
    g.sample.sort((a, b) => b.score - a.score);
    g.sample = g.sample.slice(0, 4);
  }
  // Sort by predefined order so the layout is stable across reclassification
  const order = new Map(TAG_CATEGORIES.map((c, i) => [c.id, i]));
  const out = [...groups.values()].sort(
    (a, b) => (order.get(a.category_id) ?? 999) - (order.get(b.category_id) ?? 999),
  );
  res.json({
    groups: out,
    total_categories: out.length,
    total_files: all.length - untagged,
    untagged,
  });
});

// ── /api/ingest/jobs ──────────────────────────────────────
app.get("/api/ingest/jobs", (_req, res) => {
  // Strip recentItems from the list payload — only the detail page
  // needs the per-item ring buffer, and 5k entries × dozens of jobs
  // would balloon this response unnecessarily.
  const jobs = listJobs().map(({ recentItems: _r, ...rest }) => rest);
  res.json({ jobs });
});

// Cooperative stop: signal the job to stop after current item finishes.
// Returns 404 if job is unknown or already finished/stopped.
app.post("/api/ingest/jobs/:id/stop", (req, res) => {
  const ok = requestStop(req.params.id);
  if (!ok) return res.status(404).json({ error: "job not found or not running" });
  res.json({ requested: true });
});

app.get("/api/ingest/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: "not found" });
  res.json(j);
});

// SSE 实时流
app.get("/api/ingest/jobs/:id/stream", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // 立刻发当前 state 一次
  res.write(`event: snapshot\ndata: ${JSON.stringify(j)}\n\n`);
  const send = (ev: unknown) => res.write(`event: progress\ndata: ${JSON.stringify(ev)}\n\n`);
  const unsubscribe = subscribe(req.params.id, send);
  // 完成后保持流 10s 让客户端拿到 done 事件
  req.on("close", () => unsubscribe());
});

// ── 静态前端 ───────────────────────────────────────────────
if (existsSync(UI_DIST)) {
  app.use(express.static(UI_DIST));
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(join(UI_DIST, "index.html"));
  });
}

// ── /api/list-subdirs ─────────────────────────────────────
// Returns the immediate children of a path:
//   subdirs[]: top-level subdirectories, each with a rough file-count
//              estimate (covers everything beneath, capped at 5000).
//   files[]:   loose files sitting directly in this folder, classified
//              text/catalog, excluding the user's default-skip ext list.
//              Per-call cap of 500 — if a folder has more, the UI sees
//              truncated=true and can show "+N more" rather than render
//              5000 rows.
// Used by the first-run wizard + the folder-tree picker in /add/scan.
app.get("/api/list-subdirs", async (req, res) => {
  const root = (req.query.path as string) || "";
  if (!root) return res.status(400).json({ error: "missing path" });
  if (!existsSync(root)) return res.status(404).json({ error: "path not found" });
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const settings = await readIngestSettings();
    const excludedFolders = new Set(settings.excludedFolders);
    const excludedExts = new Set(settings.excludedExts);
    const SAMPLE_CAP = 5000;
    const FILE_CAP = 500;

    // ── subdirs (full subtree estimate) ────────────────────
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
    const out: { name: string; path: string; estimate: number; size: number }[] = [];
    for (const name of dirs) {
      if (excludedFolders.has(name)) continue;
      const path = join(root, name);
      let estimate = 0;
      let size = 0;
      try {
        for await (const p of walkSmart(path, {
          excludes: foldersToWalkerExcludes(settings.excludedFolders),
          excludeExts: settings.excludedExts,
        })) {
          estimate++;
          if (estimate > SAMPLE_CAP) break;
          try {
            size += statSync(p).size;
          } catch {}
        }
      } catch {}
      out.push({ name, path, estimate, size });
    }
    out.sort((a, b) => b.estimate - a.estimate);

    // ── immediate files (not inside subdirs) ───────────────
    const fileEntries = entries
      .filter((e) => e.isFile() && !e.name.startsWith(".") && !/\.icloud$/i.test(e.name));
    const files: { name: string; path: string; size: number; kind: "text" | "catalog" }[] = [];
    let truncated = false;
    for (const e of fileEntries) {
      if (files.length >= FILE_CAP) {
        truncated = true;
        break;
      }
      const ext = extname(e.name).toLowerCase();
      if (ext && excludedExts.has(ext)) continue;
      const fp = join(root, e.name);
      const kind = classify(fp);
      if (kind === "skip") continue;
      let size = 0;
      try {
        size = statSync(fp).size;
      } catch {}
      files.push({ name: e.name, path: fp, size, kind });
    }
    // Stable sort: by name so the picker doesn't shuffle on refresh.
    files.sort((a, b) => a.name.localeCompare(b.name));
    const totalFiles = fileEntries.length;

    res.json({
      root,
      subdirs: out,
      files,
      truncated,
      totalImmediateFiles: totalFiles,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── /api/watched-roots ────────────────────────────────────
app.get("/api/watched-roots", (_req, res) => {
  const db = openDb();
  try {
    const rows = listWatchedRoots(db).map((r) => ({
      ...r,
      stats: watchedRootStats(db, r.path),
    }));
    res.json({ rows, watcher: watcherStatus() });
  } finally {
    db.close();
  }
});

app.post("/api/watched-roots", async (req, res) => {
  const path = (req.body?.path as string) || "";
  const excludes = (req.body?.excludes as string[]) ?? [];
  if (!path || !existsSync(path)) {
    return res.status(400).json({ error: "path missing or does not exist" });
  }
  const db = openDb();
  try {
    addWatchedRoot(db, path, excludes);
    const row = listWatchedRoots(db).find((r) => r.path === path);
    res.json({ row });
  } finally {
    db.close();
  }
  // Pick up the new root in the running watcher (kicks off an initial pass).
  initWatchers().catch((e) => console.error("[watcher] reinit failed:", e));
});

app.delete("/api/watched-roots", async (req, res) => {
  const path = (req.body?.path as string) || (req.query.path as string) || "";
  if (!path) return res.status(400).json({ error: "missing path" });
  const db = openDb();
  try {
    removeWatchedRoot(db, path);
    res.json({ ok: true });
  } finally {
    db.close();
  }
  stopWatching(path).catch((e) => console.error("[watcher] stop failed:", e));
});

app.patch("/api/watched-roots", async (req, res) => {
  const path = (req.body?.path as string) || "";
  const enabled = Boolean(req.body?.enabled);
  if (!path) return res.status(400).json({ error: "missing path" });
  const db = openDb();
  try {
    setWatchEnabled(db, path, enabled);
    res.json({ ok: true });
  } finally {
    db.close();
  }
  if (enabled) {
    initWatchers().catch((e) => console.error("[watcher] reinit failed:", e));
  } else {
    stopWatching(path).catch((e) => console.error("[watcher] stop failed:", e));
  }
});

// ── /api/missing-files ────────────────────────────────────
app.get("/api/missing-files", (_req, res) => {
  const db = openDb();
  try {
    const sourceRows = listMissingSources(db).map((r) => ({
      ...r,
      type: "source" as const,
    }));
    // Missing aliases — they don't have chunks of their own, but the
    // user still wants to know "this duplicate copy is gone".
    const aliasRows = db
      .prepare(
        `SELECT path AS source_path, size_bytes, missing_since, watched_root, source_path AS canonical
         FROM file_aliases WHERE missing_since IS NOT NULL ORDER BY missing_since DESC`,
      )
      .all() as {
        source_path: string;
        size_bytes: number | null;
        missing_since: number;
        watched_root: string | null;
        canonical: string;
      }[];
    const aliasFmt = aliasRows.map((a) => ({
      source_path: a.source_path,
      kind: "text" as const, // arbitrary — UI only branches on type
      chunk_count: 0,
      size_bytes: a.size_bytes,
      missing_since: a.missing_since,
      watched_root: a.watched_root,
      type: "alias" as const,
      duplicateOf: a.canonical,
    }));
    res.json({ rows: [...sourceRows, ...aliasFmt] });
  } finally {
    db.close();
  }
});

app.delete("/api/missing-files", (req, res) => {
  // Bulk delete: per path, check if it's still marked missing as a
  // source OR as an alias, then route to the right cleanup. Same path
  // showing up under both is impossible because path is a PRIMARY KEY
  // in each table.
  const paths = (req.body?.paths as string[]) ?? [];
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: "body.paths must be a non-empty array" });
  }
  const db = openDb();
  let removed = 0;
  let promoted = 0;
  try {
    for (const p of paths) {
      const sRow = db
        .prepare(`SELECT missing_since FROM sources WHERE source_path = ?`)
        .get(p) as { missing_since: number | null } | undefined;
      if (sRow && sRow.missing_since != null) {
        // Try to promote a present alias to the source slot first; if
        // that succeeds the chunks survive and we count it as a
        // promote rather than a delete. Otherwise wipe the row.
        const newPath = promoteAliasToSource(db, p);
        if (newPath) {
          promoted++;
        } else {
          deleteSource(db, p);
          removed++;
        }
        continue;
      }
      const aRow = db
        .prepare(`SELECT missing_since FROM file_aliases WHERE path = ?`)
        .get(p) as { missing_since: number | null } | undefined;
      if (aRow && aRow.missing_since != null) {
        db.prepare(`DELETE FROM file_aliases WHERE path = ?`).run(p);
        removed++;
      }
    }
  } finally {
    db.close();
  }
  res.json({ removed, promoted });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`local-kb admin ready: http://127.0.0.1:${PORT}`);
  if (!existsSync(UI_DIST)) {
    console.log(`(UI not built; run 'npm run ui:build' to enable web interface)`);
  }
  // Bring up file watchers for whatever the user already marked as
  // watched roots. Failures here are non-fatal — incremental indexing
  // simply won't run, the user can still re-scan manually.
  initWatchers().catch((e) => console.error("[watcher] init failed:", e));
  // Scheduler — fire deferred scans at their wall-clock time. Runs
  // a task by re-POSTing the existing scan / ingest-files endpoint
  // through a local fetch so we share the same code path as live
  // user-triggered jobs.
  initScheduler(async (t) => {
    const url = `http://127.0.0.1:${PORT}/api/ingest/${t.kind === "scan" ? "scan" : "files"}`;
    const body =
      t.kind === "scan"
        ? {
            root: t.params.root,
            watchAfterScan: t.params.watchAfterScan ?? true,
            excludes: t.params.excludes ?? [],
            extraIncludeExts: t.params.extraIncludeExts ?? [],
            force: t.params.force ?? false,
          }
        : { paths: t.params.paths ?? [] };
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  });
});

// ── /api/scheduled ───────────────────────────────────────
// Defer a scan / ingest-files job to a wall-clock time. Used by
// ScanConfigure's "Run when?" → "Tonight at 1 AM" flow.
app.post("/api/scheduled", (req, res) => {
  const kind = req.body?.kind as ScheduledTask["kind"];
  const runAt = Number(req.body?.runAt);
  if (kind !== "scan" && kind !== "ingest-files") {
    return res.status(400).json({ error: "kind must be 'scan' or 'ingest-files'" });
  }
  if (!Number.isFinite(runAt) || runAt < Date.now() - 1000) {
    return res.status(400).json({ error: "runAt must be a future ms-epoch timestamp" });
  }
  const params = (req.body?.params ?? {}) as ScheduledTask["params"];
  const t = scheduleTask({ kind, runAt, params });
  res.json({ task: t });
});

app.get("/api/scheduled", (_req, res) => {
  res.json({ tasks: listScheduled() });
});

app.delete("/api/scheduled/:id", (req, res) => {
  const ok = cancelScheduled(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
