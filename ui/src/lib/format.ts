// Shared display helpers

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function shortPath(p: string): string {
  const home = "/Users/leecoor";
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

// Show parent folder of a file (relative, with ~ for home)
export function parentDir(p: string, maxLen = 60): string {
  const home = "/Users/leecoor";
  const cloud = home + "/Library/Mobile Documents/com~apple~CloudDocs";
  let s = p;
  if (s.startsWith(cloud)) s = "iCloud" + s.slice(cloud.length);
  else if (s.startsWith(home)) s = "~" + s.slice(home.length);
  const idx = s.lastIndexOf("/");
  const dir = idx >= 0 ? s.slice(0, idx) : s;
  if (dir.length <= maxLen) return dir;
  // truncate middle
  const head = dir.slice(0, Math.floor(maxLen / 2) - 2);
  const tail = dir.slice(dir.length - Math.floor(maxLen / 2) + 2);
  return `${head}…${tail}`;
}

// Split an absolute path into (filename, parent directory),
// abbreviating common prefixes for friendlier display.
export function splitPath(absPath: string): { name: string; dir: string } {
  const home = "/Users/leecoor";
  const cloud = home + "/Library/Mobile Documents/com~apple~CloudDocs";
  let p = absPath;
  if (p.startsWith(cloud)) p = "iCloud" + p.slice(cloud.length);
  else if (p.startsWith(home)) p = "~" + p.slice(home.length);
  const idx = p.lastIndexOf("/");
  return { name: idx >= 0 ? p.slice(idx + 1) : p, dir: idx >= 0 ? p.slice(0, idx) : "" };
}

// Human-friendly ETA / duration (seconds → "1m 23s" / "2h 5m")
export function formatDurationSeconds(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m ${Math.round(seconds % 60)}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function relTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const ms = now - d.getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day < 1) {
    if (hr >= 1) return `${hr}h ago`;
    if (min >= 1) return `${min}m ago`;
    return "just now";
  }
  if (day < 30) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}
