// Impossible movements: places worth a look before trusting a part. Pure functions, no storage, no React.
//   player   a person (with a name first) moves farther than anyone can run: usually her name went to someone else
//            (a camera pan in the quick review left a name on the player next to her, or on whoever came into frame).
//   camera   many people "jump" at the same instant: the calibration of that frame is off, not the identities.
//   ball     the ball would have to fly faster than any shot, or it goes somewhere and comes straight back: a mark on a
//            ball in the air (taken to the pitch as if it were on the ground, it lands far away) or a wrong detection.
// Distances are in real meters of the venue: the normalised pitch (105 x 68) is not the real size.
import type { BallPoint } from "./parts.ts";
import { JUMP_MIN_M, JUMP_SPEED_MS, series } from "./cuts.ts";
import type { TracksFile } from "./tracks.ts";
import { PITCH, type TrackEdits } from "./types.ts";

// Consecutive positions further apart in time than this (s) are a hole, not a jump.
export const PAIR_MAX_S = 1;
// A jump shared by at least this many people, and this share of the people seen then, is the camera.
export const CAMERA_MIN_PEOPLE = 4;
export const CAMERA_SHARE = 0.4;
// The ball: faster than this (m/s) and farther than BALL_MIN_M is impossible (a hard shot is about 30 m/s).
export const BALL_MAX_MS = 35;
export const BALL_MIN_M = 5;
// Two known ball positions further apart in time than this (s) are not compared.
export const BALL_PAIR_MAX_S = 3;
// A detour that comes back within this long (s) is one anomaly, not two.
export const DETOUR_S = 2;

export type AnomalyKind = "player" | "camera" | "ball";
export interface Anomaly {
  kind: AnomalyKind;
  // Where to look: the first frame of the impossible movement.
  frame: number;
  // Player anomalies: the identity, and her name if she has one.
  person?: number;
  name?: string | null;
  // Camera anomalies: how many people jumped at that instant.
  people?: number;
  // Meters and the speed it would need (m/s).
  meters: number;
  speed: number;
  // A detour: the frame where it is back on a possible path.
  until?: number;
}

const scaleOf = (file: Pick<TracksFile, "venue">): [number, number] => [
  (file.venue?.length_m ?? PITCH.length) / PITCH.length,
  (file.venue?.width_m ?? PITCH.width) / PITCH.width,
];

// Players and camera. Jumps of people with a name come first (they matter for the analysis), then the camera ones.
export function playerAnomalies(file: TracksFile, edits: TrackEdits): Anomaly[] {
  const fps = file.fps;
  const names = new Map(Object.entries(edits.people).map(([k, v]) => [Number(k), v.player_id ?? null]));
  const all = series(file, edits);
  // Who is seen in each frame, to tell a camera jump from a player's.
  const seenAt = new Map<number, number>();
  const jumps: { person: number; frame: number; meters: number; speed: number }[] = [];
  for (const [person, obs] of all) {
    for (const o of obs) seenAt.set(o.frame, (seenAt.get(o.frame) ?? 0) + 1);
    for (let i = 1; i < obs.length; i++) {
      const dt = (obs[i].frame - obs[i - 1].frame) / fps;
      const d = Math.hypot(obs[i].x - obs[i - 1].x, obs[i].y - obs[i - 1].y);
      if (dt > 0 && dt <= PAIR_MAX_S && d > JUMP_MIN_M && d / dt > JUMP_SPEED_MS) jumps.push({ person, frame: obs[i].frame, meters: d, speed: d / dt });
    }
  }
  const out: Anomaly[] = [];
  const byFrame = new Map<number, typeof jumps>();
  for (const j of jumps) byFrame.set(j.frame, [...(byFrame.get(j.frame) ?? []), j]);
  for (const [frame, js] of byFrame) {
    const seen = seenAt.get(frame) ?? js.length;
    if (js.length >= CAMERA_MIN_PEOPLE && js.length >= CAMERA_SHARE * seen) {
      out.push({ kind: "camera", frame, people: js.length, meters: median(js.map((j) => j.meters)), speed: median(js.map((j) => j.speed)) });
      continue;
    }
    for (const j of js) out.push({ kind: "player", frame, person: j.person, name: names.get(j.person) ?? null, meters: j.meters, speed: j.speed });
  }
  return out.sort((a, b) => rank(a) - rank(b) || a.frame - b.frame);
}
const rank = (a: Anomaly) => (a.kind === "player" ? (a.name ? 0 : 2) : 1);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

// The ball. Only positions that are a measurement count (by hand or from the tracker); events are too rough and lines
// between marks are drawn, not seen. A detour (out and straight back) is reported once, with where it ends.
export function ballAnomalies(points: BallPoint[], file: Pick<TracksFile, "fps" | "venue">): Anomaly[] {
  const [sx, sy] = scaleOf(file);
  const pts = points.filter((p) => p.source === "manual" || p.source === "auto").sort((a, b) => a.frame - b.frame);
  const dist = (a: BallPoint, b: BallPoint) => Math.hypot((b.x - a.x) * sx, (b.y - a.y) * sy);
  const dt = (a: BallPoint, b: BallPoint) => (b.frame - a.frame) / file.fps;
  const impossible = (a: BallPoint, b: BallPoint) => {
    const t = dt(a, b);
    const d = dist(a, b);
    return t > 0 && t <= BALL_PAIR_MAX_S && d > BALL_MIN_M && d / t > BALL_MAX_MS;
  };
  const possible = (a: BallPoint, b: BallPoint) => dt(a, b) > 0 && dist(a, b) <= BALL_MAX_MS * dt(a, b) + BALL_MIN_M;
  const out: Anomaly[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!impossible(a, b)) continue;
    // Out and back: a later position, within DETOUR_S, that the ball could reach from where it was before the jump.
    let back = -1;
    for (let k = i + 1; k < pts.length && dt(b, pts[k]) <= DETOUR_S; k++) {
      if (possible(a, pts[k])) {
        back = k;
        break;
      }
    }
    out.push({ kind: "ball", frame: b.frame, meters: dist(a, b), speed: dist(a, b) / dt(a, b), ...(back >= 0 ? { until: pts[back].frame } : {}) });
    if (back >= 0) i = back;
  }
  return out;
}
