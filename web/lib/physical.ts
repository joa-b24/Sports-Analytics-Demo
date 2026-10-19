import { PITCH } from "./types.ts";
import { metersPerUnit, orient, type Oriented } from "./positions.ts";

// Physical load and team shape read from the corrected tracking (tracks_fixed), by named player. Pure functions.
// What the camera does not see is not measured: a gap of more than MAX_GAP_S in a player's track breaks it, and that
// time counts neither distance nor speed.

export const MAX_GAP_S = 1;
// Speed is measured over about one second (frame-to-frame jitter would inflate it).
export const SPEED_WINDOW_S = 1;
// Above this the track is wrong (a jump between two people), not a player.
export const MAX_KMH = 36;
// High-speed running and sprint thresholds (km/h), the usual ones in women's football analysis.
export const HSR_KMH = 18;
export const SPRINT_KMH = 22;
export const SPRINT_MIN_S = 1;

export interface PhysicalRow {
  name: string;
  seconds: number; // time measured
  distance_m: number;
  per_min_m: number | null; // distance per minute measured
  top_kmh: number | null;
  hsr_m: number; // distance above HSR_KMH
  sprints: number; // runs above SPRINT_KMH for at least SPRINT_MIN_S
}

type Sample = { t: number; x: number; y: number };

// One series per named player and part, in real meters, with the time in seconds.
function series(parts: Oriented[], team: "own" | "opp"): Map<string, Sample[][]> {
  const out = new Map<string, Sample[][]>();
  for (const o of parts) {
    const f = o.file;
    const [mx, my] = metersPerUnit(f);
    const name = new Map(f.people.filter((p) => p.team === team && p.player_id).map((p) => [p.id, p.player_id as string]));
    const byName = new Map<string, Sample[]>();
    for (const fr of f.frames)
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n || q.source === "interpolated") continue;
        const list = byName.get(n) ?? [];
        const s = { t: fr.frame / f.fps, x: q.x * mx, y: q.y * my };
        // Two boxes with the same name in one frame: keep the first.
        if (list.length && list[list.length - 1].t === s.t) continue;
        list.push(s);
        byName.set(n, list);
      }
    for (const [n, list] of byName) out.set(n, [...(out.get(n) ?? []), list]);
  }
  return out;
}

export function physical(parts: Oriented[], team: "own" | "opp"): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  for (const [name, runs] of series(parts, team)) {
    let seconds = 0;
    let distance = 0;
    let hsr = 0;
    let top: number | null = null;
    let sprints = 0;
    for (const s of runs) {
      let sprintStart: number | null = null;
      for (let i = 1; i < s.length; i++) {
        const dt = s[i].t - s[i - 1].t;
        if (dt <= 0 || dt > MAX_GAP_S) {
          sprintStart = null;
          continue;
        }
        const step = Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
        if ((step / dt) * 3.6 > MAX_KMH) continue;
        seconds += dt;
        distance += step;
        // Speed over a window centred on this step (half a window each side, without crossing a gap).
        let a = i - 1;
        let b = i;
        while (a > 0 && s[i - 1].t - s[a - 1].t <= SPEED_WINDOW_S / 2 && s[a].t - s[a - 1].t <= MAX_GAP_S) a--;
        while (b < s.length - 1 && s[b + 1].t - s[i].t <= SPEED_WINDOW_S / 2 && s[b + 1].t - s[b].t <= MAX_GAP_S) b++;
        const span = s[b].t - s[a].t;
        const kmh = span >= SPEED_WINDOW_S * 0.5 ? (Math.hypot(s[b].x - s[a].x, s[b].y - s[a].y) / span) * 3.6 : null;
        if (kmh !== null && kmh <= MAX_KMH) {
          top = top === null ? kmh : Math.max(top, kmh);
          if (kmh >= HSR_KMH) hsr += step;
          if (kmh >= SPRINT_KMH) {
            if (sprintStart === null) sprintStart = s[i - 1].t;
          } else {
            if (sprintStart !== null && s[i - 1].t - sprintStart >= SPRINT_MIN_S) sprints++;
            sprintStart = null;
          }
        }
      }
      if (sprintStart !== null && s[s.length - 1].t - sprintStart >= SPRINT_MIN_S) sprints++;
    }
    if (seconds === 0) continue;
    rows.push({
      name,
      seconds,
      distance_m: Math.round(distance),
      per_min_m: seconds >= 60 ? Math.round(distance / (seconds / 60)) : null,
      top_kmh: top === null ? null : Math.round(top * 10) / 10,
      hsr_m: Math.round(hsr),
      sprints,
    });
  }
  return rows.sort((a, b) => b.distance_m - a.distance_m);
}

export interface ShapePlayer {
  name: string;
  x: number; // average position, normalised pitch, team attacking right
  y: number;
  seconds: number;
}
export interface TeamBlock {
  players: ShapePlayer[];
  // Meters, from the average positions of the outfield players (the keeper is left out: the deepest one, if she stands
  // in her own box). Line height: mean x of the 4 deepest outfield players, from the own goal line. Length: from that
  // line to the mean of the 2 most advanced. Width: between the widest two. Null with fewer than 7 outfield players.
  line_m: number | null;
  length_m: number | null;
  width_m: number | null;
  seconds: number;
}

const BOX_DEPTH = 16.5;
export const MIN_SHAPE_S = 60;

export function teamBlock(parts: Oriented[], team: "own" | "opp"): TeamBlock {
  const acc = new Map<string, { x: number; y: number; s: number }>();
  let mx = 1;
  let my = 1;
  for (const o of parts) {
    const f = o.file;
    [mx, my] = metersPerUnit(f);
    const dt = f.stride / f.fps;
    const name = new Map(f.people.filter((p) => p.team === team && p.player_id).map((p) => [p.id, p.player_id as string]));
    for (const fr of f.frames)
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n || q.source === "interpolated") continue;
        let [x, y] = orient(o, q.x, q.y);
        if (team === "opp") [x, y] = [PITCH.length - x, PITCH.width - y];
        const a = acc.get(n) ?? { x: 0, y: 0, s: 0 };
        a.x += x * dt;
        a.y += y * dt;
        a.s += dt;
        acc.set(n, a);
      }
  }
  const players = [...acc]
    .filter(([, a]) => a.s >= MIN_SHAPE_S)
    .map(([name, a]) => ({ name, x: a.x / a.s, y: a.y / a.s, seconds: a.s }))
    .sort((a, b) => a.x - b.x);
  const seconds = players.reduce((t, p) => Math.max(t, p.seconds), 0);
  const outfield = players.length && players[0].x < BOX_DEPTH ? players.slice(1) : players;
  if (outfield.length < 7) return { players, line_m: null, length_m: null, width_m: null, seconds };
  const back = outfield.slice(0, 4);
  const front = outfield.slice(-2);
  const line = back.reduce((t, p) => t + p.x, 0) / back.length;
  const top = front.reduce((t, p) => t + p.x, 0) / front.length;
  const ys = outfield.map((p) => p.y);
  return {
    players,
    line_m: Math.round(line * mx),
    length_m: Math.round((top - line) * mx),
    width_m: Math.round((Math.max(...ys) - Math.min(...ys)) * my),
    seconds,
  };
}
