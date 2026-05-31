#!/usr/bin/env node
// Build the bitrove-ocr Swift CLI as a universal macOS binary
// (arm64 + x86_64) and drop it into resources/bin/ where
// electron-builder will pick it up via extraResources.
//
// Idempotent — safe to call from the release script every run.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const srcDir = join(repoRoot, "swift", "bitrove-ocr");
const outDir = join(repoRoot, "resources", "bin");

if (!existsSync(srcDir)) {
  console.error(`[ocr] swift sources missing at ${srcDir}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// Nuke any prior .build dir so SPM doesn't get confused by a cached
// build description from a different invocation (e.g. earlier
// developer-time `swift build` with no --arch). Cheap — full
// rebuild is ~4s per arch.
rmSync(join(srcDir, ".build"), { recursive: true, force: true });

// SPM's --arch flag lays each slice down at
//   .build/<triple>-apple-macosx/release/bitrove-ocr
// so two separate `swift build` runs into the SAME .build don't
// collide. Then lipo merges them into the universal binary.
function buildOne(arch) {
  console.log(`[ocr] swift build for ${arch} ...`);
  execSync(`swift build -c release --arch ${arch}`, {
    cwd: srcDir,
    stdio: "inherit",
  });
  return join(srcDir, ".build", `${arch}-apple-macosx`, "release", "bitrove-ocr");
}

const arm = buildOne("arm64");
const intel = buildOne("x86_64");
const dst = join(outDir, "bitrove-ocr");

console.log(`[ocr] lipo -create -> ${dst}`);
execSync(`lipo -create "${arm}" "${intel}" -output "${dst}"`, { stdio: "inherit" });
chmodSync(dst, 0o755);

const info = execSync(`lipo -info "${dst}"`).toString().trim();
console.log(`[ocr] ${info}`);
console.log(`[ocr] done`);
