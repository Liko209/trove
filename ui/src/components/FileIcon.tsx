// Color-coded file-type icon — uses Tailwind palette
// Buckets: pdf / word / spreadsheet / slide / book / markdown / text / other

export type FileBucket =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "slide"
  | "book"
  | "markdown"
  | "text"
  | "other";

const STYLE: Record<FileBucket, { bg: string; label: string; text: string }> = {
  pdf:         { bg: "bg-rose-500",    text: "text-white", label: "PDF" },
  word:        { bg: "bg-sky-600",     text: "text-white", label: "W"   },
  spreadsheet: { bg: "bg-emerald-600", text: "text-white", label: "X"   },
  slide:       { bg: "bg-orange-500",  text: "text-white", label: "P"   },
  book:        { bg: "bg-violet-600",  text: "text-white", label: "EP"  },
  markdown:    { bg: "bg-stone-700",   text: "text-white", label: "MD"  },
  text:        { bg: "bg-stone-500",   text: "text-white", label: "TXT" },
  other:       { bg: "bg-stone-400",   text: "text-white", label: "·"   },
};

export function FileIcon({ bucket, size = 28 }: { bucket: FileBucket; size?: number }) {
  const s = STYLE[bucket] ?? STYLE.other;
  const fontSize = Math.max(8, Math.round(size * 0.36));
  return (
    <span
      className={`inline-flex items-center justify-center rounded ${s.bg} ${s.text} font-semibold shrink-0`}
      style={{ width: size, height: size, fontSize }}
    >
      {s.label}
    </span>
  );
}
