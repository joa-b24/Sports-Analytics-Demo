"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DownloadSimple, FilmStrip, PencilSimple, Printer, Plus, Trash } from "@phosphor-icons/react";
import { BinChart, Legend, MirrorBars, ZoneMap } from "@/components/charts";
import { GoalFrame } from "@/components/match/GoalFrame";
import { BallBlock, LeftoversList, NetworkBlock, TouchesBlock, coverageText } from "@/components/match/ReportBall";
import { FigureRow, PassMapSection, PhysicalSection, SectionsEditor, StatList, TeamBlockSection } from "@/components/match/ReportExtra";
import { COLORS, Pitch } from "@/components/Pitch";
import { btn, btnPrimary, input } from "@/components/Shell";
import { BIN_MEASURES, type BinMeasure, type Rate, type Tally } from "@/lib/analysis";
import { useFixedParts } from "@/lib/fixed";
import { passNetwork } from "@/lib/positions";
import { NEED_TEXT, layoutOf, sectionDef, type SectionNeed } from "@/lib/reportSections";
import { downloadText } from "@/lib/format";
import { writeLocal } from "@/lib/local";
import { possessionCover } from "@/lib/playgroundHealth";
import { buildReport, clipList, clipsFileName, normalizeReport, reportFileName, type Gate, type Moment, type ReportData, type SetPieceSide, type TransitionRow } from "@/lib/report";
import type { Segment } from "@/lib/segments";
import { mutate, setPref, usePref, useStore } from "@/lib/store";
import { EVENT_DETAILS, EVENT_OUTCOMES, GOAL, type ManualResult, type Match, type MatchEvent, type Play, type Report } from "@/lib/types";
import { matchVideos } from "@/lib/videos";
import { setPaper, type Paper } from "@/lib/print";

type Side = "own" | "opp";

