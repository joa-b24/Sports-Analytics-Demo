"use client";

import { COLORS, Pitch } from "@/components/Pitch";
import { TERRITORY_TYPES, territoryGrid } from "@/lib/analysis";
import { fmtT } from "@/lib/format";
import { EVENT_LABELS, PITCH, type MatchEvent } from "@/lib/types";

// ------------------------------------------------------------------------------------------------ territory

// The pitch in a 6 x 3 grid, each cell coloured by the team with more tagged actions there (the stronger the colour, the
// clearer the lead). It reads as «who played where»; our team attacks to the right.
export function TerritoryMap({ events, aLabel, bLabel, cols: nc = 6, rows: nr = 3 }: { events: MatchEvent[]; aLabel: string; bLabel: string; cols?: number; rows?: number }) {
  const g = territoryGrid(events, nc, nr);
  const cols = g.cells[0].length;
  const rows = g.cells.length;
  const cw = PITCH.length / cols;
  const ch = PITCH.width / rows;
  return (
    <div>
      <Pitch showDirection>
        {g.cells.map((row, r) =>
          row.map((c, k) => {
            if (c.share === null) return null;
            const lead = Math.abs(c.share - 0.5) * 2;
            const n = c.own + c.opp;
            return (
              <g key={`${r}-${k}`}>
                <rect x={k * cw + 0.4} y={r * ch + 0.4} width={cw - 0.8} height={ch - 0.8} rx={1.5} fill={c.share >= 0.5 ? COLORS.own : COLORS.opp} opacity={0.14 + 0.62 * lead}>
                  <title>{`${aLabel}: ${c.own} · ${bLabel}: ${c.opp} acciones marcadas`}</title>
                </rect>
                <text x={k * cw + cw / 2} y={r * ch + ch / 2 + 1.4} textAnchor="middle" fontSize={4} fontWeight={700} fill="var(--color-ink)" opacity={n > 0 ? 0.85 : 0} pointerEvents="none">
                  {Math.round((c.share >= 0.5 ? c.share : 1 - c.share) * 100)}%
                </text>
              </g>
            );
          }),
        )}
      </Pitch>
      <p className="mt-1.5 text-[11px] text-faint">
        Cada cuadro es de quien tiene más acciones marcadas en él ({g.placed} con posición; {TERRITORY_TYPES.length} tipos). El número es su parte.
        {g.missing > 0 ? ` ${g.missing} sin posición no cuentan.` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- outcome maps

export interface OutcomeStyle {
  label: string;
  color: string;
}
type Side = "own" | "opp";

// Events of one team on the pitch, seen with that team attacking to the right. Each mark's colour is its outcome; if the
// event has an end position (crosses, corners) it is an arrow from where it started to where it ended, else a dot. The
// counts of each outcome are in the legend above the map.
export function OutcomeMap({
  events,
  team,
  styles,
  unknown = "sin resultado",
  onPick,
  inferred,
}: {
  events: MatchEvent[];
  team: Side;
  styles: Record<string, OutcomeStyle>;
  unknown?: string;
  onPick?: (e: MatchEvent) => void;
  // Where an event without an end position probably went (event_id -> x, y): drawn as a dashed arrow, as an estimate.
  inferred?: Map<string, [number, number]>;
}) {
  const turn = (x: number, y: number): [number, number] => (team === "opp" ? [PITCH.length - x, PITCH.width - y] : [x, y]);
  const keys = Object.keys(styles);
  const count = (k: string | null) => events.filter((e) => (k === null ? !e.outcome || !(e.outcome in styles) : e.outcome === k)).length;
  const placed = events.filter((e) => e.x !== null && e.y !== null);
  const noPos = events.length - placed.length;
  const tone = (e: MatchEvent) => (e.outcome && styles[e.outcome] ? styles[e.outcome].color : "var(--color-faint)");
  const pick = (e: MatchEvent) =>
    onPick
      ? {
          role: "button" as const,
          tabIndex: 0,
          cursor: "pointer",
          onClick: () => onPick(e),
          onKeyDown: (k: React.KeyboardEvent) => {
            if (k.key === "Enter" || k.key === " ") {
              k.preventDefault();
              onPick(e);
            }
          },
        }
      : {};
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {keys.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <i className="h-2.5 w-2.5 rounded-full" style={{ background: styles[k].color }} aria-hidden />
            {styles[k].label}
            <b className="num text-ink">{count(k)}</b>
          </span>
        ))}
        {count(null) > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <i className="h-2.5 w-2.5 rounded-full bg-faint" aria-hidden />
            {unknown}
            <b className="num text-ink">{count(null)}</b>
          </span>
        )}
      </div>
      <Pitch showDirection>
        {placed.map((e) => {
          const [x, y] = turn(e.x as number, e.y as number);
          const c = tone(e);
          const title = `${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}${e.outcome && styles[e.outcome] ? ` · ${styles[e.outcome].label}` : ""}${onPick ? " · clic para ver el video" : ""}`;
          const guess = inferred?.get(e.event_id);
          const hasEnd = e.x_end !== null && e.x_end !== undefined && e.y_end !== null && e.y_end !== undefined;
          if (hasEnd || guess) {
            const [x2, y2] = hasEnd ? turn(e.x_end as number, e.y_end as number) : turn((guess as [number, number])[0], (guess as [number, number])[1]);
            const ang = Math.atan2(y2 - y, x2 - x);
            const h = 2.2;
            return (
              <g key={e.event_id} {...pick(e)}>
                <line x1={x} y1={y} x2={x2} y2={y2} stroke="transparent" strokeWidth={3} />
                <line x1={x} y1={y} x2={x2} y2={y2} stroke={c} strokeWidth={0.5} strokeLinecap="round" strokeDasharray={hasEnd ? undefined : "1.6 1.4"} opacity={hasEnd ? 0.85 : 0.7} />
                <polygon points={`${x2},${y2} ${x2 - h * Math.cos(ang - 0.4)},${y2 - h * Math.sin(ang - 0.4)} ${x2 - h * Math.cos(ang + 0.4)},${y2 - h * Math.sin(ang + 0.4)}`} fill={c} />
                <circle cx={x} cy={y} r={0.9} fill={c} />
                <title>{hasEnd ? title : `${title} · destino inferido`}</title>
              </g>
            );
          }
          return (
            <circle key={e.event_id} cx={x} cy={y} r={1.6} fill={c} stroke="var(--color-bg)" strokeWidth={0.4} opacity={0.9} {...pick(e)}>
              <title>{title}</title>
            </circle>
          );
        })}
      </Pitch>
      {noPos > 0 && <p className="mt-1 text-[11px] text-faint">{noPos} sin posición marcada no salen en el mapa.</p>}
    </div>
  );
}

