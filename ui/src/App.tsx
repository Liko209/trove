import { Link, Route, Routes, useLocation } from "react-router-dom";
import Dashboard from "./pages/Dashboard.tsx";
import Library from "./pages/Library.tsx";
import Sources from "./pages/Sources.tsx";
import Add from "./pages/Add.tsx";
import Jobs from "./pages/Jobs.tsx";
import Connect from "./pages/Connect.tsx";
import { useJobs } from "./lib/useJobs.ts";
import { GlobalJobIndicator } from "./components/GlobalJobIndicator.tsx";
import UpdateBanner from "./components/UpdateBanner.tsx";

const NAV = [
  { to: "/", label: "Library" },
  { to: "/sources", label: "All files" },
  { to: "/add", label: "Add" },
  { to: "/jobs", label: "Jobs" },
  { to: "/connect", label: "Connect" },
  { to: "/dashboard", label: "Dashboard" },
];

function NavLink({ to, label, badge }: { to: string; label: string; badge?: number }) {
  const { pathname } = useLocation();
  const isActive =
    to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(to + "/");
  return (
    <Link
      to={to}
      className={
        "px-3 py-1.5 rounded text-sm font-medium transition flex items-center gap-1.5 " +
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
  const { active } = useJobs(3000);
  return (
    <div className="min-h-full flex flex-col">
      <div className="sticky top-0 z-10">
        <UpdateBanner />
      <header className="border-b border-stone-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link to="/" className="font-semibold text-stone-900 tracking-tight hover:text-stone-700 transition-colors">
            Trove
          </Link>
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                {...n}
                badge={n.to === "/jobs" ? active.length : undefined}
              />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <GlobalJobIndicator />
            <div className="text-xs text-stone-500">v0.0.4</div>
          </div>
        </div>
      </header>
      </div>
      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-8">
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/add" element={<Add />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/dashboard" element={<Dashboard />} />
        </Routes>
      </main>
    </div>
  );
}
