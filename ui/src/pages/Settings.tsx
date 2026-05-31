// Settings — multi-section page accessed via the ⚙ icon in the header.
//
// Sections live in a left-rail tab; each one renders its own form +
// save flow. Done this way (instead of one giant scroll) because the
// page now covers four unrelated configuration concerns:
//
//   - Filters: file-type + folder-name exclusion rules applied when
//     a folder is scanned.
//   - Watcher: how often the background watcher polls the watched
//     roots, plus a recent-activity log.
//   - About: app version, models, update controls.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import { UpdateFooter } from "../components/UpdateSection.tsx";
import { useNavigate } from "react-router-dom";
import {
  TIER_META,
  recommendTier,
  tierMeta,
  formatBytes,
  type Tier,
} from "../lib/tiers.ts";
import SwitchTierModal from "../components/SwitchTierModal.tsx";

type Section = "filters" | "models" | "watcher" | "about";

const TABS: { id: Section; label: string }[] = [
  { id: "filters", label: "Filters" },
  { id: "models", label: "Models" },
  { id: "watcher", label: "Watcher" },
  { id: "about", label: "About" },
];

function isSection(s: string | null): s is Section {
  return s === "filters" || s === "models" || s === "watcher" || s === "about";
}

export default function Settings() {
  // Section in URL so external callers (UpdateBanner, future deep
  // links from notifications) can land directly on the right tab.
  // Two-way sync: clicking a tab also rewrites the URL so refresh /
  // share keeps you on the same view.
  const [params, setParams] = useSearchParams();
  const initial = isSection(params.get("section")) ? (params.get("section") as Section) : "filters";
  const [section, setSectionState] = useState<Section>(initial);
  function setSection(next: Section) {
    setSectionState(next);
    setParams({ section: next }, { replace: true });
  }
  // Pick up URL changes that happen while we're already mounted
  // (e.g. the user clicks the UpdateBanner while sitting on
  // /settings?section=filters).
  useEffect(() => {
    const fromUrl = params.get("section");
    if (isSection(fromUrl) && fromUrl !== section) {
      setSectionState(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return (
    <div className="max-w-4xl mx-auto pb-12">
      <h1 className="t-display mb-8">Settings</h1>
      <div className="grid grid-cols-[160px_1fr] gap-10">
        <nav className="flex flex-col gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setSection(t.id)}
              className={
                "text-left px-3 py-2 rounded-md text-sm transition " +
                (section === t.id
                  ? "bg-stone-100 text-stone-900 font-medium"
                  : "text-stone-600 hover:bg-stone-50 hover:text-stone-900")
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div>
          {section === "filters" && <FiltersSection />}
          {section === "models" && <ModelsSection />}
          {section === "watcher" && <WatcherSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

/* ── Filters ─────────────────────────────────────────────────────── */

type SettingsResponse = Awaited<ReturnType<typeof api.getIngestSettings>>;

function FiltersSection() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [excludedExts, setExcludedExts] = useState<Set<string>>(new Set());
  const [excludedFolders, setExcludedFolders] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState("");
  const [status, setStatus] = useState<null | "saving" | "saved" | "error">(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSupported, setShowSupported] = useState(true);

  useEffect(() => {
    api
      .getIngestSettings()
      .then((d) => {
        setData(d);
        setExcludedExts(new Set(d.current.excludedExts));
        setExcludedFolders(d.current.excludedFolders);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  async function save() {
    if (!data) return;
    setStatus("saving");
    try {
      await api.saveIngestSettings({
        excludedExts: [...excludedExts],
        excludedFolders,
        watcherScanIntervalMin: data.current.watcherScanIntervalMin,
        watcherDebounceMin: data.current.watcherDebounceMin,
      });
      setStatus("saved");
      setTimeout(() => setStatus(null), 1800);
    } catch (e) {
      setStatus("error");
      setErr((e as Error).message);
    }
  }

  function toggleExt(ext: string) {
    setExcludedExts((prev) => {
      const next = new Set(prev);
      if (next.has(ext)) next.delete(ext);
      else next.add(ext);
      return next;
    });
  }
  function addFolder() {
    const v = newFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!v) return;
    if (excludedFolders.includes(v)) return;
    setExcludedFolders([...excludedFolders, v]);
    setNewFolder("");
  }
  function removeFolder(name: string) {
    setExcludedFolders(excludedFolders.filter((f) => f !== name));
  }
  function resetToDefaults() {
    if (!data) return;
    setExcludedExts(new Set(data.defaults.excludedExts));
    setExcludedFolders(data.defaults.excludedFolders);
  }

  if (err && !data) {
    return (
      <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
        {err}
      </div>
    );
  }
  if (!data) return <div className="text-sm text-stone-500">Loading…</div>;

  return (
    <div className="pb-20">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="t-h2">File and folder filters</h2>
        <button
          onClick={resetToDefaults}
          className="text-xs text-stone-500 hover:text-stone-900 underline"
        >
          Reset to recommended defaults
        </button>
      </div>
      <p className="text-stone-600 text-sm mb-8">
        These rules only apply when you add a whole folder to your library.
        Picking individual files always works, even for excluded types — we'll
        just warn you in case it's a mistake.
      </p>

      <section className="mb-10">
        <h3 className="t-section mb-3">File types to skip when scanning a folder</h3>
        <p className="text-xs text-stone-500 mb-4">
          Checked = skipped. Unchecked = included. Code-like types are off by
          default because they're usually source files, not knowledge.
        </p>
        <div className="space-y-4">
          {data.supportedTypes.map((group) => (
            <CategoryBlock
              key={group.group}
              group={group}
              excludedExts={excludedExts}
              onToggle={toggleExt}
            />
          ))}
        </div>
        <details
          className="mt-6 group"
          open={showSupported}
          onToggle={(e) => setShowSupported((e.target as HTMLDetailsElement).open)}
        >
          <summary className="text-xs text-stone-500 cursor-pointer hover:text-stone-900 list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition">▸</span>
            How file types map to indexing
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-stone-600">
            {data.supportedTypes.map((g) => (
              <div key={g.group} className="bg-stone-50 rounded-lg p-3 border border-stone-100">
                <div className="font-medium text-stone-800">{g.group}</div>
                <div className="mt-0.5">{g.description}</div>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="mb-10">
        <h3 className="t-section mb-3">Folder names to skip</h3>
        <p className="text-xs text-stone-500 mb-4">
          If Bitrove sees a folder with one of these names anywhere inside what
          you're scanning, it'll skip the whole subtree. Match is on folder
          name, not full path.
        </p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {excludedFolders.length === 0 && (
            <span className="text-xs text-stone-400 italic">No folder names excluded.</span>
          )}
          {excludedFolders.map((f) => (
            <span
              key={f}
              className="text-xs px-2 py-1 rounded-full bg-stone-100 text-stone-700 flex items-center gap-1.5"
            >
              <code className="font-mono">{f}</code>
              <button
                type="button"
                onClick={() => removeFolder(f)}
                className="text-stone-400 hover:text-rose-600"
                aria-label={`Remove ${f}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFolder()}
            placeholder="e.g. node_modules"
            className="flex-1 text-sm px-3 py-1.5 rounded-md border border-stone-300 focus:border-stone-500 focus:outline-none font-mono"
          />
          <button
            onClick={addFolder}
            disabled={!newFolder.trim()}
            className="text-sm px-3 py-1.5 rounded-md font-medium bg-stone-100 text-stone-800 hover:bg-stone-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </section>

      <div className="sticky bottom-0 -mx-4 px-4 pt-8 pb-4 bg-gradient-to-t from-stone-50 via-stone-50/90 to-stone-50/0 flex items-center gap-3">
        <span className="text-xs text-stone-500">
          {status === "saving" && "Saving…"}
          {status === "saved" && (
            <span className="text-emerald-700">Saved. New folder scans will use these rules.</span>
          )}
          {status === "error" && err && <span className="text-rose-700">{err}</span>}
        </span>
        <button
          onClick={save}
          className="ml-auto px-4 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white hover:bg-stone-700"
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

function CategoryBlock({
  group,
  excludedExts,
  onToggle,
}: {
  group: { group: string; description: string; exts: string[] };
  excludedExts: Set<string>;
  onToggle: (ext: string) => void;
}) {
  const excludedCount = group.exts.filter((e) => excludedExts.has(e)).length;
  const allOff = excludedCount === group.exts.length;
  const allOn = excludedCount === 0;
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-medium text-stone-900">{group.group}</div>
        <span className="text-[11px] text-stone-500">
          {allOff
            ? "all skipped"
            : allOn
              ? "all included"
              : `${group.exts.length - excludedCount} of ${group.exts.length} included`}
        </span>
      </div>
      <div className="text-xs text-stone-500 mb-3">{group.description}</div>
      <div className="flex flex-wrap gap-1.5">
        {group.exts.map((ext) => {
          const off = excludedExts.has(ext);
          return (
            <button
              key={ext}
              type="button"
              onClick={() => onToggle(ext)}
              className={
                "text-xs px-2.5 py-1 rounded-full font-mono tabular-nums transition " +
                (off
                  ? "bg-stone-100 text-stone-400 line-through hover:bg-stone-200"
                  : "bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100")
              }
              title={off ? `Click to include ${ext}` : `Click to skip ${ext}`}
            >
              {ext}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Watcher ─────────────────────────────────────────────────────── */

function WatcherSection() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [interval, setIntervalMin] = useState(30);
  const [debounce, setDebounceMin] = useState(30);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.watcherHistory>>["events"]>([]);
  const [status, setStatus] = useState<null | "saving" | "saved" | "error">(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getIngestSettings()
      .then((d) => {
        setData(d);
        setIntervalMin(d.current.watcherScanIntervalMin ?? 30);
        setDebounceMin(d.current.watcherDebounceMin ?? 30);
      })
      .catch((e) => setErr((e as Error).message));
    const load = () =>
      api.watcherHistory().then((r) => setEvents(r.events)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function save() {
    if (!data) return;
    setStatus("saving");
    try {
      await api.saveIngestSettings({
        excludedExts: data.current.excludedExts,
        excludedFolders: data.current.excludedFolders,
        watcherScanIntervalMin: interval,
        watcherDebounceMin: debounce,
      });
      setStatus("saved");
      setTimeout(() => setStatus(null), 1800);
    } catch (e) {
      setStatus("error");
      setErr((e as Error).message);
    }
  }

  return (
    <div className="pb-20">
      <h2 className="t-h2 mb-2">Background watcher</h2>
      <p className="text-stone-600 text-sm mb-8">
        Bitrove watches the folders you've added so it can pick up new and
        changed files automatically. Two knobs control how aggressive it is.
      </p>

      <div className="space-y-5 mb-10">
        <NumberField
          label="Re-scan every"
          unit="minutes"
          value={interval}
          onChange={setIntervalMin}
          min={1}
          max={1440}
          hint="How often the watcher walks each folder from scratch to catch deletes and anything chokidar missed. 30 min works for most people; bump up to 60+ if your library is huge."
        />
        <NumberField
          label="Wait for changes to settle"
          unit="minutes"
          value={debounce}
          onChange={setDebounceMin}
          min={1}
          max={1440}
          hint="After it sees a file change, the watcher waits this long for further edits before re-indexing. Stops it from re-indexing a doc you're still writing. 30 min is calm; drop to 5 if you want updates faster."
        />
      </div>

      <section>
        <h3 className="t-section mb-3">Recent activity</h3>
        <p className="text-xs text-stone-500 mb-3">
          The last 200 events from the watcher. Updates every 5 seconds.
        </p>
        {events.length === 0 ? (
          <div className="text-xs text-stone-400 italic py-6 text-center">
            No watcher activity yet.
          </div>
        ) : (
          <ul className="text-xs space-y-1 max-h-96 overflow-y-auto bg-white rounded-lg border border-stone-200 p-3">
            {events.map((e, i) => (
              <li key={i} className="flex items-baseline gap-2 py-0.5">
                <span className="text-stone-400 font-mono tabular-nums shrink-0 text-[10px]">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <HistoryLine event={e} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="sticky bottom-0 -mx-4 px-4 pt-8 pb-4 bg-gradient-to-t from-stone-50 via-stone-50/90 to-stone-50/0 flex items-center gap-3">
        <span className="text-xs text-stone-500">
          {status === "saving" && "Saving…"}
          {status === "saved" && (
            <span className="text-emerald-700">Saved. Watchers restarted with the new cadence.</span>
          )}
          {status === "error" && err && <span className="text-rose-700">{err}</span>}
        </span>
        <button
          onClick={save}
          className="ml-auto px-4 py-1.5 rounded-md text-sm font-medium bg-stone-900 text-white hover:bg-stone-700"
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  hint: string;
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <label className="text-sm font-medium text-stone-900">{label}</label>
        <div className="flex items-baseline gap-2">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
            className="w-20 text-sm px-2 py-1 rounded border border-stone-300 focus:border-stone-500 focus:outline-none text-right tabular-nums"
          />
          <span className="text-xs text-stone-500">{unit}</span>
        </div>
      </div>
      <p className="text-xs text-stone-500 leading-relaxed">{hint}</p>
    </div>
  );
}

function HistoryLine({
  event,
}: {
  event: Awaited<ReturnType<typeof api.watcherHistory>>["events"][number];
}) {
  const root = event.root.slice(event.root.lastIndexOf("/") + 1) || event.root;
  if (event.kind === "scan-start") {
    return (
      <span className="text-stone-600">
        Started full scan of <strong className="text-stone-800">{root}</strong>
      </span>
    );
  }
  if (event.kind === "scan-done") {
    return (
      <span className="text-stone-600">
        Finished scan of <strong className="text-stone-800">{root}</strong> ·{" "}
        {event.seen.toLocaleString()} seen
        {event.missingSources + event.missingAliases > 0 && (
          <span className="text-amber-700">
            {" "}· {event.missingSources + event.missingAliases} now missing
          </span>
        )}{" "}
        <span className="text-stone-400">in {Math.round(event.ms / 1000)}s</span>
      </span>
    );
  }
  if (event.kind === "drain") {
    return (
      <span className="text-stone-600">
        Picked up {event.files} change{event.files === 1 ? "" : "s"} in <strong>{root}</strong>
      </span>
    );
  }
  // error
  return (
    <span className="text-rose-700">
      Error in <strong>{root}</strong>: {event.message}
      {event.path && <span className="text-stone-500"> ({event.path.slice(event.path.lastIndexOf("/") + 1)})</span>}
    </span>
  );
}

/* ── About ───────────────────────────────────────────────────────── */

function AboutSection() {
  return (
    <div>
      <h2 className="t-h2 mb-2">About Bitrove</h2>
      <p className="text-stone-600 text-sm mb-8">
        Local-first knowledge base for your Mac. Everything runs on this
        device — search, embeddings, ingest — nothing leaves the machine.
      </p>

      <section className="mb-10">
        <h3 className="t-section mb-3">Version &amp; updates</h3>
        <UpdateFooter />
      </section>

      <section>
        <h3 className="t-section mb-3">Resources</h3>
        <ul className="text-sm space-y-2">
          <li>
            <a
              href="https://github.com/Liko209/bitrove"
              target="_blank"
              rel="noreferrer"
              className="text-stone-700 hover:text-stone-900 underline-offset-2 hover:underline"
            >
              Source code on GitHub →
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Liko209/bitrove/releases"
              target="_blank"
              rel="noreferrer"
              className="text-stone-700 hover:text-stone-900 underline-offset-2 hover:underline"
            >
              Release notes →
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}

/* ── Models ──────────────────────────────────────────────────────── */

type Hardware = Awaited<ReturnType<NonNullable<Window["bitrove"]>["getHardware"]>>;

function ModelsSection() {
  const navigate = useNavigate();
  const [activeTier, setActiveTier] = useState<Tier | null>(null);
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [pendingTier, setPendingTier] = useState<Tier | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<Tier | null>(null);
  const bridge = window.bitrove;

  // Pull installed state for every tier from main process so we can
  // show which models actually sit on disk (not just which one is
  // marked active in settings).
  const refreshInstalled = () => {
    if (!bridge?.listTiers) return;
    bridge
      .listTiers()
      .then((d) => {
        const map: Record<string, boolean> = {};
        for (const t of d.tiers) map[t.id] = t.installed;
        setInstalled(map);
      })
      .catch(() => {});
  };

  useEffect(() => {
    api
      .getActiveModelTier()
      .then((r) => setActiveTier(r.tier))
      .catch((e) => setErr((e as Error).message));
    if (bridge?.getHardware) {
      bridge.getHardware().then(setHardware).catch(() => {});
    }
    refreshInstalled();
  }, []);

  async function uninstall(t: Tier) {
    if (!bridge?.uninstallTier) return;
    if (t === activeTier) {
      alert("Switch to a different tier before removing this one.");
      return;
    }
    const meta = tierMeta(t);
    const ok = window.confirm(
      `Remove ${meta.label} (${formatBytes(meta.embedSizeBytes)}) from disk?\n\nYou can always re-download it later from this page.`,
    );
    if (!ok) return;
    setRemoving(t);
    setErr(null);
    try {
      await bridge.uninstallTier(t);
      refreshInstalled();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  const recommended = hardware ? recommendTier(hardware.totalRamGB) : null;

  function selectTier(t: Tier) {
    if (t === activeTier) return;
    setPendingTier(t);
  }

  return (
    <div>
      <h2 className="t-h2 mb-2">Embedding model</h2>
      <p className="text-stone-600 text-sm mb-8">
        Bitrove uses an on-device model to turn your documents into
        searchable vectors. Different tiers trade quality for speed and
        RAM. Reranker is fixed at bge-reranker-v2-m3 across all tiers.
      </p>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {/* Hardware block */}
      <section className="mb-8">
        <h3 className="t-section mb-3">Your Mac</h3>
        {hardware ? (
          <div className="bg-white border border-stone-200 rounded-xl p-4 text-sm">
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="font-medium text-stone-900">{hardware.cpuModel}</span>
              <span className="text-stone-500 tabular-nums">
                {hardware.totalRamGB} GB RAM · {hardware.cores} cores · {hardware.arch}
              </span>
            </div>
            {recommended && (
              <div className="text-xs text-stone-500 mt-1">
                Recommended tier for your Mac:{" "}
                <strong className="text-stone-800">{tierMeta(recommended).label}</strong>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-stone-500 italic">Hardware probe unavailable.</div>
        )}
      </section>

      {/* Tier cards */}
      <section>
        <h3 className="t-section mb-3">Choose a tier</h3>
        <div className="space-y-2">
          {TIER_META.map((t) => {
            const isActive = t.id === activeTier;
            const isPending = t.id === pendingTier;
            const isRecommended = t.id === recommended;
            const isInstalled = !!installed[t.id];
            const isRemoving = removing === t.id;
            return (
              <div
                key={t.id}
                className={
                  "w-full p-4 rounded-xl border transition " +
                  (isPending
                    ? "border-stone-900 bg-stone-50"
                    : isActive
                      ? "border-emerald-300 bg-emerald-50/50"
                      : "border-stone-200 bg-white hover:border-stone-400")
                }
              >
                <button
                  type="button"
                  onClick={() => selectTier(t.id)}
                  className="w-full text-left"
                >
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-stone-900">{t.label}</span>
                      {isActive && (
                        <span className="label-eyebrow text-emerald-700">Active</span>
                      )}
                      {isInstalled && !isActive && (
                        <span className="label-eyebrow text-blue-700">Installed</span>
                      )}
                      {isRecommended && !isActive && (
                        <span className="label-eyebrow text-stone-500">Recommended</span>
                      )}
                    </div>
                    <span className="text-xs text-stone-500 tabular-nums shrink-0">
                      {formatBytes(t.embedSizeBytes)} · ~{t.estRamGB} GB RAM · ~{t.estDocsPerSec} docs/s
                    </span>
                  </div>
                  <div className="text-xs text-stone-500 mt-1">{t.blurb}</div>
                  <div className="text-[11px] text-stone-400 font-mono mt-1">
                    {t.embedName} · {t.embedDim}-dim
                  </div>
                </button>
                {isInstalled && !isActive && (
                  <div className="mt-3 pt-3 border-t border-stone-100 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-stone-500">
                      On disk: {formatBytes(t.embedSizeBytes)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); uninstall(t.id); }}
                      disabled={isRemoving}
                      className="text-xs px-2.5 py-1 rounded border border-stone-300 text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                    >
                      {isRemoving ? "Removing…" : "Remove"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 text-[11px] text-stone-500">
          Reranker (bge-reranker-v2-m3, ~438 MB) is shared across all tiers
          and cannot be removed individually.
        </div>
      </section>

      <OcrSection />


      {pendingTier && pendingTier !== activeTier && activeTier && (
        <SwitchTierModal
          fromTier={activeTier}
          toTier={pendingTier}
          onCancel={() => setPendingTier(null)}
          onLaunched={() => {
            setActiveTier(pendingTier);
            setPendingTier(null);
            navigate("/jobs");
          }}
        />
      )}
    </div>
  );
}

/* ── OCR (Scanned PDFs) ─────────────────────────────────────────── */

function OcrSection() {
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(0);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    api
      .ocrStatus()
      .then((s) => {
        setEnabled(s.enabled);
        setPending(s.pending);
      })
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    refresh();
    // Light polling — pending count drops as the OCR batch finishes.
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.setOcrEnabled(next);
      setEnabled(r.enabled);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runBatch() {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.runOcrBatch();
      navigate(`/jobs/${r.jobId}`);
    } catch (e) {
      setErr((e as Error).message);
      setRunning(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="t-h2 mb-2">Scanned PDFs (OCR)</h2>
      <p className="text-stone-600 text-sm mb-6">
        Some PDFs (scans, photos of documents, old books) carry no
        text layer — Bitrove indexes them as "image-only" and can't
        search their contents. Turn this on to let macOS Vision
        Framework extract the text on-device. Everything stays on
        this Mac, nothing is sent anywhere.
      </p>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-stone-900">OCR scanned PDFs</span>
              {enabled && (
                <span className="label-eyebrow text-emerald-700">On</span>
              )}
            </div>
            <div className="text-xs text-stone-500 leading-relaxed">
              When enabled, future ingests run Vision OCR on PDFs
              with no text layer. ~1 second per page on Apple silicon.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled === true}
            disabled={saving || enabled === null}
            onClick={() => toggle(!enabled)}
            className={
              "relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition " +
              (enabled ? "bg-emerald-600" : "bg-stone-300") +
              (saving || enabled === null ? " opacity-50 cursor-wait" : "")
            }
          >
            <span
              className={
                "inline-block h-5 w-5 transform rounded-full bg-white shadow transition " +
                (enabled ? "translate-x-5" : "translate-x-0.5")
              }
            />
          </button>
        </div>

        {pending > 0 && (
          <div className="mt-4 pt-4 border-t border-stone-100">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <span className="text-sm text-stone-700">
                {pending.toLocaleString()} image-only PDF
                {pending === 1 ? "" : "s"} waiting for OCR
              </span>
              <span className="text-[11px] text-stone-500">
                ~{Math.max(1, Math.round((pending * 3) / 60))} min estimated
              </span>
            </div>
            <button
              type="button"
              onClick={runBatch}
              disabled={running || !enabled}
              title={
                !enabled
                  ? "Turn on OCR first"
                  : "Re-runs ingest with OCR on every image-only PDF"
              }
              className="text-sm px-3 py-1.5 rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {running ? "Starting…" : `Run OCR on ${pending} file${pending === 1 ? "" : "s"}`}
            </button>
          </div>
        )}

        {pending === 0 && enabled && (
          <div className="mt-4 pt-4 border-t border-stone-100 text-[11px] text-stone-500">
            No image-only PDFs in the library right now. New scans
            will automatically OCR any that come up.
          </div>
        )}
      </div>
    </section>
  );
}
