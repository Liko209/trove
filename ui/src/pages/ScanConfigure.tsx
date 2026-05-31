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
import FolderTreePicker from "../components/FolderTreePicker.tsx";

type Preview = Awaited<ReturnType<typeof api.sourcePreview>>;

export default function ScanConfigure() {
  const [params] = useSearchParams();
  const path = params.get("path") || "";
  const navigate = useNavigate();
  const { perm, recheck } = usePermission(path);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-scan overrides.
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  // Absolute path prefixes excluded by the user via the tree picker.
  // Sent verbatim to the walker as `excludes` — works for any depth
  // because the walker just substring-matches.
  const [excludedTreePaths, setExcludedTreePaths] = useState<Set<string>>(new Set());
  const [watchAfter, setWatchAfter] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!path) return;
    setPreview(null);
    setErr(null);
    setOverrides(new Set());
    setExcludedTreePaths(new Set());
    if (perm.state !== "granted") return;
    api.sourcePreview(path).then(setPreview).catch((e) => setErr((e as Error).message));
  }, [path, perm.state]);

  const excludedExtSet = useMemo(
    () => new Set(preview?.excludedExts ?? []),
    [preview?.excludedExts],
  );

  // Two independent subtractions from the raw preview total.
  // - excludedFromDefault: ext patterns user kept on default-exclude list
  // - excludedFromTree: any folder the user unchecked in the tree
  //   picker. We can only know the exact file-count for the top-level
  //   subdirs (from preview.topFolders); for deeper unchecks we don't
  //   re-walk just to update the headline number — those land in the
  //   real scan and show up there.
  const { excludedFromDefault, excludedFromTree, effectiveIndexable } = useMemo(() => {
    if (!preview)
      return { excludedFromDefault: 0, excludedFromTree: 0, effectiveIndexable: 0 };
    const total = preview.text + preview.catalog;
    let extDropped = 0;
    for (const e of preview.excludedByExt) {
      if (!overrides.has(e.ext)) extDropped += e.indexable;
    }
    // Only top-level subdirs have a precise indexable count in the
    // preview. Match by absolute path prefix from the exclude set.
    const norm = path.endsWith("/") ? path.slice(0, -1) : path;
    let treeDropped = 0;
    for (const f of preview.topFolders) {
      if (f.name === "(root)") continue;
      const abs = `${norm}/${f.name}`;
      if (excludedTreePaths.has(abs)) treeDropped += f.indexable;
    }
    return {
      excludedFromDefault: extDropped,
      excludedFromTree: treeDropped,
      effectiveIndexable: Math.max(0, total - extDropped - treeDropped),
    };
  }, [preview, overrides, excludedTreePaths, path]);

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
  // The tree picker hands us a Set<absolutePath>. The walker wants
  // path prefixes ending in "/" so its substring match cleanly kills
  // a subtree without false-positiving on sibling names that share
  // the prefix.
  function excludePaths(): string[] {
    return [...excludedTreePaths].map((p) => (p.endsWith("/") ? p : p + "/"));
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
              {excludedFromTree > 0 && (
                <Bullet>
                  Skipping <strong>{excludedFromTree.toLocaleString()}</strong>{" "}
                  files from unchecked sub-folders
                  {excludedTreePaths.size > preview.topFolders.length && (
                    <span className="text-stone-500"> (+ deeper picks)</span>
                  )}
                  .
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

          {/* ── Folder tree (any depth) ─────────────────────── */}
          <section className="mb-10">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="t-section">Pick what to include</h2>
              <span className="text-[10px] text-stone-400">
                expand to drill in · uncheck any folder to skip
              </span>
            </div>
            <FolderTreePicker
              root={path}
              excludedPaths={excludedTreePaths}
              onChange={setExcludedTreePaths}
            />
          </section>

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
            ? `Ready to index ${effectiveIndexable.toLocaleString()} file${effectiveIndexable === 1 ? "" : "s"}`
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

