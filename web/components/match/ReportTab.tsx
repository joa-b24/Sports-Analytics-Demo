"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { DownloadSimple, FilmStrip, Printer, Plus, Trash } from "@phosphor-icons/react";
import { BinChart, CompareBars, Legend, ZoneMap } from "@/components/charts";
import { GoalFrame } from "@/components/match/GoalFrame";
import { BallBlock, LeftoversList, NetworkBlock, TouchesBlock, coverageText } from "@/components/match/ReportBall";
import { COLORS, Pitch } from "@/components/Pitch";
import { btn, btnPrimary, input } from "@/components/Shell";
import { BIN_MEASURES, type BinMeasure, type Rate, type Tally } from "@/lib/analysis";
import { useFixedParts } from "@/lib/fixed";
import { downloadText } from "@/lib/format";
import { writeLocal } from "@/lib/local";
import { buildReport, clipList, clipsFileName, normalizeReport, reportFileName, type Gate, type Moment, type ReportData, type SetPieceSide, type TransitionRow } from "@/lib/report";
import type { Segment } from "@/lib/segments";
import { mutate, useStore } from "@/lib/store";
import { EVENT_DETAILS, EVENT_OUTCOMES, GOAL, type ManualResult, type Match, type MatchEvent, type Play, type Report } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

type Side = "own" | "opp";

