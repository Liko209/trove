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
import { existsSync } from "node:fs";
import { ingestFile } from "./ingest.ts";
import {
  openDb,
  listWatchedRoots,
  markScanRun,
  markSourcesMissing,
  type WatchedRoot,
} from "./db.ts";
import { walkSmart } from "./walker.ts";
import { readIngestSettings, foldersToWalkerExcludes } from "./settings.ts";

// 30 minutes for both the debounce and the periodic pass. Both are in
// the same order of magnitude so the user-perceptible latency on file
// changes is at most ~30 min regardless of whether chokidar saw the
// event. Calibrate via env if needed.
const DEBOUNCE_MS = Number(process.env.BITROVE_WATCH_DEBOUNCE_MS ?? 30 * 60 * 1000);
const PERIOD_MS = Number(process.env.BITROVE_WATCH_PERIOD_MS ?? 30 * 60 * 1000);

type WatchEntry = {
  root: string;
  watcher: chokidar.FSWatcher;
  dirty: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
  periodicTimer: NodeJS.Timeout | null;
  // Prevent two passes piling up if the previous one is still running.
  scanning: boolean;
};

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

  const watcher = chokidar.watch(root.path, {
    ignored: (path) => {
      // Hidden dotfiles / iCloud placeholders (same heuristics as walker)
      if (/(^|\/)\.[^/]+$/.test(path)) return true;
      if (/\.icloud$/i.test(path)) return true;
      for (const pat of folderPatterns) if (path.includes(pat)) return true;
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
  };

  const scheduleDrain = () => {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => drainDirty(entry).catch((e) => console.error("[watcher] drain failed:", e)),
      DEBOUNCE_MS);
  };

  watcher
    .on("add", (p) => {
      entry.dirty.add(resolve(p));
      scheduleDrain();
    })
    .on("change", (p) => {
      entry.dirty.add(resolve(p));
      scheduleDrain();
    })
    .on("unlink", (p) => {
      // We don't drop the source row instantly on unlink — the user might
      // be moving the file, or iCloud might be evicting a placeholder.
      // The periodic full pass is where missing_since gets stamped.
      const absent = resolve(p);
      console.log(`[watcher] file unlinked, will reconcile in next pass: ${absent}`);
    })
    .on("error", (e) => console.error(`[watcher] ${root.path}:`, e));

  // Periodic full pass timer.
  entry.periodicTimer = setInterval(
    () => runFullPass(entry).catch((e) => console.error("[watcher] periodic pass failed:", e)),
    PERIOD_MS,
  );

  active.set(root.path, entry);
  console.log(`[watcher] watching ${root.path}`);

  // Kick off an immediate full pass so a newly-added watched root gets
  // indexed without waiting 30 min. Don't await — the caller's HTTP
  // response shouldn't block on a scan.
  runFullPass(entry).catch((e) => console.error("[watcher] initial pass failed:", e));
}

export async function stopWatching(path: string): Promise<void> {
  const entry = active.get(path);
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.periodicTimer) clearInterval(entry.periodicTimer);
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
  try {
    for (const p of paths) {
      // includeDuplicates=false: a watcher catching a freshly-added
      // duplicate should skip it just like the folder-scan flow does.
      const r = await ingestFile(db, p, { watchedRoot: entry.root, includeDuplicates: false });
      if (r.status === "error") {
        console.warn(`[watcher] ingest error ${p}:`, r.error);
      }
    }
  } finally {
    db.close();
  }
}

async function runFullPass(entry: WatchEntry): Promise<void> {
  if (entry.scanning) return;
  entry.scanning = true;
  const startedAt = Date.now();
  const db = openDb();
  const seen = new Set<string>();
  try {
    markScanRun(db, entry.root, false);

    const settings = await readIngestSettings();
    const walkOpts = {
      excludes: foldersToWalkerExcludes(settings.excludedFolders),
      excludeExts: settings.excludedExts,
    };

    for await (const p of walkSmart(entry.root, walkOpts)) {
      seen.add(p);
      const r = await ingestFile(db, p, { watchedRoot: entry.root, includeDuplicates: false });
      if (r.status === "error") {
        console.warn(`[watcher] periodic ingest error ${p}:`, r.error);
      }
    }

    const missingCount = markSourcesMissing(db, entry.root, seen, Date.now());
    markScanRun(db, entry.root, true);
    console.log(
      `[watcher] full pass ${entry.root}: ${seen.size} files seen, ${missingCount} marked missing in ${Date.now() - startedAt}ms`,
    );
  } finally {
    db.close();
    entry.scanning = false;
  }
}

export function watcherStatus(): {
  initialized: boolean;
  active: { root: string; dirty: number; scanning: boolean }[];
} {
  return {
    initialized,
    active: [...active.values()].map((e) => ({
      root: e.root,
      dirty: e.dirty.size,
      scanning: e.scanning,
    })),
  };
}
