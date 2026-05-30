// MCP server (stdio) — 暴露 search / list_sources / stats 工具

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { embedOne } from "./embed.ts";
import { openDb, search, listSources, stats, type ChunkKind, type SearchHit } from "./db.ts";
import { rerank } from "./rerank.ts";

console.error("local-kb MCP server ready (rerank: probed per-request)");

const server = new Server(
  { name: "local-kb", version: "0.0.2" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description:
        "Semantic search over the user's local knowledge base. Two kinds of results: 'text' = excerpts from indexed text documents (PDF/DOCX/DOC/MD/TXT); 'catalog' = bookshelf entries for presentations/books (PPTX/PPT/KEY/EPUB) that record only the file's existence and metadata, not their content. By default retrieves k*4 candidates via vector search then reranks with bge-reranker-v2-m3 for higher precision.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query" },
          k: { type: "number", description: "Number of results (default 5)", default: 5 },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["text", "catalog"] },
            description:
              "Optional filter: 'text' for content excerpts, 'catalog' for file-existence entries, both if omitted",
          },
          rerank: {
            type: "boolean",
            description:
              "Whether to apply reranker (default true). Disable to inspect raw vector search ordering.",
            default: true,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "list_sources",
      description:
        "List indexed source files with pagination and filters. Returns a max of 500 per call (default 50). The DB can hold thousands of sources — always paginate. **Prefer this over `search` for enumeration intents** ('what books do I have', 'which presentations about X', 'list all PDFs in folder Y'). Use kind='catalog' for presentations/books, kind='text' for full-text documents. Use path_contains to scope (e.g. 'IBooks' to list books, 'JHU' to list course files).",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["text", "catalog"] },
          path_prefix: { type: "string", description: "Match source_path starts-with (e.g. '/Users/.../Documents/JHU/')" },
          path_contains: { type: "string", description: "Match source_path contains (e.g. 'Cryptography')" },
          limit: { type: "number", description: "Max rows to return (1-500, default 50)", default: 50 },
          offset: { type: "number", description: "Skip first N (default 0)", default: 0 },
        },
      },
    },
    {
      name: "stats",
      description: "Summary stats of the local knowledge base.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  if (name === "search") {
    const query = String(args.query ?? "");
    const k = Number(args.k ?? 5);
    const kinds = args.kinds as ChunkKind[] | undefined;
    const wantsRerank = args.rerank !== false; // default true

    const vec = await embedOne(query);
    const db = openDb();
    // 想 rerank 时过取候选，失败降级也只用前 k 个
    const candidateK = wantsRerank ? Math.min(k * 4, 50) : k;
    const candidates = search(db, vec, candidateK, kinds);
    db.close();

    let final: (SearchHit & { rerank_score?: number })[] = candidates.slice(0, k);
    let rerankNote = "";
    if (wantsRerank && candidates.length > 1) {
      try {
        const scored = await rerank(query, candidates.map((c) => c.text));
        const byIndex = new Map(scored.map((s) => [s.index, s.score]));
        final = candidates
          .map((c, i) => ({ ...c, rerank_score: byIndex.get(i) ?? -Infinity }))
          .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
          .slice(0, k);
      } catch (e) {
        rerankNote = `\n(rerank unavailable, vector-only results: ${(e as Error).message})\n`;
        console.error(`rerank failed, falling back to vector-only: ${(e as Error).message}`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            rerankNote +
            (final
              .map((h, i) => {
                const score =
                  h.rerank_score !== undefined
                    ? `rerank ${h.rerank_score.toFixed(2)} / dist ${h.distance.toFixed(4)}`
                    : `dist ${h.distance.toFixed(4)}`;
                return `[${i + 1}] [${h.kind}] ${h.source_path}#${h.chunk_index} (${score})\n${h.text}`;
              })
              .join("\n\n---\n\n") || "(no results)"),
        },
      ],
    };
  }

  if (name === "list_sources") {
    const db = openDb();
    const result = listSources(db, {
      kind: args.kind as ChunkKind | undefined,
      path_prefix: args.path_prefix as string | undefined,
      path_contains: args.path_contains as string | undefined,
      limit: args.limit as number | undefined,
      offset: args.offset as number | undefined,
    });
    db.close();
    const header = `total ${result.total}, showing ${result.returned} from offset ${result.offset}`;
    const body =
      result.rows
        .map((s) => `${s.kind.padEnd(8)} ${String(s.chunk_count).padStart(4)}  ${s.source_path}`)
        .join("\n") || "(no matches)";
    return { content: [{ type: "text", text: `${header}\n${body}` }] };
  }

  if (name === "stats") {
    const db = openDb();
    const s = stats(db);
    db.close();
    return {
      content: [
        {
          type: "text",
          text:
            s
              .map((row) => `${row.kind}: ${row.sources} sources, ${row.chunks} chunks`)
              .join("\n") || "(empty)",
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
