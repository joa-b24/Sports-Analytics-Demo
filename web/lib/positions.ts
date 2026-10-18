// Analysis from corrected positions (tracks_fixed_*.json, written by the correction table): heat maps, who has the
// ball and the passes it implies, and players behind the ball when it is lost. Pure functions, no file access.
//
// Everything here only counts what the camera saw: a player out of frame is not absent, just not seen. Positions
// filled inside short holes ("interpolated") are left out of the counts; they are not measurements.
import { boxTeamOf, fileTeamRefs, type TracksFile } from "./tracks.ts";
import { PITCH, type MatchEvent } from "./types.ts";

export type FixedTeam = "own" | "opp" | "ref" | "unk";
export interface FixedPosition {
  id: number;
  x: number;
  y: number;
  source: string;
}
export interface FixedFile {
  kind: "tracks_fixed";
  match_id: string;
  video_id: string;
  fps: number;
  start_frame: number;
  end_frame: number;
  stride: number;
  // Built from a part nobody corrected (autoFixed): teams are right box by box, identities are the program's.
  auto?: boolean;
  // Real size of the venue (m). Absent in files saved before 2026-10-16: then the loader takes it from match.yaml.
  venue?: { length_m: number; width_m: number } | null;
  people: { id: number; team: FixedTeam; player_id: string | null; tracks: number[] }[];
  ball: { frame: number; x: number; y: number; source: string }[];
  frames: { frame: number; positions: FixedPosition[] }[];
}

export const fixedName = (videoId: string) => new RegExp(`^tracks_fixed_${videoId}_\\d+_\\d+\\.json$`);

export function parseFixed(text: string): FixedFile | null {
  try {
    const d = JSON.parse(text) as FixedFile;
    return d && d.kind === "tracks_fixed" && Array.isArray(d.frames) && Array.isArray(d.people) ? { ...d, ball: d.ball ?? [] } : null;
  } catch {
    return null;
  }
}

// A processed part that nobody corrected, as positions by team. The team is read box by box from its shirt (as in the
// correction table), so a program identity that passes from one team to the other is split in two: team-level
// analysis (heat maps, players behind the ball, the animation) is right even if who is who is not. People off the
// pitch and referees are left out. No names, so nothing here enters a pass network.
const TEAM_SLOT: Record<string, number> = { own: 1, opp: 2 };
export function autoFixed(t: TracksFile): FixedFile {
  const refs = fileTeamRefs(t);
  const teamOf = new Map<number, FixedTeam>();
  const frames = t.frames.map((fr) => ({
    frame: fr.frame,
    positions: fr.boxes.flatMap((b) => {
      if (!b[11] || b[9] === null || b[10] === null) return [];
      const team = boxTeamOf(b, refs);
      if (team !== "own" && team !== "opp") return [];
      const id = (b[13] ?? b[0]) * 4 + TEAM_SLOT[team];
      teamOf.set(id, team);
      return [{ id, x: b[9], y: b[10], source: "auto" }];
    }),
  }));
  return {
    kind: "tracks_fixed",
    auto: true,
    match_id: t.match_id,
    video_id: t.video_id,
    fps: t.fps,
    start_frame: t.start_frame,
    end_frame: t.end_frame,
    stride: t.stride,
    venue: t.venue?.length_m && t.venue?.width_m ? { length_m: t.venue.length_m, width_m: t.venue.width_m } : null,
    people: [...teamOf].map(([id, team]) => ({ id, team, player_id: null, tracks: [] })),
    ball: [],
    frames,
  };
}

// --------------------------------------------------------------------------------------------- direction of play

// Whether the analysed team ("own") attacks towards x = 105 in the pitch of this part. Inferred from where each
// team spends its time: over a stretch of play a team is on average nearer its own goal. Null when the two teams
// are not seen enough, or sit too close to tell (then it has to be said by hand in the correction table).
export const ATTACK_MIN_SAMPLES = 200;
export const ATTACK_MIN_DIFF_M = 4;
// Several parts of the same video can be passed together (a video is one half: the direction does not change in it).
export function inferOwnAttacksRight(files: FixedFile | FixedFile[]): boolean | null {
  const sum = { own: 0, opp: 0 };
  const n = { own: 0, opp: 0 };
  for (const f of Array.isArray(files) ? files : [files]) {
    const team = new Map(f.people.map((p) => [p.id, p.team]));
    for (const fr of f.frames)
      for (const q of fr.positions) {
        const t = team.get(q.id);
        if ((t === "own" || t === "opp") && q.source !== "interpolated") {
          sum[t] += q.x;
          n[t] += 1;
        }
      }
  }
  if (n.own < ATTACK_MIN_SAMPLES || n.opp < ATTACK_MIN_SAMPLES) return null;
  const diff = sum.opp / n.opp - sum.own / n.own;
  return Math.abs(diff) < ATTACK_MIN_DIFF_M ? null : diff > 0;
}

