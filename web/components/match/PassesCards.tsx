"use client";

import { useMemo, useState } from "react";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import { networkFromPasses, passStats } from "@/lib/passes";
import { useStore } from "@/lib/store";
import { EVENT_LABELS, type EventType, type Match, type MatchEvent } from "@/lib/types";

// Pass network and the numbers of each player, from the passes tagged by hand (pass 4) and the events. No tracking.

type Side = "own" | "opp";
// Events counted per player in the table, in this order.
const PER_PLAYER: EventType[] = ["shot", "goal", "key_pass", "loss", "recovery", "foul"];

export function PassesCards({ match, events }: { match: Match; events: MatchEvent[] }) {
  const { passes: all = [], roster = [] } = useStore();
  const [team, setTeam] = useState<Side>("own");
  const passes = useMemo(() => all.filter((p) => p.match_id === match.match_id), [all, match.match_id]);
  const numberOf = new Map((match.kind === "own" ? roster : []).map((p) => [p.player_id, p.number]));
  const label = (id: string) => (numberOf.get(id) != null ? String(numberOf.get(id)) : id.replace(/^#/, ""));
  const net = useMemo(() => networkFromPasses(passes, events, team, label), [passes, events, team]); // eslint-disable-line react-hooks/exhaustive-deps -- label follows the roster
  const stats = useMemo(() => passStats(passes.filter((p) => p.team === team)), [passes, team]);
  const evCount = (player: string, t: EventType) => events.filter((e) => e.team === team && e.player_id === player && e.type === t).length;
  // Players with any pass or any event of the table.
  const players = [...new Set([...stats.map((s) => s.player_id), ...events.filter((e) => e.team === team && e.player_id && PER_PLAYER.includes(e.type)).map((e) => e.player_id as string)])];
  const byKey = new Map(net.nodes.map((n) => [n.key, n]));
  const maxEdge = Math.max(1, ...net.edges.map((e) => e.count));
  const color = team === "own" ? COLORS.own : COLORS.opp;
  const name = (s: Side) => (s === "own" ? match.focus_team : match.other_team);

  const toggle = (
    <div className="seg">
      {(["own", "opp"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={team === s} onClick={() => setTeam(s)} className="seg-opt">
          {name(s)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Red de pases" note={`${net.completed} de ${net.passes} pases completos · etiquetados a mano`}>
        <div className="mb-3">{toggle}</div>
        {net.passes === 0 ? (
          <p className="text-sm text-pretty text-muted">
            Todavía no hay pases etiquetados de {name(team)}. En «Video y etiquetado», pasada <strong>4 · Pases</strong>: con el video corriendo,
            el número de cada jugadora que recibe el balón, en orden.
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
                    {n.label.slice(0, 3)}
                  </text>
                </g>
              ))}
            </Pitch>
            <p className="mt-2 text-[11px] text-pretty text-faint">
              Grosor: pases completos entre las dos (en los dos sentidos). Tamaño: participación. Cada jugadora está en la posición media de sus
              eventos etiquetados con posición, con {match.focus_team} atacando a la derecha
              {net.nodes.some((n) => n.placed === "ring") && "; las de borde punteado no tienen eventos con posición y van en círculo"}.
            </p>
          </>
        )}
      </Card>

      <Card title="Por jugadora" note={`${name(team)} · pases y eventos etiquetados`}>
        {players.length === 0 ? (
          <p className="text-sm text-muted">Sin pases ni eventos con jugadora todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-nocturne w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="pb-1">Jugadora</th>
                  <th className="pb-1 text-right">Pases</th>
                  <th className="pb-1 text-right">% compl.</th>
                  <th className="pb-1 text-right">Recibidos</th>
                  {PER_PLAYER.map((t) => (
                    <th key={t} className="pb-1 text-right">
                      {EVENT_LABELS[t]}
                    </th>
                  ))}
                  <th className="pb-1">Con quién más</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const s = stats.find((x) => x.player_id === p);
                  return (
                    <tr key={p} className="border-t border-line-soft">
                      <td className="py-1 whitespace-nowrap text-ink">
                        <span className="tc mr-1.5 text-faint">{numberOf.get(p) ?? ""}</span>
                        {p}
                      </td>
                      <td className="tc text-right">{s?.attempted ?? 0}</td>
                      <td className="tc text-right">{s && s.attempted ? `${Math.round((100 * s.completed) / s.attempted)} %` : "–"}</td>
                      <td className="tc text-right">{s?.received ?? 0}</td>
                      {PER_PLAYER.map((t) => (
                        <td key={t} className="tc text-right">
                          {evCount(p, t) || ""}
                        </td>
                      ))}
                      <td className="whitespace-nowrap text-muted">{s?.partners.slice(0, 2).map((x) => `${label(x.player_id)} (${x.count})`).join(", ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-pretty text-faint">
          Carga física: sin sensores, la referencia es la carga por RPE (minutos jugados × esfuerzo percibido de 1 a 10 al terminar), que se
          registra en Entrenamientos. La distancia medida en video no sirve para comparar jugadoras: la cámara no ve a todas igual tiempo.
        </p>
      </Card>
    </div>
  );
}
