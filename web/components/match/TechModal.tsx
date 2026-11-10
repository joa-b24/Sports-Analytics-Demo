"use client";

import { ArrowsIn, ArrowsOut, ListChecks, SlidersHorizontal, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { ProcessesPanel } from "@/components/match/ProcessesPanel";
import { TechPanel } from "@/components/match/TechPanel";
import type { Match } from "@/lib/types";

export type TechSection = "params" | "procesos";
const SECTIONS: { id: TechSection; label: string; hint: string; icon: typeof ListChecks }[] = [
  { id: "params", label: "Parámetros de cálculo", hint: "Posesión, bloque y demás umbrales del partido", icon: SlidersHorizontal },
  { id: "procesos", label: "Procesos", hint: "Tracking, relleno, balón automático y detección de eventos", icon: ListChecks },
];

// The technical settings and the processes of a match in one dialog, with its sections on the left (as the settings
// of an editor): wide, and it can take the whole window. Opened from the gear of the match.
export function TechModal({ match, section, onSection, onClose }: { match: Match; section: TechSection; onSection: (s: TechSection) => void; onClose: () => void }) {
  const [max, setMax] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Configuración técnica del partido"
        onClick={(e) => e.stopPropagation()}
        className={`enter flex flex-col overflow-hidden rounded-lg bg-raised shadow-[0_0_0_1px_var(--color-line-strong),0_30px_60px_-20px_rgba(0,0,0,.8)] ${
          max ? "h-[calc(100vh-2rem)] w-[calc(100vw-2rem)]" : "h-[min(46rem,88vh)] w-[min(72rem,94vw)]"
        }`}
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <SlidersHorizontal size={18} className="text-faint" aria-hidden />
          <h2 className="m-0 min-w-0 flex-1 truncate text-base text-ink">
            Configuración técnica <span className="text-faint">· {match.name}</span>
          </h2>
          <button type="button" className="btn h-8 w-8 !p-0" aria-label={max ? "Restaurar el tamaño" : "Maximizar"} title={max ? "Restaurar el tamaño" : "Maximizar"} onClick={() => setMax((m) => !m)}>
            {max ? <ArrowsIn size={15} /> : <ArrowsOut size={15} />}
          </button>
          <button type="button" className="btn h-8 w-8 !p-0" aria-label="Cerrar" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[13.5rem_minmax(0,1fr)]">
          <nav aria-label="Secciones" className="overflow-y-auto border-r border-line p-2">
            {SECTIONS.map((s) => {
              const I = s.icon;
              const on = s.id === current.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => onSection(s.id)}
                  className={`relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${on ? "bg-bg/70 text-ink" : "text-muted hover:bg-bg/40 hover:text-ink"}`}
                >
                  {on && <i className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-own" aria-hidden />}
                  <I size={16} weight={on ? "fill" : "regular"} aria-hidden />
                  {s.label}
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 overflow-y-auto p-6">
            <h3 className="font-display mb-1 text-2xl text-ink">{current.label}</h3>
            <p className="mb-5 text-sm text-faint">{current.hint}</p>
            {current.id === "params" ? <TechPanel match={match} /> : <ProcessesPanel match={match} />}
          </div>
        </div>
      </div>
    </div>
  );
}
