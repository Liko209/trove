// Top-right indicator that surfaces "an update is available" without
// stealing the bottom of the viewport. Modelled after macOS system
// updates: a small dot lives next to the title bar, click it to see
// what's available, dismiss by going to Settings → About.
//
// States:
//   - idle / checking / up-to-date / error  → renders nothing (the user
//     doesn't need to know we're polling).
//   - available / downloading / ready       → renders a small amber dot
//     button; click jumps to Settings → About where the actual
//     Install / Later buttons live.
//
// Dismissal is handled by Settings → About: the user either installs
// the update or chooses to wait, both of which are real decisions.
// The indicator itself doesn't ship a "×" because that would just hide
// the only signal that there's something to act on.

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useUpdater } from "../lib/useUpdater.ts";

const RECHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function UpdateIndicator() {
  const { state, check } = useUpdater();

  useEffect(() => {
    check().catch(() => {});
    const t = setInterval(() => {
      check().catch(() => {});
    }, RECHECK_INTERVAL_MS);
    return () => clearInterval(t);
  }, [check]);

  const hasUpdate =
    state.phase === "available" ||
    state.phase === "downloading" ||
    state.phase === "ready";
  if (!hasUpdate) return null;
  const version = state.info.version;

  const label =
    state.phase === "downloading"
      ? `Downloading v${version}…`
      : state.phase === "ready"
        ? `v${version} ready to install`
        : `v${version} available`;

  return (
    <Link
      to="/settings?section=about"
      className="app-no-drag inline-flex items-center gap-1.5 h-6 px-2 rounded-md hover:bg-stone-100 text-[11px] text-stone-700 transition"
      title={label}
      aria-label={label}
    >
      <span className="relative inline-block w-2 h-2">
        <span className="absolute inset-0 rounded-full bg-amber-500 animate-ping opacity-50" />
        <span className="absolute inset-0 rounded-full bg-amber-500" />
      </span>
      <span className="font-medium">Update</span>
    </Link>
  );
}
