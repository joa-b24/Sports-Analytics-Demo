"use client";

import { ArrowRight, Barbell, CheckCircle, FileText, Monitor, PlayCircle, Plus, Sparkle, Tag } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AcwrChart, MiniBars } from "@/components/charts";
import { MODES, STEP_ICONS, ScoreBug, modeOf } from "@/components/match/MatchHeader";
import { CountUp, Reveal, revealRef } from "@/components/motion";
import { Card, DemoBadge, PageHeader, btnPrimary } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { TEAM_SECTIONS } from "@/lib/features";
import { fmtNum } from "@/lib/format";
import { faceOff, lastOwnMatch, nextRival, pendingTasks, rivalDossier, type RivalDossier, type Task } from "@/lib/home";
import { SAFE_ACWR, acwr, sessionLoads } from "@/lib/load";
import { readFolderFiles } from "@/lib/local";
import { segmentsFromMarks } from "@/lib/segments";
import { mean } from "@/lib/stats";
import { matchSteps, type FolderFiles, type StepId, type StepStatus } from "@/lib/steps";
import { mutate, useHydrated, useStore } from "@/lib/store";
import { matchSummary, type Comparison } from "@/lib/summary";
import type { Match, MatchEvent, State } from "@/lib/types";
import { matchVideos, videoOf } from "@/lib/videos";

// Metric used for the training-load trend, in order of preference.
const LOAD_METRICS: [string, string][] = [
  ["player_load", "Carga (player load)"],
  ["total_distance_m", "Distancia total (m)"],
];

// The steps a match can finish by itself, in the order of its modes (the board is not tied to one match).
const STEP_ORDER = MODES.flatMap((m) => m.steps.map(([id, label]) => [id, label] as [StepId, string])).filter(([id]) => id !== "board");

const fmtDate = (d: string, year = true) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) }) : "Sin fecha";

// Link to a match, opened on a mode and, optionally, on one of its steps.
const matchHref = (m: Match, mode: string, step?: StepId) =>
  `/partido?id=${encodeURIComponent(m.match_id)}&modo=${mode}${step ? `&paso=${step}` : ""}`;

function stepsOf(m: Match, state: State, events: MatchEvent[], files: FolderFiles | null) {
  const vids = matchVideos(m).map((v) => v.video_id);
  const marks = state.segments.filter((g) => g.match_id === m.match_id);
  return matchSteps({
    videoIds: vids,
    folder: m.folder,
    venueId: m.venue_id,
    segmentsByVideo: Object.fromEntries(vids.map((v) => [v, segmentsFromMarks(marks.filter((g) => videoOf(g) === v))])),
    events,
    plays: state.plays.filter((p) => p.match_id === m.match_id),
    trackEdits: state.trackEdits,
    files: m.folder ? files : null,
  });
}

// Small condensed caption in capitals.
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="cond text-xs font-bold tracking-wide text-faint uppercase">{children}</span>;
}

// One comparison: the label in the middle and a bar for each team growing outwards from it.
function FaceOffRow({ c, i }: { c: Comparison; i: number }) {
  const [own, opp] = faceOff(c.own, c.opp, c.unit);
  const lead = c.own === c.opp ? null : c.own > c.opp ? "own" : "opp";
  const value = (v: number, side: "own" | "opp") => (
    <span className={`num text-xl sm:text-2xl ${lead === side ? "text-ink" : "text-muted"} ${side === "own" ? "text-right" : ""}`}>
      <CountUp value={v} />
      {c.unit && <span className="text-sm">{c.unit}</span>}
    </span>
  );
  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_5.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 sm:grid-cols-[3.25rem_minmax(0,1fr)_7.5rem_minmax(0,1fr)_3.25rem] sm:gap-3">
      {value(c.own, "own")}
      <div className="flex h-2 justify-end overflow-hidden rounded-full bg-raised">
        <i
          className={`a-bar block h-full rounded-full bg-own ${lead === "opp" ? "opacity-60" : ""}`}
          style={{ width: `${own * 100}%`, transformOrigin: "right center", "--i": i } as React.CSSProperties}
        />
      </div>
      <span className="text-center text-xs text-muted">{c.label}</span>
      <div className="flex h-2 overflow-hidden rounded-full bg-raised">
        <i
          className={`a-bar block h-full rounded-full bg-opp ${lead === "own" ? "opacity-60" : ""}`}
          style={{ width: `${opp * 100}%`, "--i": i } as React.CSSProperties}
        />
      </div>
      {value(c.opp, "opp")}
    </div>
  );
}

