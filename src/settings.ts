// User-tunable ingest defaults. Persisted as JSON under userData.
//
// excludedExts  → file extensions never auto-indexed during folder scans.
//   Stored lowercase WITH the leading dot, e.g. ".js".
//
// excludedFolders → directory NAMES (not full paths) whose entire subtree
//   gets skipped, e.g. "node_modules". Matched as a substring of the form
//   "/<name>/" against absolute paths to avoid false positives.
//
// Both lists only affect folder scans — explicit per-file adds (future
// "pick file" flow) still go through, with a warning if they hit an
// excluded extension.

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

export type IngestSettings = {
  excludedExts: string[];
  excludedFolders: string[];
  // Watcher cadence — minutes. Both clamp at [1, 1440] when persisted.
  // Defaults to 30/30, which matches the original env-var defaults.
  watcherScanIntervalMin?: number;
  watcherDebounceMin?: number;
};

// Curated defaults — biased toward "skip what is rarely knowledge".
// Source code, build artifacts, web bundles. Conservative on scripting
// langs (.py, .rb, .sh) since notes/snippets often live there.
export const DEFAULT_EXCLUDED_EXTS: string[] = [
  // JS / TS source
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".d.ts",
  // Native compiled
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx",
  ".java", ".kt", ".kts", ".scala", ".groovy",
  ".go", ".rs", ".swift", ".m", ".mm",
  // Web assets / styles
  ".css", ".scss", ".sass", ".less", ".styl",
  // Build / debug artifacts
  ".map", ".lock", ".log",
  // Binaries we can't read anyway
  ".so", ".dylib", ".dll", ".o", ".a", ".class", ".jar", ".pyc",
];

export const DEFAULT_EXCLUDED_FOLDERS: string[] = [
  "node_modules", ".git", ".svn", ".hg",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  "dist", "build", "target", "out", "bin", "obj",
  ".next", ".nuxt", ".cache", ".parcel-cache",
  ".idea", ".vscode", ".gradle",
  "site-packages", "conda",
];

// Catalog of file types Bitrove can actually do something with. Shown in
// Settings so the user knows what's supported, and grouped so the UI can
// render checklists category-by-category. Edit this list as new ingest
// handlers are wired up.
export type SupportedTypeGroup = {
  group: string;
  description: string;
  exts: string[];
};

export const SUPPORTED_TYPES: SupportedTypeGroup[] = [
  {
    group: "Documents",
    description: "Read in full and chunked for search.",
    exts: [".pdf", ".docx", ".doc", ".rtf", ".odt"],
  },
  {
    group: "Notes & text",
    description: "Plain text, markdown, and lightweight markup.",
    exts: [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".org"],
  },
  {
    group: "Slides",
    description: "Slide decks indexed by title + body.",
    exts: [".pptx", ".ppt", ".key"],
  },
  {
    group: "Spreadsheets",
    description: "Table headers + first sheet contents.",
    exts: [".xlsx", ".xls", ".csv", ".tsv"],
  },
  {
    group: "Books",
    description: "Catalog only (title / author), not full text.",
    exts: [".epub", ".mobi", ".azw3"],
  },
  {
    group: "Web pages",
    description: "Saved HTML pages, cleaned of boilerplate.",
    exts: [".html", ".htm"],
  },
  {
    group: "Code-like",
    description: "Off by default — flip back on if you keep notes in these.",
    exts: [
      ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
      ".cpp", ".c", ".h", ".java", ".kt", ".swift",
      ".sh", ".bash", ".zsh",
    ],
  },
];

function settingsFilePath(): string {
  const root = process.env.BITROVE_USER_DATA;
  if (root) return join(root, "ingest-settings.json");
  // Dev fallback — co-locate with the index db.
  return resolve(process.cwd(), "data", "ingest-settings.json");
}

let cached: IngestSettings | null = null;

const DEFAULT_WATCHER_INTERVAL_MIN = 30;
const DEFAULT_WATCHER_DEBOUNCE_MIN = 30;

function clampMin(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(Math.round(n), 1), 1440);
}

export async function readIngestSettings(): Promise<IngestSettings> {
  if (cached) return cached;
  const p = settingsFilePath();
  if (!existsSync(p)) {
    cached = {
      excludedExts: [...DEFAULT_EXCLUDED_EXTS],
      excludedFolders: [...DEFAULT_EXCLUDED_FOLDERS],
      watcherScanIntervalMin: DEFAULT_WATCHER_INTERVAL_MIN,
      watcherDebounceMin: DEFAULT_WATCHER_DEBOUNCE_MIN,
    };
    return cached;
  }
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<IngestSettings>;
    cached = {
      excludedExts: normaliseExts(parsed.excludedExts ?? DEFAULT_EXCLUDED_EXTS),
      excludedFolders: parsed.excludedFolders ?? DEFAULT_EXCLUDED_FOLDERS,
      watcherScanIntervalMin: clampMin(parsed.watcherScanIntervalMin, DEFAULT_WATCHER_INTERVAL_MIN),
      watcherDebounceMin: clampMin(parsed.watcherDebounceMin, DEFAULT_WATCHER_DEBOUNCE_MIN),
    };
    return cached;
  } catch {
    cached = {
      excludedExts: [...DEFAULT_EXCLUDED_EXTS],
      excludedFolders: [...DEFAULT_EXCLUDED_FOLDERS],
      watcherScanIntervalMin: DEFAULT_WATCHER_INTERVAL_MIN,
      watcherDebounceMin: DEFAULT_WATCHER_DEBOUNCE_MIN,
    };
    return cached;
  }
}

export async function writeIngestSettings(
  next: IngestSettings,
): Promise<IngestSettings> {
  const sanitized: IngestSettings = {
    excludedExts: normaliseExts(next.excludedExts),
    excludedFolders: [...new Set(next.excludedFolders.map((s) => s.trim()).filter(Boolean))],
    watcherScanIntervalMin: clampMin(next.watcherScanIntervalMin, DEFAULT_WATCHER_INTERVAL_MIN),
    watcherDebounceMin: clampMin(next.watcherDebounceMin, DEFAULT_WATCHER_DEBOUNCE_MIN),
  };
  const p = settingsFilePath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(sanitized, null, 2));
  cached = sanitized;
  return sanitized;
}

function normaliseExts(exts: string[]): string[] {
  const out = new Set<string>();
  for (const raw of exts) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    out.add(s.startsWith(".") ? s : "." + s);
  }
  return [...out];
}

// Convert the folder-name list to the substring patterns walker.ts expects
// ("/<name>/"). Caller can append these to its own excludes array.
export function foldersToWalkerExcludes(folders: string[]): string[] {
  return folders.map((f) => `/${f.trim().replace(/^\/+|\/+$/g, "")}/`);
}
