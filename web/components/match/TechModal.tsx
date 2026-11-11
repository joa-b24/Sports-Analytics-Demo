"use client";

import { ArrowsIn, ArrowsOut, ListChecks, SlidersHorizontal, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { ProcessesPanel } from "@/components/match/ProcessesPanel";
import { TECH_PAGES, TechPanel, changedPages, type TechPage } from "@/components/match/TechPanel";
import type { Match } from "@/lib/types";

export type TechSection = "params" | "procesos";

// The technical settings and the processes of a match in one dialog, with its sections on the left (as the settings
// of an editor): wide, and it can take the whole window. Opened from the gear of the match.
export function TechModal({ match, section, onSection, onClose }: { match: Match; section: TechSection; onSection: (s: TechSection) => void; onClose: () => void }) {
  const [max, setMax] = useState(false);
  // Page of the settings that is open; «Procesos» is the other mode of the dialog (the page keeps `section` for it).
  const [page, setPage] = useState<TechPage>("posesion");
  const changed = changedPages(match);
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
  const procesos = section === "procesos";
  const current = TECH_PAGES.find((p) => p.id === page) ?? TECH_PAGES[0];
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
            {[...new Set(TECH_PAGES.map((p) => p.group))].map((g) => (
              <div key={g} className="mb-3">
                <div className="eyebrow px-3 pt-1 pb-1">{g}</div>
                {TECH_PAGES.filter((p) => p.group === g).map((p) => {
                  const on = !procesos && p.id === page;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-current={on ? "page" : undefined}
                      onClick={() => {
                        setPage(p.id);
                        onSection("params");
                      }}
                      className={`relative flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${on ? "bg-bg/70 text-ink" : "text-muted hover:bg-bg/40 hover:text-ink"}`}
                    >
                      {on && <i className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-own" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate">{p.label}</span>
                      {changed.has(p.id) && <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--color-warn)" }} title="Tiene valores cambiados" aria-label="con cambios" />}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="mb-3">
              <div className="eyebrow px-3 pt-1 pb-1">Ejecución</div>
              <button
                type="button"
                aria-current={procesos ? "page" : undefined}
                onClick={() => onSection("procesos")}
                className={`relative flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${procesos ? "bg-bg/70 text-ink" : "text-muted hover:bg-bg/40 hover:text-ink"}`}
              >
                {procesos && <i className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-own" aria-hidden />}
                <ListChecks size={15} aria-hidden />
                Procesos
              </button>
            </div>
          </nav>
          <div className="min-h-0 overflow-y-auto p-6">
            <h3 className="font-display mb-1 text-2xl text-ink">{procesos ? "Procesos" : current.label}</h3>
            <p className="mb-4 text-sm text-faint">{procesos ? "Tracking, relleno, balón automático y detección de eventos" : current.hint}</p>
            {procesos ? <ProcessesPanel match={match} /> : <TechPanel match={match} page={current.id} />}
          </div>
        </div>
      </div>
    </div>
  );
}
