// Single footer block for everything update-related. Always mounted at
// the bottom of Home. When an update is available it expands inline to
// show notes / download progress / install button; the rest of the time
// it's just "Bitrove vX.X.X · status · [Check for updates]".
//
// Earlier this was two separate sections — one card up top, the check
// button down bottom — which surprised people who saw the update banner
// at the top and then scrolled down to a second "Check for updates"
// section that looked unrelated.

import { useEffect, useState } from "react";
import { useUpdater } from "../lib/useUpdater.ts";

function bytes(n: number | undefined): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function speed(bps: number | undefined): string {
  if (!bps) return "";
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

// GitHub Releases hands us release notes as HTML (its Markdown renderer
// runs server-side). Whitelist a tiny prose vocabulary, drop the long
// "Installing on macOS" footer that every release carries, and trim
// down to the first <hr/> so the in-app card stays short. The source
// is our own release pipeline + GitHub API — we still strip everything
// outside the whitelist so an unexpected tag can't smuggle attributes.
const ALLOWED_TAGS = new Set([
  "H1", "H2", "H3", "H4",
  "P", "UL", "OL", "LI",
  "CODE", "STRONG", "EM", "B", "I", "BR",
]);

function sanitizeReleaseNotes(raw: string): string {
  if (!raw) return "";
  // Strip our standard "Installing on macOS" footer — everything past the
  // first horizontal rule is boilerplate that doesn't belong in the card.
  const cutAt = raw.search(/<hr\b/i);
  const body = cutAt > 0 ? raw.slice(0, cutAt) : raw;
  if (typeof DOMParser === "undefined") return ""; // SSR / preview safety
  const doc = new DOMParser().parseFromString(body, "text/html");
  return Array.from(doc.body.childNodes).map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === 3 /* TEXT_NODE */) return escapeHtml(node.textContent ?? "");
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return "";
  const el = node as Element;
  const inner = Array.from(el.childNodes).map(serializeNode).join("");
  if (ALLOWED_TAGS.has(el.tagName)) {
    const tag = el.tagName.toLowerCase();
    return `<${tag}>${inner}</${tag}>`;
  }
  return inner;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function UpdateFooter() {
  const { state, check, download, install } = useUpdater();
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  // Optimistic-UI flags. electron-updater's downloadUpdate() takes
  // ~1s between the click and the first download-progress event
  // (HTTP HEAD on latest-mac.yml, then a few hundred KB of buffer
  // before the first emit). Without these the button visually does
  // nothing for that interval. Cleared automatically as soon as the
  // real state.phase progresses past "available" / "ready".
  const [pendingDownload, setPendingDownload] = useState(false);
  const [pendingInstall, setPendingInstall] = useState(false);

  useEffect(() => {
    if (state.phase !== "available") setPendingDownload(false);
    if (state.phase !== "ready") setPendingInstall(false);
  }, [state.phase]);

  const runCheck = async () => {
    setChecking(true);
    try {
      await check();
      setLastCheckedAt(Date.now());
    } finally {
      setTimeout(() => setChecking(false), 600);
    }
  };

  const runDownload = async () => {
    setPendingDownload(true);
    try {
      await download();
    } catch {
      setPendingDownload(false);
    }
  };

  const runInstall = async () => {
    setPendingInstall(true);
    try {
      await install();
    } catch {
      setPendingInstall(false);
    }
  };

  const hasUpdate =
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "ready";
  const newVersion = hasUpdate ? state.info.version : "";

  let status = "";
  if (state.phase === "checking" || checking) status = "Checking for updates…";
  else if (state.phase === "up-to-date")
    status = `You're on the latest version (checked ${
      lastCheckedAt ? "moments ago" : new Date(state.checkedAt).toLocaleTimeString()
    })`;
  else if (pendingDownload && state.phase === "available")
    status = `Starting download of v${newVersion}…`;
  else if (state.phase === "available")
    status = `Update available · v${newVersion}`;
  else if (state.phase === "downloading") status = `Downloading v${newVersion}…`;
  else if (pendingInstall && state.phase === "ready")
    status = `Preparing installer for v${newVersion}… Bitrove will quit and reopen on its own.`;
  else if (state.phase === "ready") status = `v${newVersion} downloaded — ready to install`;
  else if (state.phase === "error") status = state.message;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-stone-900">Bitrove v{__APP_VERSION__}</div>
          <div className="text-xs text-stone-500 mt-0.5 truncate">{status || "—"}</div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {state.phase === "available" && (
            <button
              onClick={runDownload}
              disabled={pendingDownload}
              className="inline-flex items-center gap-2 text-sm px-3.5 py-1.5 rounded-md font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700 active:scale-[0.98] transition disabled:opacity-90 disabled:cursor-wait"
            >
              {pendingDownload && (
                <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {pendingDownload ? "Starting…" : "Download update"}
            </button>
          )}
          {state.phase === "ready" && (
            <button
              onClick={runInstall}
              disabled={pendingInstall}
              className="inline-flex items-center gap-2 text-sm px-3.5 py-1.5 rounded-md font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700 active:scale-[0.98] transition disabled:opacity-90 disabled:cursor-wait"
            >
              {pendingInstall && (
                <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              {pendingInstall
                ? "Preparing…"
                : state.canAutoInstall
                  ? "Restart and install"
                  : "Open installer"}
            </button>
          )}
          {!hasUpdate && (
            <button
              onClick={runCheck}
              disabled={checking || state.phase === "checking"}
              className="text-sm px-3.5 py-1.5 rounded-md font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {checking || state.phase === "checking" ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      </div>

      {/* Render a 0% placeholder bar the instant the user clicks
          Download, before electron-updater's first download-progress
          event arrives (~1s). State.phase transitioning to
          "downloading" then upgrades it with live numbers without a
          re-mount, so the bar appears to start immediately and just
          starts filling. */}
      {(pendingDownload || state.phase === "downloading") && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-stone-500 mb-1 tabular-nums">
            {state.phase === "downloading" ? (
              <>
                <span>
                  {bytes(state.transferred)} / {bytes(state.total)} ·{" "}
                  {speed(state.bytesPerSecond)}
                </span>
                <span>{Math.round(state.percent || 0)}%</span>
              </>
            ) : (
              <>
                <span className="text-stone-400">Connecting…</span>
                <span>—</span>
              </>
            )}
          </div>
          <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
            {state.phase === "downloading" ? (
              <div
                className="h-full bg-stone-900 rounded-full transition-all duration-300"
                style={{ width: `${Math.round(state.percent || 0)}%` }}
              />
            ) : (
              // Indeterminate stripe: a stone-tinted shimmer slides
              // through an otherwise empty bar so the UI feels alive
              // while we wait for the first real % number.
              <div className="h-full w-1/3 bg-stone-300 rounded-full animate-[pulse_1.2s_ease-in-out_infinite]" />
            )}
          </div>
        </div>
      )}

      {state.phase === "ready" && !state.canAutoInstall && (
        <div className="mt-2 text-xs text-stone-500">
          Drag the new app into{" "}
          <code className="bg-stone-100 px-1 py-0.5 rounded">/Applications</code> to update.
        </div>
      )}

      {state.phase === "available" && state.info.releaseNotes && (
        <div className="mt-4 pt-4 border-t border-stone-100">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-stone-500">
              What's new
            </div>
            <a
              href="https://github.com/Liko209/bitrove/releases"
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-stone-500 hover:text-stone-900 underline"
            >
              Full notes
            </a>
          </div>
          <div
            className="text-xs text-stone-700 release-notes line-clamp-6"
            dangerouslySetInnerHTML={{
              __html: sanitizeReleaseNotes(state.info.releaseNotes),
            }}
          />
        </div>
      )}
    </section>
  );
}
