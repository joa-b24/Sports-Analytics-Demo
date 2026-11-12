import { crossesCut } from "./cameraCuts.ts";
import { isExtrapolated, isMeasuredSource } from "./smooth.ts";
import { PITCH } from "./types.ts";
import { metersPerUnit, orient, playFilter, type Oriented } from "./positions.ts";
import type { Segment } from "./segments.ts";

// Physical load and team shape read from the corrected tracking (tracks_fixed), by named player. Pure functions.
//
// Filled positions (`source: "interpolated"`) are an acceptable approximation (decision of the analyst, 2026-10-25): they
// count in distance, speed and sprints, however long the fill is, and the row says how much of the time and distance
// comes from them (`fill_time_pct`, `fill_dist_pct`). Extrapolated positions (`source: "extrapolated"`: a player held still before her first and after her last
// appearance, only so she does not vanish when drawn) are invented data: they count in nothing here. What has no position at all (a gap of more than
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

// ---------------------------------------------------------------------------------------------- clean the series
// The raw tracking jumps to a neighbour for a few frames and zig-zags by a metre: a distance summed from it is too long and
// a speed from it too high. Before anything is measured each run is cleaned in three steps:
//   1. spikes: a position far from the median of its neighbours (within SPIKE_WINDOW_S) is replaced by that median. Two
//      scales: a short, tight one (a box that jumps for a frame or two) and a longer, wider one (an excursion to another
//      player and back in a second or two);
//   2. smoothing: a Gaussian average over about SMOOTH_SIGMA_S, which removes the zig-zag but keeps a real change of
//      direction (a player does not turn in less than a quarter of a second);
//   3. a dead band: a step slower than STILL_MS is standing still (jitter), it adds no distance.
// None of it crosses a gap longer than MAX_GAP_S.
export const SPIKE_SCALES: { windowS: number; metres: number }[] = [
  { windowS: 0.6, metres: 1.2 },
  { windowS: 1.6, metres: 4 },
];
export const SMOOTH_SIGMA_S = 0.25;
export const STILL_MS = 0.3;

