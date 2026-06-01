// File-watcher service for incremental indexing.
//
// Two complementary mechanisms keep watched roots in sync with what's on
// disk:
//
//   L0 — chokidar realtime events. FSEvents on macOS, so the watcher
//        hears about add/change/unlink almost immediately. Each event
//        marks the path dirty and (re)starts a 30 min debounce timer
//        for that root. When the timer fires we drain the dirty set
//        into the existing ingest pipeline. Rationale: a user editing
//        files in a working folder produces a flurry of events; we
//        don't want to re-index after every keystroke, but we do want
//        the changes to land within a reasonable window.
//
//   L1 — periodic full pass (30 min). Walks each watched root with the
//        same walkSmart() folder scanner that ingest-scan uses, runs
//        ingestFile() on everything (which itself short-circuits when
//        mtime+size match). At the end, any source row previously
//        attributed to this root that we didn't see this pass is
//        marked missing_since=now() — surfaced to the user as "files
//        on disk are gone, want to clean up?".
//
// Stop / continue: the watcher honors the existing job framework. A
// running scan exposes a jobId so JobProgress can show Stop / Continue.
// Realtime add/change events go through ingestSingle() which is a one-
// off action with no Stop button — that's intentional, single files
// finish in seconds.

import chokidar from "chokidar";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { ingestFile } from "./ingest.ts";
import {
  openDb,
  listWatchedRoots,
  markScanRun,
  markSourcesMissing,
  markSourceMissing,
  markAliasesMissing,
  getWatchedRootExcludes,
  getSource,
  clearMissing,
  type WatchedRoot,
} from "./db.ts";
import { walkSmart } from "./walker.ts";
import { readIngestSettings, foldersToWalkerExcludes } from "./settings.ts";

// Watcher cadence is read from Settings at startup; env vars still
// override for ad-hoc tuning. Restart of the admin process picks up
// any Settings changes — wired into Settings page save which can
// also poke initWatchers() if needed in the future.
async function getCadenceMs(): Promise<{ debounceMs: number; periodMs: number }> {
  const envDeb = process.env.BITROVE_WATCH_DEBOUNCE_MS;
  const envPer = process.env.BITROVE_WATCH_PERIOD_MS;
  if (envDeb && envPer) {
    return { debounceMs: Number(envDeb), periodMs: Number(envPer) };
  }
  const s = await readIngestSettings();
  return {
    debounceMs: (s.watcherDebounceMin ?? 30) * 60 * 1000,
    periodMs: (s.watcherScanIntervalMin ?? 30) * 60 * 1000,
  };
}

// ── activity history ────────────────────────────────────────
// In-memory rolling log of recent watcher events (scan completes,
// ingest counts, errors). The UI polls this to show "what has the
// watcher been doing?" without needing an SSE channel. Capped so an
// app running for weeks doesn't grow unbounded.
const HISTORY_LIMIT = 200;
type HistoryEntry =
  | { ts: number; kind: "scan-start"; root: string }
  | { ts: number; kind: "scan-done"; root: string; seen: number; missingSources: number; missingAliases: number; ms: number }
  | { ts: number; kind: "drain"; root: string; files: number }
  | { ts: number; kind: "error"; root: string; path?: string; message: string };
const history: HistoryEntry[] = [];
function recordHistory(entry: HistoryEntry): void {
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.shift();
}
export function getWatcherHistory(): HistoryEntry[] {
  // Newest first — most UIs render top-down latest.
  return [...history].reverse();
}

type WatchEntry = {
  root: string;
  watcher: chokidar.FSWatcher;
  dirty: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
  periodicTimer: NodeJS.Timeout | null;
  // Prevent two passes piling up if the previous one is still running.
  scanning: boolean;
  // Path the watcher is actively running ingestFile() on, exposed to
  // the UI so "Scanning…" rows can show the live file.
  currentFile: string | null;
  // User-supplied path-prefix excludes for this watched root (set in
  // the scan-confirm UI). Combined with the global settings excludes
  // when filtering chokidar events and walking the tree.
  perRootExcludes: string[];
  // Per-path "we saw an unlink, give the user a few seconds to do an
  // atomic move before we stamp missing_since" timers. add events
  // for the same path cancel the pending mark.
  pendingMissing: Map<string, NodeJS.Timeout>;
};

