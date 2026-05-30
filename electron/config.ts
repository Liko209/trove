// User config persisted under the platform userData dir (packaged) or
// repo/data (dev). Holds what the onboarding wizard collected.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";

export type TroveConfig = {
  // First folder the user chose during onboarding (auto-scanned once on first run)
  sources: string[];
  // Optional extra exclude substrings beyond the built-in defaults
  excludes: string[];
  // Flag: whether the user has finished onboarding (skip wizard next launch)
  onboarded: boolean;
};

const DEFAULT_CONFIG: TroveConfig = {
  sources: [],
  excludes: [],
  onboarded: false,
};

let cache: TroveConfig | null = null;

export async function readConfig(): Promise<TroveConfig> {
  if (cache) return cache;
  const p = configPath();
  if (!existsSync(p)) {
    cache = { ...DEFAULT_CONFIG };
    return cache;
  }
  try {
    const raw = await readFile(p, "utf8");
    cache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    return cache!;
  } catch {
    cache = { ...DEFAULT_CONFIG };
    return cache;
  }
}

export async function writeConfig(partial: Partial<TroveConfig>): Promise<TroveConfig> {
  const current = await readConfig();
  const next = { ...current, ...partial };
  const p = configPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

// Heuristic: detect common knowledge folders we can pre-check in the wizard.
import { existsSync as fsExists } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function autodetectSources(): { path: string; label: string; exists: boolean }[] {
  const home = homedir();
  const candidates = [
    { path: join(home, "Library/Mobile Documents/com~apple~CloudDocs"), label: "iCloud Drive" },
    { path: join(home, "Documents"), label: "Documents" },
    { path: join(home, "Desktop"), label: "Desktop" },
    { path: join(home, "Downloads"), label: "Downloads" },
  ];
  return candidates.map((c) => ({ ...c, exists: fsExists(c.path) }));
}
