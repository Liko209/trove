// Recursive folder-tree picker for the Configure-scan page.
//
// Lets the user check/uncheck any folder at any depth — not just the
// top-level subdirs. Loads children lazily (one /api/list-subdirs
// call per expand) so a 50k-file tree doesn't blow the network in
// one shot.
//
// Exclusion model (intentionally Finder-shaped, kept simple):
//   - excludedPaths is a flat Set<absolutePath>.
//   - A node is "off" if its path is in the set OR any ancestor is.
//   - Toggling a node off adds its path to the set; toggling on
//     removes its own path (it stays off if an ancestor is still in
//     the set — uncheck the ancestor first).
//   - Tristate visual: an "on" node whose path isn't in the set but
//     some descendant is shows as indeterminate.
//
// The same Set is what gets sent to /api/ingest/scan as `excludes` —
// the walker just substring-matches absolute path prefixes, so any
// depth works without backend changes.

import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { bytes } from "../lib/format.ts";
import { ChevronRightIcon } from "./icons.tsx";

type Node = {
  path: string;
  name: string;
  // Estimated indexable count + bytes inside this subtree, capped
  // at the backend's per-subdir SAMPLE_CAP=5000.
  estimate: number;
  size: number;
};

type FileNode = {
  path: string;
  name: string;
  size: number;
  kind: "text" | "catalog";
};

type ChildrenPayload = {
  subdirs: Node[];
  files: FileNode[];
  truncated: boolean;
  totalImmediateFiles: number;
};

type LoadState = "idle" | "loading" | "loaded" | "error";

export default function FolderTreePicker({
  root,
  excludedPaths,
  onChange,
}: {
  root: string;
  excludedPaths: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  // childrenMap[path] = direct children (subdirs + files + truncation
  // flags) of `path`. undefined = not requested yet.
  const [childrenMap, setChildrenMap] = useState<Map<string, ChildrenPayload>>(
    new Map(),
  );
  const [loadState, setLoadState] = useState<Map<string, LoadState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [err, setErr] = useState<string | null>(null);

  // Eagerly load the root's children — that's the only level the user
  // sees on first paint, lazy beyond.
  useEffect(() => {
    loadChildren(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function loadChildren(path: string) {
    if (childrenMap.has(path) || loadState.get(path) === "loading") return;
    setLoadState((m) => new Map(m).set(path, "loading"));
    try {
      const r = await api.listSubdirs(path);
      setChildrenMap((m) =>
        new Map(m).set(path, {
          subdirs: r.subdirs,
          files: r.files,
          truncated: r.truncated,
          totalImmediateFiles: r.totalImmediateFiles,
        }),
      );
      setLoadState((m) => new Map(m).set(path, "loaded"));
    } catch (e) {
      setErr((e as Error).message);
      setLoadState((m) => new Map(m).set(path, "error"));
    }
  }

  function isAncestorExcluded(path: string): boolean {
    // Walk up: check every parent prefix against the excluded set.
    // Stop at the root.
    let p = path;
    while (p.length > root.length) {
      const idx = p.lastIndexOf("/");
      if (idx <= 0) break;
      p = p.slice(0, idx);
      if (p.length < root.length) break;
      if (excludedPaths.has(p)) return true;
    }
    return false;
  }

  function isEffectivelyExcluded(path: string): boolean {
    return excludedPaths.has(path) || isAncestorExcluded(path);
  }

  // For tri-state visual: "this node isn't excluded itself, but some
  // descendant under it is". We can only know about descendants we've
  // already loaded — undiscovered descendants count as "fully on".
  function hasExcludedDescendant(path: string): boolean {
    const payload = childrenMap.get(path);
    if (!payload) return false;
    for (const k of payload.subdirs) {
      if (excludedPaths.has(k.path)) return true;
      if (hasExcludedDescendant(k.path)) return true;
    }
    for (const f of payload.files) {
      if (excludedPaths.has(f.path)) return true;
    }
    return false;
  }

  function toggle(path: string) {
    if (isAncestorExcluded(path)) {
      // Re-include requires uncheck of the controlling ancestor —
      // no-op for now; could promote later but keeps the model simple.
      return;
    }
    onChange(
      (() => {
        const next = new Set(excludedPaths);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      })(),
    );
  }

  function toggleExpanded(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!childrenMap.has(path)) loadChildren(path);
      }
      return next;
    });
  }

  return (
    <div className="border border-stone-200 rounded-xl bg-white overflow-hidden">
      {err && (
        <div className="px-3 py-2 bg-rose-50 border-b border-rose-200 text-xs text-rose-700">
          {err}
        </div>
      )}
      <RootRow
        root={root}
        excluded={excludedPaths.has(root)}
        onToggle={() => toggle(root)}
      />
      {/* Render the loaded subtree under the root. We pass the root's
          immediate children as the seed; <Subtree> handles deeper
          levels by reading childrenMap. */}
      <Subtree
        parentPath={root}
        depth={0}
        childrenMap={childrenMap}
        loadState={loadState}
        expanded={expanded}
        isEffectivelyExcluded={isEffectivelyExcluded}
        isAncestorExcluded={isAncestorExcluded}
        hasExcludedDescendant={hasExcludedDescendant}
        onToggle={toggle}
        onToggleExpanded={toggleExpanded}
      />
    </div>
  );
}

