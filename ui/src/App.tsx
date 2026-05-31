import { Route, Routes, Navigate } from "react-router-dom";
import Library from "./pages/Library.tsx";
import Sources from "./pages/Sources.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import ScanConfigure from "./pages/ScanConfigure.tsx";
import JobDetail from "./pages/JobDetail.tsx";
import Jobs from "./pages/Jobs.tsx";
import Agents from "./pages/Agents.tsx";
import Settings from "./pages/Settings.tsx";
import { GlobalJobIndicator } from "./components/GlobalJobIndicator.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { UpdateIndicator } from "./components/UpdateIndicator.tsx";

// Native-feeling macOS layout:
//
//   ┌─ Top bar (h-10, drag) ──────────[GlobalJob][Update][v] ┐
//   ├── Sidebar 220px ──┬── Main (flex-1, scrollable) ───────┤
//   │                   │                                    │
//   │  Bitrove          │   <Page>                           │
//   │  Dashboard        │                                    │
//   │  Library          │                                    │
//   │  Agents           │                                    │
//   │  ──────           │                                    │
//   │  Settings         │                                    │
//   └───────────────────┴────────────────────────────────────┘
//
// Top bar is intentionally thin — it exists to host the traffic-light
// drag region and the right-side indicators, not to compete with the
// sidebar as a navigation surface. Settings sits at the foot of the
// sidebar following macOS HIG conventions for less-frequent
// destinations (Mail/Notes/Reminders do the same).

export default function App() {
  return (
    <div className="h-screen flex flex-col bg-stone-50 overflow-hidden">
      <header className="h-10 shrink-0 border-b border-stone-200 bg-white/60 backdrop-blur app-drag flex items-center pl-[88px] pr-3 gap-3">
        <div className="ml-auto flex items-center gap-2 app-no-drag">
          <GlobalJobIndicator />
          <UpdateIndicator />
          <span className="text-[10px] text-stone-400 tabular-nums font-mono">
            v{__APP_VERSION__}
          </span>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="px-8 py-8">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/library" element={<Library />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/add/scan" element={<ScanConfigure />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/jobs/:id" element={<JobDetail />} />
              <Route path="/add" element={<Navigate to="/dashboard" replace />} />
              <Route path="/connect" element={<Navigate to="/agents" replace />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}
