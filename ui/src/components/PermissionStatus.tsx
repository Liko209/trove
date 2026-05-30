// Small inline component that probes a folder's access permission via
// the IPC bridge and renders one of three states with the right CTA.
//
// Used by Add page recommended sources + the Home permissions panel.

import { useEffect, useState } from "react";

export type Perm =
  | { state: "checking" }
  | { state: "granted" }
  | { state: "denied"; code?: string }
  | { state: "not-found" }
  | { state: "not-directory" }
  | { state: "error"; message?: string }
  | { state: "unavailable" };

declare global {
  interface Window {
    bitrove?: Window["bitrove"] & {
      checkPermission?: (path: string) => Promise<{
        state: "granted" | "denied" | "not-found" | "not-directory" | "error";
        code?: string;
        message?: string;
      }>;
      openPermissionSettings?: (section?: string) => Promise<void>;
    };
  }
}

export function usePermission(path: string): {
  perm: Perm;
  recheck: () => void;
} {
  const [perm, setPerm] = useState<Perm>({ state: "checking" });
  const bridge = window.bitrove;

  const check = async () => {
    if (!bridge?.checkPermission) {
      setPerm({ state: "unavailable" });
      return;
    }
    setPerm({ state: "checking" });
    try {
      const r = await bridge.checkPermission(path);
      setPerm(r as Perm);
    } catch (e) {
      setPerm({ state: "error", message: (e as Error).message });
    }
  };

  useEffect(() => {
    check();
  }, [path]);

  return { perm, recheck: check };
}

export function PermissionPill({ perm }: { perm: Perm }) {
  const style: Record<Perm["state"], { label: string; dot: string; text: string; bg: string }> = {
    checking: { label: "Checking…", dot: "bg-stone-300", text: "text-stone-600", bg: "bg-stone-100" },
    granted: {
      label: "Accessible",
      dot: "bg-emerald-500",
      text: "text-emerald-700",
      bg: "bg-emerald-50",
    },
    denied: {
      label: "Access denied",
      dot: "bg-rose-500",
      text: "text-rose-700",
      bg: "bg-rose-50",
    },
    "not-found": {
      label: "Folder missing",
      dot: "bg-stone-400",
      text: "text-stone-700",
      bg: "bg-stone-100",
    },
    "not-directory": {
      label: "Not a folder",
      dot: "bg-stone-400",
      text: "text-stone-700",
      bg: "bg-stone-100",
    },
    error: {
      label: "Could not check",
      dot: "bg-amber-500",
      text: "text-amber-800",
      bg: "bg-amber-50",
    },
    unavailable: {
      label: "—",
      dot: "bg-stone-300",
      text: "text-stone-500",
      bg: "bg-stone-50",
    },
  };
  const s = style[perm.state];
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium " +
        s.bg +
        " " +
        s.text
      }
    >
      <span className={"w-1.5 h-1.5 rounded-full " + s.dot} />
      {s.label}
    </span>
  );
}

export async function openSettingsFor(section?: string): Promise<void> {
  const bridge = window.bitrove;
  if (!bridge?.openPermissionSettings) return;
  await bridge.openPermissionSettings(section);
}