const median = (v: number[]) => {
  const a = [...v].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Spikes out: positions that are far from the median of the others around them. It needs neighbours on both sides (at the
// end of a run a moving player is far from the median of one side only), and a run with a straight line is never a spike.
export function despike<T extends { t: number; x: number; y: number }>(s: T[], windowS: number, metres: number): T[] {
  const out = s.map((p) => ({ ...p }));
  for (let i = 0; i < s.length; i++) {
    const left: number[] = [];
    const right: number[] = [];
    for (let k = i - 1; k >= 0 && s[i].t - s[k].t <= windowS && s[k + 1].t - s[k].t <= MAX_GAP_S; k--) left.push(k);
    for (let k = i + 1; k < s.length && s[k].t - s[i].t <= windowS && s[k].t - s[k - 1].t <= MAX_GAP_S; k++) right.push(k);
    // The same number of neighbours on each side: a moving player is then at the middle of what is compared.
    const m = Math.min(left.length, right.length);
    if (m < 2) continue;
    const ids = [...left.slice(0, m), ...right.slice(0, m)];
    const mx = median(ids.map((k) => s[k].x));
    const my = median(ids.map((k) => s[k].y));
    if (Math.hypot(s[i].x - mx, s[i].y - my) > metres) {
      out[i].x = mx;
      out[i].y = my;
    }
  }
  return out;
}

// Local straight line (weights: a Gaussian of σ = SMOOTH_SIGMA_S) evaluated at each position, inside the same stretch
// without gaps. A line, not an average: it does not pull the ends of a run inward nor cut the corners of a straight run.
export function smoothSeries<T extends { t: number; x: number; y: number }>(s: T[], sigmaS = SMOOTH_SIGMA_S): T[] {
  const out = s.map((p) => ({ ...p }));
  const reach = 3 * sigmaS;
  for (let i = 0; i < s.length; i++) {
    let sw = 0;
    let st = 0;
    let stt = 0;
    let sx = 0;
    let sy = 0;
    let stx = 0;
    let sty = 0;
    const add = (k: number) => {
      const tau = s[k].t - s[i].t;
      const w = Math.exp(-0.5 * (tau / sigmaS) ** 2);
      sw += w;
      st += w * tau;
      stt += w * tau * tau;
      sx += w * s[k].x;
      sy += w * s[k].y;
      stx += w * tau * s[k].x;
      sty += w * tau * s[k].y;
    };
    add(i);
    for (let k = i - 1; k >= 0 && s[i].t - s[k].t <= reach && s[k + 1].t - s[k].t <= MAX_GAP_S; k--) add(k);
    for (let k = i + 1; k < s.length && s[k].t - s[i].t <= reach && s[k].t - s[k - 1].t <= MAX_GAP_S; k++) add(k);
    const den = sw * stt - st * st;
    if (den > 1e-9) {
      out[i].x = (sx * stt - stx * st) / den;
      out[i].y = (sy * stt - sty * st) / den;
    } else {
      out[i].x = sx / sw;
      out[i].y = sy / sw;
    }
  }
  return out;
}

// A step faster than MAX_KMH is a jump between two people: the run is cut there (each side is cleaned on its own, so the
// smoothing never blurs a jump into plausible steps).
export function splitAtJumps<T extends { t: number; x: number; y: number }>(s: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (let i = 0; i < s.length; i++) {
    if (i > 0) {
      const dt = s[i].t - s[i - 1].t;
      if (dt > 0 && dt <= MAX_GAP_S && (Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y) / dt) * 3.6 > MAX_KMH) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(s[i]);
  }
  if (cur.length) out.push(cur);
  return out;
}

export const cleanSeries = <T extends { t: number; x: number; y: number }>(s: T[]): T[] => smoothSeries(SPIKE_SCALES.reduce((acc, sc) => despike(acc, sc.windowS, sc.metres), s));
// The runs of a player ready to measure: cut at the jumps and cleaned.
export const cleanRuns = <T extends { t: number; x: number; y: number }>(runs: T[][]): T[][] => runs.flatMap((r) => splitAtJumps(r).map(cleanSeries));

// A sprint is real only if the speed gets there the way a body does: between two measured speeds (close in time) the change
// cannot be faster than ACCEL_MAX_MS2 (m/s²; elite sprinters peak around 6-8 m/s² from a standing start, a university player
// less). A jump in the track shows up as an acceleration no player has: that run is not a sprint and its speed is not the top.
// The speeds from ACCEL_LEAD_S before the sprint count too (the way in).
export const ACCEL_MAX_MS2 = 8;
export const ACCEL_LEAD_S = 0.5;
// Two speeds further apart in time than this are not compared (there was a gap between them).
export const ACCEL_PAIR_S = 0.35;
export function accelerationCoherent(speeds: { t: number; kmh: number }[]): boolean {
  for (let i = 1; i < speeds.length; i++) {
    const dt = speeds[i].t - speeds[i - 1].t;
    if (dt <= 0 || dt > ACCEL_PAIR_S) continue;
    if (Math.abs((speeds[i].kmh - speeds[i - 1].kmh) / 3.6 / dt) > ACCEL_MAX_MS2) return false;
  }
  return true;
}

// The largest change of speed between two close measures (m/s²), to show why a sprint was refused.
export function maxAcceleration(speeds: { t: number; kmh: number }[]): number {
  let m = 0;
  for (let i = 1; i < speeds.length; i++) {
    const dt = speeds[i].t - speeds[i - 1].t;
    if (dt <= 0 || dt > ACCEL_PAIR_S) continue;
    m = Math.max(m, Math.abs((speeds[i].kmh - speeds[i - 1].kmh) / 3.6 / dt));
  }
  return m;
}

// A run above SPRINT_KMH for at least SPRINT_MIN_S, valid or not (for the check of the Laboratorio).
export interface SprintRecord {
  name: string;
  video_id: string;
  t_start: number;
  t_end: number;
  peak_kmh: number;
  // Counts as a sprint (its acceleration is coherent); false = refused, with the largest change of speed it had.
  valid: boolean;
  max_accel_ms2: number;
}

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

type Sample = { t: number; x: number; y: number; fill: boolean; v: string };

// One series per named player and part, in real meters, with the time in seconds.
function series(parts: Oriented[], team: "own" | "opp", play: Record<string, Segment[]> | null = null): Map<string, Sample[][]> {
  const out = new Map<string, Sample[][]>();
  const only = playFilter(play);
  for (const o of parts) {
    const f = o.file;
    const [mx, my] = metersPerUnit(f);
    const name = new Map(f.people.filter((p) => p.team === team && p.player_id).map((p) => [p.id, p.player_id as string]));
    const byName = new Map<string, Sample[][]>();
    for (const fr of f.frames) {
      if (!only(f.video_id, fr.frame / f.fps)) continue;
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n) continue;
        if (isExtrapolated(q.source)) continue; // held still outside what was seen: no distance, no speed
        const runsOf = byName.get(n) ?? [];
        let list = runsOf[runsOf.length - 1];
        // A cut of the picture breaks the series: no distance or speed across it.
        if (!list || crossesCut(f.camera_cuts, Math.round(list[list.length - 1].t * f.fps), fr.frame)) {
          list = [];
          runsOf.push(list);
          byName.set(n, runsOf);
        }
        const s = { t: fr.frame / f.fps, x: q.x * mx, y: q.y * my, fill: q.source === "interpolated", v: f.video_id };
        // Two boxes with the same name in one frame: keep the first (a measured one before a filled one).
        if (list.length && list[list.length - 1].t === s.t) {
          if (list[list.length - 1].fill && !s.fill) list[list.length - 1] = s;
          continue;
        }
        list.push(s);
      }
    }
    for (const [n, lists] of byName) out.set(n, [...(out.get(n) ?? []), ...lists]);
  }
  return out;
}