// A part with the analysed team always attacking towards x = 105 (as events are tagged), mirrored if needed.
export interface Oriented {
  file: FixedFile;
  ownRight: boolean;
}
// Real meters per unit of the normalised pitch, along x and y. Without the venue size, 1 (an error of a few percent).
export const metersPerUnit = (f: FixedFile): [number, number] =>
  f.venue?.length_m && f.venue?.width_m ? [f.venue.length_m / PITCH.length, f.venue.width_m / PITCH.width] : [1, 1];
const realDistance = (f: FixedFile, ax: number, ay: number, bx: number, by: number) => {
  const [mx, my] = metersPerUnit(f);
  return Math.hypot((ax - bx) * mx, (ay - by) * my);
};

export const orient = (o: Oriented, x: number, y: number): [number, number] => (o.ownRight ? [x, y] : [PITCH.length - x, PITCH.width - y]);

// --------------------------------------------------------------------------------------------- heat maps

export interface Heat {
  nx: number;
  ny: number;
  seconds: number[]; // nx * ny, row by row (y), seconds seen in each cell
  total: number; // seconds of player presence counted
}

// Time spent in each cell of the pitch by a team (or by one player of it, by name), with the team attacking right.
export function heatmap(parts: Oriented[], team: "own" | "opp", playerId: string | null = null, nx = 21, ny = 14): Heat {
  const seconds = new Array(nx * ny).fill(0);
  let total = 0;
  for (const o of parts) {
    const dt = o.file.stride / o.file.fps;
    const keep = new Set(o.file.people.filter((p) => p.team === team && (playerId === null || p.player_id === playerId)).map((p) => p.id));
    for (const fr of o.file.frames)
      for (const q of fr.positions) {
        if (!keep.has(q.id) || q.source === "interpolated") continue;
        const [x, y] = orient(o, q.x, q.y);
        const i = Math.min(nx - 1, Math.max(0, Math.floor((x / PITCH.length) * nx)));
        const j = Math.min(ny - 1, Math.max(0, Math.floor((y / PITCH.width) * ny)));
        seconds[j * nx + i] += dt;
        total += dt;
      }
  }
  return { nx, ny, seconds, total };
}

// Named players of a team across the parts (names come from the correction table), by time seen.
export function namedPlayers(parts: Oriented[], team: "own" | "opp"): { name: string; seconds: number }[] {
  const out = new Map<string, number>();
  for (const o of parts) {
    const dt = o.file.stride / o.file.fps;
    const name = new Map(o.file.people.filter((p) => p.team === team && p.player_id).map((p) => [p.id, p.player_id as string]));
    for (const fr of o.file.frames)
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (n && q.source !== "interpolated") out.set(n, (out.get(n) ?? 0) + dt);
      }
  }
  return [...out].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds);
}

// --------------------------------------------------------------------------------------------- ball and passes

// A player has the ball when she is the nearest one to it and within this distance, in real meters of the venue (not
// units of the 105 x 68 drawing). Calibration noise is around a metre, so tighter than this loses real touches.
export const POSSESS_M = 2;
// Two consecutive holders of the same team are a pass when the ball goes from one to the other within this time (s).
export const PASS_MAX_S = 5;

export interface Touch {
  frame: number;
  id: number;
  team: "own" | "opp";
}

// Who has the ball in each frame where the ball is known: the nearest player within POSSESS_M, unless a player of
// the other team is about as near (contested: nobody). An interpolated ball (straight line between two marks) is never
// a touch: the ball went over or past whoever was near that line, and nobody cut it. Touches only come from where the
// ball was marked by hand or from a tagged event.
export function touches(f: FixedFile): Touch[] {
  const team = new Map(f.people.map((p) => [p.id, p.team]));
  const byFrame = new Map(f.frames.map((fr) => [fr.frame, fr.positions]));
  const out: Touch[] = [];
  for (const b of f.ball) {
    if (b.source === "interpolated") continue;
    const ps = byFrame.get(b.frame);
    if (!ps) continue;
    const near = ps
      .map((q) => ({ q, t: team.get(q.id), d: realDistance(f, q.x, q.y, b.x, b.y) }))
      .filter((c) => (c.t === "own" || c.t === "opp") && c.d <= POSSESS_M)
      .sort((a, c) => a.d - c.d);
    if (near.length === 0) continue;
    const rival = near.find((c) => c.t !== near[0].t);
    if (rival && rival.d - near[0].d < 0.5) continue;
    out.push({ frame: b.frame, id: near[0].q.id, team: near[0].t as "own" | "opp" });
  }
  return out;
}