export const SET_PIECE_STYLES: Record<string, OutcomeStyle> = {
  shot: { label: "Remate", color: "var(--color-ok)" },
  play_on: { label: "Sigue la jugada", color: "var(--color-warn)" },
  cleared: { label: "Despeje", color: "var(--color-danger)" },
};
export const GOAL_KICK_STYLES: Record<string, OutcomeStyle> = {
  kept: { label: "La conservan", color: "var(--color-ok)" },
  lost: { label: "La pierden", color: "var(--color-danger)" },
};

// Names of the lanes from the top of the drawing to the bottom (3: left, centre, right; more: numbered with the sides named).
const laneNames = (n: number): string[] => (n === 3 ? ["Izquierda", "Centro", "Derecha"] : n === 5 ? ["Banda izq.", "Interior izq.", "Centro", "Interior der.", "Banda der."] : Array.from({ length: n }, (_, i) => `Carril ${i + 1}`));

// Dots of one kind of event (for instance the entries to the last third), coloured by team, with the count per lane.
export function EntryMap({ events, team, lanes: nLanes = 3 }: { events: MatchEvent[]; team: Side; lanes?: number }) {
  const turn = (x: number, y: number): [number, number] => (team === "opp" ? [PITCH.length - x, PITCH.width - y] : [x, y]);
  const color = team === "own" ? COLORS.own : COLORS.opp;
  const placed = events.filter((e) => e.x !== null && e.y !== null);
  const lane = (y: number) => Math.min(nLanes - 1, Math.floor((y / PITCH.width) * nLanes));
  const lanes = Array.from({ length: nLanes }, () => 0);
  for (const e of placed) lanes[lane(turn(e.x as number, e.y as number)[1])]++;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {laneNames(nLanes).map((n, i) => (
          <span key={n} className="inline-flex items-center gap-1.5">
            {n}
            <b className="num text-ink">{lanes[i]}</b>
          </span>
        ))}
      </div>
      <Pitch showDirection>
        {Array.from({ length: nLanes - 1 }, (_, k) => k + 1).map((k) => (
          <line key={k} x1={0} x2={PITCH.length} y1={(k * PITCH.width) / nLanes} y2={(k * PITCH.width) / nLanes} stroke="var(--color-line)" strokeWidth={0.25} strokeDasharray="1.5 2" />
        ))}
        {placed.map((e) => {
          const [x, y] = turn(e.x as number, e.y as number);
          return (
            <circle key={e.event_id} cx={x} cy={y} r={1.6} fill={color} stroke="var(--color-bg)" strokeWidth={0.4} opacity={0.85}>
              <title>{`${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}`}</title>
            </circle>
          );
        })}
      </Pitch>
    </div>
  );
}