// Grace period between chokidar unlink and stamping missing_since.
// Most atomic moves (Finder drag-and-drop, mv, editor save-replace)
// fire unlink + add within tens of milliseconds; 3 s is comfortable
// for that, while still feeling "live" for an actual delete.
const UNLINK_TO_MISSING_GRACE_MS = 3000;

const active = new Map<string, WatchEntry>();
let initialized = false;

/* ── lifecycle ──────────────────────────────────────────────── */

// Read watched_roots from DB and start watching each enabled one.
// Idempotent: safe to call on startup and whenever the list changes.
export async function initWatchers(): Promise<void> {
  const db = openDb();
  try {
    const roots = listWatchedRoots(db).filter((r) => r.watch_enabled === 1);
    for (const r of roots) {
      if (!active.has(r.path)) await startWatching(r);
    }
    // Stop anything no longer in the table.
    const enabled = new Set(roots.map((r) => r.path));
    for (const p of [...active.keys()]) {
      if (!enabled.has(p)) await stopWatching(p);
    }
  } finally {
    db.close();
  }
  initialized = true;
}

export async function startWatching(root: WatchedRoot): Promise<void> {
  if (active.has(root.path)) return;
  if (!existsSync(root.path)) {
    console.warn(`[watcher] root does not exist, skipping: ${root.path}`);
    return;
  }

  const settings = await readIngestSettings();
  // Chokidar's "ignored" takes a list of matchers; folder-name excludes
  // become substrings of the form "/name/". walkSmart uses the same
  // patterns during the periodic pass, so add/change events and the
  // periodic walk treat the same files as in-scope.
  const folderPatterns = foldersToWalkerExcludes(settings.excludedFolders);

  // Per-root absolute path prefixes the user excluded in the scan-
  // confirm UI (e.g. "/Users/x/Documents/Downloads/"). The DB stores
  // them as the canonical source of truth — re-read here so a watcher
  // restart picks up edits.
  const dbForExcl = openDb();
  let perRootExcludes: string[];
  try {
    perRootExcludes = getWatchedRootExcludes(dbForExcl, root.path);
  } finally {
    dbForExcl.close();
  }

  const watcher = chokidar.watch(root.path, {
    ignored: (path) => {
      // Hidden dotfiles / iCloud placeholders (same heuristics as walker)
      if (/(^|\/)\.[^/]+$/.test(path)) return true;
      if (/\.icloud$/i.test(path)) return true;
      for (const pat of folderPatterns) if (path.includes(pat)) return true;
      // User-defined sub-tree excludes — straight path-prefix match
      // against the absolute path.
      for (const ex of perRootExcludes) if (path.startsWith(ex)) return true;
      const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
      if (ext && settings.excludedExts.includes(ext)) return true;
      return false;
    },
    // ignoreInitial: don't fire add events for the existing tree on
    // startup. The periodic pass + the initial scan run by the user's
    // "Add" flow already cover that.
    ignoreInitial: true,
    // chokidar's awaitWriteFinish smooths events while a file is being
    // written. 2s of quiet is enough for editors saving a document; the
    // long 30-min user-facing debounce handles the bigger "user is in
    // the middle of working on this folder" case.
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 200,
    },
    persistent: true,
  });

  const entry: WatchEntry = {
    root: root.path,
    watcher,
    dirty: new Set(),
    debounceTimer: null,
    periodicTimer: null,
    scanning: false,
    currentFile: null,
    perRootExcludes,
    pendingMissing: new Map(),
  };

  const { debounceMs, periodMs } = await getCadenceMs();
  const scheduleDrain = () => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(
      () => drainDirty(entry).catch((e) => console.error("[watcher] drain failed:", e)),
      debounceMs,
    );
  };

  // Cheap synchronous DB + stat hits inside the chokidar handlers
  // so the "1 change pending" / "1 missing" header counters reflect
  // reality immediately, without waiting for the 30 min debounce.
  // Heavy work (extract + chunk + embed) still goes through drainDirty.
  //
  // Returns true if the path is genuinely new/changed and belongs in
  // the dirty Set. Returns false for "already-cached" paths — those
  // are atomic-move arrivals (Finder drag, mv, save-replace) where
  // mtime + size match the existing sources row, so an ingest would
  // immediately return skipped-cached and clutter the pending count
  // for no reason.
  const reconcileOnAdd = (absent: string): boolean => {
    try {
      const dbX = openDb();
      try {
        const src = getSource(dbX, absent);
        if (!src) return true; // never indexed → needs ingest
        // File came back after grace period stamped it missing.
        // Clear the flag so the "missing" counter drops.
        if (src.missing_since != null) clearMissing(dbX, absent);
        // mtime + size match the row we already have → cached.
        // No ingest needed; tell caller not to mark dirty.
        let stat: ReturnType<typeof statSync> | null = null;
        try { stat = statSync(absent); } catch {}
        if (
          stat &&
          src.mtime_ms != null &&
          src.mtime_ms === stat.mtimeMs &&
          src.size_bytes === stat.size
        ) {
          return false;
        }
        return true;
      } finally {
        dbX.close();
      }
    } catch {
      return true; // be conservative if the DB hit fails
    }
  };

  watcher
    .on("add", (p) => {
      const absent = resolve(p);
      // Cancel a pending "stamp this missing" timer — atomic moves
      // (mv, drag-and-drop within Finder, editor save-replace) fire
      // unlink + add within milliseconds and shouldn't flicker
      // through a missing state.
      const t = entry.pendingMissing.get(absent);
      if (t) {
        clearTimeout(t);
        entry.pendingMissing.delete(absent);
      }
      // Check cached state. If the file is already indexed and its
      // (mtime, size) match the sources row, this is a no-op arrival
      // and shouldn't appear as "change pending." Otherwise queue it
      // for the normal debounce + drain.
      const needsIngest = reconcileOnAdd(absent);
      if (needsIngest) {
        entry.dirty.add(absent);
        scheduleDrain();
      }
    })
    .on("change", (p) => {
      entry.dirty.add(resolve(p));
      scheduleDrain();
    })
    .on("unlink", (p) => {
      const absent = resolve(p);
      // Path is gone; drop any pending ingest for it.
      entry.dirty.delete(absent);
      // Schedule the missing stamp. Three-second grace gives an
      // atomic move room to fire add() and cancel this timer; long
      // enough to absorb iCloud / Spotlight churn, short enough that
      // a real delete shows up in the UI promptly.
      // Cancel any previous timer for this path first (rapid unlink
      // → add → unlink edge case).
      const prev = entry.pendingMissing.get(absent);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        entry.pendingMissing.delete(absent);
        try {
          const dbX = openDb();
          try {
            markSourceMissing(dbX, absent, Date.now());
          } finally {
            dbX.close();
          }
        } catch {}
      }, UNLINK_TO_MISSING_GRACE_MS);
      entry.pendingMissing.set(absent, t);
    })
    .on("error", (e) => console.error(`[watcher] ${root.path}:`, e));

  // Periodic full pass timer.
  entry.periodicTimer = setInterval(
    () => runFullPass(entry).catch((e) => console.error("[watcher] periodic pass failed:", e)),
    periodMs,
  );

  active.set(root.path, entry);
  console.log(`[watcher] watching ${root.path}`);

  // Kick off an immediate full pass so a newly-added watched root gets
  // indexed without waiting 30 min — but ONLY after the embed server is
  // ready, otherwise every file blows up with HTTP 503 ("model is
  // loading"). The wait is bounded (90s) so we don't hang forever if
  // something's actually broken.
  (async () => {
    try {
      await waitForEmbedReady(90_000);
    } catch (e) {
      recordHistory({
        ts: Date.now(),
        kind: "error",
        root: entry.root,
        message: `embed server never came up: ${(e as Error).message}`,
      });
      // Still try the pass — admin /api/health may be misconfigured.
    }
    runFullPass(entry).catch((e) => console.error("[watcher] initial pass failed:", e));
  })();
}

