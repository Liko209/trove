// Scan configure — second-level page that replaces ScanConfirmModal.
//
// The modal version was getting cramped: stats + subdir checkboxes +
// file-type chips + sample preview + watch toggle + drill-in. Each is
// a meaningful control the user wants room to inspect. A full page
// gives every section its own breathing space and adds an explicit
// sub-tree picker (drill into ~/Documents → pick Notes/ instead of
// the whole thing) that wasn't viable inline.
//
// Route: /add/scan?path=<encoded>
// Reached by Add.tsx via navigate(`/add/scan?path=${encoded}`).
// Cancel returns to /add. Start kicks the scan and goes to /jobs.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  PermissionPill,
  openSettingsFor,
  usePermission,
} from "../components/PermissionStatus.tsx";
import { bytes, formatDurationSeconds, shortPath } from "../lib/format.ts";
import { BookIcon, FileIcon, FolderOpenIcon } from "../components/icons.tsx";

type Preview = Awaited<ReturnType<typeof api.sourcePreview>>;

export default function ScanConfigure() {
  const [params] = useSearchParams();
  const path = params.get("path") || "";
  const navigate = useNavigate();
  const { perm, recheck } = usePermission(path);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-scan overrides — same shape as the old modal.
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [excludedSubdirs, setExcludedSubdirs] = useState<Set<string>>(new Set());
  const [watchAfter, setWatchAfter] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Drill: when the user wants to go deeper than the auto-summary's
  // top-6 subdirs, we fetch the actual immediate-child listing and
  // let them check/uncheck each, just like ScanConfirmModal does for
  // the rolled-up view. drillOpen toggles the section.
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillSubdirs, setDrillSubdirs] = useState<
    { name: string; path: string; estimate: number; size: number }[] | null
  >(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // Names (relative to path) the user explicitly drilled into and
  // disabled. Same semantics as excludedSubdirs but covers subdirs
  // that aren't in preview.topFolders.
  const [drillExcluded, setDrillExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!path) return;
    setPreview(null);
    setErr(null);
    setOverrides(new Set());
    setExcludedSubdirs(new Set());
    setDrillExcluded(new Set());
    setDrillSubdirs(null);
    setDrillOpen(false);
    if (perm.state !== "granted") return;
    api.sourcePreview(path).then(setPreview).catch((e) => setErr((e as Error).message));
  }, [path, perm.state]);

  // Lazy-load full subdir list the first time the user opens the
  // drill panel — avoids a second round-trip if they never go there.
  useEffect(() => {
    if (!drillOpen || drillSubdirs !== null || !path) return;
    setDrillLoading(true);
    api
      .listSubdirs(path)
      .then((r) => setDrillSubdirs(r.subdirs))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setDrillLoading(false));
  }, [drillOpen, drillSubdirs, path]);

  const excludedExtSet = useMemo(
    () => new Set(preview?.excludedExts ?? []),
    [preview?.excludedExts],
  );

  // Three independent subtractions from the raw preview total.
  // - excludedFromDefault: ext patterns user kept on default-exclude list
  // - excludedFromSubdirs: top-6 subdirs unchecked
  // - excludedFromDrill: any drilled subdir unchecked that's NOT
  //   already in top-6 (avoids double-counting)
  const {
    excludedFromDefault,
    excludedFromSubdirs,
    excludedFromDrill,
    effectiveIndexable,
  } = useMemo(() => {
    if (!preview)
      return {
        excludedFromDefault: 0,
        excludedFromSubdirs: 0,
        excludedFromDrill: 0,
        effectiveIndexable: 0,
      };
    const total = preview.text + preview.catalog;
    let extDropped = 0;
    for (const e of preview.excludedByExt) {
      if (!overrides.has(e.ext)) extDropped += e.indexable;
    }
    let subDropped = 0;
    for (const f of preview.topFolders) {
      if (excludedSubdirs.has(f.name)) subDropped += f.indexable;
    }
    let drillDropped = 0;
    if (drillSubdirs) {
      const topNames = new Set(preview.topFolders.map((f) => f.name));
      for (const d of drillSubdirs) {
        if (drillExcluded.has(d.name) && !topNames.has(d.name)) {
          drillDropped += d.estimate;
        }
      }
    }
    return {
      excludedFromDefault: extDropped,
      excludedFromSubdirs: subDropped,
      excludedFromDrill: drillDropped,
      effectiveIndexable: Math.max(0, total - extDropped - subDropped - drillDropped),
    };
  }, [preview, overrides, excludedSubdirs, drillSubdirs, drillExcluded]);

  const ratio = preview && preview.totalScanned > 0
    ? Math.round((effectiveIndexable / preview.totalScanned) * 100)
    : 0;

  function toggleExtOverride(ext: string) {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }
  function toggleSubdir(name: string) {
    setExcludedSubdirs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
  function toggleDrill(name: string) {
    setDrillExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Build absolute-path exclude prefixes from both subdir sources.
  // Walker substring match means /Users/.../{name}/ kills the subtree.
  function excludePaths(): string[] {
    const norm = path.endsWith("/") ? path.slice(0, -1) : path;
    const names = new Set<string>();
    for (const n of excludedSubdirs) if (n !== "(root)") names.add(n);
    for (const n of drillExcluded) names.add(n);
    return [...names].map((n) => `${norm}/${n}/`);
  }

  async function start() {
    if (!preview || effectiveIndexable === 0 || perm.state !== "granted") return;
    setSubmitting(true);
    try {
      await api.ingestScan(path, {
        extraIncludeExts: [...overrides],
        watchAfterScan: watchAfter,
        excludes: excludePaths(),
      });
      navigate("/jobs");
    } catch (e) {
      setErr((e as Error).message);
      setSubmitting(false);
    }
  }

  // ── render ──────────────────────────────────────────────────
  if (!path) {
    return (
      <div className="max-w-3xl mx-auto">
        <h1 className="t-display mb-3">Scan</h1>
        <p className="text-stone-600 text-sm">Missing path. Go back to Add and pick a folder.</p>
        <Link to="/add" className="text-sm underline">← Back to Add</Link>
      </div>
    );
  }

  const denied = perm.state === "denied";
  const checking = perm.state === "checking";

  return (
    <div className="max-w-3xl mx-auto pb-20">
      <div className="mb-6">
        <Link to="/add" className="text-xs text-stone-500 hover:text-stone-900 underline-offset-2 hover:underline">
          ← Back to Add
        </Link>
      </div>
      <h1 className="t-display mb-2">Configure scan</h1>
      <p className="font-mono text-sm text-stone-600 mb-8 truncate" title={path}>
        {shortPath(path)}
      </p>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {denied && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm mb-6">
          <div className="flex items-center gap-2 mb-1">
            <PermissionPill perm={perm} />
            <span className="font-medium">macOS is blocking access to this folder.</span>
          </div>
          <div className="text-xs text-rose-700 mb-3">
            Open System Settings → Privacy & Security, find Bitrove in the Files
            and Folders section, and toggle it on. Then click "Re-check" below.
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openSettingsFor("files")}
              className="text-xs px-3 py-1.5 rounded-md font-medium bg-stone-900 text-white hover:bg-stone-700"
            >
              Open Settings
            </button>
            <button
              onClick={recheck}
              className="text-xs px-3 py-1.5 rounded-md font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-50"
            >
              Re-check
            </button>
          </div>
        </div>
      )}

      {(checking || (perm.state === "granted" && !preview)) && !err && (
        <div className="flex items-center gap-3 py-12 text-sm text-stone-500">
          <div className="h-4 w-4 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
          {checking ? "Checking access…" : "Looking inside this folder…"}
        </div>
      )}

      {preview && perm.state === "granted" && (
        <>
          {/* ── Overview ───────────────────────────────────────── */}
          <section className="mb-10">
            <h2 className="t-section mb-3">Overview</h2>
            <div className="grid grid-cols-3 gap-3 mb-5">
              <Stat label="Documents" value={preview.text.toLocaleString()} sub="full text" />
              <Stat label="Books & decks" value={preview.catalog.toLocaleString()} sub="catalog only" />
              <Stat label="Skipped" value={preview.skipped.toLocaleString()} sub="noise" />
            </div>
            <ul className="text-sm text-stone-700 space-y-2">
              <Bullet>
                Will index <strong>{effectiveIndexable.toLocaleString()}</strong> files
                {preview.totalScanned > 0 && (
                  <span className="text-stone-500">
                    {" "}({ratio}% of {preview.totalScanned.toLocaleString()} scanned)
                  </span>
                )}
              </Bullet>
              <Bullet>
                Estimated time: <strong>{formatDurationSeconds(preview.estimatedSeconds)}</strong>
              </Bullet>
              {excludedFromDefault > 0 && (
                <Bullet>
                  Skipping <strong>{excludedFromDefault.toLocaleString()}</strong> files
                  of code-like types you've set to exclude.{" "}
                  <Link to="/settings" className="text-stone-900 underline hover:no-underline">
                    Edit defaults
                  </Link>
                </Bullet>
              )}
              {excludedFromSubdirs + excludedFromDrill > 0 && (
                <Bullet>
                  Skipping <strong>{(excludedFromSubdirs + excludedFromDrill).toLocaleString()}</strong>{" "}
                  files from unchecked sub-folders.
                </Bullet>
              )}
              {preview.cappedAt && (
                <Bullet warn>
                  Folder is very large; only the first {preview.cappedAt.toLocaleString()} entries
                  were scanned for the preview. Real indexing will still cover everything.
                </Bullet>
              )}
            </ul>
          </section>

          {/* ── Sub-folders ──────────────────────────────────── */}
          {preview.topFolders.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="t-section">Which sub-folders to include</h2>
                <span className="text-[10px] text-stone-400">
                  uncheck to skip · top {preview.topFolders.length}
                </span>
              </div>
              <FolderBreakdown
                folders={preview.topFolders}
                excluded={excludedSubdirs}
                onToggle={toggleSubdir}
              />

              {/* Drill — full immediate-child list (cached on demand) */}
              <button
                type="button"
                onClick={() => setDrillOpen((v) => !v)}
                className="mt-3 text-xs text-stone-500 hover:text-stone-900 underline-offset-2 hover:underline"
              >
                {drillOpen ? "Hide" : "Show"} all subfolders →
              </button>
              {drillOpen && (
                <div className="mt-3 border-t border-stone-100 pt-3">
                  {drillLoading && (
                    <div className="text-xs text-stone-500 flex items-center gap-2 py-2">
                      <div className="w-3 h-3 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
                      Reading subfolders…
                    </div>
                  )}
                  {drillSubdirs && drillSubdirs.length === 0 && !drillLoading && (
                    <div className="text-xs text-stone-500 italic">No subfolders.</div>
                  )}
                  {drillSubdirs && drillSubdirs.length > 0 && (
                    <ul className="space-y-1">
                      {drillSubdirs.map((d) => {
                        const inTop = preview.topFolders.some((f) => f.name === d.name);
                        const off = inTop
                          ? excludedSubdirs.has(d.name)
                          : drillExcluded.has(d.name);
                        const onToggle = inTop ? () => toggleSubdir(d.name) : () => toggleDrill(d.name);
                        return (
                          <li key={d.path}>
                            <label className="flex items-center gap-2 text-xs py-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={!off}
                                onChange={onToggle}
                                className="accent-stone-900"
                              />
                              <span className={"flex-1 truncate " + (off ? "line-through text-stone-400" : "text-stone-700")}>
                                {d.name}
                              </span>
                              <span className={"shrink-0 tabular-nums text-[11px] " + (off ? "text-stone-300" : "text-stone-500")}>
                                {d.estimate >= 5000 ? "5000+" : d.estimate.toLocaleString()} files
                                {d.size > 0 && <span className={off ? "text-stone-300" : "text-stone-400"}> · {bytes(d.size)}</span>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── File types ──────────────────────────────────── */}
          {preview.topExtensions.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="t-section">File types found</h2>
                <span className="text-[10px] text-stone-400">
                  tap a greyed type to include it this time
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {preview.topExtensions.map((e) => {
                  const isExcludedDefault = excludedExtSet.has(e.ext);
                  const overridden = overrides.has(e.ext);
                  const effectivelyOff = isExcludedDefault && !overridden;
                  const onClick = isExcludedDefault ? () => toggleExtOverride(e.ext) : undefined;
                  const cls = effectivelyOff
                    ? "bg-stone-100 text-stone-400 line-through cursor-pointer hover:opacity-80"
                    : overridden
                      ? "bg-emerald-100 text-emerald-800 border border-emerald-300 cursor-pointer hover:opacity-80"
                      : "bg-stone-100 text-stone-700 cursor-default";
                  return (
                    <button
                      type="button"
                      key={e.ext}
                      onClick={onClick}
                      disabled={!isExcludedDefault}
                      title={
                        effectivelyOff
                          ? `${e.ext} is off by default. Click to include in this scan.`
                          : overridden
                            ? `${e.ext} is off by default but you've added it to this scan.`
                            : `${e.ext} · ${e.count.toLocaleString()} files`
                      }
                      className={`text-xs px-2 py-0.5 rounded-full tabular-nums transition ${cls}`}
                    >
                      {e.ext} · {e.count.toLocaleString()}
                      {overridden && <span className="ml-1">✓</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Sample preview ──────────────────────────────── */}
          {preview.sampleFiles.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="t-section">Sample of what will be indexed</h2>
                <span className="text-[10px] text-stone-400">first {preview.sampleFiles.length}</span>
              </div>
              <ul className="space-y-1">
                {preview.sampleFiles.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-xs text-stone-700">
                    <span className="shrink-0 text-stone-400">
                      {f.kind === "text" ? <FileIcon size={14} /> : <BookIcon size={14} />}
                    </span>
                    <span className="truncate font-mono" title={f.path}>
                      {f.name}
                    </span>
                    <span className="text-stone-400 tabular-nums shrink-0 ml-auto">
                      {bytes(f.size)}
                    </span>
                  </li>
                ))}
              </ul>
              {effectiveIndexable > preview.sampleFiles.length && (
                <div className="text-[11px] text-stone-500 mt-2">
                  + {(effectiveIndexable - preview.sampleFiles.length).toLocaleString()} more like these
                </div>
              )}
            </section>
          )}

          {/* ── Watch toggle ────────────────────────────────── */}
          <section className="mb-10">
            <h2 className="t-section mb-3">Keep watching</h2>
            <label className="flex items-start gap-3 p-4 rounded-xl border border-stone-200 cursor-pointer hover:bg-stone-50">
              <input
                type="checkbox"
                checked={watchAfter}
                onChange={(e) => setWatchAfter(e.target.checked)}
                className="mt-0.5 accent-stone-900"
              />
              <div>
                <div className="font-medium text-stone-900 text-sm">
                  Re-index this folder when files change
                </div>
                <div className="text-xs text-stone-500 mt-0.5 leading-relaxed">
                  Bitrove will scan every 30 min and pick up new / changed files
                  automatically. Deleted files appear in Library so you can
                  decide whether to clean up the index. Anything you uncheck
                  above will stay excluded on every future pass.
                </div>
              </div>
            </label>
          </section>
        </>
      )}

      {/* ── Sticky footer (start button) ───────────────────── */}
      <div className="sticky bottom-0 -mx-4 px-4 pt-6 pb-4 bg-gradient-to-t from-stone-50 via-stone-50/90 to-stone-50/0 flex items-center gap-3">
        <FolderOpenIcon size={16} className="text-stone-400" />
        <span className="text-xs text-stone-500">
          {preview && perm.state === "granted"
            ? `${effectiveIndexable.toLocaleString()} files · runs in the background, pause any time`
            : "—"}
        </span>
        <Link
          to="/add"
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Cancel
        </Link>
        <button
          onClick={start}
          disabled={
            !preview || effectiveIndexable === 0 || perm.state !== "granted" || submitting
          }
          className="px-5 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Starting…" : "Start indexing"}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-lg p-3 border border-stone-200">
      <div className="t-section mb-1">{label}</div>
      <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none">{value}</div>
      <div className="text-xs text-stone-500 mt-1">{sub}</div>
    </div>
  );
}

function Bullet({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <li className={"flex items-start gap-2 " + (warn ? "text-amber-800" : "")}>
      <span className={"shrink-0 mt-2 h-1 w-1 rounded-full " + (warn ? "bg-amber-500" : "bg-stone-400")} />
      <div>{children}</div>
    </li>
  );
}

function FolderBreakdown({
  folders,
  excluded,
  onToggle,
}: {
  folders: { name: string; indexable: number; skipped: number; bytes: number }[];
  excluded: Set<string>;
  onToggle: (name: string) => void;
}) {
  const max = Math.max(...folders.map((f) => f.indexable), 1);
  return (
    <ul className="space-y-1.5">
      {folders.map((f) => {
        const isExcluded = excluded.has(f.name);
        const togglable = f.name !== "(root)";
        const ratio = Math.round((f.indexable / max) * 100);
        return (
          <li key={f.name} className="text-xs">
            <label className={"flex items-baseline gap-2 " + (togglable ? "cursor-pointer" : "cursor-default")}>
              {togglable ? (
                <input
                  type="checkbox"
                  checked={!isExcluded}
                  onChange={() => onToggle(f.name)}
                  className="shrink-0 accent-stone-900"
                />
              ) : (
                <span className="shrink-0 w-3 h-3" />
              )}
              <span
                className={
                  "font-medium truncate flex-1 " +
                  (isExcluded ? "text-stone-400 line-through" : "text-stone-800")
                }
                title={f.name}
              >
                {f.name === "(root)" ? <em className="text-stone-500">files at root</em> : f.name}
              </span>
              <span
                className={
                  "tabular-nums shrink-0 " +
                  (isExcluded ? "text-stone-300 line-through" : "text-stone-500")
                }
              >
                {f.indexable.toLocaleString()} files
                <span className={isExcluded ? "text-stone-300" : "text-stone-400"}> · {bytes(f.bytes)}</span>
              </span>
            </label>
            <div className="mt-1 ml-5 h-1 rounded bg-stone-100 overflow-hidden">
              <div
                className={
                  "h-full transition-all " +
                  (isExcluded ? "bg-stone-300" : "bg-emerald-500/70")
                }
                style={{ width: `${ratio}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
