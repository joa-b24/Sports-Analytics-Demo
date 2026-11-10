"use client";

import { useMemo } from "react";
import { Pitch } from "@/components/Pitch";
import { finishEvents } from "@/lib/analysis";
import { fmtT } from "@/lib/format";
import type { PlayerRow } from "@/lib/players";
import { passArrows, type Oriented } from "@/lib/positions";
import type { Segment } from "@/lib/segments";
import { setPref, usePref } from "@/lib/store";
import { EVENT_LABELS, PITCH, type MatchEvent } from "@/lib/types";

// What can be drawn on the map of one player, each as its own layer: events with her name (shots, losses, recoveries,
// duels) and her passes read from the tracking. Everything is drawn with her team attacking to the right.
const LAYERS = [
  { id: "shot", label: "Tiros" },
  { id: "pass", label: "Pases" },
  { id: "loss", label: "Pérdidas" },
  { id: "recovery", label: "Recuperaciones" },
  { id: "duel", label: "Duelos" },
] as const;
type LayerId = (typeof LAYERS)[number]["id"];
const TONE: Record<LayerId, string> = { shot: "var(--color-own)", pass: "var(--color-ink)", loss: "var(--color-danger)", recovery: "var(--color-ok)", duel: "var(--color-warn)" };

function Glyph({ id, tone }: { id: LayerId; tone: string }) {
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden className="shrink-0">
      {id === "shot" && <circle r="4.2" fill="none" stroke={tone} strokeWidth="1.8" />}
      {id === "pass" && <path d="M-5,3 L4,-3 M4,-3 L0.5,-3.2 M4,-3 L3,0.8" fill="none" stroke={tone} strokeWidth="1.6" strokeLinecap="round" />}
      {id === "loss" && <path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke={tone} strokeWidth="1.8" strokeLinecap="round" />}
      {id === "recovery" && <path d="M0,-5 L5,4 L-5,4 Z" fill={tone} />}
      {id === "duel" && <rect x="-4" y="-4" width="8" height="8" fill={tone} />}
    </svg>
  );
}

export function PlayerMap({
  row,
  events,
  parts,
  segmentsByVideo,
  color,
  onPick,
}: {
  row: PlayerRow;
  // Her events (tagged with her name).
  events: MatchEvent[];
  parts: Oriented[];
  segmentsByVideo: Record<string, Segment[]>;
  color: string;
  onPick?: (e: MatchEvent) => void;
}) {
  const saved = usePref("profile:layers", "shot,pass");
  const on = new Set(saved.split(",").filter(Boolean) as LayerId[]);
  const toggle = (id: LayerId) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPref("profile:layers", [...next].join(",") || "-");
  };

  // Our team is drawn as tagged; a rival is turned so that she also attacks to the right.
  const turn = (x: number, y: number): [number, number] => (row.team === "opp" ? [PITCH.length - x, PITCH.width - y] : [x, y]);
  const at = (e: MatchEvent) => (e.x !== null && e.y !== null ? turn(e.x, e.y) : null);
  const shots = useMemo(() => finishEvents(events), [events]);
  const byType = (t: MatchEvent["type"]) => events.filter((e) => e.type === t);
  const sets: Record<Exclude<LayerId, "pass">, MatchEvent[]> = { shot: shots, loss: byType("loss"), recovery: byType("recovery"), duel: byType("duel") };
  const arrows = useMemo(() => passArrows(parts, row.team, segmentsByVideo).filter((p) => p.from === row.id), [parts, row.team, row.id, segmentsByVideo]);
  const counts: Record<LayerId, number> = { shot: shots.length, pass: arrows.length, loss: sets.loss.length, recovery: sets.recovery.length, duel: sets.duel.length };
  const missing = (Object.keys(sets) as Exclude<LayerId, "pass">[]).filter((k) => on.has(k)).reduce((n, k) => n + sets[k].filter((e) => at(e) === null).length, 0);

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
  const tip = (e: MatchEvent) => `${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}${onPick ? " · clic para ver el video" : ""}`;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Qué se dibuja">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={on.has(l.id)}
            disabled={counts[l.id] === 0}
            onClick={() => toggle(l.id)}
            title={counts[l.id] === 0 ? (l.id === "pass" ? "Sin pases suyos en el tracking" : "Sin eventos suyos de este tipo") : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
              on.has(l.id) ? "bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "text-muted hover:text-ink"
            }`}
          >
            <Glyph id={l.id} tone={l.id === "shot" ? color : TONE[l.id]} />
            {l.label}
            <span className="tc text-faint">{counts[l.id]}</span>
          </button>
        ))}
      </div>
      <Pitch showDirection={false}>
        {on.has("pass") &&
          arrows.map((p, n) => (
            <g key={`p${n}`} opacity={0.7}>
              <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={TONE.pass} strokeWidth={0.4} strokeLinecap="round" />
              <circle cx={p.x2} cy={p.y2} r={0.9} fill={TONE.pass} />
            </g>
          ))}
        {on.has("recovery") &&
          sets.recovery.map((e) => {
            const p = at(e);
            return p && (
              <path key={e.event_id} d={`M${p[0]},${p[1] - 1.7} L${p[0] + 1.6},${p[1] + 1.3} L${p[0] - 1.6},${p[1] + 1.3} Z`} fill={TONE.recovery} {...pick(e)}>
                <title>{tip(e)}</title>
              </path>
            );
          })}
        {on.has("duel") &&
          sets.duel.map((e) => {
            const p = at(e);
            return p && (
              <rect key={e.event_id} x={p[0] - 1.2} y={p[1] - 1.2} width={2.4} height={2.4} fill={TONE.duel} {...pick(e)}>
                <title>{tip(e)}</title>
              </rect>
            );
          })}
        {on.has("loss") &&
          sets.loss.map((e) => {
            const p = at(e);
            return p && (
              <path key={e.event_id} d={`M${p[0] - 1.3},${p[1] - 1.3} L${p[0] + 1.3},${p[1] + 1.3} M${p[0] + 1.3},${p[1] - 1.3} L${p[0] - 1.3},${p[1] + 1.3}`} stroke={TONE.loss} strokeWidth={0.7} strokeLinecap="round" {...pick(e)}>
                <title>{tip(e)}</title>
              </path>
            );
          })}
        {on.has("shot") &&
          sets.shot.map((e) => {
            const p = at(e);
            return p && (
              <circle key={e.event_id} cx={p[0]} cy={p[1]} r={1.5} fill={e.type === "goal" ? color : "var(--color-surface)"} stroke={color} strokeWidth={0.55} {...pick(e)}>
                <title>{tip(e)}</title>
              </circle>
            );
          })}
      </Pitch>
      {missing > 0 && <p className="mt-1 text-xs text-faint">{missing} evento(s) sin posición marcada no aparecen en el mapa.</p>}
      {row.team === "opp" && <span className="sr-only">Dibujado atacando hacia la derecha</span>}
    </div>
  );
}