function RootRow({
  root,
  excluded,
  onToggle,
}: {
  root: string;
  excluded: boolean;
  onToggle: () => void;
}) {
  const name = root.slice(root.lastIndexOf("/") + 1) || root;
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-stone-50 border-b border-stone-100 text-xs">
      <input
        type="checkbox"
        checked={!excluded}
        onChange={onToggle}
        className="accent-stone-900"
      />
      <span className="font-medium text-stone-800 truncate flex-1" title={root}>
        {name}
        <span className="text-stone-400"> · everything below</span>
      </span>
    </div>
  );
}

function Subtree({
  parentPath,
  depth,
  childrenMap,
  loadState,
  expanded,
  isEffectivelyExcluded,
  isAncestorExcluded,
  hasExcludedDescendant,
  onToggle,
  onToggleExpanded,
}: {
  parentPath: string;
  depth: number;
  childrenMap: Map<string, ChildrenPayload>;
  loadState: Map<string, LoadState>;
  expanded: Set<string>;
  isEffectivelyExcluded: (path: string) => boolean;
  isAncestorExcluded: (path: string) => boolean;
  hasExcludedDescendant: (path: string) => boolean;
  onToggle: (path: string) => void;
  onToggleExpanded: (path: string) => void;
}) {
  const payload = childrenMap.get(parentPath);
  const state = loadState.get(parentPath);

  if (state === "loading") {
    return (
      <div
        className="px-3 py-2 text-xs text-stone-500 flex items-center gap-2"
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        <div className="w-3 h-3 border-2 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
        Loading…
      </div>
    );
  }
  if (!payload || (payload.subdirs.length === 0 && payload.files.length === 0)) {
    if (depth === 0) {
      return (
        <div className="px-3 py-3 text-xs text-stone-400 italic text-center">
          Empty folder.
        </div>
      );
    }
    return (
      <div
        className="text-[11px] text-stone-400 italic py-1"
        style={{ paddingLeft: `${36 + depth * 18}px` }}
      >
        No indexable files or sub-folders here.
      </div>
    );
  }

  // Sibling-relative bar maximum is based on the largest subdir
  // estimate; loose files don't share the same scale (they're a
  // single file each).
  const max = Math.max(...payload.subdirs.map((c) => c.estimate), 1);

  return (
    <ul>
      {payload.subdirs.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          max={max}
          excludedSelf={isEffectivelyExcluded(node.path)}
          ancestorExcluded={isAncestorExcluded(node.path)}
          partial={!isEffectivelyExcluded(node.path) && hasExcludedDescendant(node.path)}
          isExpanded={expanded.has(node.path)}
          onToggle={() => onToggle(node.path)}
          onToggleExpanded={() => onToggleExpanded(node.path)}
        >
          {expanded.has(node.path) && (
            <Subtree
              parentPath={node.path}
              depth={depth + 1}
              childrenMap={childrenMap}
              loadState={loadState}
              expanded={expanded}
              isEffectivelyExcluded={isEffectivelyExcluded}
              isAncestorExcluded={isAncestorExcluded}
              hasExcludedDescendant={hasExcludedDescendant}
              onToggle={onToggle}
              onToggleExpanded={onToggleExpanded}
            />
          )}
        </TreeRow>
      ))}
      {payload.files.map((f) => (
        <FileRow
          key={f.path}
          file={f}
          depth={depth}
          excludedSelf={isEffectivelyExcluded(f.path)}
          ancestorExcluded={isAncestorExcluded(f.path)}
          onToggle={() => onToggle(f.path)}
        />
      ))}
      {payload.truncated && (
        <li
          className="text-[11px] text-stone-400 italic py-1"
          style={{ paddingLeft: `${36 + depth * 18}px` }}
        >
          + {payload.totalImmediateFiles - payload.files.length} more files here
          (showing first {payload.files.length}). Indexing will still pick them all up.
        </li>
      )}
    </ul>
  );
}

