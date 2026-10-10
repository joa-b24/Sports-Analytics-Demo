"use client";

import { CompareBars, ShotMap, ZoneMap } from "@/components/charts";
import { btnPrimary, input } from "@/components/Shell";
import { fmtT, youtubeLink } from "@/lib/format";
import { countByType, shotsOf, zoneCounts } from "@/lib/stats";
import { mutate } from "@/lib/store";
import { EVENT_LABELS, type Match, type MatchEvent, type Play, type Report } from "@/lib/types";

const SECTIONS: { key: keyof Report; title: string; hint: string }[] = [
  { key: "resumen", title: "Resumen", hint: "Sistema de juego, idea general, resultado." },
  { key: "fortalezas", title: "Fortalezas", hint: "Qué hacen bien y por dónde generan peligro." },
  { key: "debilidades", title: "Debilidades", hint: "Dónde pierden el balón, espacios que dejan." },
  { key: "balon_parado", title: "Balón parado", hint: "Córners, tiros libres y saques: a favor y en contra." },
  { key: "jugadoras_clave", title: "Jugadoras clave", hint: "Número, posición y qué hacen." },
  { key: "plan", title: "Plan de partido propuesto", hint: "Qué hacer con y sin balón contra este rival." },
];

export function ReportTab({ match, events, plays }: { match: Match; events: MatchEvent[]; plays: Play[] }) {
  const A = match.focus_team;
  const B = match.other_team;
  const a = countByType(events, "own");
  const b = countByType(events, "opp");
  const set = (key: keyof Report, value: string) =>
    mutate((s) => ({
      ...s,
      matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, report: { ...m.report, [key]: value } } : m)),
    }));
  const rec = zoneCounts(events.filter((e) => e.type === "recovery" && e.team === "own"));
  const loss = zoneCounts(events.filter((e) => e.type === "loss" && e.team === "own"));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <p className="text-sm text-slate-600">Las cifras salen de tus eventos; el texto lo escribes tú. Se guarda solo.</p>
        <button type="button" className={btnPrimary} onClick={() => window.print()}>
          Imprimir / guardar PDF
        </button>
      </div>

      <header className="border-b border-slate-300 pb-3">
        <div className="text-xs tracking-wide text-slate-500 uppercase">
          {match.kind === "rival" ? "Informe de rival (análisis previo)" : "Informe post-partido"}
        </div>
        <h2 className="text-2xl font-semibold text-slate-900">{match.name}</h2>
        <div className="text-sm text-slate-600">
          Equipo analizado: <strong>{A}</strong> · Contrario: {B} · Fecha: {match.date || "sin fecha"}
        </div>
        {match.is_demo && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900">
            DATOS DE EJEMPLO: las cifras de este informe son sintéticas y no describen a ningún equipo real.
          </div>
        )}
      </header>

      <section>
        <h3 className="mb-2 text-base font-semibold text-slate-900">Cifras del partido ({events.length} eventos etiquetados)</h3>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">Sin eventos etiquetados todavía.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
            <CompareBars
              aLabel={A}
              bLabel={B}
              rows={[
                { label: "Goles", a: a.goal, b: b.goal },
                { label: "Tiros (con goles)", a: shotsOf(events, "own").length, b: shotsOf(events, "opp").length },
                { label: "Recuperaciones", a: a.recovery, b: b.recovery },
                { label: "Pérdidas", a: a.loss, b: b.loss },
                { label: "Córners", a: a.corner, b: b.corner },
                { label: "Faltas", a: a.foul, b: b.foul },
              ]}
            />
            <ShotMap events={events} aLabel={A} bLabel={B} />
            <div>
              <div className="mb-1 text-sm font-medium text-slate-800">Recuperaciones de {A} por zona</div>
              <ZoneMap grid={rec.grid} missing={rec.missing} />
            </div>
            <div>
              <div className="mb-1 text-sm font-medium text-slate-800">Pérdidas de {A} por zona</div>
              <ZoneMap grid={loss.grid} missing={loss.missing} />
            </div>
          </div>
        )}
      </section>

      {SECTIONS.map((s) => (
        <section key={s.key} className="break-inside-avoid">
          <h3 className="text-base font-semibold text-slate-900">{s.title}</h3>
          <textarea
            className={`${input} mt-1 w-full print:hidden`}
            rows={4}
            placeholder={s.hint}
            value={match.report[s.key]}
            onChange={(e) => set(s.key, e.target.value)}
          />
          <p className="hidden text-sm whitespace-pre-wrap text-slate-800 print:block">{match.report[s.key] || "—"}</p>
        </section>
      ))}

      {plays.length > 0 && (
        <section className="break-inside-avoid">
          <h3 className="mb-1 text-base font-semibold text-slate-900">Jugadas para revisar</h3>
          <ul className="space-y-1 text-sm text-slate-800">
            {plays.map((p) => (
              <li key={p.play_id}>
                <span className="font-mono tabular-nums">
                  {fmtT(p.t_start)}–{fmtT(p.t_end)}
                </span>{" "}
                · <strong>{p.title}</strong>
                {p.note && <> · {p.note}</>}
                {match.youtube_id && (
                  <>
                    {" "}
                    ·{" "}
                    <a className="text-blue-700 underline" href={youtubeLink(match.youtube_id, p.t_start)} target="_blank" rel="noreferrer">
                      ver en YouTube
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="border-t border-slate-200 pt-2 text-xs text-slate-500">
        Método: eventos etiquetados manualmente sobre el video ({Object.values(EVENT_LABELS).length} tipos). Las posiciones son las marcadas
        por la analista; los eventos sin posición no aparecen en los mapas.
      </footer>
    </div>
  );
}
