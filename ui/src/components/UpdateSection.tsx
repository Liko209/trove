// Update widgets for the Home page.
//
//   * <UpdateAvailableCard /> — prominent card shown only when an update is
//     ready to download / install. Stays mounted as the phase progresses
//     (available → downloading → ready).
//
//   * <AboutBitrove /> — small footer block that's always visible. Shows the
//     current version + a "Check for updates" button so users can ask the
//     question themselves at any time.

import { useState } from "react";
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

export function UpdateAvailableCard() {
  const { state, download, install } = useUpdater();

  if (
    state.phase === "idle" ||
    state.phase === "checking" ||
    state.phase === "up-to-date" ||
    state.phase === "error"
  ) {
    return null;
  }

  const v = state.phase === "available" || state.phase === "downloading" || state.phase === "ready"
    ? state.info.version
    : "";

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
        Update
      </h2>
      <div className="bg-white rounded-xl border border-stone-200 p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="text-2xl shrink-0">✨</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="font-semibold text-stone-900">Bitrove {v} is available</div>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {state.phase === "downloading"
                  ? "Downloading"
                  : state.phase === "ready"
                    ? "Ready"
                    : "New"}
              </span>
            </div>
            {state.phase === "available" && state.info.releaseDate && (
              <div className="text-xs text-stone-500 mt-1">
                Released {new Date(state.info.releaseDate).toLocaleDateString()}
              </div>
            )}
            {state.phase === "ready" && !state.canQuitAndInstall && (
              <div className="text-xs text-stone-500 mt-1">
                Drag the new app into <code className="bg-stone-100 px-1 py-0.5 rounded">/Applications</code>{" "}
                to update.
              </div>
            )}
          </div>
          <div className="shrink-0">
            {state.phase === "available" && (
              <button
                onClick={download}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700"
              >
                Download update
              </button>
            )}
            {state.phase === "ready" && (
              <button
                onClick={install}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white border border-stone-900 hover:bg-stone-700"
              >
                {state.canQuitAndInstall ? "Restart and install" : "Open installer"}
              </button>
            )}
          </div>
        </div>

        {state.phase === "downloading" && (
          <>
            <div className="flex items-center justify-between text-xs text-stone-500 mb-1 tabular-nums">
              <span>
                {bytes(state.transferred)} / {bytes(state.total)} ·{" "}
                {speed(state.bytesPerSecond)}
              </span>
              <span>{Math.round(state.percent || 0)}%</span>
            </div>
            <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-stone-900 transition-all"
                style={{ width: `${Math.round(state.percent || 0)}%` }}
              />
            </div>
          </>
        )}

        {state.phase === "available" && state.info.releaseNotes && (
          <div className="mt-3 pt-3 border-t border-stone-100">
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
      </div>
    </section>
  );
}

export function AboutBitrove() {
  const { state, check } = useUpdater();
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  const runCheck = async () => {
    setChecking(true);
    try {
      await check();
      setLastCheckedAt(Date.now());
    } finally {
      // Give the UI a moment to reflect the new phase before resetting the spinner.
      setTimeout(() => setChecking(false), 600);
    }
  };

  let status = "";
  if (state.phase === "checking" || checking) status = "Checking…";
  else if (state.phase === "up-to-date")
    status = `You're on the latest version (checked ${
      lastCheckedAt ? "moments ago" : new Date(state.checkedAt).toLocaleTimeString()
    })`;
  else if (state.phase === "available")
    status = `Update to ${state.info.version} available — see the panel above.`;
  else if (state.phase === "downloading") status = `Downloading ${state.info.version}…`;
  else if (state.phase === "ready") status = `${state.info.version} downloaded — ready to install.`;
  else if (state.phase === "error") status = state.message;

  return (
    <section className="mt-10 pt-6 border-t border-stone-200">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-stone-900">Bitrove v{__APP_VERSION__}</div>
          <div className="text-xs text-stone-500 mt-0.5 truncate">{status || "—"}</div>
        </div>
        <button
          onClick={runCheck}
          disabled={checking || state.phase === "checking" || state.phase === "downloading"}
          className="shrink-0 text-sm px-3.5 py-1.5 rounded-md font-medium bg-white text-stone-700 border border-stone-300 hover:bg-stone-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {checking || state.phase === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </div>
    </section>
  );
}
