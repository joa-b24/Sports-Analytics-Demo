// Metrics of one play (a stretch [t0, t1] of one video) from the corrected tracking. Pure functions over the parts
// (lib/positions.ts FixedFile with the direction of attack): no storage, no React.
//
// Rules: a number that cannot be calculated is NaN (the screen says «sin dato» and why); nothing is filled in. Positions
// held still outside what was seen (`extrapolated`) count in nothing; filled ones (`interpolated`) count in the
// player's distance and speed, and the share is reported (as physical.ts does). The ball counts only where a hand mark
// or the ball tracker put it (`manual` / `auto`); the straight line between two such marks is a minimum, not a path.
import { metersPerUnit, orient, passesAndTurnovers, ballStates, type FixedFile, type Oriented } from "./positions.ts";
import { ballJumpFrames } from "./parts.ts";
import { physical } from "./physical.ts";
import { GK_GAP_M, LINE_PLAYERS, MIN_VISIBLE } from "./blockShape.ts";
import { isExtrapolated } from "./smooth.ts";
import { PITCH, type MatchEvent } from "./types.ts";
import { videoOf } from "./videos.ts";

export type Side = "own" | "opp";

// Two ball marks further apart than this are not joined (the ball moved by more than a straight line shows).
export const BALL_GAP_S = 1.5;
// A step of the ball faster than this (m/s, 144 km/h) is a jump of the tracker, not the ball.
export const BALL_MAX_MS = 40;
// The ball keeps belonging to the team of the last touch for up to this long without another touch.
export const CARRY_S = 2;
// Window of a position «at the start» or «at the end»: the nearest processed frame within this many seconds.
export const EDGE_S = 0.5;

export interface BallMetrics {
  distance_m: number;
  mean_ms: number;
  max_ms: number;
  // Seconds of the play joined by valid steps / duration (0..1).
  coverage: number;
  marks: number;
  // Marks in the air (their ground projection): the distance is of the projection, not of the flight.
  aerial: number;
}
export interface PossessionMetrics {
  own_s: number;
  opp_s: number;
  // Ball followed but nobody had it clearly (contested, blocked, free, or too long since the last touch).
  unclear_s: number;
  // Seconds of the play with no ball measured.
  unmeasured_s: number;
  // Seconds with the ball measured / duration (0..1).
  coverage: number;
}
export interface PassCounts {
  own: number;
  opp: number;
  // Of those, the ones read between boxes of a team without names (approximate).
  approx: number;
}
export interface Edge {
  // Players of the side in frame, those nearer her own goal than the ball (behind) and nearer the rival's (ahead).
  seen: number;
  behind: number;
  ahead: number;
}
export interface ShapeNow {
  width_m: number;
  length_m: number;
  line_height_m: number;
  block_height_m: number;
  // Players of the side seen (outfield, after the keeper rule); the shape needs MIN_VISIBLE.
  seen: number;
}
export interface PlayerMetric {
  name: string;
  team: Side;
  seconds: number;
  distance_m: number;
  top_kmh: number; // NaN: no window of a second to measure
  hsr_m: number;
  sprints: number;
  fill_time_pct: number;
}
export interface PlayMetrics {
  video_id: string;
  t0: number;
  t1: number;
  duration_s: number;
  // The play falls in a part of the tracking at all.
  tracked: boolean;
  ball: BallMetrics;
  possession: PossessionMetrics;
  // Passes read from the tracking inside the play (source: tracking). Counts are NaN when no ball was measured.
  passes: PassCounts;
  // Tagged key passes (source: events) inside the play, by team.
  key_passes: { own: number; opp: number };
  ball_side: { start: Record<Side, Edge | null>; end: Record<Side, Edge | null> };
  shape: { start: Record<Side, ShapeNow | null>; end: Record<Side, ShapeNow | null> };
  players: PlayerMetric[];
  // Named players of the play with no measured position at all in it.
  players_missing: string[];
}

