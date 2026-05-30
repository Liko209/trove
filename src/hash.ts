// xxh3-64 content hashing for incremental indexing + Strategy A dedup.
//
// Why xxh3, not MD5/SHA: MD5/SHA are crypto hashes — slow and the wrong
// tool for change detection. xxh3 is ~30x faster, collision-safe at this
// scale (we're not deduping against an adversary), and is what every
// modern dedup tool (rsync 3+, ZFS, Borg, restic, …) uses.
//
// Why xxhash-wasm and not @node-rs/xxhash: avoids adding another native
// module to the electron-builder packaging matrix. wasm gives us ~500
// MB/s which is plenty since hashing is only the L2 fallback path —
// 99% of incremental scans short-circuit on (mtime, size).

import xxhash from "xxhash-wasm";
import { createReadStream } from "node:fs";

type XXH = Awaited<ReturnType<typeof xxhash>>;

let cached: XXH | null = null;
async function getXxh(): Promise<XXH> {
  if (!cached) cached = await xxhash();
  return cached;
}

// Hash the full file content as xxh3-64, returned as 16-char hex. Stream
// in 1 MiB chunks so we don't slurp giant PDFs / ePubs into memory.
export async function hashFile(path: string): Promise<string> {
  const xxh = await getXxh();
  const state = xxh.create64();
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { highWaterMark: 1024 * 1024 });
    s.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      state.update(buf);
    });
    s.on("end", () => resolve());
    s.on("error", (e) => reject(e));
  });
  return state.digest().toString(16).padStart(16, "0");
}

export async function hashString(s: string): Promise<string> {
  const xxh = await getXxh();
  return xxh.h64(s).toString(16).padStart(16, "0");
}
