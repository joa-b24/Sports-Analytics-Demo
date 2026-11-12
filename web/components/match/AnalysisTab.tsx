"use client";

import { Crosshair, ShieldCheck, SquaresFour, UserFocus } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnalysisFilter, type MinuteRange, type Period } from "@/components/match/AnalysisFilter";
import { EntryMap, GOAL_KICK_STYLES, OutcomeMap, SET_PIECE_STYLES, TerritoryMap } from "@/components/match/AttackMaps";
import { Fold } from "@/components/match/Fold";
import { analysisParamsOf } from "@/lib/tech";
import { Select } from "@/components/Select";
import { useHeaderRightSlot, useHeaderSlot } from "@/lib/stepBus";
import { useTracking } from "@/lib/useTracking";
import { BinChart, EventTimeline, FigureList, MirrorBars, MomentumChart, PartsDuo, ScoreStrip, ShotMap, ZoneMap, type PartsRow } from "@/components/charts";
import { GoalsList } from "@/components/match/GoalsList";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { PassesCards } from "@/components/match/PassesCards";
import { PlayerProfile } from "@/components/match/PlayerProfile";
import { PlayersCompare } from "@/components/match/PlayersCompare";
import { Panel, PanelMatch } from "@/components/match/Panel";
import { TeamShapeCard } from "@/components/match/TeamShape";
import { COLORS } from "@/components/Pitch";
import { Reveal } from "@/components/motion";
import { Card, Section } from "@/components/Shell";
import { setPref, usePref } from "@/lib/store";
import {
  BIN_MEASURES,
  SHOT_WINDOW_S,
  boxEntries,
  firstPass,
  goalKickLanding,
  isCrossLike,
  momentumCurve,
  playTime,
  recoveryHeight,
  shotBreakdown,
  timeBins,
  transitions,
  type BinMeasure,
  type Tally,
} from "@/lib/analysis";
import { momentOfEvent } from "@/lib/moments";
import { clipPlayWindow, type Segment } from "@/lib/segments";
import { TrackingWindow } from "@/lib/trackingWindow";
import { matchVideos } from "@/lib/videos";
import { countByType, shotsOf, zoneCounts } from "@/lib/stats";
import { EVENT_DETAILS, EVENT_LABELS, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";

// The sections of the dashboard, from the general reading to the individual one.
const VIEWS = [
  ["general", "General", SquaresFour],
  ["ataque", "Ataque", Crosshair],
  ["defensa", "Defensa", ShieldCheck],
  ["individual", "Rendimiento individual", UserFocus],
] as const;
type ViewId = (typeof VIEWS)[number][0];

type Side = "own" | "opp";
const SIDES: Side[] = ["own", "opp"];

// Each card answers one question of docs/preguntas_cuerpo_tecnico.md; the code (A1, B2...) is shown as its note.
type Props = {
  match: Match;
  // Whole match on one time axis (lib/videos.ts): with several videos, t_video here is not a video time.
  events: MatchEvent[];
  segments: Segment[];
  // How to write the moment of an event when the axis is not the video's.
  timeLabel?: (e: MatchEvent) => string;
  // Videos of the match, to read their team metrics from the match folder.
  videoIds?: string[];
  // The same events with their own video times, to place them in the measured positions.
  videoEvents?: MatchEvent[];
  // Play stretches of each video, for what is read from the tracking (individual performance).
  segmentsByVideo?: Record<string, Segment[]>;
};

export function AnalysisTab({ match, events, segments, timeLabel, videoIds = ["v1"], videoEvents, segmentsByVideo = {} }: Props) {
  const viewPref = usePref("analysis:view", "general");
  const view = (VIEWS.find(([id]) => id === viewPref)?.[0] ?? "general") as ViewId;
  const [zoneType, setZoneType] = useState<EventType>("recovery");
  const [zoneTeam, setZoneTeam] = useState<Side>("own");
  const [period, setPeriod] = useState<Period>(0);
  const [range, setRange] = useState<MinuteRange>(null);
  const [binMin, setBinMin] = useState<5 | 10>(5);
  const [counterTeam, setCounterTeam] = useState<Side>("own");
  const [detailTeam, setDetailTeam] = useState<Side | "both">("own");
  const shotsPlayer = useMomentPlayer(match);
  const headerSlot = useHeaderSlot();
  const rightSlot = useHeaderRightSlot();
  // Passes completed (read from the tracking): the headline row counts them with possession.
  const trk = useTracking(match, videoIds, segmentsByVideo);
  const passTotals = useMemo(() => {
    const own = trk.view.passes("own");
    const opp = trk.view.passes("opp");
    if (!own || !opp) return null;
    return own.completed + own.cut + opp.completed + opp.cut > 0 ? { own, opp } : null;
  }, [trk]);
  // Analysis works on a joined axis: a moment is looked up by event id among the events with their own video times.
  const ownTimes = useMemo(() => (videoEvents ? new Map(videoEvents.map((e) => [e.event_id, e])) : null), [videoEvents]);

  // The clock of the filter by minutes: minutes of play when the stretches are marked, else of video since the first event
  // (the same clock as the time bins).
  const hasPlay = segments.some((g) => g.tipo === "juego");
  const t0 = events.length ? Math.min(...events.map((e) => e.t_video)) : 0;
  const minuteOf = (e: MatchEvent): number | null => {
    const t = hasPlay ? playTime(segments, e.t_video) : e.t_video - t0;
    return t === null ? null : t / 60;
  };
  const lastMin = Math.max(0, ...events.map((e) => minuteOf(e) ?? 0));
  const byPeriod = period === 0 ? events : events.filter((e) => e.period === period);
  // The tracking follows the filter too: the play stretches cut to the window (null without a filter).
  const windowSegs = useMemo(() => {
    if (!hasPlay || (period === 0 && !range)) return null;
    const inPeriod = period === 0 ? null : matchVideos(match).filter((v, i) => (v.period ?? (i === 0 ? 1 : 2)) === period).map((v) => v.video_id);
    return clipPlayWindow(videoIds, segmentsByVideo, range ? { from: range[0], to: range[1] } : null, inPeriod);
  }, [hasPlay, period, range, match, videoIds, segmentsByVideo]);
  const trackingWindow = useMemo(() => ({ segments: windowSegs, allEvents: events }), [windowSegs, events]);
  const evs = range ? byPeriod.filter((e) => { const m = minuteOf(e); return m !== null && m >= range[0] && m < range[1]; }) : byPeriod;
  const a = countByType(evs, "own");
  const b = countByType(evs, "opp");
  const A = match.focus_team;
  const B = match.other_team;
  const name = (s: Side) => (s === "own" ? A : B);
  const color = (s: Side) => (s === "own" ? COLORS.own : COLORS.opp);
  const zones = zoneCounts(evs.filter((e) => e.type === zoneType && e.team === zoneTeam));

  if (events.length === 0) {
    return (
      <div className="space-y-8">
        <Card>
          <p className="text-sm text-muted">
            Aún no hay eventos etiquetados en este partido. Los gráficos de eventos se calculan solo con lo que etiquetes en «Video y
            etiquetado»; los de posiciones, abajo, salen de las partes corregidas.
          </p>
        </Card>
        <Section title="Pases y jugadoras" note="pases del tracking">
          <PassesCards match={match} events={[]} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </Section>
        <Section title="Bloque" note="forma del equipo, desde el tracking">
          <TeamShapeCard match={match} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </Section>
        <Section title="Perfil comparativo" note="hasta 4 jugadoras, propias y rivales">
          <PlayersCompare match={match} events={[]} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </Section>
      </div>
    );
  }

  const cfg = analysisParamsOf(match);
  const tr = { own: transitions(evs, "own", cfg), opp: transitions(evs, "opp", cfg) };
  const bins = timeBins(evs, segments, binMin);
  const mom = momentumCurve(evs, segments, range ? { from: range[0], to: range[1] } : null);
  const counterZones = zoneCounts(tr[counterTeam].recoveriesToShot);

  // Rows for the split charts: one per team, with the labels of the contract values.
  const tallyRows = (get: (s: Side) => Tally, labels: Record<string, string>): PartsRow[] =>
    SIDES.map((s) => {
      const t = get(s);
      return { who: name(s), color: color(s), parts: Object.entries(labels).map(([k, label]) => ({ label, value: t.counts[k] ?? 0 })), unknown: t.unknown };
    });
  const heightRows: PartsRow[] = SIDES.map((s) => {
    const h = recoveryHeight(evs, s);
    return {
      who: name(s),
      color: color(s),
      parts: [
        { label: "Campo rival", value: h.rival },
        { label: "Medio", value: h.middle },
        { label: "Campo propio", value: h.own },
      ],
      unknown: h.missing,
    };
  });

  // Headline figures of each section. A share is null when its base is empty (never a made-up 0).
  const pct = (k: number, n: number) => (n > 0 ? Math.round((100 * k) / n) : null);
  const shotsN = { own: shotBreakdown(evs, "own"), opp: shotBreakdown(evs, "opp") };
  const conversion = (s: Side) => pct(s === "own" ? a.goal : b.goal, shotsN[s].total);
  const onTargetPct = (s: Side) => pct(shotsN[s].onTarget, shotsN[s].total);
  // Field tilt from the events: the share of the entries to the last third and the box that each team makes (the share
  // of touches in the last third needs the ball followed everywhere).
  const entries = { own: a.final_third_entry + a.box_entry, opp: b.final_third_entry + b.box_entry };
  const tilt = (s: Side) => pct(entries[s], entries.own + entries.opp);
  const rate = (r: { k: number; n: number }) => pct(r.k, r.n);
  const box = { own: boxEntries(evs, "own"), opp: boxEntries(evs, "opp") };
  const recH = { own: recoveryHeight(evs, "own"), opp: recoveryHeight(evs, "opp") };
  const highPct = (s: Side) => pct(recH[s].rival, recH[s].rival + recH[s].middle + recH[s].own);
  const recZones = zoneCounts(evs.filter((e) => e.type === "recovery" && e.team === counterTeam));

  const tabs = (
    <div role="tablist" aria-label="Secciones del dashboard" className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-surface p-1">
      {VIEWS.map(([id, label, Icon]) => {
        const on = view === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setPref("analysis:view", id)}
            className={`relative inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors duration-150 ${
              on ? "bg-raised text-ink shadow-[inset_0_-2px_0_var(--color-own)]" : "text-muted hover:bg-raised/50 hover:text-ink"
            }`}
          >
            <Icon size={15} weight={on ? "fill" : "regular"} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <TrackingWindow.Provider value={trackingWindow}>
    <PanelMatch.Provider value={match.match_id}>
    {(() => {
      const filter = <AnalysisFilter period={period} onPeriod={setPeriod} range={range} onRange={setRange} lastMin={lastMin} />;
      return headerSlot && rightSlot ? (
        <>
          {createPortal(tabs, headerSlot)}
          {createPortal(filter, rightSlot)}
        </>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {tabs}
          {filter}
        </div>
      );
    })()}
    <div className="space-y-8">
      {view === "general" && (
        <>
      {/* The score is the one big figure; the other headline numbers go in one row under it. Only when tagged: a zero
          would read as "none" when it was not noted. */}
      <Reveal>
        {(() => {
          const cards = (t: Side, c: string) => evs.filter((e) => e.type === "foul" && e.team === t && e.detail === c).length;
          const saves = (shooter: Side) => evs.filter((e) => e.type === "shot" && e.team === shooter && e.detail === "saved").length;
          // Possession (share of the time the ball was followed) and completed passes lead the row: they say who ran the game.
          const held = match.possession ? match.possession.own + match.possession.opp : 0;
          const ownPct = held > 0 && match.possession ? Math.round((100 * match.possession.own) / held) : null;
          const passPct = (p: { completed: number; cut: number }) => (p.completed + p.cut > 0 ? Math.round((100 * p.completed) / (p.completed + p.cut)) : null);
          const stats = [
            ...(ownPct !== null ? [{ label: "Posesión", a: ownPct, b: 100 - ownPct, unit: "%" }] : []),
            ...(passTotals
              ? [{ label: "Pases completados", a: passTotals.own.completed, b: passTotals.opp.completed, note: `acierto ${passPct(passTotals.own) ?? "–"} % · ${passPct(passTotals.opp) ?? "–"} %` }]
              : []),
            { label: "Tiros", a: shotsOf(evs, "own").length, b: shotsOf(evs, "opp").length },
            { label: "Recuperaciones", a: a.recovery, b: b.recovery },
            { label: "Pérdidas", a: a.loss, b: b.loss },
            ...(cards("own", "yellow") + cards("opp", "yellow") > 0 ? [{ label: "Amarillas", a: cards("own", "yellow"), b: cards("opp", "yellow") }] : []),
            ...(cards("own", "red") + cards("opp", "red") > 0 ? [{ label: "Rojas", a: cards("own", "red"), b: cards("opp", "red") }] : []),
            ...(a.offside + b.offside > 0 ? [{ label: "Fueras de lugar", a: a.offside, b: b.offside }] : []),
            ...(saves("own") + saves("opp") > 0 ? [{ label: "Atajadas", a: saves("opp"), b: saves("own") }] : []),
          ];
          return <ScoreStrip aLabel={A} bLabel={B} goals={[a.goal, b.goal]} stats={stats} />;
        })()}
      </Reveal>

      <Section title="Cómo se jugó" note="quién creó más peligro y con qué eficacia">
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(15rem,2fr)]">
          <Panel title="Momentum" note="quién crea más peligro, y cuánto dura">
            <MomentumChart curve={mom} aLabel={A} bLabel={B} />
          </Panel>
          <Panel title="Dominio territorial" note="quién ocupó cada zona" delay={80}>
            <TerritoryMap events={evs} aLabel={A} bLabel={B} cols={cfg.zones * 2} rows={cfg.lanes} />
            <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <span className="text-xs text-muted">Field tilt</span>
              <span className="num text-2xl" style={{ color: COLORS.own }}>
                {tilt("own") ?? "–"}
                {tilt("own") !== null && <span className="text-sm"> %</span>}
              </span>
              <span className="text-xs text-faint">|</span>
              <span className="num text-2xl" style={{ color: COLORS.opp }}>
                {tilt("opp") ?? "–"}
                {tilt("opp") !== null && <span className="text-sm"> %</span>}
              </span>
            </div>
          </Panel>
        </div>
      </Section>

      <Section title="A lo largo del partido">
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Generación por tramos"
            note={
              bins.basis === "juego"
                ? `minutos de juego${bins.skipped ? ` · ${bins.skipped} evento(s) en pausa fuera` : ""}`
                : "minutos de video desde el primer evento: marca los tramos para contar minutos de juego"
            }
          >
            <div className="mb-4 seg w-fit">
              {([5, 10] as const).map((m) => (
                <button key={m} type="button" aria-pressed={binMin === m} onClick={() => setBinMin(m)} className="seg-opt">
                  Cada {m} min
                </button>
              ))}
            </div>
            <div className="space-y-6">
              {(Object.keys(BIN_MEASURES) as BinMeasure[]).map((k) => (
                <div key={k}>
                  <div className="eyebrow mb-1.5">{BIN_MEASURES[k]}</div>
                  <BinChart key={`${binMin}-${k}`} bins={bins.bins.map((x) => ({ label: x.label, a: x.own[k], b: x.opp[k] }))} aLabel={A} bLabel={B} />
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Todos los eventos por tipo" note="lo etiquetado, por equipo" delay={80}>
            <MirrorBars aLabel={A} bLabel={B} rows={EVENT_TYPES.filter((t) => a[t] + b[t] > 0).map((t) => ({ label: EVENT_LABELS[t], a: a[t], b: b[t] }))} />
          </Panel>
        </div>
        <div className="mt-5">
          <Fold id="general-linea" title="Línea de tiempo" note="un carril por tipo de evento, minuto a minuto">
            <EventTimeline events={evs} segments={segments} aLabel={A} bLabel={B} timeLabel={timeLabel} />
          </Fold>
        </div>
      </Section>
        </>
      )}

      {view === "ataque" && (
        <>
      <Section title="Cómo atacan" note="dónde tiran y qué tan bien lo aprovechan">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="Mapa de tiros">
            <ShotMap
              events={evs}
              aLabel={A}
              bLabel={B}
              onPick={(e) => shotsPlayer.show(momentOfEvent(e, ownTimes, `${EVENT_LABELS[e.type]} de ${name(e.team === "own" ? "own" : "opp")}${e.player_id ? ` · ${e.player_id}` : ""}`))}
            />
            <GoalsList
              goals={evs.filter((e) => e.type === "goal")}
              aLabel={A}
              bLabel={B}
              timeLabel={timeLabel}
              onPick={(e) => shotsPlayer.show(momentOfEvent(e, ownTimes, `Gol de ${name(e.team === "own" ? "own" : "opp")}${e.player_id ? ` · ${e.player_id}` : ""}`))}
            />
            {shotsPlayer.panel}
          </Panel>
          <Panel title="La cifra" note="lo que dice el mapa" delay={80}>
            <FigureList
              aLabel={A}
              bLabel={B}
              rows={[
                { label: "Tiros a puerta", a: onTargetPct("own"), b: onTargetPct("opp"), unit: " %", note: `${shotsN.own.onTarget} de ${shotsN.own.total} · ${shotsN.opp.onTarget} de ${shotsN.opp.total}` },
                { label: "Conversión de gol", a: conversion("own"), b: conversion("opp"), unit: " %", note: "goles entre tiros" },
                { label: "Entradas al área que acaban en tiro", a: rate(box.own), b: rate(box.opp), unit: " %", note: `tiro en menos de ${SHOT_WINDOW_S} s · ${box.own.n} y ${box.opp.n} entradas` },
                { label: "Dominio territorial (field tilt)", a: tilt("own"), b: tilt("opp"), unit: " %" },
              ]}
            />
          </Panel>
        </div>
      </Section>

      <Fold id="ataque-detalle" title="Más detalle del ataque" note="entradas, saques de meta, centros, córners y tiros libres, en mapas">
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg" role="group" aria-label="Equipo de los mapas">
            {([...SIDES, "both"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={detailTeam === s} onClick={() => setDetailTeam(s)} className="seg-opt">
                {s === "both" ? "Comparar" : name(s)}
              </button>
            ))}
          </div>
          <span className="text-xs text-faint">Vistos con cada equipo atacando hacia la derecha.</span>
        </div>
        {(() => {
          // One map per team: both side by side when comparing, so each panel shows the two teams.
          const sides: Side[] = detailTeam === "both" ? [...SIDES] : [detailTeam];
          const maps = (render: (team: Side) => React.ReactNode) => (
            <div className={sides.length > 1 ? "grid gap-4 sm:grid-cols-2" : ""}>
              {sides.map((t) => (
                <div key={t} className="min-w-0">
                  {sides.length > 1 && <div className="eyebrow mb-1.5">{name(t)}</div>}
                  {render(t)}
                </div>
              ))}
            </div>
          );
          const of = (t: Side, f: (e: MatchEvent) => boolean) => evs.filter((e) => e.team === t && f(e));
          return (
            <div className={`grid gap-5 ${sides.length > 1 ? "" : "xl:grid-cols-2"}`}>
              <Panel title="Entradas al último tercio" note="por dónde llegan">
                {maps((t) => (
                  <EntryMap events={of(t, (e) => e.type === "final_third_entry")} team={t} lanes={cfg.lanes} />
                ))}
              </Panel>
              <Panel title="Saques de meta" note="de dónde a dónde (inferido) y si la conservan">
                {maps((t) => (
                  <OutcomeMap events={of(t, (e) => e.type === "goal_kick")} team={t} styles={GOAL_KICK_STYLES} inferred={goalKickLanding(evs)} />
                ))}
                <p className="mt-2 mb-0 text-[11px] text-faint">La línea punteada es el destino inferido: el siguiente evento con posición poco después del saque (5 s si es corto, 10 s si es largo). Es una estimación.</p>
              </Panel>
              <Panel title="Centros" note="de dónde a dónde, y cómo acaban">
                {maps((t) => (
                  <OutcomeMap events={of(t, isCrossLike)} team={t} styles={SET_PIECE_STYLES} />
                ))}
              </Panel>
              <Panel title="Balón parado" note="córners y tiros libres: de dónde a dónde, y cómo acaban">
                {maps((t) => (
                  <OutcomeMap events={of(t, (e) => e.type === "corner" || e.type === "free_kick")} team={t} styles={SET_PIECE_STYLES} />
                ))}
              </Panel>
            </div>
          );
        })()}
        <p className="text-xs text-pretty text-faint">
          Quién cobra el balón parado y a quién busca, y cómo defienden en contra, se anotan en el número de jugadora y en la nota de cada evento:
          se leen en la tabla de eventos, no se cuentan.
        </p>
      </Fold>
        </>
      )}

      {view === "defensa" && (
        <>
      <Section title="Cómo defienden" note="dónde recuperan y qué pasa al perder y al recuperar">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel title="Mapa de recuperaciones">
            <div className="mb-3 seg">
              {SIDES.map((s) => (
                <button key={s} type="button" aria-pressed={counterTeam === s} onClick={() => setCounterTeam(s)} className="seg-opt">
                  {name(s)}
                </button>
              ))}
            </div>
            {recZones.grid.flat().every((v) => v === 0) ? (
              <p className="text-sm text-faint">{name(counterTeam)} no tiene recuperaciones con posición en esta selección.</p>
            ) : (
              <div className="mx-auto max-w-xl">
                <ZoneMap grid={recZones.grid} missing={recZones.missing} />
              </div>
            )}
          </Panel>
          <Panel title="La cifra" note="lo que dice el mapa" delay={80}>
            <FigureList
              aLabel={A}
              bLabel={B}
              rows={[
                { label: "Recuperaciones en campo rival", a: highPct("own"), b: highPct("opp"), unit: " %", note: `${recH.own.rival} de ${a.recovery} · ${recH.opp.rival} de ${b.recovery}` },
                { label: "Pérdidas que acaban en tiro del contrario", a: rate(tr.own.lossToShotAgainst), b: rate(tr.opp.lossToShotAgainst), unit: " %", note: `en menos de ${cfg.lossShotS} s (menos es mejor)` },
                { label: "Pérdidas que recuperan enseguida", a: rate(tr.own.counterpress), b: rate(tr.opp.counterpress), unit: " %", note: `en menos de ${cfg.quickRecoveryS} s` },
                { label: "Recuperaciones que acaban en tiro", a: rate(tr.own.recoveryToShot), b: rate(tr.opp.recoveryToShot), unit: " %", note: `en menos de ${cfg.recoveryAttackS} s` },
              ]}
            />
          </Panel>
        </div>
      </Section>

      <Fold id="defensa-detalle" title="Más detalle de la defensa" note="transiciones, altura y zonas por evento">
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="Mapa de recuperaciones que acaban en tiro">
            {tr[counterTeam].recoveriesToShot.length === 0 ? (
              <p className="text-sm text-faint">Ninguna recuperación de {name(counterTeam)} acabó en tiro en esta selección.</p>
            ) : (
              <div className="mx-auto max-w-xl">
                <ZoneMap grid={counterZones.grid} missing={counterZones.missing} />
              </div>
            )}
          </Panel>
          <Panel title="Primer pase tras recuperar" note="primer pase">
            <PartsDuo rows={tallyRows((s) => firstPass(evs, s), EVENT_DETAILS.recovery ?? {})} />
          </Panel>
          <Panel title="Altura de recuperación">
            <PartsDuo rows={heightRows} unknownLabel="sin posición" />
            <p className="mt-4 text-xs text-pretty text-faint">
              Los tiros en contra de cada equipo están en el mapa de tiros de Ataque, y por qué carril les llegan, en las entradas al último tercio del contrario.
            </p>
          </Panel>
          <Panel title="Mapa de zonas" note="elige el evento">
            <div className="mb-2 flex flex-wrap gap-2">
              <Select
                variant="field"
                label="Tipo de evento"
                value={zoneType}
                onChange={(v) => v && setZoneType(v)}
                options={EVENT_TYPES.map((t) => ({ value: t, label: EVENT_LABELS[t] }))}
              />
              <Select
                variant="field"
                label="Equipo"
                value={zoneTeam}
                onChange={(v) => v && setZoneTeam(v)}
                options={[
                  { value: "own" as Side, label: A, color: COLORS.own },
                  { value: "opp" as Side, label: B, color: COLORS.opp },
                ]}
              />
            </div>
            <ZoneMap grid={zones.grid} missing={zones.missing} />
          </Panel>
        </div>
      </Fold>
        </>
      )}

      {view === "individual" && (
        <>
      <Section title="Pases y jugadoras" note="pases del tracking; eventos por jugadora">
        <PassesCards match={match} events={videoEvents ?? events} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
      </Section>

      <Section title="Bloque" note="forma del equipo, desde el tracking">
        <TeamShapeCard match={match} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
      </Section>

      <Section title="Ficha de jugadora" note="su partido: cifras, mapa y jugadas">
        <div id="ficha-jugadora" className="scroll-mt-24" />
        <PlayerProfile match={match} events={evs} videoIds={videoIds} segmentsByVideo={segmentsByVideo} ownTimes={ownTimes} timeLabel={timeLabel} />
      </Section>

      <Section title="Perfil comparativo" note="hasta 4 jugadoras, propias y rivales">
        <PlayersCompare match={match} events={evs} videoIds={videoIds} segmentsByVideo={segmentsByVideo} periodNote={period !== 0} />
      </Section>
        </>
      )}
    </div>
    </PanelMatch.Provider>
    </TrackingWindow.Provider>
  );
}
