"use client";

import { ArrowClockwise, CaretDown, Check, FolderOpen } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listLocal, localFile } from "@/lib/local";

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// One button to open a file: a menu with the matching files of a folder of the repository (when the app runs next to
// it) and, last, «Otro archivo…» to take one from anywhere on disk.
export function FilePicker({
  dir,
  pattern,
  label,
  icon,
  accept = ".json",
  onFile,
  current,
  describe,
  warn,
  flag,
  primary = false,
  title,
  subdirs = [],
}: {
  // Folder, repository-relative: "matches/<carpeta>/tracking".
  dir: string;
  pattern: RegExp;
  label: string;
  icon?: React.ReactNode;
  accept?: string;
  onFile: (f: File) => void;
  // Name of the file already open, to mark it.
  current?: string | null;
  // Text shown for each file instead of its name.
  describe?: (name: string) => string;
  // Warning of a file (e.g. «Cambios sin guardar»): an amber dot with the text for screen readers; null: none.
  warn?: (name: string) => string | null;
  // Same warning on the button itself, when some part (maybe not the open one) has it.
  flag?: string | null;
  primary?: boolean;
  title?: string;
  // Subfolders listed too (their files show as "subfolder/name").
  subdirs?: string[];
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // By its text: a regular expression written inline is a new object on every render.
  const source = pattern.source;
  const subKey = subdirs.join("|");
  const refresh = useCallback(async () => {
    const files = await listLocal(dir);
    const re = new RegExp(source);
    if (!files) return setNames(null);
    const own = files.filter((f) => !f.dir && re.test(f.name)).map((f) => f.name).sort(byNumber);
    const extra: string[] = [];
    for (const sd of subKey ? subKey.split("|") : []) {
      // A nested path («revision/quick») needs its first folder to be there.
      if (!files.some((f) => f.dir && f.name === sd.split("/")[0])) continue;
      const inner = (await listLocal(`${dir}/${sd}`)) ?? [];
      extra.push(...inner.filter((f) => !f.dir && re.test(f.name)).map((f) => `${sd}/${f.name}`).sort(byNumber));
    }
    setNames([...own, ...extra]);
  }, [dir, source, subKey]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const pick = async (name: string) => {
    setBusy(true);
    const f = await localFile(`${dir}/${name}`);
    setBusy(false);
    setOpen(false);
    if (f) onFile(f);
  };
  return (
    <div ref={box} className="relative inline-block">
      <button
        type="button"
        className={`${primary ? "btn btn-primary" : "btn"} gap-2`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => {
          // The folder is read each time the menu opens, so a part that just finished shows up.
          if (!open) void refresh();
          setOpen(!open);
        }}
      >
        {icon}
        {busy ? "Cargando…" : label}
        {flag && (
          <span className="flex items-center" title={flag}>
            <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
            <span className="sr-only">{flag}</span>
          </span>
        )}
        <CaretDown size={12} className={`opacity-70 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      {open && (
        <div
          role="menu"
          className="enter absolute left-0 z-40 mt-1.5 w-72 overflow-hidden rounded-2xl bg-raised p-1.5 text-sm shadow-[0_0_0_1px_var(--color-line-strong),0_20px_40px_-16px_rgba(0,0,0,.7)]"
          style={{ "--d": "0ms" } as React.CSSProperties}
        >
          {names !== null && (
            <>
              <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5 text-[11px] text-faint">
                <span className="truncate">{dir.split("/").slice(-2).join("/")}</span>
                <button type="button" className="rounded-md p-0.5 transition-colors hover:text-ink" title="Volver a leer la carpeta" aria-label="Volver a leer la carpeta" onClick={() => void refresh()}>
                  <ArrowClockwise size={12} />
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {names.length === 0 && <div className="px-2.5 py-2 text-xs text-faint">No hay archivos de este tipo en la carpeta.</div>}
                {names.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    title={n}
                    onClick={() => void pick(n)}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-accent/15 hover:text-ink ${
                      n === current ? "text-accent-200" : "text-ink-2"
                    }`}
                  >
                    <span className="grid w-3.5 shrink-0 place-items-center">{n === current && <Check size={12} weight="bold" />}</span>
                    <span className="tc min-w-0 flex-1 truncate">{describe ? describe(n) : n}</span>
                    {warn?.(n) && (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-warn" title={warn(n) ?? ""}>
                        <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
                        <span className="sr-only">{warn(n)}</span>
                        <span aria-hidden>sin guardar</span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="my-1 h-px bg-line-soft" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-ink-2 transition-colors hover:bg-accent/15 hover:text-ink"
            onClick={() => {
              setOpen(false);
              fileInput.current?.click();
            }}
          >
            <FolderOpen size={14} className="shrink-0" />
            Otro archivo…
          </button>
        </div>
      )}
    </div>
  );
}

// "tracks_v1_59940_61738.json" -> "33:20 – 34:20" at `fps`.
export function partLabel(name: string, fps: number): string {
  const m = name.match(/_(\d+)_(\d+)\.json$/);
  if (!m) return name;
  const t = (f: number) => {
    const s = Math.round(f / fps);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return `${t(Number(m[1]))} – ${t(Number(m[2]))}`;
}
