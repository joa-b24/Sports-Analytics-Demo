// Analysis from corrected positions (tracks_fixed_*.json, written by the correction table): heat maps, who has the
// ball and the passes it implies, and players behind the ball when it is lost. Pure functions, no file access.
//
// Everything here only counts what the camera saw: a player out of frame is not absent, just not seen. Positions
// filled inside short holes ("interpolated") are left out of the counts; they are not measurements.
import { boxTeamOf, fileTeamRefs, type TracksFile } from "./tracks.ts";
import type { Segment } from "./segments.ts";
import { laneThirdOf } from "./stats.ts";
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

// A team is named in a part when more than this share of its measured positions belong to a named person. The rival
// is often named only in some parts, or only a few of its players: then its unnamed people are just unnamed.
export const NAMED_TEAM_MIN = 0.5;

// A person without a name of a team that is named in the part (NAMED_TEAM_MIN). The correction table gives a name to
// every player of a team it names, so this is a leftover: a second box on a player, or a piece that was not joined to
// her. Leftovers never take the ball (the named player next to them does); they are listed to be fixed in the table.
export interface Leftover {
  id: number;
  team: "own" | "opp";
  first: number; // frames where it is seen
  last: number;
  frames: number;
}
export function unnamedLeftovers(f: FixedFile): Leftover[] {
  const person = new Map(f.people.map((p) => [p.id, p]));
  const seen = { own: 0, opp: 0 };
  const named = { own: 0, opp: 0 };
  const out = new Map<number, Leftover>();
  for (const fr of f.frames)
    for (const q of fr.positions) {
      const p = person.get(q.id);
      if (!p || (p.team !== "own" && p.team !== "opp") || q.source === "interpolated") continue;
      seen[p.team]++;
      if (p.player_id) {
        named[p.team]++;
        continue;
      }
      const l = out.get(q.id) ?? { id: q.id, team: p.team, first: fr.frame, last: fr.frame, frames: 0 };
      l.first = Math.min(l.first, fr.frame);
      l.last = Math.max(l.last, fr.frame);
      l.frames++;
      out.set(q.id, l);
    }
  const isNamed = (t: "own" | "opp") => seen[t] > 0 && named[t] / seen[t] > NAMED_TEAM_MIN;
  return [...out.values()].filter((l) => isNamed(l.team)).sort((x, y) => x.first - y.first);
}

// Who has the ball in each frame where the ball is known: the nearest player within POSSESS_M, unless a player of
// the other team is about as near (contested: nobody). Only measurements count, for the ball and for the players:
//   - an interpolated ball (straight line between two marks) is never a touch: the ball went over or past whoever was
//     near that line, and nobody cut it. Touches come from where the ball was marked by hand or from a tagged event;
//   - a player at an interpolated position (a short hole filled in) was not seen there, so she is not a candidate;
//   - leftovers without a name (unnamedLeftovers) are not candidates either.
export function touches(f: FixedFile): Touch[] {
  return ballStates(f).flatMap((s) => (s.touch ? [s.touch] : []));
}

// What the ball is doing at each known position: held (a touch), contested (players of both teams about as near),
// or free (nobody near enough). `followed`: a hand mark, or a position joined to one by less than BALL_FILL_S (the
// time counted as "ball followed"); positions taken only from tagged events, far from any mark, are not.
export interface BallState {
  frame: number;
  source: string;
  followed: boolean;
  touch: Touch | null;
  contested: boolean;
}
// Same as BALL_FILL_S in parts.ts (not imported: this module stays free of the drawing code).
const FOLLOW_S = 3;

