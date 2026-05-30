// Derive a "category" (top-level shelf) for grouping.
// Heuristic: strip known roots, then take the first meaningful folder.
//   - iCloud root  → /Users/$USER/Library/Mobile Documents/com~apple~CloudDocs
//   - generic intermediates (Desktop, Documents, Downloads) get peeled away
//
// Examples:
//   …/CloudDocs/Documents/JHU/Courses/HW#1.pdf   → "JHU"
//   …/CloudDocs/Desktop/重疾险/foo.pdf            → "重疾险"
//   …/CloudDocs/Documents/IBooks/book.epub       → "IBooks"
//   …/CloudDocs/foo.pdf                          → "iCloud Drive"

import { homedir } from "node:os";
import { extname } from "node:path";

const HOME = homedir();
const ICLOUD = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`;
const GENERIC_INTERMEDIATES = new Set(["Desktop", "Documents", "Downloads", "Library"]);

const FILE_EXT_RE = /\.[a-z0-9]+$/i;

export function deriveCategory(absPath: string): { category: string; subcategory?: string } {
  let rel = absPath;
  let location: "iCloud" | "Local" = "Local";
  if (absPath.startsWith(ICLOUD)) {
    rel = absPath.slice(ICLOUD.length).replace(/^\/+/, "");
    location = "iCloud";
  } else if (absPath.startsWith(HOME)) {
    rel = absPath.slice(HOME.length).replace(/^\/+/, "");
  }
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { category: location === "iCloud" ? "iCloud Drive" : "Local" };
  }

  // Skip generic intermediates (Desktop / Documents / Downloads / Library).
  // Remember the last generic we skipped — used as a fallback bucket
  // when nothing meaningful remains.
  let lastSkipped: string | null = null;
  let idx = 0;
  while (idx < parts.length - 1 && GENERIC_INTERMEDIATES.has(parts[idx])) {
    lastSkipped = parts[idx];
    idx++;
  }
  const top = parts[idx];
  const sub = parts[idx + 1];
  const isLastSegmentFile = idx === parts.length - 1 && FILE_EXT_RE.test(top);

  if (isLastSegmentFile) {
    // remaining `top` is a filename, not a folder — bucket as scattered
    if (lastSkipped) return { category: lastSkipped };
    return { category: location === "iCloud" ? "iCloud Drive" : "Local" };
  }
  return { category: top, subcategory: sub };
}

// File-type bucket (used for icon coloring)
export type FileTypeBucket =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "slide"
  | "book"
  | "markdown"
  | "text"
  | "other";

export function fileTypeBucket(absPath: string): FileTypeBucket {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc") return "word";
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") return "spreadsheet";
  if (ext === ".pptx" || ext === ".ppt" || ext === ".key") return "slide";
  if (ext === ".epub") return "book";
  if (ext === ".md") return "markdown";
  if (ext === ".txt") return "text";
  return "other";
}
