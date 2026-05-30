// Modal shown after the user picks a folder to add. It performs a fast
// pre-scan via /api/source-preview and tells the user exactly what will
// be indexed before they commit.

import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { bytes, formatDurationSeconds, shortPath } from "../lib/format.ts";

type Preview = Awaited<ReturnType<typeof api.sourcePreview>>;

export default function ScanConfirmModal({
  path,
  onCancel,
  onConfirm,
}: {
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setErr(null);
    api
      .sourcePreview(path)
      .then(setPreview)
      .catch((e) => setErr((e as Error).message));
  }, [path]);

  const totalIndexable = preview ? preview.text + preview.catalog : 0;
  const ratio = preview && preview.totalScanned > 0
    ? Math.round((totalIndexable / preview.totalScanned) * 100)
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/40 flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl border border-stone-200 shadow-xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4 border-b border-stone-100">
          <h2 className="text-lg font-semibold text-stone-900">Add this folder to your library?</h2>
          <p className="text-sm text-stone-500 mt-1 truncate font-mono" title={path}>
            {shortPath(path)}
          </p>
        </div>

        <div className="px-6 py-5">
          {err && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
              {err}
            </div>
          )}

          {!preview && !err && (
            <div className="flex items-center gap-3 py-6 text-sm text-stone-500">
              <div className="h-4 w-4 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
              Looking inside this folder…
            </div>
          )}

          {preview && (
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
                <Bullet>
                  Estimated time:{" "}
                  <strong>{formatDurationSeconds(preview.estimatedSeconds)}</strong>
                </Bullet>
                <Bullet>
                  Will skip code repos' source, <code>node_modules</code>,{" "}
                  <code>.venv</code>, build outputs, and cached data.
                </Bullet>
                {preview.cappedAt && (
                  <Bullet warn>
                    Folder is very large; only the first {preview.cappedAt.toLocaleString()} entries were
                    scanned for the preview. Real indexing will still cover everything.
                  </Bullet>
                )}
              </div>

              {preview.topExtensions.length > 0 && (
                <div className="mt-4 pt-4 border-t border-stone-100">
                  <div className="text-xs uppercase tracking-wider text-stone-500 mb-2">
                    File types found
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.topExtensions.map((e) => (
                      <span
                        key={e.ext}
                        className="text-xs px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 tabular-nums"
                      >
                        {e.ext} · {e.count}
                      </span>
                    ))}
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

        <div className="px-6 py-4 bg-stone-50 border-t border-stone-100 flex items-center gap-3">
          <span className="text-xs text-stone-500">
            Indexing happens in the background. You can pause it any time.
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-stone-700 hover:bg-stone-100"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={!preview || totalIndexable === 0}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Start indexing
            </button>
          </div>
        </div>
      </div>
    </div>
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
