#!/usr/bin/env node
// Bitrove release pipeline — one command goes from "main is clean" to
// "users on older versions will see an UpdateBanner".
//
// Usage:
//   npm run release                         # patch bump, notes from git log
//   npm run release -- minor                # minor bump
//   npm run release -- major
//   npm run release -- patch -m "Fix X"     # explicit notes
//   npm run release -- --dry                # simulate without pushing
//   npm run release -- -y patch             # skip confirmation
//
// Steps:
//   1. Preflight: clean working tree, on main, gh authenticated, no tag clash.
//   2. `npm version <bump>` — commit + tag locally.
//   3. `npm run app:dist`   — build admin + UI + Electron + DMG.
//   4. `git push --follow-tags` — push code + tag to GitHub.
//   5. `gh release create`  — upload DMG + blockmap + latest-mac.yml.
//   6. Print release URL.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── arg parsing ───────────────────────────────────────────
const args = process.argv.slice(2);
let bump = "patch";
let notes = "";
let dry = false;
let yes = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "patch" || a === "minor" || a === "major") {
    bump = a;
  } else if (a === "-m" || a === "--notes") {
    notes = args[++i] ?? "";
  } else if (a === "--dry" || a === "--dry-run") {
    dry = true;
  } else if (a === "-y" || a === "--yes") {
    yes = true;
  } else if (a === "-h" || a === "--help") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Usage: npm run release -- [patch|minor|major] [options]

Options:
  patch                 bump 0.0.X (default)
  minor                 bump 0.X.0
  major                 bump X.0.0
  -m, --notes "..."     release notes (otherwise inferred from git log)
  --dry                 simulate without pushing or publishing
  -y, --yes             skip confirmation prompt
  -h, --help            show this help

Examples:
  npm run release
  npm run release -- minor
  npm run release -- patch -m "Fix the crash on startup"
  npm run release -- --dry
