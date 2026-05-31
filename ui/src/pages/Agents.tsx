// Agents — let AI tools see and search your library.
//
// Written for non-developers. The technical setup JSON is hidden behind
// an "advanced" section. The main flow is two big cards:
//   - Claude Code: one-click install.
//   - Other tools: friendly explanation + reveal JSON on demand.

import { useEffect, useState } from "react";
import { api, type ClaudeConfigInfo, type Health } from "../lib/api.ts";

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
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function Agents() {
  const [info, setInfo] = useState<ClaudeConfigInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function load() {
    try {
      const [i, h] = await Promise.all([api.claudeConfig(), api.health()]);
      setInfo(i);
      setHealth(h);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const claudeCode = info?.detected.find((d) => !d.path.includes("claude_desktop_config"));
  const claudeDesktop = info?.detected.find((d) => d.path.includes("claude_desktop_config"));

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
    ? JSON.stringify({ mcpServers: { bitrove: info.suggested } }, null, 2)
    : "";

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="t-display mb-3">AI tools</h1>
      <p className="text-stone-600 text-sm mb-8">
        Let your favourite AI agents read and search your library. Bitrove never sends
        the documents themselves — it just lets the agent ask "what does Liko have
        about X?" and replies with relevant snippets.
      </p>

      {err && (
        <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded text-sm">
          {err}
        </div>
      )}

      {/* ── Local MCP server status ──────────────────────────────── */}
      <section className="mb-8">
        <div className="bg-white rounded-xl border border-stone-200 p-5">
          <div className="mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="font-semibold text-stone-900">Local MCP server</div>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full label-eyebrow bg-emerald-50 text-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Ready
              </span>
            </div>
            <div className="text-sm text-stone-600 mt-1">
              AI agents launch this server on demand and ask it to search your library.
              Nothing runs unless an agent connects.
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <ServiceDot
              label="Search engine"
              detail="Embeddings · port 8765"
              healthy={!!health?.embed}
            />
            <ServiceDot
              label="Relevance ranker"
              detail="Reranker · port 8766"
              healthy={!!health?.rerank}
            />
            <ServiceDot
              label="Library API"
              detail="REST · port 8770"
              healthy={true}
            />
          </div>

          <div className="text-xs text-stone-500">
            Tools available to agents:{" "}
            <code className="bg-stone-100 px-1.5 py-0.5 rounded">search</code>{" "}
            <code className="bg-stone-100 px-1.5 py-0.5 rounded">list_sources</code>{" "}
            <code className="bg-stone-100 px-1.5 py-0.5 rounded">stats</code>
          </div>
        </div>
      </section>

      {/* ── Claude Code ──────────────────────────────────────────── */}
      <section className="mb-6">
        <AppCard
          icon="CC"
          name="Claude Code"
          description="Anthropic's terminal-based assistant. Lets Claude search your library while you work."
          state={
            !claudeCode?.exists
              ? "not-installed"
              : claudeCode.hasBitroveEntry
                ? "connected"
                : "ready-to-connect"
          }
          actionLabel={
            !claudeCode?.exists
              ? "Open install page →"
              : claudeCode.hasBitroveEntry
                ? "Re-install connection"
                : "Connect"
          }
          actionDisabled={busy === claudeCode?.path}
          actionVariant={claudeCode?.hasBitroveEntry ? "secondary" : "primary"}
          onAction={() => {
            if (!claudeCode?.exists) {
              window.open("https://docs.claude.com/en/docs/claude-code/overview", "_blank");
              return;
            }
            install(claudeCode.path);
          }}
          footer={
            claudeCode?.exists ? (
              claudeCode.hasBitroveEntry ? (
                <span className="text-xs text-stone-500">
                  Connected. You may need to restart Claude Code to pick up the change.
                </span>
              ) : (
                <span className="text-xs text-stone-500">
                  We'll edit <code className="bg-stone-100 px-1 rounded">~/.claude.json</code>{" "}
                  to add Bitrove. A backup is created the first time.
                </span>
              )
            ) : null
          }
        />
      </section>

      {/* ── Claude Desktop ───────────────────────────────────────── */}
      {claudeDesktop?.exists && (
        <section className="mb-6">
          <AppCard
            icon="CD"
            name="Claude Desktop"
            description="The Claude app for Mac. Same connection, different config file."
            state={claudeDesktop.hasBitroveEntry ? "connected" : "ready-to-connect"}
            actionLabel={claudeDesktop.hasBitroveEntry ? "Re-install" : "Connect"}
            actionDisabled={busy === claudeDesktop.path}
            actionVariant={claudeDesktop.hasBitroveEntry ? "secondary" : "primary"}
            onAction={() => install(claudeDesktop.path)}
          />
        </section>
      )}

      {/* ── Other ─────────────────────────────────────────────────── */}
      <section className="mb-6">
        <AppCard
          icon={<span className="text-stone-500">+</span>}
          name="Other AI tools"
          description="Any tool that speaks MCP (Codex, Cursor agents, custom apps…) can also talk to Bitrove. Show the technical setup if you need it."
          state="info"
        />
      </section>

      {/* ── Advanced ─────────────────────────────────────────────── */}
      <section>
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-stone-600 hover:text-stone-900 font-medium"
        >
          {showAdvanced ? "Hide" : "Show"} advanced setup
        </button>
        {showAdvanced && info && (
          <div className="mt-4 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-stone-500 mb-1">
                Manual MCP configuration
              </div>
              <p className="text-xs text-stone-500 mb-2">
                Paste this into your client's MCP server list.
              </p>
              <div className="relative">
                <pre className="bg-stone-950 text-stone-100 rounded-lg p-3 overflow-x-auto text-xs font-mono whitespace-pre-wrap leading-relaxed">
                  {mcpJson}
                </pre>
                <div className="absolute top-2 right-2">
                  <CopyButton text={mcpJson} />
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

type AppState = "not-installed" | "ready-to-connect" | "connected" | "info";

function ServiceDot({
  label,
  detail,
  healthy,
}: {
  label: string;
  detail: string;
  healthy: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-stone-50 border border-stone-100">
      <span className="relative inline-block h-2 w-2 shrink-0">
        {healthy && (
          <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-50" />
        )}
        <span
          className={
            "absolute inset-0 rounded-full " +
            (healthy ? "bg-emerald-500" : "bg-stone-400")
          }
        />
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium text-stone-800 truncate">{label}</div>
        <div className="text-[10px] text-stone-500 truncate">{detail}</div>
      </div>
    </div>
  );
}

function AppCard({
  icon,
  name,
  description,
  state,
  actionLabel,
  actionDisabled,
  actionVariant,
  onAction,
  footer,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  state: AppState;
  actionLabel?: string;
  actionDisabled?: boolean;
  actionVariant?: "primary" | "secondary";
  onAction?: () => void;
  footer?: React.ReactNode;
}) {
  const stateLabel: Record<AppState, { text: string; dotClass: string; pillClass: string }> = {
    "not-installed": {
      text: "Not installed",
      dotClass: "bg-stone-400",
      pillClass: "bg-stone-100 text-stone-700",
    },
    "ready-to-connect": {
      text: "Ready to connect",
      dotClass: "bg-amber-500",
      pillClass: "bg-amber-50 text-amber-800",
    },
    connected: {
      text: "Connected",
      dotClass: "bg-emerald-500",
      pillClass: "bg-emerald-50 text-emerald-700",
    },
    info: { text: "", dotClass: "", pillClass: "" },
  };
  const s = stateLabel[state];

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5">
      <div className="flex items-start gap-4">
        <div className="shrink-0 w-10 h-10 rounded-lg bg-stone-100 text-stone-700 flex items-center justify-center font-mono text-sm font-semibold tracking-tight">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-semibold text-stone-900">{name}</div>
            {state !== "info" && (
              <span
                className={
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium " +
                  s.pillClass
                }
              >
                <span className={"w-1.5 h-1.5 rounded-full " + s.dotClass} />
                {s.text}
              </span>
            )}
          </div>
          <div className="text-sm text-stone-600 mt-1">{description}</div>
          {footer && <div className="mt-3">{footer}</div>}
        </div>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            disabled={actionDisabled}
            className={
              "shrink-0 text-sm px-3.5 py-1.5 rounded-md font-medium border disabled:opacity-50 disabled:cursor-not-allowed " +
              (actionVariant === "primary"
                ? "bg-stone-900 text-white border-stone-900 hover:bg-stone-700"
                : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50")
            }
          >
            {actionDisabled ? "…" : actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
