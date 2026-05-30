# Trove

> *Your private knowledge layer for AI agents — everything on your Mac.*

Trove indexes your local documents (PDFs, Word, Markdown) and presents them to
AI tools like Claude Code via MCP and REST — all on-device. Embeddings, search,
and reranking happen locally using open-source models. Nothing is sent to the
cloud.

## What's inside

```
phase0-spikes/demo/
├── electron/         # Electron main process + preload
├── src/              # Admin server, MCP server, ingestion pipeline, classifier
├── ui/               # React renderer (Library / All files / Add / Jobs / Connect)
├── scripts/          # Vendor llama.cpp, build admin bundle
├── electron-builder.yml
└── electron.vite.config.ts
```

## Build from source

Requirements: Node 22+, macOS 14+ (arm64).

```bash
npm install
npm run rebuild              # rebuild better-sqlite3 for Electron's node
npm run vendor:llama         # fetch llama.cpp prebuilt arm64 + dylibs (~54 MB)
npm run app:dist             # build admin + UI + electron + DMG
# → dist-electron/Trove-0.0.1-arm64.dmg
```

## Dev loop

```bash
# 1. Two llama-servers (embedding + reranker) on 8765/8766
llama-server -m models/bge-m3-Q4_K_M.gguf --embedding --pooling cls --port 8765 --batch-size 8192 --ubatch-size 8192 -c 8192 --log-disable &
llama-server -m models/bge-reranker-v2-m3-Q4_K_M.gguf --reranking --port 8766 --batch-size 8192 --ubatch-size 8192 -c 8192 --log-disable &

# 2. Admin server + UI on 8770
npm run ui

# 3. Or launch the Electron shell
npm run electron:dev
```

## Tech stack

| Layer | Tool |
|---|---|
| Embeddings | bge-m3-Q4_K_M (1024d, multilingual) via llama.cpp |
| Reranker | bge-reranker-v2-m3-Q4_K_M |
| Vector store | sqlite-vec |
| MCP / REST | TypeScript, @modelcontextprotocol/sdk, Express |
| UI | React 19, Vite, Tailwind 4 |
| Desktop shell | Electron 41, electron-vite, electron-builder |
| Auto-update | electron-updater (GitHub Releases provider) |

## What gets indexed

| Layer | Extensions | What we store |
|---|---|---|
| Text | PDF / DOCX / DOC / MD / TXT | Full-text chunks + 1024d embeddings |
| Catalog | PPTX / PPT / KEY / EPUB | Filename + path + size + mtime card only |
| Skipped | HTML / images / binaries / `node_modules` / `.venv` / etc. | — |

Smart defaults skip code repos' source files automatically (only `README` and
`docs/` are indexed inside any directory containing `.git`).

## Privacy

- Nothing is sent to the cloud. Embeddings + search + reranking are 100% local.
- Models (`models/`) are fetched once from Hugging Face on first run; they stay
  on your Mac afterwards.
- The index DB (`~/Library/Application Support/Trove/data/index.db`) only
  contains chunks of files you explicitly chose to index.
- This repository is open so anyone can audit those claims.