export function ballStates(f: FixedFile): BallState[] {
  const team = new Map(f.people.map((p) => [p.id, p.team]));
  const leftover = new Set(unnamedLeftovers(f).map((l) => l.id));
  const byFrame = new Map(f.frames.map((fr) => [fr.frame, fr.positions]));
  const manual = f.ball.filter((b) => b.source === "manual").map((b) => b.frame).sort((x, y) => x - y);
  const nearManual = (frame: number) => {
    let lo = 0;
    let hi = manual.length - 1;
    if (hi < 0) return false;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (manual[mid] < frame) lo = mid + 1;
      else hi = mid;
    }
    const d = Math.min(Math.abs(manual[lo] - frame), lo > 0 ? Math.abs(manual[lo - 1] - frame) : Infinity);
    return d / f.fps <= FOLLOW_S;
  };
  const out: BallState[] = [];
  for (const b of [...f.ball].sort((x, y) => x.frame - y.frame)) {
    const state: BallState = { frame: b.frame, source: b.source, followed: b.source === "manual" || nearManual(b.frame), touch: null, contested: false };
    out.push(state);
    if (b.source === "interpolated") continue;
    const ps = byFrame.get(b.frame);
    if (!ps) continue;
    const near = ps
      .filter((q) => q.source !== "interpolated" && !leftover.has(q.id))
      .map((q) => ({ q, t: team.get(q.id), d: realDistance(f, q.x, q.y, b.x, b.y) }))
      .filter((c) => (c.t === "own" || c.t === "opp") && c.d <= POSSESS_M)
      .sort((a, c) => a.d - c.d);
    if (near.length === 0) continue;
    const rival = near.find((c) => c.t !== near[0].t);
    if (rival && rival.d - near[0].d < 0.5) {
      state.contested = true;
      continue;
    }
    state.touch = { frame: b.frame, id: near[0].q.id, team: near[0].t as "own" | "opp" };
  }
  return out;
}

export interface Pass {
  frame: number; // when the receiver first has it
  from_frame: number; // the last touch of the passer
  from: number;
  to: number;
  team: "own" | "opp";
}
export interface Turnover {
  frame: number; // when the other team first has it
  from_frame: number; // the last touch of the team that lost it
  from: number; // who had it
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
    if (a.team === b.team) passes.push({ frame: b.frame, from_frame: a.frame, from: a.id, to: b.id, team: a.team });
    else turnovers.push({ frame: b.frame, from_frame: a.frame, from: a.id, lost: a.team });
  }
  return { passes, turnovers, touches: ts };
}

// --------------------------------------------------------------------------------------------- possession and passes

// Time is counted on cells of COVER_STEP_S per video, so that a stretch in two files counts once and the possession adds
// up exactly to the time with the ball followed.
export const COVER_STEP_S = 0.5;
// A tagged loss (or a recovery of the other team) this close to a change of team read from the ball confirms it (s).
export const CONFIRM_S = 2;

export type PossessionState = "own" | "opp" | "unassigned";
type Side = "own" | "opp";

const inStretches = (play: Segment[] | null, t: number) => !play || play.some((g) => g.tipo === "juego" && g.end !== null && t >= g.start && t < g.end);

// Who has the ball in each cell of followed ball, inside the closed play stretches (all of it when `play` is null).
// A team keeps the ball from one of its touches until a touch of the other team, for at most PASS_MAX_S without a new
// touch. A contested ball, a ball nobody has touched for longer, or a ball before the first touch is "unassigned":
// never shared out between the teams.
export function possessionCells(o: Oriented, play: Segment[] | null, cells: Map<string, PossessionState> = new Map()): Map<string, PossessionState> {
  const f = o.file;
  const states = ballStates(f);
  const step = Math.max(1, f.stride);
  let holder: Side | null = null;
  let since = -Infinity;
  states.forEach((st, i) => {
    if (st.touch) {
      holder = st.touch.team;
      since = st.frame;
    } else if (st.contested) holder = null;
    if (!st.followed) return;
    const t = st.frame / f.fps;
    if (!inStretches(play, t)) return;
    const next = states[i + 1]?.frame ?? st.frame + step;
    const t1 = (st.frame + Math.max(1, Math.min(step, next - st.frame))) / f.fps;
    const who: PossessionState = st.touch ? st.touch.team : holder && (st.frame - since) / f.fps <= PASS_MAX_S ? holder : "unassigned";
    for (let k = Math.floor(t / COVER_STEP_S); k * COVER_STEP_S < t1; k++) {
      const key = `${f.video_id}|${k}`;
      if (!cells.has(key)) cells.set(key, who);
    }
  });
  return cells;
}

