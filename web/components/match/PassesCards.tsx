"use client";

import { useMemo, useState } from "react";
import { Locked } from "@/components/Locked";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
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

const pct = (done: number, of: number) => (of ? `${Math.round((100 * done) / of)} %` : "–");

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
  const [pick, setPick] = useState<PassSource | null>(null);
  const hand = useMemo(() => all.filter((p) => p.match_id === match.match_id && p.team === team), [all, match.match_id, team]);
  const numberOf = new Map((match.kind === "own" ? roster : []).map((p) => [p.player_id, p.number]));
  const label = (id: string) => (numberOf.get(id) != null ? String(numberOf.get(id)) : id.replace(/^#/, ""));

  const tracked = useMemo(() => trackedPasses(parts, team, segmentsByVideo), [parts, team, segmentsByVideo]);
  const trackedNetwork = useMemo(() => trackedNet(parts, team, segmentsByVideo), [parts, team, segmentsByVideo]);
  const handNet = useMemo(() => networkFromPasses(hand, events, team, label), [hand, events, team]); // eslint-disable-line react-hooks/exhaustive-deps -- label follows the roster
  const handStats = useMemo(() => passStats(hand), [hand]);
  const stretches = useMemo(() => passStretches(parts, segmentsByVideo), [parts, segmentsByVideo]);

  const has: Record<PassSource, boolean> = { tracking: tracked.completed + tracked.cut > 0, hand: hand.length > 0 };
  const source: PassSource | null = pick && has[pick] ? pick : has.tracking ? "tracking" : has.hand ? "hand" : null;
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
  const sourceToggle = (
    <div className="seg" role="group" aria-label="Fuente de los pases">
      {(["tracking", "hand"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={source === s} disabled={!has[s]} onClick={() => setPick(s)} className="seg-opt" title={has[s] ? undefined : "Sin pases de esta fuente"}>
          {PASS_SOURCE_LABEL[s]}
        </button>
      ))}
    </div>
  );

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
      <Card
        title="Red de pases"
        note={
          source
            ? `${PASS_SOURCE_LABEL[source].toLowerCase()} · ${source === "tracking" ? `${tracked.completed} completos${tracked.approx > 0 ? " (aprox.)" : ""}` : `${handNet.completed} de ${handNet.passes} completos`}`
            : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {toggle}
          {sourceToggle}
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
      </Card>

      <Card title="Por jugadora" note={`${name(team)} · cada grupo de columnas dice su fuente`}>
        {players.length === 0 && !has.tracking ? (
          <p className="text-sm text-muted">Sin pases ni eventos con jugadora todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-nocturne w-full text-left text-xs">
              <thead>
                <tr className="text-faint">
                  <th />
                  {showTracked && (
                    <th colSpan={4} className="pb-0.5 text-center font-normal">
                      <span className="tag">Tracking</span>
                    </th>
                  )}
                  {handStats.length > 0 && (
                    <th colSpan={3} className="pb-0.5 text-center font-normal">
                      <span className="tag">A mano</span>
                    </th>
                  )}
                  <th colSpan={PER_PLAYER.length} className="pb-0.5 text-center font-normal">
                    <span className="tag">Eventos etiquetados</span>
                  </th>
                  <th />
                </tr>
                <tr>
                  <th className="pb-1">Jugadora</th>
                  {showTracked && (
                    <>
                      <th className="pb-1 text-right">Pases</th>
                      <th className="pb-1 text-right">% compl.</th>
                      <th className="pb-1 text-right">Recibidos</th>
                      <th className="pb-1 text-right">Toques</th>
                    </>
                  )}
                  {handStats.length > 0 && (
                    <>
                      <th className="pb-1 text-right">Pases</th>
                      <th className="pb-1 text-right">% compl.</th>
                      <th className="pb-1 text-right">Recibidos</th>
                    </>
                  )}
                  {PER_PLAYER.map((t) => (
                    <th key={t} className="pb-1 text-right">
                      {EVENT_LABELS[t]}
                    </th>
                  ))}
                  <th className="pb-1 pl-3">Con quién más</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const tr = trackedBy.get(p);
                  const hd = handBy.get(p);
                  return (
                    <tr key={p} className="border-t border-line-soft">
                      <td className="py-1 whitespace-nowrap text-ink">
                        <span className="tc mr-1.5 text-faint">{numberOf.get(p) ?? ""}</span>
                        {p}
                      </td>
                      {showTracked && (
                        <>
                          <td className="tc text-right">{tr?.attempted ?? "–"}</td>
                          <td className="tc text-right">{tr ? pct(tr.completed, tr.attempted) : "–"}</td>
                          <td className="tc text-right">{tr?.received ?? "–"}</td>
                          <td className="tc text-right">{tr?.touches ?? "–"}</td>
                        </>
                      )}
                      {handStats.length > 0 && (
                        <>
                          <td className="tc text-right">{hd?.attempted ?? "–"}</td>
                          <td className="tc text-right">{hd ? pct(hd.completed, hd.attempted) : "–"}</td>
                          <td className="tc text-right">{hd?.received ?? "–"}</td>
                        </>
                      )}
                      {PER_PLAYER.map((t) => (
                        <td key={t} className="tc text-right">
                          {evCount(p, t) || ""}
                        </td>
                      ))}
                      <td className="whitespace-nowrap pl-3 text-muted">{partnersOf(p).slice(0, 2).map((x) => `${label(x.player_id)} (${x.count})`).join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {has.tracking && (
          <p className="mt-2 text-xs text-pretty text-ink-2">
            Equipo, del tracking: {tracked.completed} pases completos y {tracked.cut} cortados
            {tracked.approx > 0 && ` (aproximado: ${tracked.approx} sin nombre en la mesa de corrección, contados a nivel de equipo)`}.
          </p>
        )}
        <p className="mt-2 text-[11px] text-pretty text-faint">
          Del tracking: «pases» son los intentos de la jugadora (completos más cortados) y cuentan toques del balón seguido separados por
          al menos 0,5 s; un cambio de fragmento de la misma jugadora no es un pase. «A mano» son pases etiquetados antes de quitar esa pasada.
          Carga física: la referencia es la carga por RPE (Entrenamientos); la distancia medida en video no sirve para comparar jugadoras.
        </p>
      </Card>
    </div>
  );
}
