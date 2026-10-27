import { PITCH } from "./types.ts";
import { metersPerUnit, orient, type Oriented } from "./positions.ts";

// Physical load and team shape read from the corrected tracking (tracks_fixed), by named player. Pure functions.
//
// Filled positions (`source: "interpolated"`) are an acceptable approximation (decision of the analyst, 2026-10-25): they
// count in distance, speed and sprints, however long the fill is, and the row says how much of the time and distance
// comes from them (`fill_time_pct`, `fill_dist_pct`). Extrapolated positions (holding a player still outside what was
// observed) would be invented data: the pipeline does not produce them. What has no position at all (a gap of more than
// MAX_GAP_S between two samples) is not measured: it breaks the series and counts neither distance nor speed.

export const MAX_GAP_S = 1;
// Speed is measured over about one second (frame-to-frame jitter would inflate it).
export const SPEED_WINDOW_S = 1;
// A step faster than this is a jump between two people, not a player: it adds no distance and poisons every window that
// contains it, which is then dropped whole (before 2026-10-25 only the step itself was dropped, and the neighbour
// windows kept the jump: top speeds of 35 km/h).
export const MAX_KMH = 36;
// A window needs most of its length: two samples 0.1 s apart next to a gap are noise, not a speed.
export const MIN_WINDOW_FRAC = 0.8;
// Physiological ceiling for a speed over one second. The best women's sprinters measured with GPS peak at about
// 32-33 km/h, and a university team is below that. A window above it is a track error: it does not count for the top
// speed, HSR or sprints (its step still adds distance if the step itself is below MAX_KMH).
export const PLAUSIBLE_KMH = 33;
// High-speed running (HSR) and sprint thresholds (km/h), the usual ones in women's football analysis.
export const HSR_KMH = 18;
export const SPRINT_KMH = 22;
export const SPRINT_MIN_S = 1;
// A sprint is not cut by a stretch with no valid speed (a gap, a jump, a short window) of up to this long; a step that
// is valid and below SPRINT_KMH does end it.
export const SPRINT_GAP_S = 0.5;

export interface PhysicalRow {
  name: string;
  seconds: number; // time seen (measured or filled)
  distance_m: number;
  per_min_m: number | null; // distance per minute seen
  top_kmh: number | null;
  hsr_m: number; // distance above HSR_KMH
  sprints: number; // runs above SPRINT_KMH for at least SPRINT_MIN_S
  // Share (0-100) of the time and of the distance that comes from filled positions (a step with a filled end).
  fill_time_pct: number;
  fill_dist_pct: number;
}

type Sample = { t: number; x: number; y: number; fill: boolean };

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
        if (!n) continue;
        const list = byName.get(n) ?? [];
        const s = { t: fr.frame / f.fps, x: q.x * mx, y: q.y * my, fill: q.source === "interpolated" };
        // Two boxes with the same name in one frame: keep the first (a measured one before a filled one).
        if (list.length && list[list.length - 1].t === s.t) {
          if (list[list.length - 1].fill && !s.fill) list[list.length - 1] = s;
          continue;
        }
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
    let fillSeconds = 0;
    let distance = 0;
    let fillDistance = 0;
    let hsr = 0;
    let top: number | null = null;
    let sprints = 0;
    for (const s of runs) {
      const n = s.length;
      // Speed of every step; null where the step is not valid (a gap or a jump).
      const stepKmh: (number | null)[] = [null];
      for (let i = 1; i < n; i++) {
        const dt = s[i].t - s[i - 1].t;
        if (dt <= 0 || dt > MAX_GAP_S) stepKmh.push(null);
        else {
          const v = (Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y) / dt) * 3.6;
          stepKmh.push(v > MAX_KMH ? null : v);
        }
      }
      // A sprint run: from its first fast step to its last; `lastFast` is the end time of the last fast step.
      let sprintStart: number | null = null;
      let lastFast = 0;
      const closeSprint = () => {
        if (sprintStart !== null && lastFast - sprintStart >= SPRINT_MIN_S) sprints++;
        sprintStart = null;
      };
      for (let i = 1; i < n; i++) {
        const dt = s[i].t - s[i - 1].t;
        if (sprintStart !== null && s[i - 1].t - lastFast > SPRINT_GAP_S) closeSprint();
        if (stepKmh[i] === null) continue;
        const step = Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
        const filled = s[i].fill || s[i - 1].fill;
        seconds += dt;
        distance += step;
        if (filled) {
          fillSeconds += dt;
          fillDistance += step;
        }
        // Speed over a window centred on this step (half a window each side, without crossing a gap).
        let a = i - 1;
        let b = i;
        while (a > 0 && s[i - 1].t - s[a - 1].t <= SPEED_WINDOW_S / 2 && s[a].t - s[a - 1].t <= MAX_GAP_S) a--;
        while (b < n - 1 && s[b + 1].t - s[i].t <= SPEED_WINDOW_S / 2 && s[b + 1].t - s[b].t <= MAX_GAP_S) b++;
        const span = s[b].t - s[a].t;
        let kmh: number | null = null;
        if (span >= SPEED_WINDOW_S * MIN_WINDOW_FRAC) {
          let clean = true;
          for (let k = a + 1; k <= b; k++) if (stepKmh[k] === null) clean = false;
          if (clean) kmh = (Math.hypot(s[b].x - s[a].x, s[b].y - s[a].y) / span) * 3.6;
        }
        if (kmh === null || kmh > PLAUSIBLE_KMH) continue;
        top = top === null ? kmh : Math.max(top, kmh);
        if (kmh >= HSR_KMH) hsr += step;
        if (kmh >= SPRINT_KMH) {
          if (sprintStart === null) sprintStart = s[i - 1].t;
          lastFast = s[i].t;
        } else closeSprint();
      }
      closeSprint();
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
      fill_time_pct: Math.round((1000 * fillSeconds) / seconds) / 10,
      fill_dist_pct: distance > 0 ? Math.round((1000 * fillDistance) / distance) / 10 : 0,
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