export interface TeamPasses {
  completed: number;
  // Passes cut: the other team had the ball within PASS_MAX_S of the last touch.
  cut: number;
  // By where the passer had the ball, seen by her team attacking right: thirds (own, middle, rival) and lanes (left
  // wing to right wing, as in lib/stats.ts).
  completed_by_third: number[];
  cut_by_third: number[];
  completed_by_lane: number[];
  cut_by_lane: number[];
}
export interface ChangeRow {
  video_id: string;
  t: number; // when the other team first has it (s of the video)
  lost: Side;
  // A tagged loss of that team (or recovery of the other) within CONFIRM_S.
  confirmed: boolean;
}
export interface PlayerTouches {
  player: string;
  team: Side;
  touches: number;
  // Where, team attacking right.
  points: [number, number][];
}
export interface BallReport {
  // Seconds of play with the ball followed, and how they split.
  followed_s: number;
  possession: Record<PossessionState, number>;
  passes: Record<Side, TeamPasses>;
  changes: ChangeRow[];
  // Tagged losses at a moment with the ball followed that no change read from the ball matches.
  tagged_unmatched: number;
  players: PlayerTouches[];
  leftovers: { video_id: string; team: Side; t0: number; t1: number }[];
}

const emptyPasses = (): TeamPasses => ({ completed: 0, cut: 0, completed_by_third: [0, 0, 0], cut_by_third: [0, 0, 0], completed_by_lane: [0, 0, 0, 0, 0], cut_by_lane: [0, 0, 0, 0, 0] });

