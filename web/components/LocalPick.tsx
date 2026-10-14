"use client";

import { ArrowClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { listLocal, localFile } from "@/lib/local";

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// Choose a file of a folder of the repository instead of looking for it on disk. Renders nothing when the files are
// not reachable (the app is not running next to the repository), so the usual file button stays as the only way.
export function LocalPick({
  dir,
  pattern,
  label,
  onFile,
  current,
  describe,
}: {
  // Folder, repository-relative: "matches/<carpeta>/tracking".
  dir: string;
  pattern: RegExp;
  label: string;
  onFile: (f: File) => void;
  // Name of the file already open, to mark it.
  current?: string | null;
  // Text shown for each file instead of its name.
  describe?: (name: string) => string;
}) {
  const [names, setNames] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // By its text: a regular expression written inline is a new object on every render.
  const source = pattern.source;
  const refresh = useCallback(async () => {
    const files = await listLocal(dir);
    const re = new RegExp(source);
    setNames(files ? files.filter((f) => !f.dir && re.test(f.name)).map((f) => f.name).sort(byNumber) : null);
  }, [dir, source]);
  useEffect(() => {
    let live = true;
    const re = new RegExp(source);
    void listLocal(dir).then((files) => live && setNames(files ? files.filter((f) => !f.dir && re.test(f.name)).map((f) => f.name).sort(byNumber) : null));
    return () => {
      live = false;
    };
  }, [dir, source]);
  if (names === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        className="chip-select"
        aria-label={label}
        value=""
        disabled={busy || names.length === 0}
        onChange={async (e) => {
          const name = e.target.value;
          if (!name) return;
          setBusy(true);
          const f = await localFile(`${dir}/${name}`);
          setBusy(false);
          if (f) onFile(f);
        }}
      >
        <option value="">{busy ? "Cargando…" : names.length === 0 ? `${label}: no hay archivos` : `${label} (${names.length})`}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n === current ? "● " : ""}
            {describe ? describe(n) : n}
          </option>
        ))}
      </select>
      <button type="button" className="text-faint transition-colors hover:text-ink" title="Volver a leer la carpeta" aria-label="Volver a leer la carpeta" onClick={() => void refresh()}>
        <ArrowClockwise size={13} />
      </button>
    </span>
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
