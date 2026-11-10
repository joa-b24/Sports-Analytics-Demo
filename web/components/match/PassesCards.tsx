"use client";

import { useMemo, useState } from "react";
import { Locked } from "@/components/Locked";
import { Panel } from "@/components/match/Panel";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import { TrackingLoading } from "@/components/TrackingLoading";
import { useFixedParts } from "@/lib/fixed";
import { networkFromPasses, passStats, type Net, type PlayerPasses } from "@/lib/passes";
import { PASS_SOURCE_LABEL, trackedNet, trackedPasses, type PassSource } from "@/lib/passSources";
import { passStretches } from "@/lib/positions";
import { type Segment } from "@/lib/segments";
import { useStore } from "@/lib/store";
import { EVENT_LABELS, type EventType, type Match, type MatchEvent } from "@/lib/types";

// Pass network and the numbers of each player, from the two sources the app has: the passes read from the tracking
// (ball + players, the Informe uses them) and the ones tagged by hand before pass 4 was removed (kept so old data
// still shows). They are shown apart, never added: the same pass could be in both. Every figure says its source.

type Side = "own" | "opp";
// Events counted per player in the table, in this order.
const PER_PLAYER: EventType[] = ["shot", "goal", "key_pass", "loss", "recovery", "foul"];


export function PassesCards({
  match,
  events,
  videoIds = ["v1"],
  segmentsByVideo = {},
}: {
  match: Match;
  events: MatchEvent[];
  videoIds?: string[];
  segmentsByVideo?: Record<string, Segment[]>;
}) {
  const { passes: all = [], roster = [] } = useStore();
  const fixed = useFixedParts(match.folder, videoIds);
  const parts = useMemo(() => fixed?.parts ?? [], [fixed]);
  const [team, setTeam] = useState<Side>("own");
  const hand = useMemo(() => all.filter((p) => p.match_id === match.match_id && p.team === team), [all, match.match_id, team]);
  const numberOf = new Map((match.kind === "own" ? roster : []).map((p) => [p.player_id, p.number]));
  const label = (id: string) => (numberOf.get(id) != null ? String(numberOf.get(id)) : id.replace(/^#/, ""));

  const tracked = useMemo(() => trackedPasses(parts, team, segmentsByVideo), [parts, team, segmentsByVideo]);
  const trackedNetwork = useMemo(() => trackedNet(parts, team, segmentsByVideo), [parts, team, segmentsByVideo]);
  const handNet = useMemo(() => networkFromPasses(hand, events, team, label), [hand, events, team]); // eslint-disable-line react-hooks/exhaustive-deps -- label follows the roster
  const handStats = useMemo(() => passStats(hand), [hand]);
  const stretches = useMemo(() => passStretches(parts, segmentsByVideo), [parts, segmentsByVideo]);

  const has: Record<PassSource, boolean> = { tracking: tracked.completed + tracked.cut > 0, hand: hand.length > 0 };
  // Passes are read from the tracking; hand-tagged ones only show for old matches that have nothing else (no toggle).
  const source: PassSource | null = has.tracking ? "tracking" : has.hand ? "hand" : null;
  const color = team === "own" ? COLORS.own : COLORS.opp;
  const name = (s: Side) => (s === "own" ? match.focus_team : match.other_team);
  const net: Net | null = source === "tracking" ? trackedNetwork : source === "hand" ? handNet : null;
  const byKey = new Map((net?.nodes ?? []).map((n) => [n.key, n]));
  const maxEdge = Math.max(1, ...(net?.edges ?? []).map((e) => e.count));

  const evCount = (player: string, t: EventType) => events.filter((e) => e.team === team && e.player_id === player && e.type === t).length;
  const trackedBy = new Map(tracked.players.map((p) => [p.player_id, p]));
  const handBy = new Map(handStats.map((p) => [p.player_id, p]));
  const players = [
    ...new Set([
      ...tracked.players.map((p) => p.player_id),
      ...handStats.map((s) => s.player_id),
      ...events.filter((e) => e.team === team && e.player_id && PER_PLAYER.includes(e.type)).map((e) => e.player_id as string),
    ]),
  ];
  const partnersOf = (p: string): PlayerPasses["partners"] => (source === "hand" ? handBy.get(p)?.partners : trackedBy.get(p)?.partners) ?? [];
  const showTracked = has.tracking && tracked.players.length > 0;

  const toggle = (
    <div className="seg">
      {(["own", "opp"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={team === s} onClick={() => setTeam(s)} className="seg-opt">
          {name(s)}
        </button>
      ))}
    </div>
  );
  if (match.folder && fixed === null) {
    return (
      <Card title="Red de pases y jugadoras">
        <TrackingLoading what="los pases" />
      </Card>
    );
  }
  if (!source && tracked.players.length === 0 && players.length === 0) {
    return (
      <Locked
        reason="tracking"
        title="Red de pases y jugadoras"
        why={`Todavía no hay pases de ${name(team)}: ni etiquetados a mano ni leídos del tracking, y tampoco eventos con jugadora.`}
        need="procesar el tracking del partido y seguir el balón (pestaña Tracking), o etiquetar pases en un partido anterior."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Red de pases"
        note={
          source
            ? `${PASS_SOURCE_LABEL[source].toLowerCase()} · ${source === "tracking" ? `${tracked.completed} completos${tracked.approx > 0 ? " (aprox.)" : ""}` : `${handNet.completed} de ${handNet.passes} completos`}`
            : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {toggle}
        </div>
        {!net || (net.nodes.length === 0 && source === "tracking") ? (
          <p className="text-sm text-pretty text-muted">
            {source === "tracking" && tracked.completed > 0
              ? `${name(team)}: ${tracked.completed} pases completos y ${tracked.cut} cortados leídos del tracking, solo a nivel de equipo y aproximados (sus jugadoras no tienen nombre en la mesa de corrección, así que no hay red).`
              : `No hay pases de ${name(team)} en ninguna de las dos fuentes.`}
          </p>
        ) : (
          <>
            <Pitch>
              {net.edges.map((e) => {
                const a = byKey.get(e.a);
                const b = byKey.get(e.b);
                if (!a || !b) return null;
                return (
                  <line key={`${e.a}-${e.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={0.3 + (2 * e.count) / maxEdge} opacity={0.35 + (0.55 * e.count) / maxEdge} strokeLinecap="round" />
                );
              })}
              {net.nodes.map((n) => (
                <g key={n.key} transform={`translate(${n.x} ${n.y})`}>
                  <circle r={1.6 + Math.min(2.2, n.touches / 12)} fill={color} stroke="var(--color-bg)" strokeWidth={0.4} strokeDasharray={n.placed === "ring" ? "0.8 0.6" : undefined} />
                  <text y={0.8} textAnchor="middle" fontSize={2.2} fontWeight={700} fill="var(--color-bg)" pointerEvents="none">
                    {(source === "tracking" ? label(n.key) : n.label).slice(0, 3)}
                  </text>
                </g>
              ))}
            </Pitch>
            <p className="mt-2 text-[11px] text-pretty text-faint">
              Grosor: pases completos entre las dos (en los dos sentidos). Tamaño: toques.{" "}
              {source === "tracking"
                ? `Cada jugadora está en su posición media medida, con ${match.focus_team} atacando a la derecha.`
                : `Cada jugadora está en la posición media de sus eventos etiquetados con posición, con ${match.focus_team} atacando a la derecha${net.nodes.some((n) => n.placed === "ring") ? "; las de borde punteado no tienen eventos con posición y van en círculo" : ""}.`}
              {source === "tracking" && tracked.approx > 0 && ` ${tracked.approx} pase(s) sin nombre en un extremo no entran a la red (cifra aproximada).`}
            </p>
          </>
        )}
        {stretches.length > 0 && (
          <p className="mt-2 text-[11px] text-faint">
            El tracking tiene pases en {stretches.filter((r) => r.done).length} de {stretches.length} tramos de juego.
          </p>
        )}
      </Panel>

      <Panel title="Tabla por jugadora" note={name(team)}>
        {players.length === 0 && !has.tracking ? (
          <p className="text-sm text-muted">Sin pases ni eventos con jugadora todavía.</p>
        ) : (
          <div className="overflow-x-auto rounded-md shadow-[0_0_0_1px_var(--color-line-soft)]">
            <table className="w-full min-w-max border-collapse text-left text-xs">
              <thead>
                <tr className="bg-bg/50 text-[11px] text-faint">
                  <th className="sticky left-0 bg-bg/80 px-3 py-2 font-medium">Jugadora</th>
                  {showTracked && (
                    <>
                      <th className="px-2 py-2 text-right font-medium">Pases</th>
                      <th className="px-2 py-2 font-medium">Completados</th>
                      <th className="px-2 py-2 text-right font-medium">Recibidos</th>
                      <th className="px-2 py-2 text-right font-medium">Toques</th>
                    </>
                  )}
                  {PER_PLAYER.map((t) => (
                    <th key={t} className="px-2 py-2 text-right font-medium">
                      {EVENT_LABELS[t]}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium">Con quién más</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const tr = trackedBy.get(p);
                  const share = tr && tr.attempted > 0 ? Math.round((100 * tr.completed) / tr.attempted) : null;
                  return (
                    <tr key={p} className="border-t border-line-soft transition-colors odd:bg-bg/20 hover:bg-raised/60">
                      <td className="sticky left-0 bg-surface px-3 py-1.5 whitespace-nowrap text-ink">
                        <span className="tc mr-2 inline-block w-5 text-right text-faint">{numberOf.get(p) ?? ""}</span>
                        {p}
                      </td>
                      {showTracked && (
                        <>
                          <td className="tc px-2 text-right">{tr?.attempted ?? "–"}</td>
                          <td className="px-2">
                            {share === null ? (
                              <span className="tc text-faint">–</span>
                            ) : (
                              <span className="flex items-center gap-2" title={`${tr?.completed} de ${tr?.attempted} pases completos`}>
                                <span className="h-1.5 w-14 overflow-hidden rounded-full bg-line-soft">
                                  <span className="block h-full rounded-full" style={{ width: `${share}%`, background: color }} />
                                </span>
                                <span className="tc w-9 text-right text-ink-2">{share} %</span>
                              </span>
                            )}
                          </td>
                          <td className="tc px-2 text-right">{tr?.received ?? "–"}</td>
                          <td className="tc px-2 text-right">{tr?.touches ?? "–"}</td>
                        </>
                      )}
                      {PER_PLAYER.map((t) => (
                        <td key={t} className="tc px-2 text-right text-ink-2">
                          {evCount(p, t) || <span className="text-line-strong">·</span>}
                        </td>
                      ))}
                      <td className="px-3 whitespace-nowrap text-muted">{partnersOf(p).slice(0, 2).map((x) => `${label(x.player_id)} (${x.count})`).join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {has.tracking && (
          <p className="mt-3 mb-0 text-xs text-pretty text-ink-2">
            Equipo, del tracking: {tracked.completed} pases completos y {tracked.cut} cortados
            {tracked.approx > 0 && ` (aproximado: ${tracked.approx} sin nombre en la mesa de corrección, contados a nivel de equipo)`}.
          </p>
        )}
      </Panel>
    </div>
  );
}