// Poll the embed server's /health until it returns ok, up to maxMs.
// Used to gate scan kickoff so we don't generate dozens of 503s while
// the GGUF model is still being loaded into memory.
async function waitForEmbedReady(maxMs: number): Promise<void> {
  const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:8765";
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${EMBED_URL}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return;
    } catch {}
    attempt++;
    // Exponential-ish backoff between probes, capped at 3s.
    const delay = Math.min(500 + attempt * 250, 3000);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`embed server not ready after ${maxMs} ms`);
}

export async function stopWatching(path: string): Promise<void> {
  const entry = active.get(path);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.periodicTimer) clearInterval(entry.periodicTimer);
  // Drop any pending unlink-grace timers so they don't stamp
  // missing on rows under a root the user just stopped watching.
  for (const t of entry.pendingMissing.values()) clearTimeout(t);
  entry.pendingMissing.clear();
  await entry.watcher.close();
  active.delete(path);
  console.log(`[watcher] stopped ${path}`);
}

export async function shutdownAllWatchers(): Promise<void> {
  for (const p of [...active.keys()]) await stopWatching(p);
}

/* ── work passes ────────────────────────────────────────────── */

// Drain the dirty set built up by chokidar events. Each path goes
// through ingestFile() which already does the (mtime,size,hash) skip
// dance + dedup.
async function drainDirty(entry: WatchEntry): Promise<void> {
  if (entry.scanning) {
    // Periodic pass is in flight; let it absorb whatever's dirty.
    return;
  }
  if (entry.dirty.size === 0) return;
  const paths = [...entry.dirty];
  entry.dirty.clear();
  entry.debounceTimer = null;

  const db = openDb();
  let errored = 0;
  try {
    for (const p of paths) {
      // The file may have been unlinked between the add event and
      // now (user moved it back out, iCloud evicted, …). Skip those
      // silently so a stale dirty entry doesn't show up as a job
      // error a half-hour after the user already cleaned up.
      if (!existsSync(p)) continue;
      entry.currentFile = p;
      // includeDuplicates=false: a watcher catching a freshly-added
      // duplicate should skip it just like the folder-scan flow does.
      const r = await ingestFile(db, p, { watchedRoot: entry.root, includeDuplicates: false });
      if (r.status === "error") {
        console.warn(`[watcher] ingest error ${p}:`, r.error);
        recordHistory({ ts: Date.now(), kind: "error", root: entry.root, path: p, message: r.error });
        errored++;
      }
    }
  } finally {
    entry.currentFile = null;
    db.close();
    void errored; // surfaced via recordHistory entries
    recordHistory({ ts: Date.now(), kind: "drain", root: entry.root, files: paths.length });
  }
}