`);
}

// ── shell helpers ─────────────────────────────────────────
function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}`);
  if (dry) return "";
  const r = spawnSync(cmd, argv, {
    stdio: opts.capture ? "pipe" : "inherit",
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv[0]} failed with exit code ${r.status}`);
  }
  return (r.stdout ?? "").trim();
}

function tryRun(cmd, argv) {
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function step(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

// ── preflight ─────────────────────────────────────────────
step("Preflight");

const dirty = tryRun("git", ["status", "--porcelain"]).stdout;
if (dirty) {
  console.error("✗ Working tree is not clean. Commit or stash first:");
  console.error(dirty);
  process.exit(1);
}
console.log("✓ Working tree clean");

const branch = tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
if (branch !== "main") {
  console.error(`✗ Must be on 'main' branch (currently on '${branch}')`);
  process.exit(1);
}
console.log(`✓ On main branch`);

if (tryRun("gh", ["auth", "status"]).code !== 0) {
  console.error("✗ gh CLI not authenticated. Run `gh auth login` first.");
  process.exit(1);
}
console.log("✓ gh CLI authenticated");

// Determine new version
const pkgPath = resolve(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, bump);

function bumpVersion(v, b) {
  const [maj, min, pat] = v.split(".").map(Number);
  if (b === "major") return `${maj + 1}.0.0`;
  if (b === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

console.log(`✓ Bump:  ${currentVersion}  →  ${newVersion}`);

// Tag clash?
const tagCheck = tryRun("git", ["rev-parse", `v${newVersion}`]);
if (tagCheck.code === 0) {
  console.error(`✗ Tag v${newVersion} already exists locally.`);
  process.exit(1);
}

// Confirm
if (!yes && !dry) {
  console.log();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`Release v${newVersion}? [y/N] `);
  rl.close();
  if (ans.trim().toLowerCase() !== "y") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// ── pipeline ─────────────────────────────────────────────
let versionBumped = false;
try {
  step("Bumping version + committing tag");
  run("npm", ["version", bump, "-m", "chore: release v%s"]);
  versionBumped = true;

  step("Building bitrove-ocr universal binary (arm64 + x86_64)");
  run("node", ["scripts/build-ocr.mjs"]);

  step("Building admin + UI + Electron + DMG");
  run("npm", ["run", "app:dist"]);

  step("Pushing main + tag to GitHub");
  run("git", ["push", "origin", "main", "--follow-tags"]);

  // ── release notes ──
  if (!notes) {
    const prevTag = tryRun("git", ["describe", "--tags", "--abbrev=0", `v${newVersion}^`]).stdout;
    if (prevTag) {
      const log = tryRun("git", ["log", "--pretty=format:- %s", `${prevTag}..v${newVersion}`]).stdout;
      notes = log
        ? `## Changes since ${prevTag}\n\n${log}`
        : "Maintenance release.";
    } else {
      notes = "Maintenance release.";
    }
  }
  // Append the standard "macOS says it's damaged" footer to every release.
  // Until we ship a signed build, every download needs the xattr step.
  notes += `

---

## Installing on macOS

Bitrove is currently unsigned. macOS will block it twice unless you take one
extra step:

1. Download the DMG below, open it, drag **Bitrove** to Applications.
2. Open Terminal and run:
   \`\`\`
   xattr -cr /Applications/Bitrove.app
   \`\`\`
3. Double-click Bitrove. It will open normally from now on.

If you see "Bitrove is damaged and can't be opened", you skipped step 2 — it's
not actually damaged, that's just macOS Gatekeeper's wording for any unsigned
app downloaded from a browser. Run the \`xattr\` command above and try again.

Signing + notarization (which would make this step unnecessary) is on the
roadmap.`;

  step("Creating GitHub release");
  // electron-builder emits both:
  //   - the DMG (first-install download, listed in release notes)
  //   - the ZIP + blockmap (used by electron-updater's Squirrel.Mac flow)
  // Without the ZIP, auto-update fails with "ZIP file not provided".
  const dmg = `dist-electron/Bitrove-${newVersion}-arm64.dmg`;
  const dmgBlockmap = `dist-electron/Bitrove-${newVersion}-arm64.dmg.blockmap`;
  const zip = `dist-electron/Bitrove-${newVersion}-arm64-mac.zip`;
  const zipBlockmap = `dist-electron/Bitrove-${newVersion}-arm64-mac.zip.blockmap`;
  const yml = `dist-electron/latest-mac.yml`;
  const assets = [dmg, dmgBlockmap, zip, zipBlockmap, yml];
  if (!dry) {
    for (const f of assets) {
      if (!existsSync(resolve(ROOT, f))) {
        throw new Error(`Build output missing: ${f}`);
      }
    }
  }
  const notesFile = `/tmp/bitrove-release-notes-${newVersion}.md`;
  writeFileSync(notesFile, notes);
  try {
    run("gh", [
      "release", "create", `v${newVersion}`,
      ...assets,
      "--title", `Bitrove v${newVersion}`,
      "--notes-file", notesFile,
    ]);
  } finally {
    try { unlinkSync(notesFile); } catch {}
  }

  // ── done ──
  const repoUrl = tryRun("gh", ["repo", "view", "--json", "url", "-q", ".url"]).stdout;
  console.log(`\n✅ Released v${newVersion}`);
  if (repoUrl) {
    console.log(`   ${repoUrl}/releases/tag/v${newVersion}`);
  }
  console.log(`\nUsers on older Bitrove versions will see an UpdateBanner within 6 hours,`);
  console.log(`or on their next launch (whichever comes first).`);
} catch (e) {
  console.error(`\n✗ Release failed: ${e.message}`);
  if (versionBumped && !dry) {
    console.error(`\nThe version bump commit + tag were created locally. To undo:`);
    console.error(`  git tag -d v${newVersion}`);
    console.error(`  git reset --hard HEAD^`);
  }
  process.exit(1);
}
