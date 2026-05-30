// Connect AI agents to Bitrove.
// Covers the two paths a non-tech user needs:
//   1. Claude Code — auto-detect ~/.claude.json and one-click install.
//   2. Manual (any MCP / REST client) — show JSON to copy/paste.

import { useEffect, useState } from "react";
import { api, type ClaudeConfigInfo } from "../lib/api.ts";

const REST_BASE = window.location.origin + "/api";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className="text-xs px-2.5 py-1 rounded-md bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 font-medium"
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="bg-stone-50 border border-stone-200 rounded-lg p-3 overflow-x-auto text-xs font-mono text-stone-800 whitespace-pre-wrap">
        {children}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={children} />
      </div>
    </div>
  );
}

export default function Connect() {
  const [info, setInfo] = useState<ClaudeConfigInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setInfo(await api.claudeConfig());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const install = async (path: string) => {
    setBusy(path);
    try {
      await api.installClaudeConfig(path);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const mcpJson = info
    ? JSON.stringify(
        {
          mcpServers: {
            bitrove: info.suggested,
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div>
      <div className="flex items-baseline mb-6">
        <h1 className="text-2xl font-semibold text-stone-900">Connect agents</h1>
        <span className="ml-3 text-stone-500 text-sm">
          Let AI tools search your knowledge base.
        </span>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {/* ── Claude Code ────────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-baseline mb-3">
          <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider">
            Claude Code
          </h2>
          <span className="ml-2 text-xs text-stone-500">
            Recommended for most users
          </span>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
          {info?.detected.map((d) => (
            <div key={d.path} className="px-5 py-4 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-stone-900">
                    {d.path.includes("claude_desktop_config.json") ? "Claude Desktop" : "Claude CLI"}
                  </span>
                  {!d.exists && (
                    <span className="text-[10px] uppercase tracking-wider text-stone-400">
                      not installed
                    </span>
                  )}
                  {d.exists && d.hasBitroveEntry && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      Connected
                    </span>
                  )}
                </div>
                <div className="text-xs text-stone-500 font-mono mt-1 truncate">
                  {d.path.replace(/^\/Users\/[^/]+/, "~")}
                </div>
              </div>
              <button
                onClick={() => install(d.path)}
                disabled={busy === d.path || !d.exists && d.hasBitroveEntry}
                className={
                  "shrink-0 text-xs px-3 py-1.5 rounded-md font-medium border " +
                  (d.exists && d.hasBitroveEntry
                    ? "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                    : "bg-stone-900 text-white border-stone-900 hover:bg-stone-700") +
                  " disabled:opacity-50 disabled:cursor-not-allowed"
                }
              >
                {busy === d.path
                  ? "Installing…"
                  : d.hasBitroveEntry
                    ? "Re-install"
                    : d.exists
                      ? "Install"
                      : "Create + install"}
              </button>
            </div>
          ))}
        </div>

        <p className="text-xs text-stone-500 mt-3 leading-relaxed">
          Bitrove will add itself as an MCP server in the chosen config. Any existing entries
          stay untouched; a <code>.bitrove.bak</code> backup is created on first install.
          You may need to restart Claude Code for the change to take effect.
        </p>
      </section>

      {/* ── Manual (any MCP client) ────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          Other MCP clients
        </h2>
        <p className="text-sm text-stone-600 mb-3">
          Paste this into your client's MCP configuration:
        </p>
        {info && <CodeBlock>{mcpJson}</CodeBlock>}
      </section>

      {/* ── REST API ───────────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-stone-900 uppercase tracking-wider mb-3">
          REST API
        </h2>
        <p className="text-sm text-stone-600 mb-3">
          Any tool that speaks HTTP can use Bitrove via REST. Bound to{" "}
          <code className="text-xs bg-stone-100 px-1 py-0.5 rounded">127.0.0.1</code> only.
        </p>

        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1">
              Semantic search
            </div>
            <CodeBlock>
              {`curl -X POST ${REST_BASE}/sources \\
  -H "content-type: application/json"
# (use the MCP search tool for semantic queries)`}
            </CodeBlock>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1">
              Library stats
            </div>
            <CodeBlock>{`curl ${REST_BASE}/stats`}</CodeBlock>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1">
              List sources
            </div>
            <CodeBlock>{`curl "${REST_BASE}/sources?path_contains=Books&limit=20"`}</CodeBlock>
          </div>
        </div>
      </section>
    </div>
  );
}
