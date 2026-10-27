"use client";

import { useState } from "react";
import { fmtHms, parseHms } from "@/lib/segments";
import { fullWindows, withFullMark, withoutFull } from "@/lib/videos";
import type { FullVideoMarks as Marks, MatchVideo } from "@/lib/types";

const MARKS: { key: keyof Marks; label: string }[] = [
  { key: "h1_start", label: "Inicio del 1.er tiempo" },
  { key: "h1_end", label: "Fin del 1.er tiempo" },
  { key: "h2_start", label: "Inicio del 2.º tiempo" },
  { key: "h2_end", label: "Fin del 2.º tiempo" },
];

// «Partido completo» of a video (Configuración del partido): both halves come in this one video, so the four times
// where each half starts and ends are marked here (in the seconds of the video; saved in the video, not in segments.csv).
export function FullVideoMarks({ video, now, onChange }: { video: MatchVideo; now: number; onChange: (v: MatchVideo) => void }) {
  const full = !!video.full;
  const [draft, setDraft] = useState<Partial<Record<keyof Marks, string>>>({});
  const ok = fullWindows(video) !== null;
  return (
    <div className="space-y-1.5">
      <label className="flex items-start gap-2 text-xs text-muted" title="El video trae los dos tiempos juntos (una transmisión): hay que marcar dónde empieza y termina cada uno">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={full}
          onChange={(e) => onChange(e.target.checked ? { ...video, full: video.full ?? {} } : withoutFull(video))}
        />
        <span>
          Partido completo (los dos tiempos en este video)
          <span className="mt-0.5 block text-[11px] text-faint">Por defecto: no, el video es un solo tiempo.</span>
        </span>
      </label>
      {full && (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {MARKS.map(({ key, label }) => {
            const v = video.full?.[key];
            const shown = draft[key] ?? (v === undefined ? "" : fmtHms(v));
            const bad = draft[key] !== undefined && draft[key] !== "" && parseHms(draft[key] as string) === null;
            return (
              <div key={key} className="text-[11px] text-faint">
                <span className="block">{label}</span>
                <span className="mt-0.5 flex items-center gap-1">
                  <input
                    className={`input tc w-24 ${bad ? "border-danger" : ""}`}
                    placeholder="hh:mm:ss"
                    aria-label={label}
                    value={shown}
                    onChange={(e) => {
                      const t = e.target.value;
                      setDraft((d) => ({ ...d, [key]: t }));
                      const n = parseHms(t);
                      if (t.trim() === "") onChange(withFullMark(video, key, undefined));
                      else if (n !== null && n >= 0) onChange(withFullMark(video, key, n));
                    }}
                    onBlur={() => setDraft((d) => ({ ...d, [key]: undefined }))}
                  />
                  <button type="button" className="btn btn-ghost !px-2 text-xs" title="Usar el instante del video que se está viendo" onClick={() => onChange(withFullMark(video, key, Math.round(now * 10) / 10))}>
                    Aquí
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {full && !ok && <p className="m-0 text-[11px] text-warn">Faltan marcas o no van en orden: mientras tanto el video se lee como un solo tiempo.</p>}
    </div>
  );
}
