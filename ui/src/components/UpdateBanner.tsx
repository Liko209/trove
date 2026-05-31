// Persistent footer banner that surfaces "an update is available"
// across the entire app.
//
// Lifecycle:
//   - On mount: immediately runs an update check.
//   - Every 2 hours: re-checks.
//   - When state.phase becomes "available" / "downloading" / "ready",
//     a small amber bar slides up at the bottom with a "Go to
//     Settings" link.
//   - The bar can be dismissed for the current session (× button);
//     dismissal clears as soon as state.phase moves to a different
//     version, because there's a real new fact worth surfacing.
//   - Hidden in all other phases (idle / checking / up-to-date /
//     error).
//
// Rendered globally from App.tsx, NOT from a single page — Library
// used to host the UpdateFooter inline; Settings → About is now the
// canonical place to actually perform the update.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useUpdater } from "../lib/useUpdater.ts";

const RECHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function UpdateBanner() {
  const { state, check } = useUpdater();
  // Per-session dismissal. We track which version was dismissed so
  // that if a newer one appears later we re-show without forcing the
  // user to find a hidden setting.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  // Tracks the version the banner is currently showing so we know when
  // to reset the dismissal.
  const lastSeenVersionRef = useRef<string | null>(null);

  useEffect(() => {
    // Kick off the first check on mount. useUpdater's hook also
    // listens to whatever the main process pushed during boot, but
    // calling check() makes sure we trigger one fresh round-trip
    // regardless of any startup race.
    check().catch(() => {});
    const t = setInterval(() => {
      check().catch(() => {});
    }, RECHECK_INTERVAL_MS);
    return () => clearInterval(t);
  }, [check]);

  // Only available / downloading / ready phases have an info.version.
  const hasUpdate =
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "ready";
  const version = hasUpdate ? state.info.version : null;

  // Reset dismissal when the offered version changes.
  useEffect(() => {
    if (version && lastSeenVersionRef.current !== version) {
      lastSeenVersionRef.current = version;
      // If the user dismissed an older version, this new one should re-show.
      if (dismissedVersion && dismissedVersion !== version) {
        setDismissedVersion(null);
      }
    }
  }, [version, dismissedVersion]);

  if (!hasUpdate || !version) return null;
  if (dismissedVersion === version) return null;

  // Phase-tailored copy + CTA. Settings is always the canonical
  // destination — the banner is awareness, not action.
  const message =
    state.phase === "downloading"
      ? `Downloading Bitrove v${version}…`
      : state.phase === "ready"
        ? `Bitrove v${version} is ready to install`
        : `Bitrove v${version} is available`;
  const cta =
    state.phase === "ready" ? "Install in Settings" : "Open Settings";

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="max-w-4xl mx-auto px-4 pb-3">
        <div
          className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm shadow-sm"
          style={{
            boxShadow:
              "0 8px 24px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.03)",
          }}
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="flex-1 truncate">{message}</span>
          <Link
            to="/settings"
            className="shrink-0 text-xs px-3 py-1 rounded-md bg-amber-900 text-white font-medium hover:bg-amber-800 transition"
          >
            {cta}
          </Link>
          <button
            type="button"
            onClick={() => setDismissedVersion(version)}
            className="shrink-0 w-6 h-6 rounded text-amber-700 hover:bg-amber-100 hover:text-amber-900 transition flex items-center justify-center"
            title="Dismiss until next version"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