// Draws a ReportData (lib/report.ts): every figure comes from there; the texts are the analyst's.
export function ReportTab({ match, events, plays, segmentsByVideo }: { match: Match; events: MatchEvent[]; plays: Play[]; segmentsByVideo: Record<string, Segment[]> }) {
  const state = useStore();
  const videoIds = matchVideos(match).map((v) => v.video_id);
  const fixed = useFixedParts(match.folder, videoIds);
  const [anon, setAnon] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const report = normalizeReport(match.report);
  // The PDF keeps the app's colours unless white paper is chosen; it applies to Ctrl+P too while the report is open.
  const paper = usePref("report:paper", "app") as Paper;
  useEffect(() => {
    setPaper(paper);
    return () => setPaper(null);
  }, [paper]);

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

  // The possession goes into the match too, for its summary in the match list.
  const poss = data.summary.ball?.possession;
  useEffect(() => {
    if (!poss) return;
    const det = data.summary.ball?.possession_detail;
    const next = { own: poss.own, opp: poss.opp, followed_s: data.summary.ball?.followed_s ?? 0, coverage: det?.coverage ?? null, contact_coverage: det?.contact_coverage ?? null };
    const cur = match.possession;
    if (cur && cur.own === next.own && cur.opp === next.opp && cur.followed_s === next.followed_s && cur.coverage === next.coverage && cur.contact_coverage === next.contact_coverage) return;
    mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, possession: next } : m)) }));
  }, [poss?.own, poss?.opp, data.summary.ball?.possession_detail?.coverage, data.summary.ball?.possession_detail?.contact_coverage]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const B = data.cover.other_team;
  const closingHint = data.texts.closing.key === "plan" ? "Qué hacer con y sin balón contra este rival." : "Qué salió bien, qué no y qué se trabaja en la semana.";
  const parts = fixed?.parts ?? [];
  const focus: Side = report.focus ?? "own";
  const F = focus === "own" ? A : B;
  const layout = layoutOf(report.sections);

  // What each section needs and whether this match has it. A section without its data hides itself.
  const src = data.cover.level.sources;
  const hasNeed = (n: SectionNeed) => (n === "dev" ? false : n === "events" ? src.events : n === "ball" ? src.ball : n === "tracking" ? src.tracking : src.names && src.ball);
  const m = data.maps;
  const empty: Record<string, string | null> = {
    shots: m.shots.some((x) => x.team === focus) ? null : m.shots_no_pos > 0 ? "sin tiros con posición" : "sin tiros",
    crosses: m.crosses_outcome[focus].total > 0 ? null : "sin centros",
    duels: m.duels && m.duels.points.some((d) => d.team === focus) ? null : "sin duelos con posición",
    network: focus === "own" && !data.summary.network ? "sin red" : null,
    touches: data.key_players.rows.some((r) => r.team === focus) ? null : "sin toques",
    plays: data.plays.length > 0 ? null : "sin jugadas marcadas",
  };
  const missing: Record<string, string> = {};
  for (const id of layout) {
    const d = sectionDef(id);
    if (!d) continue;
    if (!hasNeed(d.needs)) missing[id] = NEED_TEXT[d.needs];
    else if (empty[id]) missing[id] = empty[id] as string;
  }
  const oppNet =
    focus === "opp" && src.names && src.ball
      ? (() => {
          const n = passNetwork(parts, "opp", segmentsByVideo);
          if (n.passes === 0) return null;
          // Turned so the rival also attacks right.
          return { nodes: n.nodes.map((x) => ({ player: x.label, x: 105 - x.x, y: 68 - x.y, touches: x.touches })), edges: n.edges, passes: n.passes, unnamed: n.unnamed };
        })()
      : null;

  const section = (id: string): React.ReactNode => {
    switch (id) {
      case "general":
        return <General data={data} />;
      case "block":
        return <TeamBlockSection parts={parts} side={focus} team={F} />;
      case "transitions":
        return <Transitions data={data} side={focus} />;
      case "shots":
        return <Shots data={data} side={focus} />;
      case "crosses":
        return <Crosses data={data} side={focus} />;
      case "network": {
        const net = focus === "own" ? data.summary.network : oppNet;
        return net ? <NetworkBlock net={net} team={F} side={focus} /> : <GateLine gate={data.summary.network_gate} />;
      }
      case "pass_map":
        return <PassMapSection parts={parts} side={focus} team={F} segmentsByVideo={segmentsByVideo} />;
      case "touches":
        return data.summary.ball ? (
          <TouchesBlock
            rows={data.key_players.rows.filter((r) => r.team === focus)}
            team={A}
            other={B}
            coverage={coverageText(data.summary.ball)}
            print={data.key_players.print}
            onPrint={(v) => setReport({ print_touches: v })}
          />
        ) : null;
      case "zones":
        return <Zones data={data} side={focus} />;
      case "duels":
        return <Duels data={data} side={focus} />;
      case "physical":
        return <PhysicalSection parts={parts} side={focus} team={F} />;
      case "set_pieces":
        return (
          <>
            <SetPieces data={data} />
            <TextField value={report.balon_parado} hint="Córners, tiros libres y saques: a favor y en contra." onChange={(v) => setReport({ balon_parado: v })} />
          </>
        );
      case "key_players":
        return <TextField value={report.jugadoras_clave} hint="Número, posición y qué hacen." onChange={(v) => setReport({ jugadoras_clave: v })} />;
      case "notes":
        return (
          <div className="grid gap-5 md:grid-cols-2 print:grid-cols-2">
            <Note title="Fortalezas" value={report.fortalezas} hint="Qué hacen bien y por dónde generan peligro." onChange={(v) => setReport({ fortalezas: v })} />
            <Note title="Debilidades" value={report.debilidades} hint="Dónde pierden el balón, espacios que dejan." onChange={(v) => setReport({ debilidades: v })} />
            <div className="md:col-span-2 print:col-span-2">
              <Note
                title={data.texts.closing.title}
                value={data.texts.closing.text}
                hint={closingHint}
                onChange={(v) => setReport(data.texts.closing.key === "plan" ? { plan: v } : { conclusiones: v })}
              />
            </div>
          </div>
        );
      case "plays":
        return (
          <ul className="divide-y divide-line-soft text-sm text-ink">
            {data.plays.map((p) => (
              <li key={p.id} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5 break-inside-avoid">
                <span className="tc text-xs text-faint">
                  {p.moment.label}–{p.end_label}
                </span>
                <span>
                  <strong>{p.title}</strong>
                  {p.note && <span className="text-ink-2"> · {p.note}</span>}
                </span>
                <See m={p.moment} />
              </li>
            ))}
          </ul>
        );
      case "results":
        return <Results data={data} report={report} setReport={setReport} />;
      default:
        return null;
    }
  };

  const shown = layout.filter((id) => !missing[id]);
  const rest = shown.filter((id) => id !== "general");
  // On screen they invite to write; on paper a section with nothing written (or a table left out) is not printed.
  const blank = (...v: (string | undefined)[]) => v.every((x) => !x?.trim());
  const printEmpty: Record<string, boolean> = {
    key_players: blank(report.jugadoras_clave),
    notes: blank(report.fortalezas, report.debilidades, data.texts.closing.text),
    touches: !data.key_players.print,
  };

  return (
    <div className="print-sheet mx-auto max-w-5xl space-y-8 print:max-w-none print:space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <label className="mr-auto flex items-center gap-1.5 text-xs text-muted" title="Cambia los nombres por el dorsal, para compartir fuera del cuerpo técnico">
          <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
          Sin nombres
        </label>
        <button type="button" className={btn} onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
          <PencilSimple size={15} />
          Secciones
        </button>
        <button type="button" className={btn} onClick={() => void exportData()}>
          <DownloadSimple size={15} />
          Datos
        </button>
        <button type="button" className={btn} onClick={() => void exportClips()} title="Transiciones y jugadas del informe como lista de clips (los editados salen con sus dibujos)">
          <FilmStrip size={15} />
          Clips
        </button>
        <div className="seg" role="group" aria-label="Color del PDF" title="Color del PDF: el de la app o papel blanco (para imprimir en papel)">
          {(
            [
              ["app", "Como la app"],
              ["white", "Blanco"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="seg-opt" aria-pressed={paper === k} onClick={() => setPref("report:paper", k)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className={btnPrimary} onClick={() => window.print()}>
          <Printer size={15} />
          PDF
        </button>
        {saved && <p className="w-full text-right text-xs text-faint">{saved}</p>}
      </div>
      {editing && <SectionsEditor layout={layout} onChange={(l) => setReport({ sections: l })} missing={missing} onClose={() => setEditing(false)} />}

      <Cover data={data} report={report} setReport={setReport} loading={!!match.folder && fixed === null} />

      {shown.includes("general") && (
        <Block title="General" note="Los dos equipos">
          {section("general")}
        </Block>
      )}

      {/* Everything below describes one team: usually ours, the rival when it is the one being studied. */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <span className="text-sm text-muted">Secciones de</span>
        <div className="seg" role="group" aria-label="Equipo del informe">
          {(["own", "opp"] as const).map((sd) => (
            <button key={sd} type="button" className="seg-opt inline-flex items-center gap-2" aria-pressed={focus === sd} onClick={() => setReport({ focus: sd })}>
              <i className="h-2.5 w-2.5 rounded-sm" style={{ background: sd === "own" ? COLORS.own : COLORS.opp }} />
              {sd === "own" ? A : B}
            </button>
          ))}
        </div>
      </div>

      {rest.map((id) => (
        <Block key={id} title={sectionDef(id)?.title ?? id} note={sectionDef(id)?.both ? "Los dos equipos" : F} side={sectionDef(id)?.both ? null : focus} printHidden={printEmpty[id]}>
          {section(id)}
        </Block>
      ))}

      {Object.keys(missing).length > 0 && (
        <p className="text-xs text-faint print:hidden">
          Sin datos en este partido:{" "}
          {Object.entries(missing)
            .map(([id, why]) => `${sectionDef(id)?.title} (${why.toLowerCase()})`)
            .join(" · ")}
          .
        </p>
      )}

      <footer className="break-inside-avoid border-t border-line pt-3 text-xs text-faint">
        <div className="mb-1 font-medium text-muted">Método</div>
        <ul className="space-y-0.5">
          {data.method.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {data.summary.ball && <LeftoversList b={data.summary.ball} team={A} other={B} />}
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- pieces

// A section flows across pages (a long table may split); its title stays with what follows and each figure inside keeps
// itself whole (break-inside-avoid on the figures).
function Block({ title, note, side, gate, printHidden, children }: { title: string; note?: string; side?: Side | null; gate?: Gate; printHidden?: boolean; children?: React.ReactNode }) {
  // A section with nothing but its level line is left out of the printout.
  const onlyGate = gate && !gate.ok && !children;
  return (
    <section className={onlyGate || printHidden ? "print:hidden" : ""}>
      <div className="flex flex-wrap items-center gap-3 break-after-avoid">
        <h3 className="sec-tag">{title}</h3>
        <span className="h-px flex-1 bg-line" />
        {note && (
          <span className="inline-flex items-center gap-1.5 text-xs text-faint">
            {side && <i className="h-2.5 w-1 rounded-full" style={{ background: sideColor(side) }} />}
            {note}
          </span>
        )}
      </div>
      <div className="mt-3 rounded-[10px] border border-line-soft bg-surface p-5 print:p-4">
        {gate && <GateLine gate={gate} />}
        {children}
      </div>
    </section>
  );
}

function Cover({ data, report, setReport, loading }: { data: ReportData; report: Report; setReport: (p: Partial<Report>) => void; loading: boolean }) {
  const c = data.cover;
  const kpis = coverKpis(data);
  return (
    <header className="space-y-3 break-inside-avoid">
      <div className="overflow-hidden rounded-[14px] border border-line-soft bg-surface">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-6 pt-5 pb-5">
          <div className="min-w-0">
            <div className="text-xs font-medium tracking-wide text-faint uppercase">{c.title}</div>
            <h2 className="mt-1 text-3xl leading-tight text-ink">{c.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span className="tc">{c.date || "sin fecha"}</span>
              {c.jornada && <span>Jornada {c.jornada}</span>}
              <label className="flex items-center gap-1.5 print:hidden">
                {!c.jornada && "Jornada"}
                <input className={`${input} w-16 !py-0.5`} value={report.jornada ?? ""} placeholder="3" aria-label="Jornada" onChange={(e) => setReport({ jornada: e.target.value })} />
              </label>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="cond flex h-12 items-stretch text-xl font-bold uppercase" title="Goles etiquetados de cada equipo">
              <span className="flex items-center gap-2 rounded-l-md bg-raised px-4 whitespace-nowrap">
                <i className="h-5 w-1 rounded-full bg-own" />
                {c.focus_team}
              </span>
              <span className="grid w-12 place-items-center bg-ink text-3xl font-extrabold text-bg">{c.score ? c.score.own : "–"}</span>
              <span className="grid w-12 place-items-center border-l border-bg bg-ink text-3xl font-extrabold text-bg">{c.score ? c.score.opp : "–"}</span>
              <span className="flex items-center gap-2 rounded-r-md bg-raised px-4 whitespace-nowrap">
                {c.other_team}
                <i className="h-5 w-1 rounded-full bg-opp" />
              </span>
            </div>
            {c.shootout && (
              <span className="cond text-lg font-bold text-ink-2" title={`Tanda de penales: ${c.shootout.kicks.length} tiros`}>
                Penales {c.shootout.own}–{c.shootout.opp}
              </span>
            )}
          </div>
        </div>
        {kpis.length > 0 && (
          <dl className="grid grid-cols-2 border-t border-line-soft sm:grid-cols-3 lg:grid-cols-5 print:grid-cols-5">
            {kpis.map((k) => (
              <div key={k.label} className="border-line-soft px-5 py-3.5 not-first:border-l" title={`${k.label} · ${c.focus_team}: ${k.own} · ${c.other_team}: ${k.opp}`}>
                <dt className="text-xs text-muted">{k.label}</dt>
                <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="num text-3xl whitespace-nowrap text-ink">{k.own}</span>
                  <span className="text-xs whitespace-nowrap text-faint">vs {k.opp}</span>
                </dd>
                {k.note && <div className="mt-0.5 text-[11px] text-faint">{k.note}</div>}
                <div className="mt-2 flex h-1 gap-0.5 overflow-hidden rounded-full">
                  {k.share === null ? (
                    <span className="h-full w-full bg-line-soft" />
                  ) : (
                    <>
                      <span className="h-full rounded-full" style={{ width: `${100 * k.share}%`, background: COLORS.own }} />
                      <span className="h-full flex-1 rounded-full" style={{ background: COLORS.opp }} />
                    </>
                  )}
                </div>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="tag">Datos {c.level.label.replace(/^Nivel de datos:\s*/, "")}</span>
      </div>
      {c.level.next && <p className="text-xs text-faint print:hidden">{c.level.next}</p>}
      {loading && <p className="text-xs text-faint print:hidden">Leyendo el tracking de la carpeta del partido…</p>}
      {c.is_demo && (
        <div className="rounded-md bg-warn-900 px-3 py-1.5 text-sm text-warn">
          DATOS DE EJEMPLO: las cifras de este informe son sintéticas y no describen a ningún equipo real.
        </div>
      )}
    </header>
  );
}

// The headline figures under the scoreboard: only those this match has (no ball followed, no possession tile).
function coverKpis(data: ReportData): { label: string; own: string; opp: string; share: number | null; note?: string }[] {
  const out: { label: string; own: string; opp: string; share: number | null; note?: string }[] = [];
  const share = (a: number, b: number) => (a + b > 0 ? a / (a + b) : null);
  const b = data.summary.ball;
  if (b) {
    const s = share(b.possession.own, b.possession.opp);
    // The possession never goes without its coverage (lib/playgroundHealth.ts possessionCover).
    const cov = possessionCover(b.possession_detail);
    if (s !== null) out.push({ label: "Posesión", own: `${Math.round(100 * s)} %`, opp: `${100 - Math.round(100 * s)} %`, share: s, note: cov.cover === null ? "cobertura desconocida" : `sobre el ${Math.round(100 * cov.cover)} % del tiempo vivo` });
  }
  if (data.cover.level.events > 0) {
    const row = (k: string) => data.summary.rows.find((r) => r.key === k);
    for (const [k, label] of [
      ["shots", "Tiros"],
      ["on_target", "A puerta"],
      ["recoveries", "Recuperaciones"],
    ] as const) {
      const r = row(k);
      if (r) out.push({ label, own: String(r.own), opp: String(r.opp), share: share(r.own, r.opp) });
    }
  }
  if (b) {
    const p = (s: Side) => b.passes[s].completed + b.passes[s].cut;
    if (p("own") + p("opp") > 0) {
      const pc = (s: Side) => (p(s) > 0 ? Math.round((100 * b.passes[s].completed) / p(s)) : null);
      out.push({ label: "Pases completos", own: pc("own") === null ? "—" : `${pc("own")} %`, opp: pc("opp") === null ? "—" : `${pc("opp")} %`, share: share(b.passes.own.completed, b.passes.opp.completed) });
    }
  }
  return out;
}

// General: both teams side by side (figures, by 5 or 10 min, possession and passes read from the ball).
function General({ data }: { data: ReportData }) {
  const [binMin, setBinMin] = useState<"5" | "10">("5");
  const [measure, setMeasure] = useState<BinMeasure>("shots");
  const A = data.cover.focus_team;
  const B = data.cover.other_team;
  const box = data.summary.rows.find((r) => r.rate);
  const bins = data.summary.bins[binMin];
  // A row where neither team has anything says nothing; it is listed in a line under the chart instead.
  const rows = data.summary.rows.filter((r) => r.own + r.opp > 0);
  const zero = data.summary.rows.filter((r) => r.own + r.opp === 0).map((r) => r.label.toLowerCase());
  const binsAny = bins.bins.some((x) => x.own[measure] + x.opp[measure] > 0);
  return (
    <div className="space-y-6">
      {data.cover.level.events === 0 ? (
        <p className="text-sm text-faint">Sin eventos etiquetados todavía.</p>
      ) : (
        <div className="space-y-6">
          <div className="mx-auto max-w-3xl break-inside-avoid">
            <MirrorBars aLabel={A} bLabel={B} rows={rows.map((r) => ({ label: r.label, a: r.own, b: r.opp }))} />
            {zero.length > 0 && <p className="mt-2 text-xs text-faint">Ninguno de los dos: {zero.join(", ")}.</p>}
            {box?.rate && (
              <p className="mt-2 text-xs text-faint">
                Entradas al área que acaban en tiro (15 s): {A} {rate(box.rate.own)} · {B} {rate(box.rate.opp)}.
              </p>
            )}
            <div className="mt-2">
              <GateLine gate={data.summary.possession} />
            </div>
          </div>
          <div className={`grid gap-8 ${data.summary.substitutions.length > 0 ? "md:grid-cols-[minmax(0,1fr)_16rem] print:grid-cols-[minmax(0,1fr)_14rem]" : ""}`}>
            <div className="break-inside-avoid">
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
              {binsAny ? (
                <BinChart aLabel={A} bLabel={B} bins={bins.bins.map((x) => ({ label: x.label, a: x.own[measure], b: x.opp[measure] }))} />
              ) : (
                <p className="text-sm text-faint">Ningún equipo tiene {BIN_MEASURES[measure].toLowerCase()} en este partido.</p>
              )}
              {bins.skipped > 0 && <p className="mt-1 text-xs text-faint">{bins.skipped} evento(s) fuera de los tramos de juego no se cuentan.</p>}
            </div>
            {data.summary.substitutions.length > 0 && (
              <div className="break-inside-avoid">
                <div className="mb-1 text-sm font-medium text-ink">Cambios</div>
                <ul className="m-0 space-y-0.5 p-0 text-xs text-muted">
                  {data.summary.substitutions.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <i className={`h-3 w-1 shrink-0 rounded-full ${s.team === "own" ? "bg-own" : "bg-opp"}`} />
                      <span className="tc w-12 shrink-0 text-faint">{s.moment.minute !== null ? `${s.moment.minute}'` : s.moment.label}</span>
                      <span className="text-ink-2">{s.in ?? "¿?"}</span>
                      <span className="text-faint">por</span>
                      <span>{s.out ?? "¿?"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      <BallBlock data={data} />
    </div>
  );
}

const sideColor = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);
const OUTCOME_COLOR: Record<string, string> = { shot: "var(--color-ok)", cleared: "var(--color-muted)", play_on: "var(--color-accent-400)" };
const teamName = (data: ReportData, s: Side) => (s === "own" ? data.cover.focus_team : data.cover.other_team);

function Shots({ data, side }: { data: ReportData; side: Side }) {
  const T = teamName(data, side);
  const m = data.maps;
  const shots = m.shots.filter((s) => s.team === side);
  const goalMarks = shots.filter((s) => s.goal_y !== null && s.goal_z !== null);
  return (
    <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
      <div className="break-inside-avoid">
        <Legend
          items={[
            { color: sideColor(side), label: "Gol" },
            { color: sideColor(side), label: "Sin gol", hollow: true },
          ]}
        />
        <Pitch className="mt-2">
          {shots.map((s) => (
            <circle key={s.id} cx={s.x} cy={s.y} r={1.5} fill={s.goal ? sideColor(side) : "var(--color-surface)"} stroke={sideColor(side)} strokeWidth={0.55}>
              <title>{`${s.goal ? "Gol" : (EVENT_OUTCOMES.shot?.[s.outcome ?? ""] ?? "Tiro")} · ${when(s.moment)}${s.player ? ` · ${s.player}` : ""}`}</title>
            </circle>
          ))}
        </Pitch>
        <p className="mt-1 text-xs text-faint">
          {shots.length} tiro(s) de {T} en el mapa{m.shots_no_pos > 0 && ` · ${m.shots_no_pos} sin posición marcada (los dos equipos)`}.
        </p>
      </div>
      <div className="break-inside-avoid">
        <div className="mb-1 text-sm font-medium text-ink">Dónde cruzaron la portería</div>
        {goalMarks.length === 0 ? (
          <p className="text-sm text-faint">Ningún remate con su punto en la portería (se marca en la pasada 3).</p>
        ) : (
          <>
            <GoalFrame marks={goalMarks.map((s) => ({ id: s.id, y: s.goal_y as number, z: s.goal_z as number, color: sideColor(side), title: when(s.moment) }))} />
            <p className="mt-1 text-xs text-faint">
              {goalMarks.length} de {shots.length} tiros, vistos desde quien remata. Portería de {GOAL.width} m.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Crosses({ data, side }: { data: ReportData; side: Side }) {
  const m = data.maps;
  const crossLabels = EVENT_OUTCOMES.cross ?? {};
  const arrows = m.crosses.filter((c) => c.team === side);
  const t = m.crosses_outcome[side];
  const missingNote = [m.crosses_no_end[side] > 0 && `${m.crosses_no_end[side]} sin destino marcado`, m.crosses_no_pos[side] > 0 && `${m.crosses_no_pos[side]} sin posición`]
    .filter(Boolean)
    .join(" · ");
  return (
    <FigureRow
      note={`${arrows.length} de ${t.total} centro(s) en el mapa${missingNote ? ` · ${missingNote}` : ""}. Línea discontinua: sin resultado anotado.`}
      aside={
        <StatList
          items={[
            { label: "Centros", value: t.total },
            ...Object.entries(crossLabels).map(([k, v]) => ({ label: v, value: t.counts[k] ?? 0, mark: OUTCOME_COLOR[k] })),
            ...(t.unknown > 0 ? [{ label: "Sin resultado", value: t.unknown, mark: "var(--color-faint)", hollow: true }] : []),
          ]}
        />
      }
    >
      <Pitch>
        <defs>
          <marker id={`arrow-${side}`} viewBox="0 0 6 6" refX={5} refY={3} markerWidth={4} markerHeight={4} orient="auto-start-reverse">
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
            markerEnd={`url(#arrow-${side})`}
          >
            <title>{`${when(c.moment)} · ${c.outcome ? crossLabels[c.outcome] : "sin resultado"}${c.player ? ` · ${c.player}` : ""}`}</title>
          </line>
        ))}
      </Pitch>
    </FigureRow>
  );
}

function Duels({ data, side }: { data: ReportData; side: Side }) {
  const d = data.maps.duels;
  if (!d) return null;
  const c = sideColor(side);
  const mine = d.points.filter((p) => p.team === side);
  const aerial = mine.filter((p) => p.detail === "aerial");
  const won = d.won[side];
  const lost = d.lost[side];
  return (
    <FigureRow
      note={<>Cuadrado: aéreo · círculo: en el suelo o sin anotar.{d.no_pos > 0 && ` ${d.no_pos} sin posición no salen en el mapa.`}</>}
      aside={
        <StatList
          items={[
            { label: "Ganados", value: won, mark: c },
            { label: "Perdidos", value: lost, mark: c, hollow: true },
            { label: "% ganados", value: won + lost > 0 ? `${Math.round((100 * won) / (won + lost))} %` : "—" },
            { label: "Aéreos ganados", value: `${aerial.filter((p) => p.outcome === "won").length} de ${aerial.length}` },
          ]}
        />
      }
    >
      <Pitch>
        {mine.map((p) => {
          const fill = p.outcome === "won" ? c : "var(--color-surface)";
          const title = `${p.outcome ? EVENT_OUTCOMES.duel?.[p.outcome] : "sin resultado"} · ${p.detail ? EVENT_DETAILS.duel?.[p.detail] : "tipo sin anotar"} · ${when(p.moment)}`;
          return p.detail === "aerial" ? (
            <rect key={p.id} x={p.x - 1.3} y={p.y - 1.3} width={2.6} height={2.6} fill={fill} stroke={c} strokeWidth={0.5}>
              <title>{title}</title>
            </rect>
          ) : (
            <circle key={p.id} cx={p.x} cy={p.y} r={1.4} fill={fill} stroke={c} strokeWidth={0.5}>
              <title>{title}</title>
            </circle>
          );
        })}
      </Pitch>
    </FigureRow>
  );
}

function Zones({ data, side }: { data: ReportData; side: Side }) {
  const z = data.maps.zones;
  return (
    <div className="grid gap-6 md:grid-cols-2 print:grid-cols-2">
      {(["loss", "recovery"] as const).map((k) => (
        <div key={k} className="break-inside-avoid">
          <div className="mb-1 text-sm text-ink-2">{k === "loss" ? "Pérdidas" : "Recuperaciones"}</div>
          <ZoneMap grid={z[k][side].grid} missing={z[k][side].missing} showDirection={false} />
        </div>
      ))}
      <p className="text-xs text-faint md:col-span-2">5 carriles × 3 tercios, con el equipo atacando hacia la derecha (su banda izquierda arriba).</p>
    </div>
  );
}

function TransitionList({ rows, empty, what }: { rows: TransitionRow[]; empty: string; what: string }) {
  if (rows.length === 0) return <p className="text-sm text-faint">{empty}</p>;
  return (
    <ul className="divide-y divide-line-soft text-sm text-ink">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-baseline gap-2 py-1 break-inside-avoid">
          <span className="tc text-xs text-faint">{when(r.moment)}</span>
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

// Two chains, read left to right: after losing the ball, and after winning it.
function Transitions({ data, side }: { data: ReportData; side: Side }) {
  const t = data.transitions[side];
  const them = teamName(data, side === "own" ? "opp" : "own");
  const step = (n: number | string, label: string, share: number | null) => (
    <div className="rounded-lg bg-raised px-4 py-3">
      <div className="num text-3xl text-ink">{n}</div>
      <div className="mt-0.5 text-sm text-muted">{label}</div>
      <div className="mt-2 h-1 rounded-full bg-line">
        {share !== null && share > 0 && <div className="h-full rounded-full" style={{ width: `${Math.min(100, 100 * share)}%`, background: sideColor(side) }} />}
      </div>
    </div>
  );
  const pct = (k: number, n: number) => (n > 0 ? ` · ${Math.round((100 * k) / n)} %` : "");
  return (
    <div className="space-y-6">
      <div className="grid items-center gap-3 md:grid-cols-[11rem_repeat(3,minmax(0,1fr))] print:grid-cols-[9rem_repeat(3,minmax(0,1fr))]">
        <div className="text-sm font-medium text-ink">Después de perder el balón</div>
        {step(t.counterpress.n, "pérdidas", 1)}
        {step(t.counterpress.k, `recuperadas antes de 8 s${pct(t.counterpress.k, t.counterpress.n)}`, t.counterpress.n ? t.counterpress.k / t.counterpress.n : null)}
        {step(t.loss_to_shot.k, `acabaron en tiro de ${them}${pct(t.loss_to_shot.k, t.loss_to_shot.n)}`, t.loss_to_shot.n ? t.loss_to_shot.k / t.loss_to_shot.n : null)}
      </div>
      <div className="grid items-center gap-3 md:grid-cols-[11rem_repeat(3,minmax(0,1fr))] print:grid-cols-[9rem_repeat(3,minmax(0,1fr))]">
        <div className="text-sm font-medium text-ink">Después de recuperarlo</div>
        {step(t.recovery_to_shot.n, "recuperaciones", 1)}
        {step(t.recovery_to_shot.k, `acabaron en tiro antes de 15 s${pct(t.recovery_to_shot.k, t.recovery_to_shot.n)}`, t.recovery_to_shot.n ? t.recovery_to_shot.k / t.recovery_to_shot.n : null)}
        <div />
      </div>
      <div className="grid gap-4 md:grid-cols-2 print:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-ink-2">Pérdida → tiro de {them}</div>
          <TransitionList rows={t.losses} what="Pérdida" empty="Ninguna." />
        </div>
        <div>
          <div className="mb-1 text-xs text-ink-2">Recuperación → tiro</div>
          <TransitionList rows={t.recoveries} what="Recuperación" empty="Ninguna." />
        </div>
      </div>
    </div>
  );
}

function GateLine({ gate }: { gate: Gate }) {
  if (gate.ok) return null;
  return <p className="text-sm text-faint print:hidden">{gate.need}</p>;
}

function Note({ title, value, hint, onChange }: { title: string; value: string; hint: string; onChange: (v: string) => void }) {
  return (
    <div className={`break-inside-avoid ${value.trim() ? "" : "print:hidden"}`}>
      <h4 className="text-sm font-medium text-ink">{title}</h4>
      <TextField value={value} hint={hint} onChange={onChange} />
    </div>
  );
}

function TextField({ value, hint, onChange }: { value: string; hint: string; onChange: (v: string) => void }) {
  return (
    <>
      <textarea className={`${input} mt-2 w-full print:hidden`} rows={4} placeholder={hint} value={value} onChange={(e) => onChange(e.target.value)} />
      {value.trim() && <p className="mt-2 hidden text-sm whitespace-pre-wrap text-ink print:block">{value}</p>}
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
              <li key={p.id} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-baseline gap-3">
                <span className="tc text-xs text-faint">{p.moment.label}</span>
                <span>
                  <strong>{p.title}</strong>
                  {p.note && <span className="text-ink-2"> · {p.note}</span>}
                </span>
                <See m={p.moment} />
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
