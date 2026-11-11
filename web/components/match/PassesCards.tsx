"use client";

import { useMemo, useState } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { Locked } from "@/components/Locked";
import { StatList } from "@/components/match/ReportExtra";
import { usePlayersData } from "@/components/match/PlayersCompare";
import { Panel } from "@/components/match/Panel";
import { RatingBadge } from "@/components/match/RatingBadge";
import { COLORS, Pitch } from "@/components/Pitch";
import { Card } from "@/components/Shell";
import { TrackingLoading } from "@/components/TrackingLoading";
import { useFixedParts } from "@/lib/fixed";
import { networkFromPasses, passStats, type Net, type PlayerPasses } from "@/lib/passes";
import { PASS_SOURCE_LABEL, trackedNet, trackedPasses, type PassSource } from "@/lib/passSources";
import { passStretches } from "@/lib/positions";
import { type Segment } from "@/lib/segments";
import { setPref, useStore } from "@/lib/store";
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
  const { ratings } = usePlayersData(match, events, videoIds, segmentsByVideo);
  const [team, setTeam] = useState<Side>("own");
  // Order of the table: a click on a header sorts by it (down, then up, then back to the original order).
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
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

  // Clicking a player of the table selects her in the individual sheet and goes there.
  const openProfile = (p: string) => {
    setPref(`profile:${match.match_id}`, `${team}|${p}`);
    document.getElementById("ficha-jugadora")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
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
  // The lists beside the network (as in the report): the five pairs with most passes between them and the five with most touches.
  const nodeName = (key: string) => (source === "tracking" ? label(key) : (byKey.get(key)?.label ?? key));
  const pairs = [...(net?.edges ?? [])].sort((x, y) => y.count - x.count).slice(0, 5);
  const most = [...(net?.nodes ?? [])].sort((x, y) => y.touches - x.touches).slice(0, 5);

  // The columns: each one knows how to sort (a number, or text for the name). Short headers, the full name in the tooltip.
  type Col = { id: string; label: string; title?: string; flag?: string; left?: boolean; val: (p: string) => number | string };
  const short: Partial<Record<EventType, string>> = { shot: "Tiros", goal: "Goles", key_pass: "P. clave", loss: "Pérd.", recovery: "Recup.", foul: "Faltas" };
  const columns: Col[] = [
    { id: "name", label: "Jugadora", left: true, val: (p) => p },
    { id: "rating", label: "Calif.", flag: "rev.", title: "Calificación del partido, en revisión (clic en la jugadora para ver de dónde sale)", val: (p) => ratings.get(`${team}|${p}`)?.score ?? -1 },
    ...(showTracked
      ? ([
          { id: "passes", label: "Pases", title: "Pases intentados (del tracking)", val: (p) => trackedBy.get(p)?.attempted ?? -1 },
          { id: "share", label: "Completos", title: "Porcentaje de pases completos", val: (p) => { const t = trackedBy.get(p); return t && t.attempted > 0 ? t.completed / t.attempted : -1; } },
          { id: "received", label: "Recib.", title: "Pases recibidos", val: (p) => trackedBy.get(p)?.received ?? -1 },
          { id: "touches", label: "Toques", val: (p) => trackedBy.get(p)?.touches ?? -1 },
        ] as Col[])
      : []),
    ...PER_PLAYER.map((t): Col => ({ id: t, label: short[t] ?? EVENT_LABELS[t], title: EVENT_LABELS[t], val: (p) => evCount(p, t) })),
    { id: "partners", label: "Con quién más", left: true, title: "Con quién más pasa", val: (p) => partnersOf(p)[0]?.count ?? 0 },
  ];
  const sortCol = sort ? columns.find((c) => c.id === sort.key) : undefined;
  const sorted = sortCol && sort
    ? [...players].sort((a, b) => {
        const x = sortCol.val(a);
        const y = sortCol.val(b);
        const d = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y), "es") : x - y;
        return sort.dir === -1 ? -d : d;
      })
    : players;

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
        className="lg:col-span-2"
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
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
            <div className="min-w-0">
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
            </div>
            <div className="min-w-0">
              <StatList title="Conexiones más usadas" items={pairs.map((e) => ({ label: `${nodeName(e.a)} – ${nodeName(e.b)}`, value: e.count }))} />
              <div className="mt-4">
                <StatList title="Más toques" items={most.map((n) => ({ label: nodeName(n.key), value: n.touches }))} />
              </div>
            </div>
          </div>
        )}
        {stretches.length > 0 && (
          <p className="mt-2 text-[11px] text-faint">
            El tracking tiene pases en {stretches.filter((r) => r.done).length} de {stretches.length} tramos de juego.
          </p>
        )}
      </Panel>

      <Panel title="Tabla por jugadora" note={name(team)} className="lg:col-span-2">
        {players.length === 0 && !has.tracking ? (
          <p className="text-sm text-muted">Sin pases ni eventos con jugadora todavía.</p>
        ) : (
          <div className="overflow-x-auto rounded-md shadow-[0_0_0_1px_var(--color-line-soft)]">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="bg-bg/50 text-[11px] text-faint">
                  {columns.map((c) => {
                    const on = sort?.key === c.id;
                    return (
                      <th key={c.id} aria-sort={on ? (sort.dir === -1 ? "descending" : "ascending") : "none"} className={`${c.id === "name" ? "sticky left-0 bg-bg/80 px-3" : "px-1.5"} py-2 font-medium ${c.left ? "" : "text-right"}`} title={c.title}>
                        <button
                          type="button"
                          className={`inline-flex items-center gap-0.5 whitespace-nowrap hover:text-ink ${on ? "text-ink" : ""}`}
                          onClick={() => { const first = c.id === "name" ? 1 : -1; setSort(!on ? { key: c.id, dir: first } : sort.dir === first ? { key: c.id, dir: first === 1 ? -1 : 1 } : null); }}
                        >
                          {c.label}
                          {c.flag && <span className="text-[9px] text-warn">{c.flag}</span>}
                          {on && (sort.dir === -1 ? <CaretDown size={10} weight="bold" /> : <CaretUp size={10} weight="bold" />)}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const tr = trackedBy.get(p);
                  const share = tr && tr.attempted > 0 ? Math.round((100 * tr.completed) / tr.attempted) : null;
                  return (
                    <tr
                      key={p}
                      className="cursor-pointer border-t border-line-soft transition-colors odd:bg-bg/20 hover:bg-raised/60"
                      title="Ver su ficha"
                      tabIndex={0}
                      onClick={() => openProfile(p)}
                      onKeyDown={(k) => {
                        if (k.key === "Enter") openProfile(p);
                      }}
                    >
                      <td className="sticky left-0 bg-surface px-3 py-1.5 whitespace-nowrap text-ink">
                        <span className="tc mr-2 inline-block w-5 text-right text-faint">{numberOf.get(p) ?? ""}</span>
                        {p}
                      </td>
                      <td className="px-1.5 text-right">
                        <RatingBadge rating={ratings.get(`${team}|${p}`)} mark={false} />
                      </td>
                      {showTracked && (
                        <>
                          <td className="tc px-1.5 text-right">{tr?.attempted ?? "–"}</td>
                          <td className="px-1.5">
                            {share === null ? (
                              <span className="tc block text-right text-faint">–</span>
                            ) : (
                              <span className="flex items-center justify-end gap-1.5" title={`${tr?.completed} de ${tr?.attempted} pases completos`}>
                                <span className="h-1.5 w-8 overflow-hidden rounded-full bg-line-soft">
                                  <span className="block h-full rounded-full" style={{ width: `${share}%`, background: color }} />
                                </span>
                                <span className="tc w-8 text-right text-ink-2">{share} %</span>
                              </span>
                            )}
                          </td>
                          <td className="tc px-1.5 text-right">{tr?.received ?? "–"}</td>
                          <td className="tc px-1.5 text-right">{tr?.touches ?? "–"}</td>
                        </>
                      )}
                      {PER_PLAYER.map((t) => (
                        <td key={t} className="tc px-1.5 text-right text-ink-2">
                          {evCount(p, t) || <span className="text-line-strong">·</span>}
                        </td>
                      ))}
                      <td className="max-w-[9rem] truncate px-1.5 text-muted" title={partnersOf(p).slice(0, 2).map((x) => `${label(x.player_id)} (${x.count})`).join(", ")}>
                        {partnersOf(p).slice(0, 2).map((x) => `${label(x.player_id)} (${x.count})`).join(", ")}
                      </td>
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
