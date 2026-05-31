// Inline SVG icon set used in place of emojis. Phosphor-Bold-style:
// 1.75px stroke, rounded joints, square caps off, currentColor stroke so
// callers control color via Tailwind text-* utilities.
//
// Keep these tiny and structurally consistent — same viewBox, same stroke
// width, same visual weight. If the set grows past ~12 icons we should
// switch to a real icon library (Phosphor Icons React or Radix).

type IconProps = {
  size?: number;
  className?: string;
};

const base = (size: number, className: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
});

export function CloudIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6.5 6.5 0 0 0 4 12a4 4 0 0 0 1 7.87h12.5z" />
    </svg>
  );
}

export function FolderIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

export function FolderOpenIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z" />
      <path d="M3 9h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" />
    </svg>
  );
}

export function DesktopIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function DownloadIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 4v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function FileIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

export function BookIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5z" />
      <path d="M8 7h7" />
      <path d="M8 11h7" />
    </svg>
  );
}

export function PaperclipIcon({ size = 20, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M21 11.5L12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5" />
    </svg>
  );
}

// Disclosure chevron used for tree expand/collapse. Rotates 90deg via
// CSS when the parent is expanded; the icon itself draws pointing
// right.
export function ChevronRightIcon({ size = 12, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)} strokeWidth={2.5}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function SettingsGearIcon({ size = 18, className = "" }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.97 1.29 1.6 2.31 1.51H22a2 2 0 0 1 0 4h-.09c-1.02 0-1.95.54-2.51 1z" />
    </svg>
  );
}
