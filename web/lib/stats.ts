import { EVENT_TYPES, PITCH, type EventType, type Keyframe, type MatchEvent, type Team } from "./types";

// Pure functions over plain arrays: no storage, no React.

export function countByType(events: MatchEvent[], team: Team): Record<EventType, number> {
  const out = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<EventType, number>;
  for (const e of events) if (e.team === team) out[e.type]++;
  return out;
}

// A goal is also a shot: "tiros" in the UI means shot + goal.
export function shotsOf(events: MatchEvent[], team: Team): MatchEvent[] {
  return events.filter((e) => e.team === team && (e.type === "shot" || e.type === "goal"));
}

// 3 x 3 grid: rows are lanes across the width (y), columns are thirds along the length (x).
// Events without position are not counted (returned separately), never guessed.
export function zoneCounts(events: MatchEvent[]): { grid: number[][]; missing: number } {
  const grid = [0, 1, 2].map(() => [0, 0, 0]);
  let missing = 0;
  for (const e of events) {
    if (e.x === null || e.y === null) {
      missing++;
      continue;
    }
    const col = Math.min(2, Math.max(0, Math.floor(e.x / (PITCH.length / 3))));
    const row = Math.min(2, Math.max(0, Math.floor(e.y / (PITCH.width / 3))));
    grid[row][col]++;
  }
  return { grid, missing };
}

export const TOKENS: { id: string; team: "own" | "opp" | "ball"; label: string }[] = [
  ...Array.from({ length: 11 }, (_, i) => ({ id: `o${i + 1}`, team: "own" as const, label: String(i + 1) })),
  ...Array.from({ length: 11 }, (_, i) => ({ id: `r${i + 1}`, team: "opp" as const, label: String(i + 1) })),
  { id: "ball", team: "ball", label: "" },
];

// 4-3-3 with the analysed team attacking to the right; the other team mirrored.
const BASE: [number, number][] = [
  [6, 34],
  [25, 10],
  [22, 26],
  [22, 42],
  [25, 58],
  [42, 20],
  [38, 34],
  [42, 48],
  [62, 12],
  [66, 34],
  [62, 56],
];

export function defaultPositions(): Record<string, [number, number]> {
  const pos: Record<string, [number, number]> = { ball: [52.5, 34] };
  BASE.forEach(([x, y], i) => {
    pos[`o${i + 1}`] = [x, y];
    pos[`r${i + 1}`] = [PITCH.length - x, PITCH.width - y];
  });
  return pos;
}

// Linear interpolation between the two keyframes around `t`; clamps at the ends.
export function interpolate(keyframes: Keyframe[], t: number): Record<string, [number, number]> | null {
  if (keyframes.length === 0) return null;
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  if (t <= kfs[0].t) return kfs[0].pos;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.pos;
  const i = kfs.findIndex((k) => k.t > t);
  const a = kfs[i - 1];
  const b = kfs[i];
  const f = (t - a.t) / (b.t - a.t);
  const out: Record<string, [number, number]> = {};
  for (const id of Object.keys(a.pos)) {
    const p = a.pos[id];
    const q = b.pos[id] ?? p;
    out[id] = [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  }
  return out;
}

export function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