// Draws a ReportData (lib/report.ts): every figure comes from there; the texts are the analyst's.
export function ReportTab({ match, events, plays, segmentsByVideo }: { match: Match; events: MatchEvent[]; plays: Play[]; segmentsByVideo: Record<string, Segment[]> }) {
  const state = useStore();
  const videoIds = matchVideos(match).map((v) => v.video_id);
  const fixed = useFixedParts(match.folder, videoIds);
  const [anon, setAnon] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const report = normalizeReport(match.report);

  const build = (anonymize: boolean) =>
    buildReport({
      match,
      events,
      plays,
      edits: state.edits ?? [],
      segmentsByVideo,
      parts: fixed?.parts ?? [],
      roster: state.roster ?? [],
      library: state.matches.map((m) => ({ match: m, events: state.events.filter((e) => e.match_id === m.match_id) })),
      anonymize,
      now: new Date().toISOString().slice(0, 10),
    });
  const data = useMemo(() => build(false), [match, events, plays, segmentsByVideo, fixed, state.roster, state.matches, state.events, state.edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const setReport = (p: Partial<Report>) =>
    mutate((s) => ({
      ...s,
      matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, report: { ...normalizeReport(m.report), ...p } } : m)),
    }));

  const exportData = async () => {
    const out = build(anon);
    const name = reportFileName(match);
    const text = JSON.stringify(out, null, 1);
    downloadText(name, text, "application/json");
    const ok = match.folder ? await writeLocal(`matches/${match.folder}/${name}`, text) : false;
    setSaved(ok ? `Guardado también en matches/${match.folder}/${name}.` : `Descargado ${name}.`);
  };

  // The clips of the report for `python -m sportsan.clips.cut_clips`: next to the match when the app runs on this
  // computer, otherwise downloaded.
  const exportClips = async () => {
    const name = clipsFileName(match);
    const text = JSON.stringify(clipList(build(true)), null, 1);
    const ok = match.folder ? await writeLocal(`matches/${match.folder}/${name}`, text) : false;
    if (!ok) downloadText(name, text, "application/json");
    setSaved(
      ok
        ? `Lista de clips guardada en matches/${match.folder}/${name}. Para cortarlos: python -m sportsan.clips.cut_clips --match ${match.folder}`
        : `Descargada ${name}: guárdala en la carpeta del partido para cortar los clips.`,
    );
  };

  const A = data.cover.focus_team;
  const closingHint = data.texts.closing.key === "plan" ? "Qué hacer con y sin balón contra este rival." : "Qué salió bien, qué no y qué se trabaja en la semana.";

  return (
    <div className="card mx-auto max-w-4xl space-y-10 md:p-10 print:bg-none print:p-0 print:shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="max-w-md text-sm text-muted">Las cifras salen de tus datos; los textos los escribes tú. Se guarda solo.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Cambia los nombres por el dorsal, para compartir fuera del cuerpo técnico">
            <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
            Sin nombres
          </label>
          <button type="button" className={btn} onClick={() => void exportData()}>
            <DownloadSimple size={15} />
            Exportar datos del reporte
          </button>
          <button type="button" className={btn} onClick={() => void exportClips()} title="Transiciones y jugadas del informe como lista de clips (los editados salen con sus dibujos)">
            <FilmStrip size={15} />
            Exportar lista de clips
          </button>
          <button type="button" className={btnPrimary} onClick={() => window.print()}>
            <Printer size={15} />
            Imprimir / guardar PDF
          </button>
        </div>
        {saved && <p className="w-full text-right text-xs text-faint">{saved}</p>}
      </div>

      <Cover data={data} report={report} setReport={setReport} loading={!!match.folder && fixed === null} />

      <Block title={`Últimos resultados de ${A}`}>
        <Results data={data} report={report} setReport={setReport} />
      </Block>

      <Block title="Resumen del juego">
        <Summary data={data} />
        <TextField value={report.resumen} hint="Sistema de juego, idea general, resultado." onChange={(v) => setReport({ resumen: v })} />
      </Block>

      <Block title="Mapas" pageBreak note={`Cancha con ${A} atacando hacia la derecha.`}>
        <Maps data={data} />
      </Block>

      <Block title="Transiciones" pageBreak>
        <Transitions data={data} />
      </Block>

      <Block title="Balón parado">
        <SetPieces data={data} />
        <TextField value={report.balon_parado} hint="Córners, tiros libres y saques: a favor y en contra." onChange={(v) => setReport({ balon_parado: v })} />
      </Block>

      <Block title="Patrones" gate={data.patterns} />

      <Block title="Jugadoras clave">
        <TextField value={report.jugadoras_clave} hint="Número, posición y qué hacen." onChange={(v) => setReport({ jugadoras_clave: v })} />
        <GateLine gate={data.key_players.touches} />
        {data.key_players.touches.ok && data.summary.ball && (
          <TouchesBlock
            rows={data.key_players.rows}
            team={A}
            other={data.cover.other_team}
            coverage={coverageText(data.summary.ball)}
            print={data.key_players.print}
            onPrint={(v) => setReport({ print_touches: v })}
          />
        )}
      </Block>

      <Block title="Fortalezas, debilidades y plan" pageBreak>
        <h4 className="mt-1 text-base text-ink">Fortalezas</h4>
        <TextField value={report.fortalezas} hint="Qué hacen bien y por dónde generan peligro." onChange={(v) => setReport({ fortalezas: v })} />
        <h4 className="mt-4 text-base text-ink">Debilidades</h4>
        <TextField value={report.debilidades} hint="Dónde pierden el balón, espacios que dejan." onChange={(v) => setReport({ debilidades: v })} />
        <h4 className="mt-4 text-base text-ink">{data.texts.closing.title}</h4>
        <TextField
          value={data.texts.closing.text}
          hint={closingHint}
          onChange={(v) => setReport(data.texts.closing.key === "plan" ? { plan: v } : { conclusiones: v })}
        />
      </Block>

      {data.plays.length > 0 && (
        <Block title="Jugadas para revisar">
          <ul className="space-y-1 text-sm text-ink">
            {data.plays.map((p) => (
              <li key={p.id}>
                <span className="tc">
                  {p.moment.label}–{p.end_label}
                </span>{" "}
                · <strong>{p.title}</strong>
                {p.note && <> · {p.note}</>} · <See m={p.moment} />
              </li>
            ))}
          </ul>
        </Block>
      )}

      <footer className="break-inside-avoid border-t border-line pt-3 text-xs text-faint">
        <div className="mb-1 font-medium text-muted">Método</div>
        <ul className="space-y-0.5">
          {data.method.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {data.summary.ball && <LeftoversList b={data.summary.ball} team={A} other={data.cover.other_team} />}
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- pieces

function Block({ title, note, gate, pageBreak, children }: { title: string; note?: string; gate?: Gate; pageBreak?: boolean; children?: React.ReactNode }) {
  // A section with nothing but its level line is left out of the printout.
  const onlyGate = gate && !gate.ok && !children;
  return (
    <section className={`break-inside-avoid ${pageBreak ? "print:break-before-page" : ""} ${onlyGate ? "print:hidden" : ""}`}>
      <h3 className="text-xl text-ink">
        {title}
      </h3>
      {note && <p className="mt-0.5 text-xs text-faint">{note}</p>}
      <div className="mt-3">
        {gate && <GateLine gate={gate} />}
        {children}
      </div>
    </section>
  );
}

function GateLine({ gate }: { gate: Gate }) {
  if (gate.ok) return null;
  return <p className="text-sm text-faint print:hidden">{gate.need}</p>;
}

function TextField({ value, hint, onChange }: { value: string; hint: string; onChange: (v: string) => void }) {
  return (
    <>
      <textarea className={`${input} mt-2 w-full print:hidden`} rows={4} placeholder={hint} value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="mt-2 hidden text-sm whitespace-pre-wrap text-ink print:block">{value || "—"}</p>
    </>
  );
}

// Link to a moment: its edited clip if there is one (opens in presentation mode); otherwise YouTube when the video has
// a link (it works in the PDF too), otherwise the app's player.
function See({ m, children = "ver" }: { m: Moment; children?: React.ReactNode }) {
  if (m.edit)
    return (
      <Link className="link print:hidden" href={m.edit.app} title="Abre el clip con sus dibujos, en modo presentación">
        {children} (clip editado)
      </Link>
    );
  if (m.youtube)
    return (
      <a className="link" href={m.youtube} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  return (
    <Link className="link print:hidden" href={m.app}>
      {children}
    </Link>
  );
}

const when = (m: Moment) => (m.minute !== null ? `${m.minute}′` : m.label);
const rate = (r: Rate) => (r.n === 0 ? "—" : `${r.k} de ${r.n}`);

function Cover({ data, report, setReport, loading }: { data: ReportData; report: Report; setReport: (p: Partial<Report>) => void; loading: boolean }) {
  const c = data.cover;
  return (
    <header className="border-b border-line pb-5">
      <div className="eyebrow">{c.title}</div>
      <h2 className="mt-1 text-4xl leading-tight text-ink">{c.name}</h2>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-muted">
        <span>
          Equipo analizado: <strong className="text-ink">{c.focus_team}</strong>
        </span>
        <span>Contrario: {c.other_team}</span>
        <span className="tc">{c.date || "sin fecha"}</span>
        <label className="flex items-baseline gap-1.5 print:hidden">
          Jornada
          <input className={`${input} w-28`} value={report.jornada ?? ""} placeholder="p. ej. 3" onChange={(e) => setReport({ jornada: e.target.value })} />
        </label>
        {c.jornada && <span className="hidden print:inline">Jornada {c.jornada}</span>}
      </div>
      {c.score && (
        <div className="mt-4 flex items-baseline gap-3" title="Goles etiquetados de cada equipo">
          <span className="text-sm text-ink-2">{c.focus_team}</span>
          <span className="num text-5xl" style={{ color: COLORS.own }}>
            {c.score.own}
          </span>
          <span className="text-faint">–</span>
          <span className="num text-5xl" style={{ color: COLORS.opp }}>
            {c.score.opp}
          </span>
          <span className="text-sm text-ink-2">{c.other_team}</span>
        </div>
      )}
      <div className="mt-4 text-sm text-ink-2">{c.level.label}</div>
      {c.level.next && <p className="mt-0.5 text-xs text-faint print:hidden">{c.level.next}</p>}
      {loading && <p className="mt-0.5 text-xs text-faint print:hidden">Leyendo el tracking de la carpeta del partido…</p>}
      {c.is_demo && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-900 px-3 py-1.5 text-sm text-warn">
          DATOS DE EJEMPLO: las cifras de este informe son sintéticas y no describen a ningún equipo real.
        </div>
      )}
    </header>
  );
}

// Goals as typed: empty until written, never taken as 0.
type Draft = Omit<ManualResult, "goals_for" | "goals_against"> & { goals_for: string; goals_against: string };
const EMPTY_RESULT: Draft = { date: "", opponent: "", home: true, goals_for: "", goals_against: "", competition: "" };
const goalsOk = (v: string) => /^\d{1,2}$/.test(v.trim());

function Results({ data, report, setReport }: { data: ReportData; report: Report; setReport: (p: Partial<Report>) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_RESULT);
  const manual = report.results_manual ?? [];
  const tone = { V: "text-ok", E: "text-muted", D: "text-danger" } as const;
  const ready = !!draft.date && !!draft.opponent.trim() && goalsOk(draft.goals_for) && goalsOk(draft.goals_against);
  const add = () => {
    if (!ready) return;
    setReport({ results_manual: [...manual, { ...draft, opponent: draft.opponent.trim(), goals_for: Number(draft.goals_for), goals_against: Number(draft.goals_against) }] });
    setDraft(EMPTY_RESULT);
  };
  return (
    <div>
      {data.results.rows.length === 0 ? (
        <p className="text-sm text-faint">Sin resultados: no hay otros partidos de este equipo con eventos en la app ni resultados escritos a mano.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {data.results.rows.map((r, i) => (
              <tr key={`${r.date}-${r.opponent}-${i}`} className="border-b border-line-soft">
                <td className={`num w-8 py-1 text-lg ${tone[r.result]}`}>{r.result}</td>
                <td className="tc py-1 text-faint">{r.date || "sin fecha"}</td>
                <td className="py-1 text-ink">
                  {r.home === null ? "vs" : r.home ? "vs" : "en"} {r.opponent}
                </td>
                <td className="num py-1 text-ink">
                  {r.goals_for}–{r.goals_against}
                </td>
                <td className="py-1 text-xs text-faint">
                  {r.competition}
                  {r.source === "app" ? " (de la app)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-xs text-faint">
        {data.results.total > data.results.rows.length && `Últimos ${data.results.rows.length} de ${data.results.total}. `}
        Los de la app salen de los goles etiquetados; «en» = de visitante.
        {data.results.no_events > 0 && ` ${data.results.no_events} partido(s) de la app sin eventos no cuentan.`}
      </p>
      <details className="mt-3 print:hidden">
        <summary className="cursor-pointer text-xs text-muted">Resultados escritos a mano ({manual.length})</summary>
        <ul className="mt-2 space-y-1 text-xs text-ink-2">
          {manual.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="tc">{r.date}</span> {r.home ? "vs" : "en"} {r.opponent} {r.goals_for}–{r.goals_against} {r.competition}
              <button type="button" className="text-faint hover:text-danger" aria-label="Quitar" onClick={() => setReport({ results_manual: manual.filter((_, j) => j !== i) })}>
                <Trash size={13} />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
          <input className={input} type="date" aria-label="Fecha" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          <input className={`${input} w-36`} placeholder="Rival" value={draft.opponent} onChange={(e) => setDraft({ ...draft, opponent: e.target.value })} />
          <select className={input} aria-label="Local o visitante" value={draft.home ? "home" : "away"} onChange={(e) => setDraft({ ...draft, home: e.target.value === "home" })}>
            <option value="home">Local</option>
            <option value="away">Visitante</option>
          </select>
          <input className={`${input} w-14`} type="number" min={0} aria-label="Goles a favor" value={draft.goals_for} onChange={(e) => setDraft({ ...draft, goals_for: e.target.value })} />
          <span className="pb-2 text-faint">–</span>
          <input className={`${input} w-14`} type="number" min={0} aria-label="Goles en contra" value={draft.goals_against} onChange={(e) => setDraft({ ...draft, goals_against: e.target.value })} />
          <input className={`${input} w-32`} placeholder="Competición" value={draft.competition} onChange={(e) => setDraft({ ...draft, competition: e.target.value })} />
          <button type="button" className={btn} onClick={add} disabled={!ready}>
            <Plus size={13} />
            Añadir
          </button>
        </div>
      </details>
    </div>
  );
}

function Summary({ data }: { data: ReportData }) {
  const [binMin, setBinMin] = useState<"5" | "10">("5");
  const [measure, setMeasure] = useState<BinMeasure>("shots");
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  const box = data.summary.rows.find((r) => r.rate);
  const bins = data.summary.bins[binMin];
  return (
    <div className="space-y-6">
      {data.cover.level.events === 0 ? (
        <p className="text-sm text-faint">Sin eventos etiquetados todavía.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
          <div>
            <CompareBars aLabel={A} bLabel={B} rows={data.summary.rows.map((r) => ({ label: r.label, a: r.own, b: r.opp }))} />
            {box?.rate && (
              <p className="mt-2 text-xs text-faint">
                Entradas al área que acaban en tiro (15 s): {A} {rate(box.rate.own)} · {B} {rate(box.rate.opp)}.
              </p>
            )}
            <div className="mt-2">
              <GateLine gate={data.summary.possession} />
            </div>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 print:hidden">
              <div className="seg">
                {(["5", "10"] as const).map((b) => (
                  <button key={b} type="button" className="seg-opt" aria-pressed={binMin === b} onClick={() => setBinMin(b)}>
                    {b} min
                  </button>
                ))}
              </div>
              <select className={input} value={measure} onChange={(e) => setMeasure(e.target.value as BinMeasure)} aria-label="Qué contar">
                {Object.entries(BIN_MEASURES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-1 text-sm font-medium text-ink">
              {BIN_MEASURES[measure]} cada {binMin} min {bins.basis === "juego" ? "de juego" : "de video"}
            </div>
            <BinChart aLabel={A} bLabel={B} bins={bins.bins.map((x) => ({ label: x.label, a: x.own[measure], b: x.opp[measure] }))} />
            {bins.skipped > 0 && <p className="mt-1 text-xs text-faint">{bins.skipped} evento(s) fuera de los tramos de juego no se cuentan.</p>}
          </div>
        </div>
      )}
      <BallBlock data={data} />
      {data.summary.network ? <NetworkBlock net={data.summary.network} team={A} /> : data.summary.ball && <GateLine gate={data.summary.network_gate} />}
    </div>
  );
}

const sideColor = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);
const OUTCOME_COLOR: Record<string, string> = { shot: "var(--color-ok)", cleared: "var(--color-muted)", play_on: "var(--color-accent-400)" };

function Maps({ data }: { data: ReportData }) {
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  const m = data.maps;
  const goalMarks = m.shots.filter((s) => s.goal_y !== null && s.goal_z !== null);
  const crossLabels = EVENT_OUTCOMES.cross ?? {};
  return (
    <div className="space-y-8">
      <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
        <div className="break-inside-avoid">
          <div className="mb-1 text-sm font-medium text-ink">Tiros</div>
          <Legend
            items={[
              { color: COLORS.own, label: A },
              { color: COLORS.opp, label: B },
              { color: "var(--color-muted)", label: "Gol (relleno)" },
              { color: "var(--color-muted)", label: "Sin gol", hollow: true },
            ]}
          />
          <Pitch className="mt-2">
            {m.shots.map((s) => (
              <circle key={s.id} cx={s.x} cy={s.y} r={1.5} fill={s.goal ? sideColor(s.team) : "var(--color-surface)"} stroke={sideColor(s.team)} strokeWidth={0.55}>
                <title>{`${s.goal ? "Gol" : (EVENT_OUTCOMES.shot?.[s.outcome ?? ""] ?? "Tiro")} · ${s.team === "own" ? A : B} · ${when(s.moment)}${s.player ? ` · ${s.player}` : ""}`}</title>
              </circle>
            ))}
          </Pitch>
          {m.shots_no_pos > 0 && <p className="mt-1 text-xs text-faint">{m.shots_no_pos} tiro(s) sin posición marcada no salen en el mapa.</p>}
        </div>
        <div className="break-inside-avoid">
          <div className="mb-1 text-sm font-medium text-ink">Dónde cruzaron la portería</div>
          {goalMarks.length === 0 ? (
            <p className="text-sm text-faint">Ningún remate con su punto en la portería (se marca en la pasada 3).</p>
          ) : (
            <>
              <GoalFrame marks={goalMarks.map((s) => ({ id: s.id, y: s.goal_y as number, z: s.goal_z as number, color: sideColor(s.team), title: `${s.team === "own" ? A : B} · ${when(s.moment)}` }))} />
              <p className="mt-1 text-xs text-faint">
                {goalMarks.length} de {m.shots.length + m.shots_no_pos} tiros, vistos desde quien remata. Portería de {GOAL.width} m.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
        {(["own", "opp"] as const).map((s) => {
          const arrows = m.crosses.filter((c) => c.team === s);
          const t = m.crosses_outcome[s];
          if (t.total === 0) return null;
          return (
            <div key={s} className="break-inside-avoid">
              <div className="mb-1 text-sm font-medium text-ink">Centros de {s === "own" ? A : B}</div>
              <Legend items={[...Object.entries(crossLabels).map(([k, v]) => ({ color: OUTCOME_COLOR[k], label: `${v} (${t.counts[k] ?? 0})` })), { color: "var(--color-faint)", label: `Sin resultado (${t.unknown})`, hollow: true }]} />
              <Pitch className="mt-2">
                <defs>
                  <marker id={`arrow-${s}`} viewBox="0 0 6 6" refX={5} refY={3} markerWidth={4} markerHeight={4} orient="auto-start-reverse">
                    <path d="M0 0L6 3L0 6z" fill="context-stroke" />
                  </marker>
                </defs>
                {arrows.map((c) => (
                  <line
                    key={c.id}
                    x1={c.x}
                    y1={c.y}
                    x2={c.x_end}
                    y2={c.y_end}
                    stroke={c.outcome ? (OUTCOME_COLOR[c.outcome] ?? "var(--color-faint)") : "var(--color-faint)"}
                    strokeWidth={0.6}
                    strokeDasharray={c.outcome ? undefined : "1.2 0.8"}
                    markerEnd={`url(#arrow-${s})`}
                  >
                    <title>{`${when(c.moment)} · ${c.outcome ? crossLabels[c.outcome] : "sin resultado"}${c.player ? ` · ${c.player}` : ""}`}</title>
                  </line>
                ))}
              </Pitch>
              <p className="mt-1 text-xs text-faint">
                {t.total} centro(s): {arrows.length} en el mapa
                {m.crosses_no_end[s] > 0 && ` · ${m.crosses_no_end[s]} sin destino marcado`}
                {m.crosses_no_pos[s] > 0 && ` · ${m.crosses_no_pos[s]} sin posición`}.
              </p>
            </div>
          );
        })}
      </div>

      {m.duels && (
        <div className="break-inside-avoid">
          <div className="mb-1 text-sm font-medium text-ink">Duelos</div>
          <Legend
            items={[
              { color: COLORS.own, label: `${A}: ${m.duels.won.own} ganados, ${m.duels.lost.own} perdidos` },
              { color: COLORS.opp, label: `${B}: ${m.duels.won.opp} ganados, ${m.duels.lost.opp} perdidos` },
              { color: "var(--color-muted)", label: "Ganado (relleno)" },
              { color: "var(--color-muted)", label: "Perdido", hollow: true },
            ]}
          />
          <Pitch className="mt-2 md:max-w-[60%]">
            {m.duels.points.map((d) => {
              const c = sideColor(d.team);
              const fill = d.outcome === "won" ? c : "var(--color-surface)";
              const title = `${d.team === "own" ? A : B} · ${d.outcome ? EVENT_OUTCOMES.duel?.[d.outcome] : "sin resultado"} · ${d.detail ? EVENT_DETAILS.duel?.[d.detail] : "tipo sin anotar"} · ${when(d.moment)}`;
              // Aerial duels are squares, on the ground circles.
              return d.detail === "aerial" ? (
                <rect key={d.id} x={d.x - 1.3} y={d.y - 1.3} width={2.6} height={2.6} fill={fill} stroke={c} strokeWidth={0.5}>
                  <title>{title}</title>
                </rect>
              ) : (
                <circle key={d.id} cx={d.x} cy={d.y} r={1.4} fill={fill} stroke={c} strokeWidth={0.5}>
                  <title>{title}</title>
                </circle>
              );
            })}
          </Pitch>
          <p className="mt-1 text-xs text-faint">Cuadrado: aéreo · círculo: en el suelo o sin anotar.{m.duels.no_pos > 0 && ` ${m.duels.no_pos} sin posición no salen en el mapa.`}</p>
        </div>
      )}

      <div>
        <div className="mb-1 text-sm font-medium text-ink">Pérdidas y recuperaciones por zona</div>
        <p className="mb-3 text-xs text-faint">5 carriles × 3 tercios. Cada mapa, visto como si ese equipo atacara hacia la derecha (su banda izquierda arriba).</p>
        <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
          {(["own", "opp"] as const).flatMap((s) =>
            (["loss", "recovery"] as const).map((k) => (
              <div key={`${s}-${k}`} className="break-inside-avoid">
                <div className="mb-1 text-xs text-ink-2">
                  {k === "loss" ? "Pérdidas" : "Recuperaciones"} de {s === "own" ? A : B}
                </div>
                <ZoneMap grid={m.zones[k][s].grid} missing={m.zones[k][s].missing} showDirection={false} />
              </div>
            )),
          )}
        </div>
      </div>
    </div>
  );
}

function TransitionList({ rows, empty, what }: { rows: TransitionRow[]; empty: string; what: string }) {
  if (rows.length === 0) return <p className="text-sm text-faint">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm text-ink">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="tc w-10 text-faint">{when(r.moment)}</span>
          <span>
            {what} {r.zone ? <span className="text-ink-2">en {r.zone.toLowerCase()}</span> : <span className="text-faint">sin zona</span>}
            {r.player && <span className="text-faint"> · {r.player}</span>} → {r.goal ? <strong>gol</strong> : "tiro"} a los {r.seconds} s
          </span>
          <See m={r.moment} />
        </li>
      ))}
    </ul>
  );
}

function Transitions({ data }: { data: ReportData }) {
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  return (
    <div className="space-y-6">
      {(["own", "opp"] as const).map((s) => {
        const t = data.transitions[s];
        const me = s === "own" ? A : B;
        const them = s === "own" ? B : A;
        return (
          <div key={s} className="break-inside-avoid">
            <div className="text-sm font-medium text-ink">{me}</div>
            <p className="mt-0.5 text-xs text-faint">
              Pérdidas que acaban en tiro de {them}: {rate(t.loss_to_shot)} · recuperan en menos de 8 s tras perder (contrapresión): {rate(t.counterpress)} ·
              recuperaciones que acaban en tiro propio: {rate(t.recovery_to_shot)}.
            </p>
            <div className="mt-2 grid gap-4 md:grid-cols-2 print:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-ink-2">Pérdida → tiro de {them}</div>
                <TransitionList rows={t.losses} what="Pérdida" empty="Ninguna." />
              </div>
              <div>
                <div className="mb-1 text-xs text-ink-2">Recuperación → tiro de {me}</div>
                <TransitionList rows={t.recoveries} what="Recuperación" empty="Ninguna." />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function tallyText(t: Tally, labels: Record<string, string> | undefined): string {
  if (t.total === 0) return "—";
  const parts = Object.entries(labels ?? {})
    .filter(([k]) => (t.counts[k] ?? 0) > 0)
    .map(([k, v]) => `${v.toLowerCase()} ${t.counts[k]}`);
  if (t.unknown > 0) parts.push(`sin anotar ${t.unknown}`);
  return `${t.total}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function SetPieces({ data }: { data: ReportData }) {
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  const rows: { label: string; get: (s: SetPieceSide) => string }[] = [
    { label: "Córners: resultado", get: (s) => tallyText(s.corners.outcome, EVENT_OUTCOMES.corner) },
    { label: "Córners: envío", get: (s) => tallyText(s.corners.delivery, EVENT_DETAILS.corner) },
    { label: "Tiros libres", get: (s) => tallyText(s.free_kicks, EVENT_OUTCOMES.free_kick) },
    { label: "Saques de meta: salida", get: (s) => tallyText(s.goal_kicks.length, EVENT_DETAILS.goal_kick) },
    { label: "Saques de meta: resultado", get: (s) => tallyText(s.goal_kicks.outcome, EVENT_OUTCOMES.goal_kick) },
    { label: "Penales", get: (s) => (s.penalties.total === 0 ? "—" : `${s.penalties.total} (${s.penalties.scored} gol)`) },
  ];
  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-faint">
            <th className="py-1 font-normal" />
            <th className="py-1 font-normal" style={{ color: COLORS.own }}>
              {A}
            </th>
            <th className="py-1 font-normal" style={{ color: COLORS.opp }}>
              {B}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line-soft">
              <td className="py-1 text-xs text-ink-2">{r.label}</td>
              <td className="py-1 text-ink">{r.get(data.set_pieces.own)}</td>
              <td className="py-1 text-ink">{r.get(data.set_pieces.opp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.set_pieces.plays.length > 0 ? (
        <div>
          <div className="mb-1 text-xs text-ink-2">Jugadas de balón parado guardadas</div>
          <ul className="space-y-1 text-sm text-ink">
            {data.set_pieces.plays.map((p) => (
              <li key={p.id}>
                <span className="tc text-faint">{p.moment.label}</span> · <strong>{p.title}</strong>
                {p.note && <> · {p.note}</>} · <See m={p.moment} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-faint print:hidden">Marca una jugada como «balón parado» en la pestaña Jugadas para que salga aquí.</p>
      )}
    </div>
  );
}