// The steps of a match as a row of icons: green when done, amber when started, dim when not. Each opens its step.
function StepStrip({ m, steps }: { m: Match; steps: Record<StepId, StepStatus> }) {
  const done = STEP_ORDER.filter(([id]) => steps[id].state === "done").length;
  return (
    <div className="flex items-center gap-2">
      <ul className="m-0 flex items-center gap-0.5 rounded-full bg-bg/60 px-1.5 py-1" aria-label={`Pasos completos: ${done} de ${STEP_ORDER.length}`}>
        {STEP_ORDER.map(([id, label]) => {
          const I = STEP_ICONS[id];
          const st = steps[id].state;
          const tone = st === "done" ? "text-ok" : st === "partial" ? "text-warn" : "text-faint/45";
          return (
            <li key={id}>
              <Link
                href={matchHref(m, modeOf(id), id)}
                title={`${label} · ${steps[id].text}`}
                aria-label={`${label}: ${steps[id].text}`}
                className={`grid h-7 w-7 place-items-center rounded-full transition-colors hover:bg-raised ${tone}`}
              >
                <I size={15} weight={st === "done" ? "fill" : "regular"} aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
      <span className="tc rounded px-1.5 py-0.5 text-xs text-muted tabular-nums">
        {done}/{STEP_ORDER.length}
      </span>
    </div>
  );
}

// The football-pitch lines behind an empty state, drawn once when it appears.
function PitchLines() {
  return (
    <svg viewBox="0 0 105 68" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.08]" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g fill="none" stroke="var(--color-ink)" strokeWidth={0.3} className="draw-in">
        <rect x={1} y={1} width={103} height={66} pathLength={1} />
        <line x1={52.5} y1={1} x2={52.5} y2={67} pathLength={1} />
        <circle cx={52.5} cy={34} r={9.15} pathLength={1} />
        <rect x={1} y={13.84} width={16.5} height={40.32} pathLength={1} />
        <rect x={87.5} y={13.84} width={16.5} height={40.32} pathLength={1} />
      </g>
    </svg>
  );
}

// Faint wash of each team's colour from its side, behind the score.
const TEAM_WASH: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(90deg, color-mix(in srgb, var(--color-own) 11%, transparent), transparent 38%, transparent 62%, color-mix(in srgb, var(--color-opp) 8%, transparent))",
};

function LastMatch({ m, events, steps }: { m: Match; events: MatchEvent[]; steps: Record<StepId, StepStatus> }) {
  const s = matchSummary(m, events);
  const meta = [fmtDate(m.date), m.report?.jornada?.trim()].filter(Boolean).join(" · ");
  return (
    <section ref={revealRef} className="card card-hero reveal relative overflow-hidden !p-0 xl:col-span-8">
      <div className="absolute inset-0" style={TEAM_WASH} aria-hidden />
      <div className="relative flex flex-col gap-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Último partido</Eyebrow>
            <span className="text-xs text-faint">{meta}</span>
            {m.is_demo && <DemoBadge />}
          </div>
          <StepStrip m={m} steps={steps} />
        </div>

        <div className="flex flex-col gap-3">
          <Link href={matchHref(m, "analisis")} className="max-w-full self-start overflow-x-auto rounded-md transition-opacity hover:opacity-90" aria-label={`Abrir el análisis de ${m.name}`}>
            <ScoreBug match={m} events={events} size="lg" />
          </Link>
          {s.lead && <p className="m-0 max-w-2xl text-base text-pretty text-ink-2">{s.lead}</p>}
        </div>

        {s.comparisons.length > 0 ? (
          <Reveal className="flex flex-col gap-3">
            {s.comparisons.map((c, i) => (
              <FaceOffRow key={c.label} c={c} i={i} />
            ))}
          </Reveal>
        ) : (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-bg/50 px-4 py-3 text-sm text-muted">
            <Tag size={16} className="text-faint" />
            {events.length === 0 ? "Sin eventos etiquetados: la comparación aparece al etiquetar." : "Los eventos etiquetados aún no tienen tiros, córners ni recuperaciones."}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-4">
          {events.length > 0 ? (
            <>
              <Link href={matchHref(m, "analisis")} className={btnPrimary}>
                <Monitor size={15} />
                Análisis
              </Link>
              <Link href={matchHref(m, "analisis", "report")} className="btn">
                <FileText size={15} />
                Informe
              </Link>
              <Link href={matchHref(m, "estudio")} className="btn">
                <PlayCircle size={15} />
                Estudio
              </Link>
            </>
          ) : (
            <Link href={matchHref(m, "captura", "tag")} className={btnPrimary}>
              <Tag size={15} />
              Etiquetar eventos
            </Link>
          )}
          <span className="ml-auto text-xs text-faint">
            {events.length > 0 ? `${events.length} eventos` : ""}
            {s.status.state === "review" ? ` · ${s.status.text}` : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

function NoOwnMatch() {
  return (
    <section className="card card-hero relative grid min-h-56 place-items-center overflow-hidden xl:col-span-8">
      <PitchLines />
      <div className="relative flex flex-col items-center gap-3 text-center">
        <Eyebrow>Último partido</Eyebrow>
        <p className="m-0 text-lg text-ink">Aún no hay partidos nuestros</p>
        <Link href="/partidos" className={btnPrimary}>
          <Plus size={15} />
          Crear un partido propio
        </Link>
      </div>
    </section>
  );
}

const scoreText = (a: number, b: number) => `${a}–${b}`;

function Rival({ d }: { d: RivalDossier }) {
  const newest = d.videos[0]?.match;
  const tagged = d.videos.find((v) => v.events > 0)?.match;
  return (
    <Card className="flex flex-col gap-5 xl:col-span-4" delay={80}>
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Próximo rival</Eyebrow>
        {d.demo && <DemoBadge />}
      </div>
      <div className="-mt-2">
        <div className="cond flex items-center gap-2.5 text-3xl leading-none font-extrabold text-ink uppercase">
          <i className="h-7 w-1.5 shrink-0 rounded-full bg-opp" aria-hidden />
          <span className="min-w-0 truncate">{d.team}</span>
        </div>
        <p className="m-0 mt-2 text-xs text-muted">
          {d.videos.length} {d.videos.length === 1 ? "video" : "videos"} · {d.tagged} {d.tagged === 1 ? "etiquetado" : "etiquetados"}
        </p>
      </div>

      {d.tagged > 0 && (
        <dl className="m-0 grid grid-cols-3 gap-2">
          {(
            [
              ["Goles a favor", d.goalsFor],
              ["Goles en contra", d.goalsAgainst],
              ["Tiros", d.shots],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="rounded-lg bg-bg/60 px-3 py-2.5">
              <dd className="num m-0 text-3xl text-ink">
                <CountUp value={v} />
              </dd>
              <dt className="mt-1 text-[11px] leading-tight text-faint">
                {label}
                {label === "Tiros" && d.shots > 0 ? ` · ${d.onTarget} a puerta` : ""}
              </dt>
            </div>
          ))}
        </dl>
      )}

      {d.lead && (
        <figure className="m-0 border-l-2 border-opp pl-3">
          <blockquote className="m-0 text-sm text-pretty text-ink-2">{d.lead.text}</blockquote>
          <figcaption className="mt-1 text-[11px] text-faint">
            Informe · vs {d.lead.match.other_team}
          </figcaption>
        </figure>
      )}

      <div className="flex flex-col gap-3">
        <ul className="m-0">
          {d.videos.slice(0, 3).map((v) => (
            <li key={v.match.match_id} className="border-t border-line-soft first:border-t-0">
              <Link href={matchHref(v.match, v.events ? "analisis" : "captura")} className="group flex items-center gap-3 py-2 text-sm">
                <span className="cond w-14 shrink-0 text-xs font-bold text-faint uppercase">{fmtDate(v.match.date, false)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2 group-hover:text-accent-300">vs {v.match.other_team}</span>
                <span className={v.score ? "num text-base text-ink" : "text-xs text-faint"}>{v.score ? scoreText(v.score.for, v.score.against) : "sin etiquetar"}</span>
              </Link>
            </li>
          ))}
        </ul>
        {d.meetings.length > 0 && (
          <div>
            <Eyebrow>Contra nosotros</Eyebrow>
            <ul className="m-0 mt-1">
              {d.meetings.slice(0, 2).map((mt) => (
                <li key={mt.match.match_id}>
                  <Link href={matchHref(mt.match, mt.score ? "analisis" : "captura")} className="group flex items-center gap-3 py-1.5 text-sm">
                    <span className="cond w-14 shrink-0 text-xs font-bold text-faint uppercase">{fmtDate(mt.match.date, false)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2 group-hover:text-accent-300">vs {mt.match.focus_team}</span>
                    {/* Rival first, like its videos above. */}
                    <span className={mt.score ? "num text-base text-ink" : "text-xs text-faint"}>{mt.score ? scoreText(mt.score.opp, mt.score.own) : "sin etiquetar"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-wrap gap-2">
        {tagged ? (
          <>
            <Link href={matchHref(tagged, "analisis", "report")} className={btnPrimary}>
              <FileText size={15} />
              Informe del rival
            </Link>
            <Link href={matchHref(tagged, "analisis")} className="btn">
              Análisis
              <ArrowRight size={14} />
            </Link>
          </>
        ) : (
          newest && (
            <Link href={matchHref(newest, "captura", "tag")} className={btnPrimary}>
              <Tag size={15} />
              Etiquetar su video
            </Link>
          )
        )}
      </div>
    </Card>
  );
}

function NoRival() {
  return (
    <Card className="flex flex-col items-start gap-3 xl:col-span-4" delay={80}>
      <Eyebrow>Próximo rival</Eyebrow>
      <p className="m-0 text-sm text-muted">Sin videos de rivales.</p>
      <Link href="/partidos" className="btn">
        <Plus size={15} />
        Añadir un video del rival
      </Link>
    </Card>
  );
}

const TASKS_SHOWN = 8;

function Pending({ tasks, steps }: { tasks: Task[]; steps: Record<string, Record<StepId, StepStatus>> }) {
  return (
    <Card className="xl:col-span-12" delay={140}>
      <div className="mb-3 flex items-center gap-3">
        <Eyebrow>Pendiente</Eyebrow>
        {tasks.length > 0 && <span className="tc rounded px-1.5 text-xs text-muted tabular-nums">{tasks.length}</span>}
      </div>
      {tasks.length === 0 ? (
        <p className="m-0 flex items-center gap-2 text-sm text-muted">
          <CheckCircle size={16} weight="fill" className="text-ok" />
          Todo al día: eventos revisados, tramos marcados y resúmenes escritos.
        </p>
      ) : (
        <>
          <ul className="m-0 grid grid-cols-1 gap-x-8 xl:grid-cols-2">
            {tasks.slice(0, TASKS_SHOWN).map((t) => {
              const I = STEP_ICONS[t.step];
              const started = steps[t.match.match_id]?.[t.step]?.state === "partial";
              return (
                <li key={`${t.match.match_id}-${t.step}`} className="border-t border-line-soft">
                  <Link href={matchHref(t.match, t.mode, t.step)} className="group flex items-center gap-3 py-2.5">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-raised ${started ? "text-warn" : "text-ink-2"}`}>
                      <I size={16} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm text-ink group-hover:text-accent-300">
                        {t.label}
                        {t.match.is_demo && <DemoBadge />}
                      </span>
                      <span className="block truncate text-xs text-faint">
                        {t.match.name} · {t.text}
                      </span>
                    </span>
                    <ArrowRight size={14} className="shrink-0 text-faint transition-[transform,color] group-hover:translate-x-0.5 group-hover:text-accent-300" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {tasks.length > TASKS_SHOWN && (
            <Link href="/partidos" className="link mt-3 inline-block text-xs">
              y {tasks.length - TASKS_SHOWN} más en Partidos
            </Link>
          )}
        </>
      )}
    </Card>
  );
}

function EmptyHome({ canDemo }: { canDemo: boolean }) {
  return (
    <section className="card card-hero relative mb-6 grid min-h-80 place-items-center overflow-hidden">
      <PitchLines />
      <div className="relative flex max-w-md flex-col items-center gap-4 text-center">
        <h2 className="cond m-0 text-3xl font-extrabold text-ink uppercase">Empieza con un partido</h2>
        <p className="m-0 text-sm text-pretty text-muted">Un video de YouTube y eventos etiquetados a mano bastan para el análisis y el informe.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/partidos" className={btnPrimary}>
            <Plus size={15} />
            Crear un partido
          </Link>
          {canDemo && (
            <button type="button" className="btn" onClick={() => mutate(() => buildDemo())}>
              <Sparkle size={15} />
              Cargar datos de ejemplo
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const state = useStore();
  const hydrated = useHydrated();
  const { matches, events, sessions } = state;

  // What each match folder holds, for its finished steps (only when the app runs next to the repository).
  const [files, setFiles] = useState<Record<string, FolderFiles | null>>({});
  const folders = [...new Set(matches.map((m) => m.folder).filter((f): f is string => !!f))].sort().join("|");
  useEffect(() => {
    if (!folders) return;
    let live = true;
    void Promise.all(folders.split("|").map(async (f) => [f, await readFolderFiles(f)] as const)).then((rows) => {
      if (live) setFiles(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
  }, [folders]);

  if (!hydrated) return null;
  const eventsOf = (m: Match) => events.filter((e) => e.match_id === m.match_id);
  const stepsByMatch = Object.fromEntries(
    matches.map((m) => [m.match_id, stepsOf(m, state, eventsOf(m), m.folder ? (files[m.folder] ?? null) : null)]),
  );

  // The two jobs of the week: our last match (post-match) and the next rival (preparation).
  const last = lastOwnMatch(matches, events);
  const rival = nextRival(matches);
  const dossier = rival ? rivalDossier(rival, matches, events) : null;
  const tasks = pendingTasks(matches.map((m) => ({ match: m, steps: stepsByMatch[m.match_id], events: eventsOf(m).length })));

  const dates = [...new Set(sessions.map((s) => s.date))].sort();
  const metricKeys = new Set(sessions.flatMap((s) => Object.keys(s.metrics)));
  const load = LOAD_METRICS.find(([k]) => metricKeys.has(k));
  const loadByDate = load ? dates.map((d) => mean(sessions.filter((s) => s.date === d).map((s) => s.metrics[load[0]] ?? null))) : [];
  const sessionsDemo = sessions.some((s) => s.is_demo);
  const ratio = acwr(sessionLoads(sessions));
  const hasRatio = ratio.players.some((p) => p.ratio !== null);
  const outOfBand = ratio.players.filter((p) => p.ratio !== null && (p.ratio < SAFE_ACWR[0] || p.ratio > SAFE_ACWR[1]));

  return (
    <>
      <PageHeader title="Inicio" />

      {matches.length === 0 ? (
        <EmptyHome canDemo={sessions.length === 0} />
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-12">
          {last ? <LastMatch m={last} events={eventsOf(last)} steps={stepsByMatch[last.match_id]} /> : <NoOwnMatch />}
          {dossier ? <Rival d={dossier} /> : <NoRival />}
          <Pending tasks={tasks} steps={stepsByMatch} />
        </div>
      )}

      {TEAM_SECTIONS && (
        <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-12">
          <Card title="Carga de entrenamiento" note={load ? load[1] : undefined} className="xl:col-span-5">
            {load && dates.length > 0 ? (
              <>
                <MiniBars values={loadByDate} labels={dates} fmt={(v) => fmtNum(v)} />
                <div className="tc mt-2 flex justify-between text-[11px] text-faint">
                  <span>{dates[0]}</span>
                  <span>{dates[dates.length - 1]}</span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  {sessionsDemo ? <DemoBadge /> : <span />}
                  <Link href="/entrenamientos" className="btn btn-ghost">
                    Por jugadora
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </>
            ) : (
              <Link href="/datos" className="btn">
                <Barbell size={15} />
                Subir CSV de sensores
              </Link>
            )}
          </Card>
          {hasRatio && (
            <Card title="Carga aguda : crónica" note={`al ${ratio.asOf} · franja ${SAFE_ACWR[0]} – ${SAFE_ACWR[1]}`} className="xl:col-span-7">
              <AcwrChart players={ratio.players} band={SAFE_ACWR} />
              {outOfBand.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {outOfBand.map((p) => (
                    <li key={p.player_id} className="flex items-center gap-3 text-sm">
                      <span className="flex-1 text-ink">{p.player_id}</span>
                      <span className="text-xs text-muted">{(p.ratio as number) > SAFE_ACWR[1] ? "subió" : "bajó"}</span>
                      <span className="num text-base text-warn">{(p.ratio as number).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