export interface Pass {
  frame: number; // when the receiver first has it
  from: number;
  to: number;
  team: "own" | "opp";
}
export interface Turnover {
  frame: number; // when the other team first has it
  lost: "own" | "opp";
}

// Passes and changes of team from the sequence of holders. Only when the ball is followed: with no ball, nothing.
export function passesAndTurnovers(f: FixedFile): { passes: Pass[]; turnovers: Turnover[]; touches: Touch[] } {
  const ts = touches(f);
  const passes: Pass[] = [];
  const turnovers: Turnover[] = [];
  const maxGap = PASS_MAX_S * f.fps;
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1];
    const b = ts[i];
    if (a.id === b.id || b.frame - a.frame > maxGap) continue;
    if (a.team === b.team) passes.push({ frame: b.frame, from: a.id, to: b.id, team: a.team });
    else turnovers.push({ frame: b.frame, lost: a.team });
  }
  return { passes, turnovers, touches: ts };
}

export interface PassNode {
  key: string;
  label: string;
  x: number;
  y: number;
  touches: number;
}
export interface PassNetwork {
  nodes: PassNode[];
  edges: { a: string; b: string; count: number }[];
  passes: number;
  unnamed: number; // passes with a player who has no name in the correction table
  ballSeconds: number; // time with the ball known
}

// Who passes to whom in a team, over the parts. Players are joined across parts by their name; a pass with a player
// without a name is counted apart. Each player is drawn at her average position (team attacking right).
export function passNetwork(parts: Oriented[], team: "own" | "opp"): PassNetwork {
  const pos = new Map<string, { x: number; y: number; n: number }>();
  const touchesOf = new Map<string, number>();
  const edges = new Map<string, number>();
  let passes = 0;
  let unnamed = 0;
  let ballSeconds = 0;
  for (const o of parts) {
    const name = new Map(o.file.people.map((p) => [p.id, p.player_id]));
    const teamOf = new Map(o.file.people.map((p) => [p.id, p.team]));
    ballSeconds += (o.file.ball.length * o.file.stride) / o.file.fps;
    for (const fr of o.file.frames)
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n || teamOf.get(q.id) !== team || q.source === "interpolated") continue;
        const [x, y] = orient(o, q.x, q.y);
        const s = pos.get(n) ?? { x: 0, y: 0, n: 0 };
        pos.set(n, { x: s.x + x, y: s.y + y, n: s.n + 1 });
      }
    const r = passesAndTurnovers(o.file);
    for (const t of r.touches) {
      const n = name.get(t.id);
      if (n && t.team === team) touchesOf.set(n, (touchesOf.get(n) ?? 0) + 1);
    }
    for (const p of r.passes) {
      if (p.team !== team) continue;
      passes += 1;
      const a = name.get(p.from);
      const b = name.get(p.to);
      if (!a || !b) {
        unnamed += 1;
        continue;
      }
      const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const inEdges = new Set([...edges.keys()].flatMap((k) => k.split("\u0000")));
  const nodes = [...pos]
    .filter(([k]) => inEdges.has(k) || touchesOf.has(k))
    .map(([key, s]) => ({ key, label: key, x: s.x / s.n, y: s.y / s.n, touches: touchesOf.get(key) ?? 0 }));
  return {
    nodes,
    edges: [...edges].map(([k, count]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, count };
    }),
    passes,
    unnamed,
    ballSeconds,
  };
}

// --------------------------------------------------------------------------------------------- behind the ball

export interface BehindBall {
  t: number; // t_video
  video_id: string;
  behind: number; // players of the team that lost it nearer their own goal than the ball
  seen: number; // players of that team in frame
  source: "event" | "ball"; // a tagged loss, or a change of team read from the followed ball
}