async function runFullPass(entry: WatchEntry): Promise<void> {
  if (entry.scanning) return;
  entry.scanning = true;
  const startedAt = Date.now();
  const db = openDb();
  const seen = new Set<string>();
  recordHistory({ ts: startedAt, kind: "scan-start", root: entry.root });
  try {
    markScanRun(db, entry.root, false);

    const settings = await readIngestSettings();
    const walkOpts = {
      // Per-root excludes go in *before* the global folder excludes so
      // either category can short-circuit the walker.
      excludes: [...entry.perRootExcludes, ...foldersToWalkerExcludes(settings.excludedFolders)],
      excludeExts: settings.excludedExts,
    };

    for await (const p of walkSmart(entry.root, walkOpts)) {
      seen.add(p);
      entry.currentFile = p;
      const r = await ingestFile(db, p, { watchedRoot: entry.root, includeDuplicates: false });
      if (r.status === "error") {
        console.warn(`[watcher] periodic ingest error ${p}:`, r.error);
        recordHistory({ ts: Date.now(), kind: "error", root: entry.root, path: p, message: r.error });
      }
    }
    entry.currentFile = null;

    const now = Date.now();
    const missingSources = markSourcesMissing(db, entry.root, seen, now);
    const missingAliases = markAliasesMissing(db, entry.root, seen, now);
    markScanRun(db, entry.root, true);
    const ms = Date.now() - startedAt;
    console.log(
      `[watcher] full pass ${entry.root}: ${seen.size} seen, ${missingSources} sources + ${missingAliases} aliases marked missing in ${ms}ms`,
    );
    recordHistory({
      ts: now,
      kind: "scan-done",
      root: entry.root,
      seen: seen.size,
      missingSources,
      missingAliases,
      ms,
    });
  } finally {
    db.close();
    entry.scanning = false;
  }
}

export function watcherStatus(): {
  initialized: boolean;
  active: {
    root: string;
    dirty: number;
    // Up to 20 of the actual paths in the dirty set so the UI can
    // show "Waiting to ingest: foo.pdf, bar.md, …" rather than
    // just "1 change pending" with no way to know what changed.
    dirtyPaths: string[];
    scanning: boolean;
    currentFile: string | null;
  }[];
} {
  return {
    initialized,
    active: [...active.values()].map((e) => ({
      root: e.root,
      dirty: e.dirty.size,
      dirtyPaths: [...e.dirty].slice(0, 20),
      scanning: e.scanning,
      currentFile: e.currentFile,
    })),
  };
}
