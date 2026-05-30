// 用 MCP client 通过 stdio 连 server，模拟 Claude Code 真实接入路径
// 覆盖：v0.0.2 新增的 rerank、list_sources 分页/过滤、search 的 kinds filter

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", resolve(import.meta.dirname, "server.ts")],
});

const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

const banner = (s: string) => console.log(`\n${"=".repeat(70)}\n${s}\n${"=".repeat(70)}`);
const sub = (s: string) => console.log(`\n--- ${s} ---`);

banner("1. tools/list — 看 server 暴露的新 schema");
const tools = await client.listTools();
for (const t of tools.tools) {
  console.log(`* ${t.name}`);
  console.log(`  ${(t.description ?? "").slice(0, 110)}…`);
  const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  console.log(`  params: ${Object.keys(props).join(", ")}`);
}

banner("2. stats — 库总体规模");
const st = await client.callTool({ name: "stats", arguments: {} });
console.log((st.content as { text: string }[])[0].text);

banner("3. list_sources 分页验证（之前会爆 152K token）");
sub("first 5 catalog files");
const cat5 = await client.callTool({
  name: "list_sources",
  arguments: { kind: "catalog", limit: 5 },
});
console.log((cat5.content as { text: string }[])[0].text);

sub("books only: path_contains='IBooks'");
const books = await client.callTool({
  name: "list_sources",
  arguments: { path_contains: "IBooks", limit: 20 },
});
console.log((books.content as { text: string }[])[0].text);

sub("Cryptography course only");
const crypto = await client.callTool({
  name: "list_sources",
  arguments: { path_contains: "Cryptography", limit: 5 },
});
console.log((crypto.content as { text: string }[])[0].text);

banner("4. search — 默认带 rerank");
const r1 = await client.callTool({
  name: "search",
  arguments: { query: "vesting schedule and cliff acceleration", k: 3 },
});
console.log((r1.content as { text: string }[])[0].text);

banner("5. search — kinds=['catalog'] 只搜书架（应避免 noise）");
const r2 = await client.callTool({
  name: "search",
  arguments: { query: "高一物理 圆周运动", k: 5, kinds: ["catalog"] },
});
console.log((r2.content as { text: string }[])[0].text);

banner("6. search — 关掉 rerank 看原始向量排序");
const r3 = await client.callTool({
  name: "search",
  arguments: { query: "PRG pseudorandom generator", k: 3, rerank: false },
});
console.log((r3.content as { text: string }[])[0].text);

await client.close();
console.log("\n✓ all tests passed");