// Everything the report reads from the followed ball. `playByVideo`: the play stretches of each video; with none, all
// the followed ball counts. `events` with their own video times.
export function ballReport(parts: Oriented[], playByVideo: Record<string, Segment[]>, events: MatchEvent[]): BallReport {
  const usePlay = Object.values(playByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
  const playOf = (v: string) => (usePlay ? (playByVideo[v] ?? []) : null);
  const cells = new Map<string, PossessionState>();
  const passes = { own: emptyPasses(), opp: emptyPasses() };
  const changes: ChangeRow[] = [];
  const players = new Map<string, PlayerTouches>();
  const leftovers: BallReport["leftovers"] = [];
  const losses = events.filter((e) => (e.type === "loss" || e.type === "recovery") && (e.team === "own" || e.team === "opp"));
  for (const o of parts) {
    const f = o.file;
    const play = playOf(f.video_id);
    possessionCells(o, play, cells);
    const ballAt = new Map(f.ball.map((b) => [b.frame, b]));
    const zone = (frame: number, team: Side) => {
      const b = ballAt.get(frame);
      if (!b) return null;
      const [x, y] = orient(o, b.x, b.y);
      return laneThirdOf({ x, y, team });
    };
    const r = passesAndTurnovers(f);
    const inPlay = (frame: number) => inStretches(play, frame / f.fps);
    for (const p of r.passes) {
      if (!inPlay(p.from_frame)) continue;
      const tp = passes[p.team];
      tp.completed++;
      const z = zone(p.from_frame, p.team);
      if (z) {
        tp.completed_by_third[z.third]++;
        tp.completed_by_lane[z.lane]++;
      }
    }
    for (const tv of r.turnovers) {
      if (!inPlay(tv.from_frame)) continue;
      const tp = passes[tv.lost];
      tp.cut++;
      const z = zone(tv.from_frame, tv.lost);
      if (z) {
        tp.cut_by_third[z.third]++;
        tp.cut_by_lane[z.lane]++;
      }
      const t0 = tv.from_frame / f.fps - CONFIRM_S;
      const t1 = tv.frame / f.fps + CONFIRM_S;
      const confirmed = losses.some(
        (e) =>
          (e.video_id ?? "v1") === f.video_id &&
          e.t_video >= t0 &&
          e.t_video <= t1 &&
          ((e.type === "loss" && e.team === tv.lost) || (e.type === "recovery" && e.team !== tv.lost)),
      );
      changes.push({ video_id: f.video_id, t: tv.frame / f.fps, lost: tv.lost, confirmed });
    }
    const name = new Map(f.people.map((p) => [p.id, p.player_id]));
    for (const t of r.touches) {
      const n = name.get(t.id);
      if (!n || !inPlay(t.frame)) continue;
      const b = ballAt.get(t.frame);
      const row = players.get(`${t.team}|${n}`) ?? { player: n, team: t.team, touches: 0, points: [] };
      row.touches++;
      if (b) row.points.push(orient(o, b.x, b.y));
      players.set(`${t.team}|${n}`, row);
    }
    for (const l of unnamedLeftovers(f)) leftovers.push({ video_id: f.video_id, team: l.team, t0: l.first / f.fps, t1: l.last / f.fps });
  }
  const possession: Record<PossessionState, number> = { own: 0, opp: 0, unassigned: 0 };
  for (const v of cells.values()) possession[v] += COVER_STEP_S;
  // Tagged losses where the ball was followed, with no change read from the ball near them.
  const cellOf = (e: MatchEvent) => `${e.video_id ?? "v1"}|${Math.floor(e.t_video / COVER_STEP_S)}`;
  const tagged_unmatched = losses.filter(
    (e) =>
      e.type === "loss" &&
      cells.has(cellOf(e)) &&
      !changes.some((c) => c.video_id === (e.video_id ?? "v1") && c.lost === e.team && Math.abs(c.t - e.t_video) <= CONFIRM_S + PASS_MAX_S),
  ).length;
  return {
    followed_s: cells.size * COVER_STEP_S,
    possession,
    passes,
    changes: changes.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t - b.t),
    tagged_unmatched,
    players: [...players.values()].sort((a, b) => b.touches - a.touches),
    leftovers,
  };
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
// `playByVideo`: when given (with closed play stretches), only passes and touches inside play count.
export function passNetwork(parts: Oriented[], team: "own" | "opp", playByVideo: Record<string, Segment[]> = {}): PassNetwork {
  const usePlay = Object.values(playByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
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
    const play = usePlay ? (playByVideo[o.file.video_id] ?? []) : null;
    const inPlay = (frame: number) => inStretches(play, frame / o.file.fps);
    const r = passesAndTurnovers(o.file);
    for (const t of r.touches) {
      const n = name.get(t.id);
      if (n && t.team === team && inPlay(t.frame)) touchesOf.set(n, (touchesOf.get(n) ?? 0) + 1);
    }
    for (const p of r.passes) {
      if (p.team !== team || !inPlay(p.from_frame)) continue;
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

// ------------------------------------------------------------------------------------------- passes by stretch

// Passes are read from the tracking, never tagged by hand. A stretch of play has them when the analysed team was
// tracked for most of it (at least PASS_MIN_OWN of its players seen in a processed frame) and the ball was followed
// (by hand, from events or by the ball tracker) for most of it. The other team tracked as well is a plus.
export const PASS_MIN_OWN = 5;
export const PASS_PLAYERS_SHARE = 0.8;
export const PASS_BALL_SHARE = 0.7;
export interface PassStretch {
  video_id: string;
  segment_id: string;
  start: number;
  end: number;
  // Share of the stretch (0..1) with the analysed team tracked, the other team tracked and the ball followed.
  own: number;
  opp: number;
  ball: number;
  done: boolean;
}
export function passStretches(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>): PassStretch[] {
  const out: PassStretch[] = [];
  for (const [video_id, segs] of Object.entries(segmentsByVideo)) {
    for (const g of segs) {
      if (g.tipo !== "juego" || g.end === null) continue;
      let n = 0;
      let own = 0;
      let opp = 0;
      let ball = 0;
      for (const o of parts) {
        const f = o.file;
        if (f.video_id !== video_id) continue;
        const team = new Map(f.people.map((p) => [p.id, p.team]));
        const balls = new Set(f.ball.map((b) => b.frame));
        for (const fr of f.frames) {
          const t = fr.frame / f.fps;
          if (t < g.start || t >= (g.end as number)) continue;
          n++;
          let a = 0;
          let b = 0;
          for (const q of fr.positions) {
            if (q.source === "interpolated") continue;
            const tm = team.get(q.id);
            if (tm === "own") a++;
            else if (tm === "opp") b++;
          }
          if (a >= PASS_MIN_OWN) own++;
          if (b >= PASS_MIN_OWN) opp++;
          if (balls.has(fr.frame)) ball++;
        }
      }
      // Shares over the whole stretch: what no part covers counts as not tracked.
      const ref = parts.find((o) => o.file.video_id === video_id)?.file;
      const expected = ref ? Math.max(n, Math.round((((g.end as number) - g.start) * ref.fps) / ref.stride)) : n;
      const share = (k: number) => (expected ? Math.min(1, k / expected) : 0);
      const s = { own: share(own), opp: share(opp), ball: share(ball) };
      out.push({ video_id, segment_id: g.segment_id, start: g.start, end: g.end as number, ...s, done: s.own >= PASS_PLAYERS_SHARE && s.ball >= PASS_BALL_SHARE });
    }
  }
  return out;
}