const nanBall = (): BallMetrics => ({ distance_m: NaN, mean_ms: NaN, max_ms: NaN, coverage: 0, marks: 0, aerial: 0 });

// The parts that cover the stretch, of its video.
const partsOf = (parts: Oriented[], videoId: string, t0: number, t1: number) =>
  parts.filter((o) => o.file.video_id === videoId && t1 * o.file.fps > o.file.start_frame && t0 * o.file.fps < o.file.end_frame);

// Ball marks of a part inside [t0, t1], sorted: measured ones only (manual / auto), in real meters.
function ballMarks(f: FixedFile, t0: number, t1: number) {
  const [mx, my] = metersPerUnit(f);
  const jumps = ballJumpFrames(f.ball, f.fps, mx, my);
  return f.ball
    .filter((b) => (b.source === "manual" || b.source === "auto") && b.frame / f.fps >= t0 && b.frame / f.fps <= t1)
    .sort((a, b) => a.frame - b.frame)
    .map((b) => ({ t: b.frame / f.fps, x: b.x * mx, y: b.y * my, aerial: !!b.aerial, jump: jumps.has(b.frame) }));
}

export function ballMetrics(parts: Oriented[], t0: number, t1: number): BallMetrics {
  const dur = t1 - t0;
  if (!(dur > 0)) return nanBall();
  let dist = 0;
  let covered = 0;
  let max = 0;
  let marks = 0;
  let aerial = 0;
  for (const o of parts) {
    const ms = ballMarks(o.file, t0, t1);
    marks += ms.length;
    aerial += ms.filter((m) => m.aerial).length;
    for (let i = 1; i < ms.length; i++) {
      const dt = ms[i].t - ms[i - 1].t;
      if (dt <= 0 || dt > BALL_GAP_S || ms[i - 1].jump) continue;
      const d = Math.hypot(ms[i].x - ms[i - 1].x, ms[i].y - ms[i - 1].y);
      if (d / dt > BALL_MAX_MS) continue;
      dist += d;
      covered += dt;
      max = Math.max(max, d / dt);
    }
  }
  if (covered === 0) return { ...nanBall(), marks, aerial };
  return { distance_m: dist, mean_ms: dist / covered, max_ms: max, coverage: Math.min(1, covered / dur), marks, aerial };
}

// Who had the ball and for how long: every measured ball mark weighs the time to the next one (at most BALL_GAP_S); a
// touch gives the ball to her team, and without another touch it stays with that team for CARRY_S.
export function possessionMetrics(parts: Oriented[], t0: number, t1: number): PossessionMetrics {
  const dur = t1 - t0;
  const out = { own_s: 0, opp_s: 0, unclear_s: 0 };
  if (!(dur > 0)) return { ...out, unmeasured_s: NaN, coverage: 0 };
  for (const o of parts) {
    const f = o.file;
    const st = ballStates(f)
      .filter((s) => (s.source === "manual" || s.source === "auto") && s.frame / f.fps >= t0 - CARRY_S && s.frame / f.fps <= t1)
      .sort((a, b) => a.frame - b.frame);
    let holder: Side | null = null;
    let since = -Infinity;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const t = s.frame / f.fps;
      if (s.touch) {
        holder = s.touch.team;
        since = t;
      }
      if (t < t0) continue;
      const next = st[i + 1] ? st[i + 1].frame / f.fps : t;
      const w = Math.max(0, Math.min(next - t, BALL_GAP_S, t1 - t));
      const key = s.touch ? s.touch.team : holder && t - since <= CARRY_S && !s.contested && !s.blocked && !s.jump ? holder : null;
      if (key === "own") out.own_s += w;
      else if (key === "opp") out.opp_s += w;
      else out.unclear_s += w;
    }
  }
  const measured = out.own_s + out.opp_s + out.unclear_s;
  return { ...out, unmeasured_s: Math.max(0, dur - measured), coverage: Math.min(1, measured / dur) };
}

