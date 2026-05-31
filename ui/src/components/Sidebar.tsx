// Left-rail navigation, modelled after macOS Mail / Notes / Reminders.
// Items are app sections (not document tabs); the active row gets a
// subtle pill background instead of a heavy underline so it reads as
// "where you are" rather than "what you clicked last."
//
// Settings deliberately sits at the bottom — Mac convention reserves
// the corners for less-frequent / settings-like destinations.

import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  BookIcon,
  FolderOpenIcon,
  SettingsGearIcon,
} from "./icons.tsx";

type Item = {
  to: string;
  label: string;
  icon: (props: { size?: number; className?: string }) => ReactNode;
};

const PRIMARY: Item[] = [
  { to: "/dashboard", label: "Dashboard", icon: DashIcon },
  { to: "/library", label: "Library", icon: FolderOpenIcon },
  { to: "/agents", label: "Agents", icon: AgentsIcon },
];

const SECONDARY: Item[] = [
  { to: "/settings", label: "Settings", icon: SettingsGearIcon },
];

function DashIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function AgentsIcon({ size = 16, className }: { size?: number; className?: string }) {
  return <BookIcon size={size} className={className} />;
}

export function Sidebar() {
  const { pathname } = useLocation();

  const renderItem = (item: Item) => {
    const isActive =
      pathname === item.to || pathname.startsWith(item.to + "/");
    return (
      <Link
        key={item.to}
        to={item.to}
        className={
          "group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition app-no-drag " +
          (isActive
            ? "bg-stone-200 text-stone-900 font-medium"
            : "text-stone-700 hover:bg-stone-100")
        }
      >
        <item.icon
          size={15}
          className={isActive ? "text-stone-700" : "text-stone-500 group-hover:text-stone-700"}
        />
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <aside
      className="h-full w-[188px] shrink-0 bg-stone-50 border-r border-stone-200 flex flex-col app-drag"
      // Sidebar surface is drag-enabled by default so the user can grab
      // anywhere empty to move the window — but every interactive child
      // overrides with app-no-drag so clicks aren't swallowed.
    >
      {/* Spacer matching the top-bar height in App.tsx so the traffic
          lights at (16, 13) sit clear of the wordmark below. */}
      <div className="h-10 shrink-0" />

      <div className="px-3 pt-2 pb-4 app-no-drag">
        <Link
          to="/"
          className="block px-1 hover:opacity-70 transition-opacity"
          aria-label="Bitrove"
        >
          <span
            className="text-[24px] font-medium tracking-tight text-stone-900"
            style={{
              // Same editorial serif stack the page titles use, but at
              // ~2/3 the size so the rail wordmark reads as a logo
              // rather than competing with the page hero.
              fontFamily:
                '"New York", "Newsreader", "Lyon Text", "Instrument Serif", Georgia, "Times New Roman", serif',
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            Bitrove
          </span>
        </Link>
      </div>

      <nav className="px-2 flex flex-col gap-0.5 app-no-drag">
        {PRIMARY.map(renderItem)}
      </nav>

      <div className="flex-1" />

      <nav className="px-2 pb-3 flex flex-col gap-0.5 app-no-drag">
        {SECONDARY.map(renderItem)}
      </nav>
    </aside>
  );
}
