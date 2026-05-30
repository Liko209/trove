// 智能目录遍历 — 共用给 scan.ts 和 admin.ts
//
// 主要规则:
// 1. 跳过隐藏文件 / iCloud placeholder (*.icloud)
// 2. 跳过命中 excludes substring 的路径
// 3. **Git 仓库感知**: 检测到 .git 目录的子树视为代码仓库,在仓库内只保留:
//    - 顶层 README / CHANGELOG / CONTRIBUTING / LICENSE 等说明文件
//    - docs/ 或 doc/ 或 documentation/ 路径下的 .md/.txt/.rst/.adoc
//    其他全部跳过(源码、data/、test/、生成物等都不是"知识")

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type WalkOpts = { excludes: string[] };

const HIDDEN_NAME = /^\./;
const PLACEHOLDER = /\.icloud$/i;

// 顶层说明类文件 (allow inside git repos)
const REPO_TOPLEVEL_DOC = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE|AUTHORS|CODE_OF_CONDUCT|SECURITY)(\.[A-Za-z]+)?$/i;
// 文档目录
const REPO_DOC_PATH = /^(docs?|documentation)\//i;
const REPO_DOC_FILE_EXT = /\.(md|markdown|txt|rst|adoc)$/i;

function isExcluded(absPath: string, excludes: string[]): boolean {
  for (const e of excludes) if (absPath.includes(e)) return true;
  return false;
}

function isRepoAllowed(absPath: string, repoRoot: string): boolean {
  const rel = absPath.slice(repoRoot.length).replace(/^\/+/, "");
  // 顶层 README / CHANGELOG 等
  if (REPO_TOPLEVEL_DOC.test(rel)) return true;
  // docs 路径下的文档
  if (REPO_DOC_PATH.test(rel) && REPO_DOC_FILE_EXT.test(rel)) return true;
  return false;
}

export async function* walkSmart(
  root: string,
  opts: WalkOpts,
  inheritedRepoRoot?: string,
): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  // 当前目录是不是新的 git repo 根
  const hasDotGit = entries.some((e) => e.name === ".git" && e.isDirectory());
  const currentRepoRoot = hasDotGit ? root : inheritedRepoRoot;

  for (const e of entries) {
    if (HIDDEN_NAME.test(e.name)) continue;
    const full = join(root, e.name);
    if (isExcluded(full, opts.excludes)) continue;
    if (e.isDirectory()) {
      yield* walkSmart(full, opts, currentRepoRoot);
    } else if (e.isFile()) {
      if (PLACEHOLDER.test(e.name)) continue;
      if (currentRepoRoot && !isRepoAllowed(full, currentRepoRoot)) continue;
      yield full;
    }
  }
}