export function passMetrics(parts: Oriented[], t0: number, t1: number, ball: BallMetrics): PassCounts {
  if (ball.marks === 0) return { own: NaN, opp: NaN, approx: NaN };
  const out = { own: 0, opp: 0, approx: 0 };
  for (const o of parts) {
    for (const p of passesAndTurnovers(o.file).passes) {
      const from = p.from_frame / o.file.fps;
      const to = p.frame / o.file.fps;
      if (from < t0 || to > t1) continue;
      out[p.team]++;
      if (p.approx) out.approx++;
    }
  }
  return out;
}

// The part and ball mark nearest a time, within EDGE_S (measured marks only).
function ballAt(o: Oriented, t: number): [number, number] | null {
  const f = o.file;
  let best: { d: number; x: number; y: number } | null = null;
  for (const b of f.ball) {
    if (b.source !== "manual" && b.source !== "auto") continue;
    const d = Math.abs(b.frame / f.fps - t);
    if (d <= EDGE_S && (!best || d < best.d)) best = { d, x: b.x, y: b.y };
  }
  return best ? orient(o, best.x, best.y) : null;
}

// Measured positions of the people at the processed frame nearest t, with the analysed team attacking right
// (x = 0 is her own goal). Extrapolated ones are left out.
function peopleAt(o: Oriented, t: number): { team: string; x: number; y: number }[] | null {
  const f = o.file;
  const at = t * f.fps;
  let best: (typeof f.frames)[number] | null = null;
  for (const fr of f.frames) if (!best || Math.abs(fr.frame - at) < Math.abs(best.frame - at)) best = fr;
  if (!best || Math.abs(best.frame - at) / f.fps > EDGE_S) return null;
  const team = new Map(f.people.map((p) => [p.id, p.team]));
  return best.positions.flatMap((q) => {
    const tm = team.get(q.id);
    if (!tm || isExtrapolated(q.source)) return [];
    const [x, y] = orient(o, q.x, q.y);
    return [{ team: tm, x, y }];
  });
}

const sideEdge = (o: Oriented, t: number, side: Side): Edge | null => {
  const ball = ballAt(o, t);
  const ps = peopleAt(o, t);
  if (!ball || !ps) return null;
  const mine = ps.filter((p) => p.team === side);
  // Own team defends x = 0 and attacks right; the rival the other way round.
  const behind = mine.filter((p) => (side === "own" ? p.x < ball[0] : p.x > ball[0])).length;
  const ahead = mine.filter((p) => (side === "own" ? p.x > ball[0] : p.x < ball[0])).length;
  return { seen: mine.length, behind, ahead };
};

const shapeNow = (o: Oriented, t: number, side: Side): ShapeNow | null => {
  const ps = peopleAt(o, t);
  if (!ps) return null;
  const [mx, my] = metersPerUnit(o.file);
  const mine = ps.filter((p) => p.team === side);
  // Depth in meters from her own goal, as blockShape does.
  const depth = mine.map((p) => (side === "own" ? p.x : PITCH.length - p.x) * mx);
  const ys = mine.map((p) => p.y * my);
  const idx = depth.map((_, i) => i).sort((a, b) => depth[a] - depth[b]);
  let d = idx.map((i) => depth[i]);
  let y = idx.map((i) => ys[i]);
  if (d.length >= 2 && d[1] - d[0] > GK_GAP_M) {
    d = d.slice(1);
    y = y.slice(1);
  }
  if (d.length < MIN_VISIBLE) return null;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  return { width_m: Math.max(...y) - Math.min(...y), length_m: d[d.length - 1] - d[0], line_height_m: mean(d.slice(0, LINE_PLAYERS)), block_height_m: mean(d), seen: d.length };
};

// The part with a given file sliced to [t0, t1] (frames inside), so that physical() reads only the play.
const slice = (o: Oriented, t0: number, t1: number): Oriented => ({
  ...o,
  file: { ...o.file, frames: o.file.frames.filter((fr) => fr.frame / o.file.fps >= t0 && fr.frame / o.file.fps <= t1) },
});

