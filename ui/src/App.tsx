import { Link, Route, Routes, useLocation, Navigate } from "react-router-dom";
import Home from "./pages/Home.tsx";
import Library from "./pages/Library.tsx";
import Sources from "./pages/Sources.tsx";
import Add from "./pages/Add.tsx";
import Jobs from "./pages/Jobs.tsx";
import Agents from "./pages/Agents.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Settings from "./pages/Settings.tsx";
import { SettingsGearIcon } from "./components/icons.tsx";
import { useJobs } from "./lib/useJobs.ts";
import { GlobalJobIndicator } from "./components/GlobalJobIndicator.tsx";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/library", label: "Library" },
  { to: "/add", label: "Add" },
  { to: "/jobs", label: "Activity" },
  { to: "/agents", label: "AI tools" },
];

function NavLink({ to, label, badge }: { to: string; label: string; badge?: number }) {
  const { pathname } = useLocation();
  const isActive = pathname === to || pathname.startsWith(to + "/");
  return (
    <Link
      to={to}
      className={
        "px-3 py-1.5 rounded text-sm font-medium transition flex items-center gap-1.5 app-no-drag " +
        (isActive ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-200")
      }
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          className={
            "inline-flex items-center justify-center text-[10px] font-bold rounded-full px-1.5 min-w-[1.25rem] " +
            (isActive ? "bg-emerald-400 text-stone-900" : "bg-emerald-500 text-white")
          }
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

export default function App() {
  return (
    <div className="min-h-full flex flex-col">
      <div className="sticky top-0 z-10">
        <header className="border-b border-stone-200 bg-white app-drag">
          {/* main.ts pins the macOS traffic lights at {x:20, y:18}, which
              centers their 12px bullets on y=24. Header is h-12 (48px),
              so its flex-items-center row also centers on y=24. Wordmark
              + nav now sit on the same horizontal axis as the lights. */}
          <div className="max-w-7xl mx-auto pl-[88px] pr-6 h-12 flex items-center gap-6">
            <Link
              to="/"
              className="text-[15px] font-semibold text-stone-900 tracking-tight hover:text-stone-700 transition-colors app-no-drag"
            >
              Bitrove
            </Link>
            <nav className="flex gap-1 app-no-drag">
              {NAV.map((n) => (
                <NavLink key={n.to} {...n} />
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-4 app-no-drag">
              <GlobalJobIndicator />
              <Link
                to="/settings"
                className="text-stone-500 hover:text-stone-900 transition"
                title="Settings"
                aria-label="Settings"
              >
                <SettingsGearIcon size={18} />
              </Link>
              <div className="text-[11px] text-stone-400 tabular-nums font-mono">v{__APP_VERSION__}</div>
            </div>
          </div>
        </header>
      </div>
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/add" element={<Add />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/settings" element={<Settings />} />
          {/* Reachable by URL or contextual link, not in primary nav */}
          <Route path="/sources" element={<Sources />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/dashboard" element={<Dashboard />} />
          {/* Legacy paths */}
          <Route path="/connect" element={<Navigate to="/agents" replace />} />
          <Route path="*" element={<Navigate to="/library" replace />} />
        </Routes>
      </main>
    </div>
  );
}
