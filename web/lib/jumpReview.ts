// What a reviewed jump looks like once corrected and smoothed, and whether it then fits what a player can do.
// Used by the temporary review page (app/revision). Pure functions.
import { SMOOTH_DEFAULTS, smoothTrack, type TrackPoint } from "./smooth.ts";

// Physical limits of the team (docs/propuesta_union_tracks.md, 8c): top speed S0 and the linear acceleration-speed
// profile, a_max(v) = A0 * (1 - v / S0). The analyst's own top speed in Strava is 6.9 m/s (24.7 km/h), and she is
// among the slower ones: S0 leaves room for the fastest. A0 from the literature (watch GPS cannot measure it).
export const TEAM_S0_MS = 8.5;
export const TEAM_A0_MS2 = 7;
export const MAX_DECEL_MS2 = 8;
// Allowance for what is left of calibration noise after smoothing.
export const ACCEL_SLACK_MS2 = 1;
// Speed and acceleration are measured over this window (s), as in lib/physical.ts.
export const WINDOW_S = 1;

// A path around the jump: [s from the jump, x m, y m].
export type Path = [number, number, number][];
export type Fix = "pico" | "antes" | "prolongado" | "camara" | "otro";

// Same rule as the correction table (lib/cuts.ts): farther than 3 m faster than 9 m/s between consecutive positions.
const JUMP_M = 3;
const JUMP_MS = 9;
const PAIR_MAX_S = 1;
const RETURN_S = 2;
const isJump = (a: Path[number], b: Path[number]) => {
  const dt = b[0] - a[0];
  const d = Math.hypot(b[1] - a[1], b[2] - a[2]);
  return dt > 0 && dt <= PAIR_MAX_S && d > JUMP_M && d / dt > JUMP_MS;
};

// The path with the answer applied as a correction. A marked wrong stretch wins; otherwise:
//   pico: out from the jump at 0 until she jumps back (within 2 s); if she does not, only the point at 0.
//   antes: out the stretch before 0, back to the previous jump or hole.
//   prolongado: from 0 on it is somebody else: out.
//   camara / otro: nothing removed (smoothing deals with it).
export function applyFix(path: Path, fix: Fix | undefined, bad?: { from?: number; to?: number }): Path {
  if (bad?.from !== undefined && bad?.to !== undefined) {
    const lo = Math.min(bad.from, bad.to) - 0.02;
    const hi = Math.max(bad.from, bad.to) + 0.02;
    return path.filter((p) => p[0] < lo || p[0] > hi);
  }
  const i0 = path.findIndex((p) => Math.abs(p[0]) < 0.02);
  if (i0 < 0 || !fix) return path;
  if (fix === "pico") {
    for (let j = i0 + 1; j < path.length && path[j][0] <= RETURN_S; j++) if (isJump(path[j - 1], path[j])) return [...path.slice(0, i0), ...path.slice(j)];
    return [...path.slice(0, i0), ...path.slice(i0 + 1)];
  }
  if (fix === "antes") {
    let k = i0 - 1;
    while (k > 0 && path[k][0] - path[k - 1][0] <= PAIR_MAX_S && !isJump(path[k - 1], path[k])) k--;
    return [...path.slice(0, k), ...path.slice(i0)];
  }
  if (fix === "prolongado") return path.slice(0, i0);
  return path;
}

// The app's export cleaning (lib/smooth.ts) on a path in meters.
export function smoothPath(path: Path, venue: { length_m: number; width_m: number }, fps = 29.97, stride = 3): Path {
  const mx = venue.length_m / 105;
  const my = venue.width_m / 68;
  // Frames counted from 10 s before the jump, so they stay positive.
  const pts: TrackPoint[] = path.map(([t, x, y]) => ({ frame: Math.round((t + 10) * fps), x: x / mx, y: y / my, source: "auto" }));
  const out = smoothTrack(pts, { fps, stride, metersPerUnit: [mx, my], ...SMOOTH_DEFAULTS }).points;
  return out.map((p) => [Math.round((p.frame / fps - 10) * 100) / 100, p.x * mx, p.y * my]);
}

export interface ProfilePoint {
  t: number; // middle of the window
  v: number; // m/s over WINDOW_S
  a: number | null; // m/s² between this window and the one WINDOW_S later
  limit: number | null; // highest possible acceleration from this speed
}

// Speed over 1 s windows of unbroken path, and the acceleration from one window to the next.
export function profile(path: Path): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (let i = 0; i < path.length; i++) {
    let j = i;
    while (j + 1 < path.length && path[j + 1][0] - path[j][0] <= 0.35 && path[j + 1][0] - path[i][0] <= WINDOW_S + 0.01) j++;
    const dt = path[j][0] - path[i][0];
    if (dt < WINDOW_S * 0.8) continue;
    out.push({ t: (path[i][0] + path[j][0]) / 2, v: Math.hypot(path[j][1] - path[i][1], path[j][2] - path[i][2]) / dt, a: null, limit: null });
  }
  for (const p of out) {
    const q = out.find((x) => Math.abs(x.t - (p.t + WINDOW_S)) < 0.06);
    if (!q) continue;
    p.a = (q.v - p.v) / (q.t - p.t);
    p.limit = TEAM_A0_MS2 * Math.max(0, 1 - p.v / TEAM_S0_MS);
  }
  return out;
}

export interface Verdict {
  top_kmh: number | null;
  over_speed: boolean;
  impossible_starts: number; // accelerations above what is possible from that speed (+ slack)
  hard_stops: number; // decelerations beyond MAX_DECEL_MS2
  ok: boolean;
}

export function verdict(prof: ProfilePoint[]): Verdict {
  const top = prof.length ? Math.max(...prof.map((p) => p.v)) : null;
  const starts = prof.filter((p) => p.a !== null && p.limit !== null && p.a > p.limit + ACCEL_SLACK_MS2).length;
  const stops = prof.filter((p) => p.a !== null && p.a < -MAX_DECEL_MS2).length;
  const over = top !== null && top > TEAM_S0_MS;
  return { top_kmh: top === null ? null : Math.round(top * 36) / 10, over_speed: over, impossible_starts: starts, hard_stops: stops, ok: !over && starts === 0 && stops === 0 };
}
