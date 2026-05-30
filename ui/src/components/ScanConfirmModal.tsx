// Modal shown after the user picks a folder to add. It performs a fast
// pre-scan via /api/source-preview and tells the user exactly what will
// be indexed before they commit. Also flags permission errors up-front so
// users aren't dropped into a half-finished scan that quietly stops.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { bytes, formatDurationSeconds, shortPath } from "../lib/format.ts";
import { openSettingsFor, usePermission } from "./PermissionStatus.tsx";
import { BookIcon, FileIcon } from "./icons.tsx";

type Preview = Awaited<ReturnType<typeof api.sourcePreview>>;

export default function ScanConfirmModal({
  path,
  onCancel,
  onConfirm,
}: {
  path: string;
  onCancel: () => void;
  // First arg: ext overrides (default-excluded types the user wants this
  //   one scan to include).
  // Second arg: whether to keep this folder under a file-watcher after
  //   the initial scan. Default true; user can opt out via the toggle.
  onConfirm: (extraIncludeExts: string[], watchAfterScan: boolean) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Extensions the user has clicked back ON for this scan.
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const [watchAfter, setWatchAfter] = useState(true);
  const { perm, recheck } = usePermission(path);

  useEffect(() => {
    setPreview(null);
    setErr(null);
    setOverrides(new Set());
    // Only attempt the preview when we know we have access. If the user
    // grants permission and clicks Re-check, the new "granted" state will
    // re-fire this effect.
    if (perm.state !== "granted") return;
    api
      .sourcePreview(path)
      .then(setPreview)
      .catch((e) => setErr((e as Error).message));
  }, [path, perm.state]);

  const denied = perm.state === "denied";
  const checking = perm.state === "checking";

  const excludedSet = useMemo(
    () => new Set(preview?.excludedExts ?? []),
    [preview?.excludedExts],
  );

  // Default-excluded count (before any user override) and the count the
  // user has *kept* excluded (i.e. didn't toggle back on).
  const { excludedFromDefault, effectiveIndexable } = useMemo(() => {
    if (!preview) return { excludedFromDefault: 0, effectiveIndexable: 0 };
    const total = preview.text + preview.catalog;
    let dropped = 0;
    for (const e of preview.excludedByExt) {
      if (!overrides.has(e.ext)) dropped += e.indexable;
    }
    return { excludedFromDefault: dropped, effectiveIndexable: Math.max(0, total - dropped) };
  }, [preview, overrides]);

  const totalIndexable = effectiveIndexable;
  const ratio = preview && preview.totalScanned > 0
    ? Math.round((totalIndexable / preview.totalScanned) * 100)
    : 0;

  function toggleOverride(ext: string) {
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/40 flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-xl border border-stone-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]"
        style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.03)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 border-b border-stone-100 shrink-0">
          <h2 className="font-serif-display text-[22px] text-stone-900">Add this folder to your library?</h2>
          <p className="text-xs text-stone-500 mt-1.5 truncate font-mono" title={path}>
            {shortPath(path)}
          </p>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1">
          {err && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
              {err}
            </div>
          )}

          {denied && (
            <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm">
              <div className="font-medium mb-1">macOS is blocking access to this folder.</div>
              <div className="text-xs text-rose-700 mb-3">
                Open System Settings → Privacy & Security, find Bitrove in the relevant
                Files and Folders section, and toggle it on. Then click "Re-check" below.
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => openSettingsFor("files")}
                  className="text-xs px-3 py-1.5 rounded-md font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700"
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
            <div className="flex items-center gap-3 py-6 text-sm text-stone-500">
              <div className="h-4 w-4 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
              {checking ? "Checking access…" : "Looking inside this folder…"}
            </div>
          )}

          {preview && perm.state === "granted" && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Stat label="Documents" value={preview.text.toLocaleString()} sub="full text" />
                <Stat label="Books & decks" value={preview.catalog.toLocaleString()} sub="catalog only" />
                <Stat label="Skipped" value={preview.skipped.toLocaleString()} sub="noise" />
              </div>

              <div className="text-sm text-stone-700 space-y-2">
                <Bullet>
                  Will index <strong>{totalIndexable.toLocaleString()}</strong> files
                  {preview.totalScanned > 0 && (
                    <span className="text-stone-500">
                      {" "}({ratio}% of {preview.totalScanned.toLocaleString()} scanned)
                    </span>
                  )}
                </Bullet>
                {excludedFromDefault > 0 && (
                  <Bullet>
                    Skipping{" "}
                    <strong>{excludedFromDefault.toLocaleString()}</strong>{" "}
                    files of code-like types you've set to exclude.{" "}
                    <Link to="/settings" className="text-stone-900 underline hover:no-underline">
                      Edit defaults
                    </Link>
                  </Bullet>
                )}
                <Bullet>
                  Estimated time:{" "}
                  <strong>{formatDurationSeconds(preview.estimatedSeconds)}</strong>
                </Bullet>
                {preview.cappedAt && (
                  <Bullet warn>
                    Folder is very large; only the first {preview.cappedAt.toLocaleString()} entries were
                    scanned for the preview. Real indexing will still cover everything.
                  </Bullet>
                )}
              </div>

              {preview.topFolders.length > 0 && (
                <div className="mt-4 pt-4 border-t border-stone-100">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-xs uppercase tracking-wider text-stone-500">
                      From these folders
                    </div>
                    <div className="text-[10px] text-stone-400">top {preview.topFolders.length}</div>
                  </div>
                  <FolderBreakdown folders={preview.topFolders} />
                </div>
              )}

              {preview.sampleFiles.length > 0 && (
                <div className="mt-4 pt-4 border-t border-stone-100">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-xs uppercase tracking-wider text-stone-500">
                      Sample of what will be indexed
                    </div>
                    <div className="text-[10px] text-stone-400">
                      first {preview.sampleFiles.length}
                    </div>
                  </div>
                  <ul className="space-y-1">
                    {preview.sampleFiles.map((f) => (
                      <li
                        key={f.path}
                        className="flex items-center gap-2 text-xs text-stone-700"
                      >
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
                  {totalIndexable > preview.sampleFiles.length && (
                    <div className="text-[11px] text-stone-500 mt-2">
                      + {(totalIndexable - preview.sampleFiles.length).toLocaleString()} more like these
                    </div>
                  )}
                </div>
              )}

              {preview.topExtensions.length > 0 && (
                <div className="mt-4 pt-4 border-t border-stone-100">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-xs uppercase tracking-wider text-stone-500">
                      File types found
                    </div>
                    <div className="text-[10px] text-stone-400">
                      tap a greyed type to include it this time
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.topExtensions.map((e) => {
                      const isExcludedDefault = excludedSet.has(e.ext);
                      const overridden = overrides.has(e.ext);
                      const effectivelyOff = isExcludedDefault && !overridden;
                      const onClick = isExcludedDefault
                        ? () => toggleOverride(e.ext)
                        : undefined;
                      const base =
                        "text-xs px-2 py-0.5 rounded-full tabular-nums transition";
                      const cls = effectivelyOff
                        ? "bg-stone-100 text-stone-400 line-through"
                        : overridden
                          ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                          : "bg-stone-100 text-stone-700";
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
                                ? `${e.ext} is off by default but you've added it to this scan. Click to drop it again.`
                                : `${e.ext} · ${e.count.toLocaleString()} files`
                          }
                          className={`${base} ${cls} ${isExcludedDefault ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                        >
                          {e.ext} · {e.count.toLocaleString()}
                          {overridden && <span className="ml-1">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {preview.totalBytes > 0 && (
                <div className="mt-3 text-xs text-stone-500">
                  Folder size: {bytes(preview.totalBytes)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 bg-stone-50 border-t border-stone-100 flex items-center gap-4 shrink-0">
          <label className="flex items-center gap-2 text-xs text-stone-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={watchAfter}
              onChange={(e) => setWatchAfter(e.target.checked)}
              className="accent-stone-900"
            />
            Keep watching for changes
          </label>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm([...overrides], watchAfter)}
              disabled={!preview || totalIndexable === 0 || perm.state !== "granted"}
              className="px-4 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FolderBreakdown({
  folders,
}: {
  folders: { name: string; indexable: number; skipped: number; bytes: number }[];
}) {
  const max = Math.max(...folders.map((f) => f.indexable), 1);
  return (
    <ul className="space-y-1.5">
      {folders.map((f) => {
        const ratio = Math.round((f.indexable / max) * 100);
        return (
          <li key={f.name} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-stone-800 truncate" title={f.name}>
                {f.name === "(root)" ? <em className="text-stone-500">files at root</em> : f.name}
              </span>
              <span className="text-stone-500 tabular-nums shrink-0">
                {f.indexable.toLocaleString()} files
                <span className="text-stone-400"> · {bytes(f.bytes)}</span>
              </span>
            </div>
            <div className="mt-1 h-1 rounded bg-stone-100 overflow-hidden">
              <div
                className="h-full bg-emerald-500/70"
                style={{ width: `${ratio}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-stone-50 rounded-lg p-3 border border-stone-100">
      <div className="text-[10px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className="text-xl font-semibold text-stone-900 tabular-nums leading-none mt-1">{value}</div>
      <div className="text-xs text-stone-500 mt-1">{sub}</div>
    </div>
  );
}

function Bullet({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div className={"flex items-start gap-2 " + (warn ? "text-amber-800" : "")}>
      <span className={"shrink-0 mt-2 h-1 w-1 rounded-full " + (warn ? "bg-amber-500" : "bg-stone-400")} />
      <div>{children}</div>
    </div>
  );
}
