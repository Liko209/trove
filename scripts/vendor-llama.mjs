// Vendor llama.cpp's pre-built macOS arm64 binaries (llama-server + dylibs)
// into resources/bin/ so they ship with the packaged app.
//
// Usage: node scripts/vendor-llama.mjs [--version bXXXX]

import { mkdir, rm, writeFile, readdir, stat, chmod, rename } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const VENDOR_DIR = join(ROOT, "resources", "bin");
const TMP_DIR = join(ROOT, ".vendor-tmp");

const args = process.argv.slice(2);
const verArg = args.indexOf("--version");
const requestedVersion = verArg >= 0 ? args[verArg + 1] : null;

async function pickRelease() {
  if (requestedVersion) return requestedVersion;
  const r = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest");
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.tag_name;
}

async function findAsset(tag) {
  const r = await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`);
  if (!r.ok) throw new Error(`release ${tag}: ${r.status}`);
  const j = await r.json();
  const asset = j.assets.find((a) => /macos-arm64\.(tar\.gz|zip)$/i.test(a.name));
  if (!asset) throw new Error(`no macos-arm64 asset in ${tag}`);
  return asset;
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
  const total = Number(r.headers.get("content-length") ?? 0);
  let got = 0;
  let lastLog = 0;
  const out = createWriteStream(dest);
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
    got += value.length;
    if (total > 0 && got - lastLog > total / 20) {
      process.stdout.write(`\r  ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
      lastLog = got;
    }
  }
  out.end();
  await new Promise((res) => out.on("close", res));
  process.stdout.write("\n");
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exit ${code}`))));
  });
}

async function flattenIntoBin(extractedDir) {
  // The tarball may unpack as `build/bin/...` or directly to bin contents.
  // We want llama-server + dylibs + ggml plugins at the top of resources/bin/.
  async function walk(dir) {
    const items = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of items) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  }
  const all = await walk(extractedDir);
  // Vendor the server binary + every dylib it might pull in. Other CLI
  // binaries (llama-cli, llama-quantize, etc.) are dropped to save ~30 MB.
  const keep = all.filter((p) => {
    const name = p.split("/").pop();
    if (name === "llama-server") return true;
    if (name.endsWith(".dylib")) return true;
    return false;
  });
  await mkdir(VENDOR_DIR, { recursive: true });
  for (const src of keep) {
    const name = src.split("/").pop();
    const dest = join(VENDOR_DIR, name);
    await rename(src, dest);
    if (name === "llama-server") await chmod(dest, 0o755);
  }
}

async function verifyBinary() {
  const bin = join(VENDOR_DIR, "llama-server");
  if (!existsSync(bin)) throw new Error("llama-server not found after extract");
  return new Promise((res, rej) => {
    const p = spawn(bin, ["--version"], { stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("exit", (code) => {
      if (code === 0) {
        console.log("✓ llama-server runs:", out.trim().split("\n")[0]);
        res();
      } else {
        rej(new Error(`llama-server --version failed (${code}): ${out}`));
      }
    });
  });
}

async function main() {
  const tag = await pickRelease();
  console.log(`Vendoring llama.cpp ${tag} for macOS arm64...`);

  const asset = await findAsset(tag);
  console.log(`  asset: ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`);

  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
  const archive = join(TMP_DIR, asset.name);

  console.log("  downloading...");
  await download(asset.browser_download_url, archive);

  console.log("  extracting...");
  if (archive.endsWith(".tar.gz")) {
    await run("tar", ["-xzf", archive, "-C", TMP_DIR]);
  } else {
    await run("unzip", ["-q", archive, "-d", TMP_DIR]);
  }

  if (existsSync(VENDOR_DIR)) {
    await rm(VENDOR_DIR, { recursive: true });
  }
  await flattenIntoBin(TMP_DIR);
  await rm(TMP_DIR, { recursive: true });

  await writeFile(join(VENDOR_DIR, "VERSION"), `${tag}\n`);
  await verifyBinary();

  const files = await readdir(VENDOR_DIR);
  console.log(`\n✓ Vendored to ${VENDOR_DIR}:`);
  for (const f of files) {
    const s = await stat(join(VENDOR_DIR, f));
    console.log(`  ${f}  (${(s.size / 1e6).toFixed(1)} MB)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