function FileRow({
  file,
  depth,
  excludedSelf,
  ancestorExcluded,
  onToggle,
}: {
  file: FileNode;
  depth: number;
  excludedSelf: boolean;
  ancestorExcluded: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <div
        className={
          "flex items-center gap-2 py-1 text-xs hover:bg-stone-50 transition border-b border-stone-100 last:border-b-0 " +
          (excludedSelf ? "opacity-60" : "")
        }
        style={{ paddingLeft: `${12 + depth * 18}px`, paddingRight: "12px" }}
      >
        {/* Files have no chevron — placeholder keeps columns aligned. */}
        <span className="shrink-0 w-5 h-5" />
        <input
          type="checkbox"
          checked={!excludedSelf}
          onChange={onToggle}
          disabled={ancestorExcluded}
          className="accent-stone-900 shrink-0"
          title={
            ancestorExcluded
              ? "A parent folder is unchecked — uncheck it first to control this file individually."
              : undefined
          }
        />
        <span
          className={
            "truncate flex-1 font-mono text-[11px] " +
            (excludedSelf ? "line-through text-stone-400" : "text-stone-700")
          }
          title={file.path}
        >
          {file.name}
        </span>
        <span
          className={
            "shrink-0 tabular-nums text-[11px] " +
            (excludedSelf ? "text-stone-300 line-through" : "text-stone-500")
          }
        >
          {bytes(file.size)}
        </span>
      </div>
    </li>
  );
}

function TreeRow({
  node,
  depth,
  max,
  excludedSelf,
  ancestorExcluded,
  partial,
  isExpanded,
  onToggle,
  onToggleExpanded,
  children,
}: {
  node: Node;
  depth: number;
  max: number;
  excludedSelf: boolean;
  ancestorExcluded: boolean;
  partial: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onToggleExpanded: () => void;
  children?: React.ReactNode;
}) {
  const ratio = Math.round((node.estimate / max) * 100);
  const checked = !excludedSelf;
  const showAsCapped = node.estimate >= 5000;
  // The ref-based "indeterminate" is the only way to set it on a
  // controlled checkbox; React leaves it for us to assign on mount.
  const setIndeterminate = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = partial;
  };
  return (
    <li>
      <div
        className={
          "flex items-center gap-2 py-1.5 text-xs hover:bg-stone-50 transition border-b border-stone-100 last:border-b-0 " +
          (excludedSelf ? "opacity-60" : "")
        }
        style={{ paddingLeft: `${12 + depth * 18}px`, paddingRight: "12px" }}
      >
        {/* Expand / collapse chevron. Folders that we know are empty
            (loaded but no kids) get an empty placeholder so columns
            still line up. */}
        <button
          type="button"
          onClick={onToggleExpanded}
          className="shrink-0 w-5 h-5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded flex items-center justify-center transition"
          title={isExpanded ? "Collapse" : "Expand"}
        >
          <span
            className={
              "inline-flex transition-transform duration-150 " +
              (isExpanded ? "rotate-90" : "")
            }
          >
            <ChevronRightIcon size={14} />
          </span>
        </button>

        <input
          type="checkbox"
          checked={checked}
          ref={setIndeterminate}
          onChange={onToggle}
          disabled={ancestorExcluded}
          className="accent-stone-900 shrink-0"
          title={
            ancestorExcluded
              ? "A parent folder is unchecked — uncheck it first to control this row individually."
              : undefined
          }
        />

        <span
          className={
            "truncate flex-1 " +
            (excludedSelf ? "line-through text-stone-400" : "text-stone-800")
          }
          title={node.path}
        >
          {node.name}
        </span>

        <span
          className={
            "shrink-0 tabular-nums text-[11px] " +
            (excludedSelf ? "text-stone-300 line-through" : "text-stone-500")
          }
        >
          {showAsCapped ? "5000+" : node.estimate.toLocaleString()} files
          {node.size > 0 && (
            <span className={excludedSelf ? "text-stone-300" : "text-stone-400"}>
              {" · "}
              {bytes(node.size)}
            </span>
          )}
        </span>
      </div>
      {/* Inline bar — same visual language as the original FolderBreakdown */}
      <div
        className="h-0.5 bg-transparent"
        style={{ paddingLeft: `${36 + depth * 18}px`, paddingRight: "12px" }}
      >
        <div
          className="h-0.5 rounded bg-stone-100 overflow-hidden"
          style={{ marginTop: "-2px" }}
        >
          <div
            className={
              "h-full " + (excludedSelf ? "bg-stone-300" : "bg-emerald-500/70")
            }
            style={{ width: `${ratio}%` }}
          />
        </div>
      </div>
      {children}
    </li>
  );
}

