"use client";

import { useMemo, useState } from "react";
import { BinChart, CompareBars, EventTimeline, MomentumChart, PartsDuo, RateDuo, ScoreStrip, ShotMap, ZoneMap, type PartsRow } from "@/components/charts";
import { GoalsList } from "@/components/match/GoalsList";
import { useMomentPlayer } from "@/components/match/MomentPlayer";
import { PassesCards } from "@/components/match/PassesCards";
import { PlayerProfile } from "@/components/match/PlayerProfile";
import { PlayersCompare } from "@/components/match/PlayersCompare";
import { DeckView } from "@/components/match/DeckView";
import { Panel, PanelMatch } from "@/components/match/Panel";
import { PositionsCards } from "@/components/match/PositionsCards";
import { TeamShapeCard } from "@/components/match/TeamShape";
import { COLORS } from "@/components/Pitch";
import { Reveal } from "@/components/motion";
import { Card, Section, input } from "@/components/Shell";
import { setPref, usePref } from "@/lib/store";
import {
  BIN_MEASURES,
  COUNTERPRESS_WINDOW_S,
  SHOT_WINDOW_S,
  boxEntries,
  crosses,
  finalThirdEntries,
  firstPass,
  goalKicks,
  momentum,
  recoveryHeight,
  setPieces,
  shotBreakdown,
  timeBins,
  transitions,
  type BinMeasure,
  type Lanes,
  type Tally,
} from "@/lib/analysis";
import { momentOfEvent } from "@/lib/moments";
import { type Segment } from "@/lib/segments";
import { countByType, shotsOf, zoneCounts } from "@/lib/stats";
import { EVENT_DETAILS, EVENT_LABELS, EVENT_OUTCOMES, EVENT_TYPES, type EventType, type Match, type MatchEvent } from "@/lib/types";