// The positions of a part closest to a frame (within two processed frames), or null.
function positionsNear(f: FixedFile, frame: number): FixedPosition[] | null {
  let lo = 0;
  let hi = f.frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.frames[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  const cands = [f.frames[lo], f.frames[lo - 1]].filter(Boolean);
  const best = cands.sort((a, b) => Math.abs(a.frame - frame) - Math.abs(b.frame - frame))[0];
  return Math.abs(best.frame - frame) <= 2 * f.stride ? best.positions : null;
}

// For each loss of the analysed team: how many of its players were behind the ball (between the ball and their own
// goal) at that instant. Losses come from tagged events ("loss" by the analysed team), whose position is the ball;
// where the ball is followed, a change of team read from it also counts (unless a tagged loss is within 2 s).
export function behindBallAtLosses(parts: Oriented[], events: MatchEvent[]): BehindBall[] {
  const out: BehindBall[] = [];
  for (const o of parts) {
    const f = o.file;
    const team = new Map(f.people.map((p) => [p.id, p.team]));
    const count = (frame: number, ballX: number): { behind: number; seen: number } | null => {
      const ps = positionsNear(f, frame);
      if (!ps) return null;
      const own = ps.filter((q) => team.get(q.id) === "own" && q.source !== "interpolated");
      return { behind: own.filter((q) => orient(o, q.x, q.y)[0] < ballX).length, seen: own.length };
    };
    const ballAt = new Map(f.ball.map((b) => [b.frame, b]));
    const lossFrames: number[] = [];
    for (const e of events) {
      if (e.type !== "loss" || e.team !== "own" || (e.video_id ?? "v1") !== f.video_id) continue;
      const frame = Math.round(e.t_video * f.fps);
      if (frame < f.start_frame || frame >= f.end_frame) continue;
      // The followed ball if it is known there, otherwise where the event was tagged (already attacking right).
      const near = f.ball.find((b) => Math.abs(b.frame - frame) <= f.stride * 2);
      const ballX = near ? orient(o, near.x, near.y)[0] : e.x;
      if (ballX === null) continue;
      const c = count(frame, ballX);
      if (!c) continue;
      lossFrames.push(frame);
      out.push({ t: e.t_video, video_id: f.video_id, ...c, source: "event" });
    }
    for (const tv of passesAndTurnovers(f).turnovers) {
      if (tv.lost !== "own" || lossFrames.some((fr) => Math.abs(fr - tv.frame) <= 2 * f.fps)) continue;
      const b = ballAt.get(tv.frame);
      if (!b) continue;
      const c = count(tv.frame, orient(o, b.x, b.y)[0]);
      if (c) out.push({ t: tv.frame / f.fps, video_id: f.video_id, ...c, source: "ball" });
    }
  }
  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t - b.t);
}

// --------------------------------------------------------------------------------------------- plays

export interface Dot {
  id: number;
  team: FixedTeam;
  label: string;
  x: number;
  y: number;
}

// Measured positions at a moment of the video (t_video), joined linearly between the two processed frames around
// it, with the analysed team attacking right. Ball too when it is known there. Null outside the part.
export function positionsAt(o: Oriented, t: number): { players: Dot[]; ball: [number, number] | null } | null {
  const f = o.file;
  const at = t * f.fps;
  if (at < f.start_frame || at > f.end_frame || f.frames.length === 0) return null;
  let i = 0;
  while (i < f.frames.length - 1 && f.frames[i + 1].frame <= at) i++;
  const a = f.frames[i];
  const b = f.frames[Math.min(i + 1, f.frames.length - 1)];
  const w = b.frame > a.frame ? Math.min(1, Math.max(0, (at - a.frame) / (b.frame - a.frame))) : 0;
  const next = new Map(b.positions.map((q) => [q.id, q]));
  const people = new Map(f.people.map((p) => [p.id, p]));
  const players = a.positions.flatMap((q) => {
    const p = people.get(q.id);
    if (!p) return [];
    const r = next.get(q.id) ?? q;
    const [x, y] = orient(o, q.x + (r.x - q.x) * w, q.y + (r.y - q.y) * w);
    return [{ id: q.id, team: p.team, label: p.player_id ? p.player_id.slice(0, 3) : "", x, y }];
  });
  const ba = f.ball.find((p) => p.frame === a.frame);
  const bb = f.ball.find((p) => p.frame === b.frame) ?? ba;
  const ball = ba && bb ? orient(o, ba.x + (bb.x - ba.x) * w, ba.y + (bb.y - ba.y) * w) : null;
  return { players, ball };
}

// The part that covers a stretch of a video, if any.
export const partFor = <T extends Oriented>(parts: T[], videoId: string, t0: number, t1: number): T | null =>
  parts.find((o) => o.file.video_id === videoId && t1 * o.file.fps > o.file.start_frame && t0 * o.file.fps < o.file.end_frame) ?? null;
