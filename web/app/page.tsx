"use client";

import { ArrowRight, Barbell, Sparkle, VideoCamera } from "@phosphor-icons/react";
import Link from "next/link";
import { AcwrChart, MiniBars } from "@/components/charts";
import { score } from "@/components/match/MatchHeader";
import { Card, DemoBadge, PageHeader, btnPrimary } from "@/components/Shell";
import { buildDemo } from "@/lib/demo";
import { fmtNum } from "@/lib/format";
import { SAFE_ACWR, acwr, sessionLoads } from "@/lib/load";
import { segmentsFromMarks } from "@/lib/segments";
import { countByType, shotsOf } from "@/lib/stats";
import { matchSteps } from "@/lib/steps";
import { mean } from "@/lib/stats";
import { mutate, useHydrated, useStore } from "@/lib/store";
import type { Match, MatchEvent } from "@/lib/types";
import { matchVideos, videoOf } from "@/lib/videos";

// Metric used for the training-load trend, in order of preference.
const LOAD_METRICS: [string, string][] = [
  ["player_load", "Carga (player load)"],
  ["total_distance_m", "Distancia total (m)"],
];

const byDate = (a: Match, b: Match) => (b.date || "").localeCompare(a.date || "");

function ScoreBug({ m, events }: { m: Match; events: MatchEvent[] }) {
  const s = score(events);
  const scored = events.some((e) => e.type === "goal");
  return (
    <div className="cond flex h-10 items-stretch text-lg font-bold uppercase">
      <span className="flex items-center gap-2 rounded-l-md bg-raised px-3 whitespace-nowrap">
        <i className="h-4 w-1 rounded-full bg-own" />
        {m.focus_team}
      </span>
      <span className="grid w-10 place-items-center bg-ink text-xl font-extrabold text-bg">{scored ? s.own : "–"}</span>
      <span className="grid w-10 place-items-center border-l border-bg bg-ink text-xl font-extrabold text-bg">{scored ? s.opp : "–"}</span>
      <span className="flex items-center gap-2 rounded-r-md bg-raised px-3 whitespace-nowrap">
        {m.other_team}
        <i className="h-4 w-1 rounded-full bg-opp" />
      </span>
    </div>
  );
}

export default function Home() {
  const state = useStore();
  const hydrated = useHydrated();
  const { matches, events, sessions } = state;
  if (!hydrated) return null;
  const empty = matches.length === 0 && sessions.length === 0;
  const eventsOf = (m: Match) => events.filter((e) => e.match_id === m.match_id);

  // The two jobs of the week: our last match (post-match) and the next rival (preparation).
  // The last one with events (a match just created, without tagging yet, says nothing).
  const ownByDate = matches.filter((m) => m.kind === "own").sort(byDate);
  const last = ownByDate.find((m) => events.some((e) => e.match_id === m.match_id)) ?? ownByDate[0];
  const rival = matches.filter((m) => m.kind === "rival").sort(byDate)[0];
  const lastEvents = last ? eventsOf(last) : [];
  const lastCounts = countByType(lastEvents, "own");

  // What is left to do, match by match (the steps that are not done).
  const pending = matches
    .filter((m) => m.kind !== "reference")
    .sort(byDate)
    .flatMap((m) => {
      const ev = eventsOf(m);
      const marks = state.segments.filter((g) => g.match_id === m.match_id);
      const vids = matchVideos(m).map((v) => v.video_id);
      const st = matchSteps({
        videoIds: vids,
        folder: m.folder,
        venueId: m.venue_id,
        segmentsByVideo: Object.fromEntries(vids.map((v) => [v, segmentsFromMarks(marks.filter((g) => videoOf(g) === v))])),
        events: ev,
        plays: state.plays.filter((p) => p.match_id === m.match_id),
        trackEdits: state.trackEdits,
        files: null,
      });
      return (
        [
          ["segments", "Tramos"],
          ["tag", "Eventos"],
        ] as const
      )
        .filter(([k]) => st[k].state === "partial" || st[k].state === "todo")
        .map(([k, label]) => ({ m, label, text: st[k].text, key: `${m.match_id}-${k}` }));
    })
    .slice(0, 6);

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

      {empty && (
        <Card className="mb-8">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <h2 className="text-lg text-ink">Sin datos en este navegador</h2>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} onClick={() => mutate(() => buildDemo())}>
                <Sparkle size={15} />
                Cargar datos de ejemplo
              </button>
              <Link href="/partidos" className="btn">
                Crear un partido
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </Card>
      )}

      <div className="mb-6 grid gap-4 xl:grid-cols-12">
        <Card title="Último partido" note={last?.date || undefined} className="xl:col-span-7">
          {last ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-3">
                <ScoreBug m={last} events={lastEvents} />
                {last.is_demo && <DemoBadge />}
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  ["Tiros", shotsOf(lastEvents, "own").length],
                  ["Recuperaciones", lastCounts.recovery],
                  ["Pérdidas", lastCounts.loss],
                  ["Eventos", lastEvents.length],
                ].map(([label, v]) => (
                  <div key={label as string} className="border-l border-line pl-3">
                    <div className="num text-3xl text-ink">{v}</div>
                    <div className="mt-1 text-xs text-muted">{label}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Link href={`/partido?id=${last.match_id}`} className={btnPrimary}>
                  Análisis
                  <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          ) : (
            <Link href="/partidos" className="btn">
              <VideoCamera size={15} />
              Crear un partido
            </Link>
          )}
        </Card>

        <Card title="Próximo rival" note={rival?.date || undefined} className="xl:col-span-5">
          {rival ? (
            <div className="flex flex-col gap-4">
              <div className="text-xl font-semibold text-ink">{rival.focus_team}</div>
              <div className="text-sm text-muted">
                Video: {rival.name} · {eventsOf(rival).length} eventos
              </div>
              <Link href={`/partido?id=${rival.match_id}`} className="btn self-start">
                Abrir
                <ArrowRight size={14} />
              </Link>
            </div>
          ) : (
            <Link href="/partidos" className="btn">
              Añadir un partido del rival
            </Link>
          )}
        </Card>
      </div>

      <div className="mb-6 grid gap-4 xl:grid-cols-12">
        <Card title="Pendiente" className="xl:col-span-7">
          {pending.length === 0 ? (
            <p className="text-sm text-muted">Nada pendiente en tramos ni eventos.</p>
          ) : (
            <ul>
              {pending.map((p) => (
                <li key={p.key} className="border-t border-line-soft first:border-t-0">
                  <Link href={`/partido?id=${p.m.match_id}`} className="flex items-center gap-3 py-2.5 text-sm transition-colors hover:text-accent-300">
                    <span className="flex-1 truncate text-ink">{p.m.name}</span>
                    <span className="cond text-xs font-bold text-muted uppercase">{p.label}</span>
                    <span className="w-56 truncate text-right text-xs text-faint">{p.text}</span>
                    <ArrowRight size={13} className="text-faint" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

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
      </div>

      {hasRatio && (
        <div className="grid gap-4 xl:grid-cols-12">
          <Card title="Carga aguda : crónica" note={`al ${ratio.asOf} · franja ${SAFE_ACWR[0]} – ${SAFE_ACWR[1]}`} className="xl:col-span-7">
            <AcwrChart players={ratio.players} band={SAFE_ACWR} />
          </Card>
          <Card title="Fuera de la franja" className="xl:col-span-5">
            {outOfBand.length === 0 ? (
              <p className="text-sm text-muted">Nadie.</p>
            ) : (
              <ul className="space-y-1.5">
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
        </div>
      )}
    </>
  );
}