const VIEWS = [
  ["ataque", "Ataque y balón parado"],
  ["defensa", "Transiciones y defensa"],
  ["tiempo", "A lo largo del partido"],
  ["jugadoras", "Jugadoras"],
  ["posiciones", "Posiciones"],
  ["presentacion", "Presentación"],
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
  const viewPref = usePref("analysis:view", "ataque");
  const view = (VIEWS.find(([id]) => id === viewPref)?.[0] ?? "ataque") as ViewId;
  const [zoneType, setZoneType] = useState<EventType>("recovery");
  const [zoneTeam, setZoneTeam] = useState<Side>("own");
  const [period, setPeriod] = useState<0 | 1 | 2>(0);
  const [binMin, setBinMin] = useState<5 | 10>(5);
  const [binMeasure, setBinMeasure] = useState<BinMeasure>("shots");
  const [counterTeam, setCounterTeam] = useState<Side>("own");
  const shotsPlayer = useMomentPlayer(match);
  // Analysis works on a joined axis: a moment is looked up by event id among the events with their own video times.
  const ownTimes = useMemo(() => (videoEvents ? new Map(videoEvents.map((e) => [e.event_id, e])) : null), [videoEvents]);

  const evs = period === 0 ? events : events.filter((e) => e.period === period);
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
      <Section title="Rendimiento individual" note="hasta 4 jugadoras, propias y rivales">
          <PlayersCompare match={match} events={[]} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </Section>
        <Section title="Pases y jugadoras" note="del tracking y a mano">
          <PassesCards match={match} events={[]} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </Section>
      <Section title="Con posiciones medidas" note="desde el tracking">
          <div className="mb-4">
            <TeamShapeCard match={match} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
          </div>
          <PositionsCards match={match} videoIds={videoIds} events={[]} />
        </Section>
      </div>
    );
  }

  const tr = { own: transitions(evs, "own"), opp: transitions(evs, "opp") };
  const bins = timeBins(evs, segments, binMin);
  const mom = momentum(evs, segments, 5);
  const counterZones = zoneCounts(tr[counterTeam].recoveriesToShot);

  // Rows for the split charts: one per team, with the labels of the contract values.
  const tallyRows = (get: (s: Side) => Tally, labels: Record<string, string>): PartsRow[] =>
    SIDES.map((s) => {
      const t = get(s);
      return { who: name(s), color: color(s), parts: Object.entries(labels).map(([k, label]) => ({ label, value: t.counts[k] ?? 0 })), unknown: t.unknown };
    });
  const laneRows = (get: (s: Side) => Lanes): PartsRow[] =>
    SIDES.map((s) => {
      const l = get(s);
      return {
        who: name(s),
        color: color(s),
        parts: [
          { label: "Izquierda", value: l.left },
          { label: "Centro", value: l.center },
          { label: "Derecha", value: l.right },
        ],
        unknown: l.missing,
      };
    });
  const shotRows: PartsRow[] = SIDES.map((s) => {
    const sh = shotBreakdown(evs, s);
    return {
      who: name(s),
      color: color(s),
      parts: [
        { label: "A puerta (con los goles)", value: sh.onTarget },
        { label: "Fuera", value: sh.offTarget },
        { label: "Bloqueado", value: sh.blocked },
      ],
      unknown: sh.unknown,
    };
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

  return (
    <PanelMatch.Provider value={match.match_id}>
    <div className="space-y-12">
      <div className="space-y-8">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <div className="seg">
            {([0, 1, 2] as const).map((p) => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} className="seg-opt">
                {p === 0 ? "Todo el partido" : `${p}.º tiempo`}
              </button>
            ))}
          </div>
        </div>

        {/* The score is the one big figure; the other headline numbers go in one row under it. Only when tagged: a zero
            would read as "none" when it was not noted. */}
        <Reveal>
          {(() => {
            const cards = (t: Side, c: string) => evs.filter((e) => e.type === "foul" && e.team === t && e.detail === c).length;
            const saves = (shooter: Side) => evs.filter((e) => e.type === "shot" && e.team === shooter && e.detail === "saved").length;
            const stats = [
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
      </div>

      {/* One topic at a time instead of one long page. */}
      <div className="seg flex-wrap" role="group" aria-label="Qué analizar">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setPref("analysis:view", id)} className="seg-opt">
            {label}
          </button>
        ))}
      </div>

      {view === "ataque" && (
        <>
      <Section title="Ataque organizado">
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="¿Desde dónde tiran?">
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
          <div className="space-y-5">
            <Panel title="¿Cuántos tiros van a puerta?" delay={80}>
              <PartsDuo rows={shotRows} unknownLabel="sin resultado anotado" />
            </Panel>
            <Panel title="¿Cuántas entradas al área acaban en tiro?" note={`tiro en menos de ${SHOT_WINDOW_S} s`} delay={140}>
              <RateDuo a={boxEntries(evs, "own")} b={boxEntries(evs, "opp")} aLabel={A} bLabel={B} unit="entradas al área" />
            </Panel>
          </div>
          <Panel title="¿Por qué carril llegan al último tercio?" note="visto por quien ataca">
            <PartsDuo rows={laneRows((s) => finalThirdEntries(evs, s))} unknownLabel="sin posición" />
          </Panel>
          <Panel title="¿Cómo salen desde su portería?" delay={80}>
            <PartsDuo rows={tallyRows((s) => goalKicks(evs, s).length, EVENT_DETAILS.goal_kick ?? {})} />
            <div className="hr-fade my-4" />
            <PartsDuo rows={tallyRows((s) => goalKicks(evs, s).outcome, EVENT_OUTCOMES.goal_kick ?? {})} />
          </Panel>
          <Panel title="Centros: ¿desde qué banda y cuántos se rematan?" className="xl:col-span-2">
            <div className="grid gap-6 md:grid-cols-2">
              <PartsDuo rows={laneRows((s) => crosses(evs, s).lanes)} unknownLabel="sin posición" />
              <PartsDuo rows={tallyRows((s) => crosses(evs, s).outcome, EVENT_OUTCOMES.cross ?? {})} />
            </div>
          </Panel>
        </div>
      </Section>

      <Section title="Balón parado">
        <div className="grid gap-5 xl:grid-cols-3">
          <Panel title="Córners: ¿cómo acaban?">
            <PartsDuo rows={tallyRows((s) => setPieces(evs, s).corners, EVENT_OUTCOMES.corner ?? {})} />
          </Panel>
          <Panel title="Córners: ¿cómo los mandan?" delay={80}>
            <PartsDuo rows={tallyRows((s) => setPieces(evs, s).delivery, EVENT_DETAILS.corner ?? {})} />
          </Panel>
          <Panel title="Tiros libres: ¿cómo acaban?" delay={160}>
            <PartsDuo rows={tallyRows((s) => setPieces(evs, s).freeKicks, EVENT_OUTCOMES.free_kick ?? {})} />
          </Panel>
        </div>
        <p className="mt-3 text-xs text-pretty text-faint">
          Quién los cobra y a quién buscan, y cómo defienden en contra, se anotan en el número de jugadora y en la nota de cada evento:
          se leen en la tabla de eventos, no se cuentan.
        </p>
      </Section>
        </>
      )}

      {view === "defensa" && (
        <>
      <Section title="Transiciones" note="al perder y al recuperar el balón">
        <div className="grid gap-5 xl:grid-cols-3">
          <Panel title="Pérdidas que acaban en tiro del contrario" note={`en menos de ${SHOT_WINDOW_S} s`}>
            <RateDuo a={tr.own.lossToShotAgainst} b={tr.opp.lossToShotAgainst} aLabel={A} bLabel={B} unit="pérdidas" />
          </Panel>
          <Panel title="Pérdidas que recuperan enseguida" note={`en menos de ${COUNTERPRESS_WINDOW_S} s`} delay={80}>
            <RateDuo a={tr.own.counterpress} b={tr.opp.counterpress} aLabel={A} bLabel={B} unit="pérdidas" />
          </Panel>
          <Panel title="Recuperaciones que acaban en tiro propio" note={`en menos de ${SHOT_WINDOW_S} s`} delay={160}>
            <RateDuo a={tr.own.recoveryToShot} b={tr.opp.recoveryToShot} aLabel={A} bLabel={B} unit="recuperaciones" />
          </Panel>
          <Panel title="¿Desde dónde salen las recuperaciones que acaban en tiro?" className="xl:col-span-2">
            <div className="mb-3 seg">
              {SIDES.map((s) => (
                <button key={s} type="button" aria-pressed={counterTeam === s} onClick={() => setCounterTeam(s)} className="seg-opt">
                  {name(s)}
                </button>
              ))}
            </div>
            {tr[counterTeam].recoveriesToShot.length === 0 ? (
              <p className="text-sm text-faint">Ninguna recuperación de {name(counterTeam)} acabó en tiro en esta selección.</p>
            ) : (
              <div className="mx-auto max-w-xl">
                <ZoneMap grid={counterZones.grid} missing={counterZones.missing} />
              </div>
            )}
          </Panel>
          <Panel title="Tras recuperar, ¿adelante o atrás?" note="primer pase" delay={80}>
            <PartsDuo rows={tallyRows((s) => firstPass(evs, s), EVENT_DETAILS.recovery ?? {})} />
          </Panel>
        </div>
      </Section>

      <Section title="Defensa organizada">
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="¿A qué altura recuperan?">
            <PartsDuo rows={heightRows} unknownLabel="sin posición" />
            <p className="mt-4 text-xs text-pretty text-faint">
              Los tiros en contra de cada equipo están en el mapa de tiros de arriba, y por qué carril les llegan, en las entradas al último
              tercio del contrario.
            </p>
          </Panel>
          <Panel title="¿Dónde ocurre? Zonas de la cancha" note="elige el evento" delay={80}>
            <div className="mb-2 flex flex-wrap gap-2">
              <select className={input} value={zoneType} aria-label="Tipo de evento" onChange={(e) => setZoneType(e.target.value as EventType)}>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_LABELS[t]}
                  </option>
                ))}
              </select>
              <select className={input} value={zoneTeam} aria-label="Equipo" onChange={(e) => setZoneTeam(e.target.value as Side)}>
                <option value="own">{A}</option>
                <option value="opp">{B}</option>
              </select>
            </div>
            <ZoneMap grid={zones.grid} missing={zones.missing} />
          </Panel>
        </div>
      </Section>
        </>
      )}


      {view === "tiempo" && (
        <>
      <Section title="A lo largo del partido">
        <div className="space-y-5">
          <Panel title="Momentum" note={`quién crea más peligro, en ventanas de ${mom.windowMin} min`} defaultWide>
            <MomentumChart points={mom.points} aLabel={A} bLabel={B} />
            <p className="mt-2 text-xs text-pretty text-faint">Suma el peligro de goles, tiros, entradas al área y al último tercio, córners y centros de cada equipo. Pasa el cursor por un minuto para ver las cifras.</p>
          </Panel>
          <Panel
            title="¿En qué tramo generan y reciben más?"
            note={
              bins.basis === "juego"
                ? `minutos de juego${bins.skipped ? ` · ${bins.skipped} evento(s) en pausa fuera` : ""}`
                : "minutos de video desde el primer evento: marca los tramos para contar minutos de juego"
            }
          >
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="seg">
                {([5, 10] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={binMin === m} onClick={() => setBinMin(m)} className="seg-opt">
                    Cada {m} min
                  </button>
                ))}
              </div>
              <select className={input} value={binMeasure} aria-label="Qué se cuenta" onChange={(e) => setBinMeasure(e.target.value as BinMeasure)}>
                {Object.entries(BIN_MEASURES).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <BinChart key={`${binMin}-${binMeasure}`} bins={bins.bins.map((x) => ({ label: x.label, a: x.own[binMeasure], b: x.opp[binMeasure] }))} aLabel={A} bLabel={B} />
            <p className="mt-3 text-xs text-pretty text-faint">
              Para ver si cambian tras el descanso, compara «1.º tiempo» y «2.º tiempo» con el selector de arriba.
            </p>
          </Panel>
          <Panel title="Línea de tiempo" note="un carril por tipo de evento">
            <EventTimeline events={evs} segments={segments} aLabel={A} bLabel={B} timeLabel={timeLabel} />
          </Panel>
          <Panel title="Todos los eventos por tipo">
            <CompareBars aLabel={A} bLabel={B} rows={EVENT_TYPES.map((t) => ({ label: EVENT_LABELS[t], a: a[t], b: b[t] }))} />
          </Panel>
        </div>
      </Section>
        </>
      )}

      {view === "jugadoras" && (
        <>
      <Section title="Ficha de jugadora" note="su partido: cifras, zonas, tiros y jugadas">
        <PlayerProfile match={match} events={evs} videoIds={videoIds} segmentsByVideo={segmentsByVideo} ownTimes={ownTimes} timeLabel={timeLabel} />
      </Section>

      <Section title="Rendimiento individual" note="hasta 4 jugadoras, propias y rivales">
        <PlayersCompare match={match} events={evs} videoIds={videoIds} segmentsByVideo={segmentsByVideo} periodNote={period !== 0} />
      </Section>

      <Section title="Pases y jugadoras" note="pases del tracking y a mano; eventos por jugadora">
        <PassesCards match={match} events={videoEvents ?? events} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
      </Section>
        </>
      )}

      {view === "posiciones" && (
        <>
      <Section title="Con posiciones medidas" note="desde el tracking">
        <div className="mb-4">
          <TeamShapeCard match={match} videoIds={videoIds} segmentsByVideo={segmentsByVideo} />
        </div>
        <PositionsCards match={match} videoIds={videoIds} events={videoEvents ?? events} />
      </Section>
        </>
      )}
      {view === "presentacion" && <DeckView match={match} />}
    </div>
    </PanelMatch.Provider>
  );
}