// `collect` receives every candidate sprint (valid or refused) and `only` limits the work to one named player: both are for the
// check of the Laboratorio; the rows are the same.
export function physical(parts: Oriented[], team: "own" | "opp", play: Record<string, Segment[]> | null = null, collect?: (s: SprintRecord) => void, only?: string): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  for (const [name, runs] of series(parts, team, play)) {
    if (only !== undefined && name !== only) continue;
    let seconds = 0;
    let fillSeconds = 0;
    let distance = 0;
    let fillDistance = 0;
    let hsr = 0;
    let top: number | null = null;
    let sprints = 0;
    for (const s of cleanRuns(runs)) {
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
      // The speeds measured in this run (time, km/h), to check that a sprint is physically coherent.
      const speeds: { t: number; kmh: number }[] = [];
      const closeSprint = () => {
        if (sprintStart !== null && lastFast - sprintStart >= SPRINT_MIN_S) {
          const from = sprintStart;
          const to = lastFast;
          const inRun = speeds.filter((v) => v.t >= from - ACCEL_LEAD_S && v.t <= to);
          const coherent = accelerationCoherent(inRun);
          collect?.({ name, video_id: s[0].v, t_start: from, t_end: to, peak_kmh: Math.round(Math.max(...inRun.filter((v) => v.t >= from).map((v) => v.kmh), 0) * 10) / 10, valid: coherent, max_accel_ms2: Math.round(maxAcceleration(inRun) * 10) / 10 });
          if (coherent) {
            sprints++;
            // The top speed is the fastest moment of a valid sprint, not any window of the match.
            const peak = Math.max(...inRun.filter((v) => v.t >= from).map((v) => v.kmh));
            top = top === null ? peak : Math.max(top, peak);
          }
        }
        sprintStart = null;
      };
      for (let i = 1; i < n; i++) {
        const dt = s[i].t - s[i - 1].t;
        if (sprintStart !== null && s[i - 1].t - lastFast > SPRINT_GAP_S) closeSprint();
        if (stepKmh[i] === null) continue;
        const step = Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
        const filled = s[i].fill || s[i - 1].fill;
        seconds += dt;
        // Standing still: the jitter of the track adds no metres (STILL_MS).
        const walked = step / dt >= STILL_MS ? step : 0;
        distance += walked;
        if (filled) {
          fillSeconds += dt;
          fillDistance += walked;
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
        speeds.push({ t: s[i].t, kmh });
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

export function teamBlock(parts: Oriented[], team: "own" | "opp", play: Record<string, Segment[]> | null = null): TeamBlock {
  const only = playFilter(play);
  const acc = new Map<string, { x: number; y: number; s: number }>();
  let mx = 1;
  let my = 1;
  for (const o of parts) {
    const f = o.file;
    [mx, my] = metersPerUnit(f);
    const dt = f.stride / f.fps;
    const name = new Map(f.people.filter((p) => p.team === team && p.player_id).map((p) => [p.id, p.player_id as string]));
    for (const fr of f.frames) {
      if (!only(f.video_id, fr.frame / f.fps)) continue;
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n || !isMeasuredSource(q.source)) continue;
        let [x, y] = orient(o, q.x, q.y);
        if (team === "opp") [x, y] = [PITCH.length - x, PITCH.width - y];
        const a = acc.get(n) ?? { x: 0, y: 0, s: 0 };
        a.x += x * dt;
        a.y += y * dt;
        a.s += dt;
        acc.set(n, a);
      }
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

// Every candidate sprint of one named player (valid and refused), in time order.
export function playerSprints(parts: Oriented[], team: "own" | "opp", name: string, play: Record<string, Segment[]> | null = null): SprintRecord[] {
  const out: SprintRecord[] = [];
  physical(parts, team, play, (s) => out.push(s), name);
  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start);
}
