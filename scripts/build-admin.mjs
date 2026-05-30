// Bundle the admin server (and its TypeScript sources) into a single
// CommonJS file that can be spawned by Electron's bundled Node binary.
//
// Native modules (better-sqlite3, sqlite-vec) are kept external — they
// must be reachable via require() and electron-rebuild must have been
// run for the target Electron version.

import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "dist-app", "admin");

// Native modules + heavy CJS deps stay external; everything else is bundled.
const EXTERNALS = [
  "better-sqlite3",
  "sqlite-vec",
  "pdf-parse",
  "@modelcontextprotocol/sdk",
  // express + its plugins are fine to bundle; nothing platform-specific
];

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  // Output as ESM (.mjs) because source uses import.meta and top-level await.
  // Native modules are still ESM-importable via Node's CJS interop.
  await build({
    entryPoints: [resolve(ROOT, "src", "admin.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: resolve(OUT_DIR, "index.mjs"),
    external: EXTERNALS,
    minify: false,
    sourcemap: false,
    logLevel: "info",
    banner: {
      // Polyfill require() for the few CJS-style imports that linger.
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    },
  });

  await build({
    entryPoints: [resolve(ROOT, "src", "server.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: resolve(ROOT, "dist-app", "mcp", "index.mjs"),
    external: EXTERNALS,
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    },
  });

  console.log(`\n✓ Built admin + MCP to ${dirname(OUT_DIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