export function playerMetrics(parts: Oriented[], t0: number, t1: number, names: string[]): { rows: PlayerMetric[]; missing: string[] } {
  const sliced = parts.map((o) => slice(o, t0, t1));
  const rows: PlayerMetric[] = [];
  for (const team of ["own", "opp"] as Side[]) {
    for (const r of physical(sliced, team)) {
      if (!names.includes(r.name)) continue;
      rows.push({
        name: r.name,
        team,
        seconds: r.seconds,
        distance_m: r.distance_m,
        top_kmh: r.top_kmh === null ? NaN : r.top_kmh,
        hsr_m: r.hsr_m,
        sprints: r.sprints,
        fill_time_pct: r.fill_time_pct,
      });
    }
  }
  const got = new Set(rows.map((r) => r.name));
  return { rows, missing: names.filter((n) => !got.has(n)) };
}

// Named players seen in the parts of the play (for the picker), with the team.
export function playPlayers(parts: Oriented[]): { name: string; team: Side }[] {
  const seen = new Map<string, Side>();
  for (const o of parts)
    for (const p of o.file.people) if (p.player_id && (p.team === "own" || p.team === "opp")) seen.set(p.player_id, p.team);
  return [...seen].map(([name, team]) => ({ name, team })).sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));
}

export function playMetrics(input: { parts: Oriented[]; videoId: string; t0: number; t1: number; events?: MatchEvent[]; players?: string[] }): PlayMetrics {
  const { videoId, t0, t1 } = input;
  const parts = partsOf(input.parts, videoId, t0, t1);
  const dur = t1 - t0;
  const first = parts[0];
  const edges = (t: number) => ({
    ball: { own: first ? sideEdge(first, t, "own") : null, opp: first ? sideEdge(first, t, "opp") : null },
    shape: { own: first ? shapeNow(first, t, "own") : null, opp: first ? shapeNow(first, t, "opp") : null },
  });
  const a = edges(t0);
  const b = edges(t1);
  const ball = parts.length ? ballMetrics(parts, t0, t1) : nanBall();
  const { rows, missing } = parts.length ? playerMetrics(parts, t0, t1, input.players ?? []) : { rows: [], missing: input.players ?? [] };
  const key = (input.events ?? []).filter((e) => e.type === "key_pass" && videoOf(e) === videoId && e.t_video >= t0 && e.t_video <= t1);
  return {
    video_id: videoId,
    t0,
    t1,
    duration_s: dur,
    tracked: parts.length > 0,
    ball,
    possession: parts.length ? possessionMetrics(parts, t0, t1) : { own_s: NaN, opp_s: NaN, unclear_s: NaN, unmeasured_s: dur, coverage: 0 },
    passes: parts.length ? passMetrics(parts, t0, t1, ball) : { own: NaN, opp: NaN, approx: NaN },
    key_passes: { own: key.filter((e) => e.team === "own").length, opp: key.filter((e) => e.team === "opp").length },
    ball_side: { start: a.ball, end: b.ball },
    shape: { start: a.shape, end: b.shape },
    players: rows,
    players_missing: missing,
  };
}

// Why a number is not there (for the «sin dato» note). Empty when it is.
export function missingReason(m: PlayMetrics, what: "ball" | "possession" | "passes" | "edge" | "shape"): string {
  if (!m.tracked) return "La jugada no cae en una parte con tracking.";
  if (what === "ball" || what === "possession" || what === "passes") return m.ball.marks === 0 ? "El balón no está medido en este tramo (sin marcas a mano ni del seguimiento)." : "";
  if (what === "edge") return "Falta el balón o las jugadoras en ese instante.";
  return `Hacen falta ${MIN_VISIBLE} jugadoras del equipo en cuadro en ese instante.`;
}
