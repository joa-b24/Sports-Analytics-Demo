"use client";

import { CompareBars, ShotMap, ZoneMap } from "@/components/charts";
import { Printer } from "@phosphor-icons/react";
import { btnPrimary, input } from "@/components/Shell";
import { fmtT, youtubeLink } from "@/lib/format";
import { countByType, shotsOf, zoneCounts } from "@/lib/stats";
import { mutate } from "@/lib/store";
import { matchVideos, videoOf } from "@/lib/videos";
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
  const videos = matchVideos(match);
  const set = (key: keyof Report, value: string) =>
    mutate((s) => ({
      ...s,
      matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, report: { ...m.report, [key]: value } } : m)),
    }));
  const rec = zoneCounts(events.filter((e) => e.type === "recovery" && e.team === "own"));
  const loss = zoneCounts(events.filter((e) => e.type === "loss" && e.team === "own"));

  return (
    <div className="card mx-auto max-w-4xl space-y-8 md:p-10 print:bg-none print:p-0 print:shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted">Las cifras salen de tus eventos; el texto lo escribes tú. Se guarda solo.</p>
        <button type="button" className={btnPrimary} onClick={() => window.print()}>
          <Printer size={15} />
          Imprimir / guardar PDF
        </button>
      </div>

      <header className="border-b border-line pb-4">
        <div className="eyebrow">
          {match.kind === "rival" ? "Informe de rival (análisis previo)" : match.kind === "reference" ? "Informe de video de referencia" : "Informe post-partido"}
        </div>
        <h2 className="mt-1 text-4xl leading-tight text-ink">{match.name}</h2>
        <div className="mt-2 text-sm text-muted">
          Equipo analizado: <strong>{A}</strong> · Contrario: {B} · Fecha: {match.date || "sin fecha"}
        </div>
        {match.is_demo && (
          <div className="mt-3 rounded-xl border border-warn/40 bg-warn-900 px-3 py-1.5 text-sm text-warn">
            DATOS DE EJEMPLO: las cifras de este informe son sintéticas y no describen a ningún equipo real.
          </div>
        )}
      </header>

      <section>
        <h3 className="mb-2 text-xl text-ink">Cifras del partido ({events.length} eventos etiquetados)</h3>
        {events.length === 0 ? (
          <p className="text-sm text-faint">Sin eventos etiquetados todavía.</p>
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
              <div className="mb-1 text-sm font-medium text-ink">Recuperaciones de {A} por zona</div>
              <ZoneMap grid={rec.grid} missing={rec.missing} />
            </div>
            <div>
              <div className="mb-1 text-sm font-medium text-ink">Pérdidas de {A} por zona</div>
              <ZoneMap grid={loss.grid} missing={loss.missing} />
            </div>
          </div>
        )}
      </section>

      {SECTIONS.map((s) => (
        <section key={s.key} className="break-inside-avoid">
          <h3 className="text-xl text-ink">{s.title}</h3>
          <textarea
            className={`${input} mt-1 w-full print:hidden`}
            rows={4}
            placeholder={s.hint}
            value={match.report[s.key]}
            onChange={(e) => set(s.key, e.target.value)}
          />
          <p className="hidden text-sm whitespace-pre-wrap text-ink print:block">{match.report[s.key] || "—"}</p>
        </section>
      ))}

      {plays.length > 0 && (
        <section className="break-inside-avoid">
          <h3 className="mb-1 text-xl text-ink">Jugadas para revisar</h3>
          <ul className="space-y-1 text-sm text-ink">
            {plays.map((p) => {
              const video = videos.find((v) => v.video_id === videoOf(p));
              return (
              <li key={p.play_id}>
                {videos.length > 1 && <span className="text-faint">{video?.label ?? videoOf(p)} · </span>}
                <span className="tc">
                  {fmtT(p.t_start)}–{fmtT(p.t_end)}
                </span>{" "}
                · <strong>{p.title}</strong>
                {p.note && <> · {p.note}</>}
                {video?.youtube_id && (
                  <>
                    {" "}
                    ·{" "}
                    <a className="link" href={youtubeLink(video.youtube_id, p.t_start)} target="_blank" rel="noreferrer">
                      ver en YouTube
                    </a>
                  </>
                )}
              </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="border-t border-line pt-3 text-xs text-faint">
        Método: eventos etiquetados manualmente sobre el video ({Object.values(EVENT_LABELS).length} tipos). Las posiciones son las marcadas
        por la analista; los eventos sin posición no aparecen en los mapas.
      </footer>
    </div>
  );
}
