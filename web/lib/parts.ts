import { apply, invert, orient } from "./homography.ts";
import { smoothTrack, type SmoothOptions, type TrackPoint } from "./smooth.ts";
import { boxTeamOf, droppedSet, editsKey, emptyEdits, fileTeamRefs, identityOf, isDropped, nearestFrame, people, type JerseyColors, type TeamCode, type TracksFile } from "./tracks.ts";
import { PITCH, type MatchEvent, type TrackEdits } from "./types.ts";

// From corrected parts to what is exported: the path of every person on the pitch, the ball, and several parts of
// one video joined into a single file. Pure functions: no storage, no React.

// Pixels -> normalised pitch through the calibration of a frame. The homography goes to real meters of the venue.
export function pixelToPitch(file: TracksFile, H: number[] | null | undefined, px: number, py: number): [number, number] | null {
  if (!H) return null;
  const m = apply(orient(H, [[file.image_w / 2, file.image_h * 0.8]]) ?? H, [px, py]);
  if (!m) return null;
  return [(m[0] * PITCH.length) / (file.venue?.length_m ?? PITCH.length), (m[1] * PITCH.width) / (file.venue?.width_m ?? PITCH.width)];
}

// Normalised pitch -> pixels of a frame: the inverse of pixelToPitch (a click on the drawing of the pitch, a ball held
// in place while the camera moves). Null without calibration or behind the camera.
export function pitchToPixel(file: TracksFile, H: number[] | null | undefined, x: number, y: number): [number, number] | null {
  if (!H) return null;
  const o = orient(H, [[file.image_w / 2, file.image_h * 0.8]]) ?? H;
  const inv = invert(o);
  if (!inv) return null;
  const real: [number, number] = [(x * (file.venue?.length_m ?? PITCH.length)) / PITCH.length, (y * (file.venue?.width_m ?? PITCH.width)) / PITCH.width];
  const w = inv[6] * real[0] + inv[7] * real[1] + inv[8];
  if (Math.abs(w) < 1e-12) return null;
  const px = (inv[0] * real[0] + inv[1] * real[1] + inv[2]) / w;
  const py = (inv[3] * real[0] + inv[4] * real[1] + inv[5]) / w;
  // The round trip must come back to the point: otherwise it is behind the camera.
  const back = pixelToPitch(file, H, px, py);
  return back && Math.hypot(back[0] - x, back[1] - y) < 0.01 ? [px, py] : null;
}

// Path of every person of a part on the pitch, as measured: detections inside the pitch plus hand marks.
// Discarded identities and boxes left out are not included.
export function measuredPaths(file: TracksFile, edits: TrackEdits): Map<number, TrackPoint[]> {
  const out = new Map<number, TrackPoint[]>();
  const gone = new Set(edits.removed);
  const add = (id: number, point: TrackPoint) => {
    if (gone.has(id)) return;
    const list = out.get(id);
    if (list) list.push(point);
    else out.set(id, [point]);
  };
  const drop = droppedSet(edits);
  const H = new Map<number, number[] | null | undefined>();
  for (const fr of file.frames) {
    H.set(fr.frame, fr.H);
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame)) continue;
      if (b[11] && b[9] !== null && b[10] !== null) add(identityOf(b, fr.frame, edits), { frame: fr.frame, x: b[9], y: b[10], source: "auto" });
    }
  }
  for (const m of edits.manual) {
    const p = pixelToPitch(file, H.get(m.frame), m.px, m.py);
    if (p) add(m.identity, { frame: m.frame, x: p[0], y: p[1], source: "manual" });
  }
  return out;
}

export const metersPerUnit = (file: TracksFile): [number, number] => [
  (file.venue?.length_m ?? PITCH.length) / PITCH.length,
  (file.venue?.width_m ?? PITCH.width) / PITCH.width,
];

// ---------------------------------------------------------------- ball

// Where a ball position comes from.
//   manual        clicked on the video or on the drawing of the pitch (taken to the pitch as if on the ground)
//   auto          found by the ball tracker (sportsan.tracking.ball) where it was very sure; a hand mark wins over it
//   event         position of a tagged event at that moment
//   interpolated  straight line between two of the above that are close in time; never a measurement
export type BallSource = "manual" | "auto" | "event" | "interpolated";
// Which one wins when two fall on the same frame.
const BALL_RANK: Record<BallSource, number> = { manual: 3, auto: 2, event: 1, interpolated: 0 };
export interface BallPoint {
  frame: number;
  x: number;
  y: number;
  source: BallSource;
  // The mark is the ground projection of a ball in the air: nobody touches it there.
  aerial?: boolean;
}

// State of the ball over time, from the marks of the analyst. «visible» is the default (a hand mark, the tracker, an
// event); «hidden» (no se ve): in play but not seen, so the path is interpolated and no touch is measured on it; «out»
// (fuera): outside the pitch with the game stopped until the next visible mark: dead ball, no positions, no possession.
export type BallStateName = "visible" | "hidden" | "out";
// Frames [from, to) (to null: until the end of the part). Ranges end at the next mark of any kind.
export interface BallStateRange {
  from: number;
  to: number | null;
  state: "hidden" | "out";
}

export function ballStateRanges(edits: Pick<TrackEdits, "ball" | "ballStates">): BallStateRange[] {
  const marks = [...(edits.ball ?? []).map((b) => b.frame), ...(edits.ballStates ?? []).map((s) => s.frame)].sort((a, b) => a - b);
  return [...(edits.ballStates ?? [])]
    .sort((a, b) => a.frame - b.frame)
    .map((s) => ({ from: s.frame, to: marks.find((m) => m > s.frame) ?? null, state: s.state }));
}
const inRange = (r: BallStateRange, frame: number) => frame >= r.from && (r.to === null || frame < r.to);

// State of the ball at a frame of a part (visible where no range covers it).
export function ballStateAtFrame(ranges: BallStateRange[] | undefined, frame: number): BallStateName {
  return (ranges ?? []).find((r) => inRange(r, frame))?.state ?? "visible";
}

// What the ball was doing at video time `t` (seconds): the state of the part that covers it. Null where no part covers
// that moment (nothing is known). Reads `ball_states` of tracks_fixed; parts saved before it are all «visible».
export function ballStateAt(parts: { file: { video_id: string; fps: number; start_frame: number; end_frame: number; ball_states?: BallStateRange[] } }[], video: string, t: number): BallStateName | null {
  for (const o of parts) {
    const f = o.file;
    if (f.video_id !== video) continue;
    const frame = t * f.fps;
    if (frame >= f.start_frame && frame < f.end_frame) return ballStateAtFrame(f.ball_states, frame);
  }
  return null;
}

// Longest stretch between two known ball positions that is joined with a straight line (s).
export const BALL_FILL_S = 3;

// Tagged events as ball positions of a part. Events are tagged with the analysed team always attacking towards
// x = 105; `ownAttacksRight` says whether that is also true on the pitch of this video (if not, they are mirrored).
export function eventBall(file: TracksFile, events: MatchEvent[], ownAttacksRight: boolean): BallPoint[] {
  const out = new Map<number, BallPoint>();
  for (const e of events) {
    if (e.x === null || e.y === null || (e.video_id ?? "v1") !== file.video_id) continue;
    const f = Math.round(e.t_video * file.fps);
    if (f < file.start_frame || f >= file.end_frame) continue;
    const frame = nearestFrame(file, f);
    out.set(frame, { frame, x: ownAttacksRight ? e.x : PITCH.length - e.x, y: ownAttacksRight ? e.y : PITCH.width - e.y, source: "event" });
  }
  return [...out.values()].sort((a, b) => a.frame - b.frame);
}

// Ball marks made by hand on the video of a part, on the pitch. Marks on frames without calibration are left out.
export function manualBall(file: TracksFile, edits: TrackEdits): BallPoint[] {
  const H = new Map(file.frames.map((fr) => [fr.frame, fr.H]));
  const out: BallPoint[] = [];
  for (const m of edits.ball ?? []) {
    const p = pixelToPitch(file, H.get(m.frame), m.px, m.py);
    if (p) out.push({ frame: m.frame, x: p[0], y: p[1], source: "manual", ...(m.aerial ? { aerial: true } : {}) });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

// What the ball tracker wrote for a part (ball_auto_<video>_<ini>_<fin>.json): pixels of the frames where it is sure,
// and the frames where it asks for a hand mark.
export interface BallAuto {
  frames: { frame: number; px: number; py: number; p: number }[];
  ask: number[];
}

// A ball cannot move faster than this (m/s): a hard shot is about 30. Two tracker positions closer in time than
// BALL_JUMP_LINK_S and farther than that are not the same ball.
export const BALL_JUMP_MS = 30;
export const BALL_JUMP_LINK_S = 1;
// A run of tracker positions cut off from the rest by such jumps is an excursion (a painted number, a head, a ball in
// the air projected far away) when it lasts less than this (s). A longer run is kept: it may be the real ball.
export const BALL_JUMP_RUN_S = 1;

// Frames of tracker ("auto") positions to distrust because of jumps. Hand marks are never touched, but they count as
// neighbours: an automatic run that jumps away from a mark and back is as suspicious as one that jumps away from
// another automatic run. `mx, my`: meters per unit of the pitch. Pure, no file access.
// `jumpMs`: the speed above which two positions are not the same ball (Detalles técnicos; default BALL_JUMP_MS).
export function ballJumpFrames(points: { frame: number; x: number; y: number; source: string }[], fps: number, mx = 1, my = 1, maxRunS = BALL_JUMP_RUN_S, jumpMs = BALL_JUMP_MS): Set<number> {
  const pts = points.filter((p) => p.source === "manual" || p.source === "auto").sort((a, b) => a.frame - b.frame);
  const bad = new Set<number>(); // index i: the link between pts[i] and pts[i+1] is a jump
  for (let i = 0; i + 1 < pts.length; i++) {
    const dt = (pts[i + 1].frame - pts[i].frame) / fps;
    if (dt <= 0 || dt > BALL_JUMP_LINK_S) continue;
    if (Math.hypot((pts[i + 1].x - pts[i].x) * mx, (pts[i + 1].y - pts[i].y) * my) / dt > jumpMs) bad.add(i);
  }
  const out = new Set<number>();
  let start = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i + 1 < pts.length && !bad.has(i)) continue;
    // Run pts[start..i]: bounded by a jump on the side(s) that have a neighbour.
    const jumpBefore = start > 0 && bad.has(start - 1);
    const jumpAfter = bad.has(i);
    const run = pts.slice(start, i + 1);
    const dur = (run[run.length - 1].frame - run[0].frame) / fps;
    if ((jumpBefore || jumpAfter) && dur <= maxRunS && run.every((p) => p.source === "auto")) for (const p of run) out.add(p.frame);
    start = i + 1;
  }
  return out;
}

export type BallDropReason = "jump" | "ref_box" | "unk_box";

// The tracker's ball on the pitch, without the frames rejected by hand and those with a hand mark (the hand wins).
// Also left out (see autoBallChecked): isolated runs that jump faster than a ball can move, and positions that fall
// inside the box of a referee or of a person with no team (on the pitch) without any box of a team around.
export function autoBall(file: TracksFile, auto: BallAuto | null, edits: TrackEdits, check = true, jumpMs = BALL_JUMP_MS): BallPoint[] {
  return autoBallChecked(file, auto, edits, check, jumpMs).kept;
}

export function autoBallChecked(file: TracksFile, auto: BallAuto | null, edits: TrackEdits, check = true, jumpMs = BALL_JUMP_MS): { kept: BallPoint[]; dropped: { frame: number; reason: BallDropReason }[] } {
  if (!auto) return { kept: [], dropped: [] };
  const H = new Map(file.frames.map((fr) => [fr.frame, fr.H]));
  const rejected = new Set(edits.ballRejected ?? []);
  const hand = new Set((edits.ball ?? []).map((b) => b.frame));
  const pts: (BallPoint & { px: number; py: number })[] = [];
  for (const a of auto.frames) {
    if (rejected.has(a.frame) || hand.has(a.frame)) continue;
    const p = pixelToPitch(file, H.get(a.frame), a.px, a.py);
    if (p) pts.push({ frame: a.frame, x: p[0], y: p[1], source: "auto", px: a.px, py: a.py });
  }
  const plain = (p: BallPoint): BallPoint => ({ frame: p.frame, x: p.x, y: p.y, source: p.source });
  if (!check) return { kept: pts.map(plain), dropped: [] };
  const [mx, my] = metersPerUnit(file);
  // Hand marks are neighbours of the jump test even though they are not returned here.
  const marks = manualBall(file, edits);
  const jumps = ballJumpFrames([...marks, ...pts], file.fps, mx, my, BALL_JUMP_RUN_S, jumpMs);
  const refs = fileTeamRefs(file);
  const boxesAt = new Map(file.frames.map((fr) => [fr.frame, fr.boxes]));
  const kept: BallPoint[] = [];
  const dropped: { frame: number; reason: BallDropReason }[] = [];
  for (const pt of pts) {
    const { px, py } = pt;
    const b = plain(pt);
    if (jumps.has(b.frame)) {
      dropped.push({ frame: b.frame, reason: "jump" });
      continue;
    }
    // Which boxes contain the ball: if one is a team's, the ball is at the feet of a player of a team; if only
    // referees / people with no team do, it is not a ball (or is one that nobody can be credited with).
    let inTeam = false;
    let inOther: "ref" | "unk" | null = null;
    for (const bx of boxesAt.get(b.frame) ?? []) {
      if (!bx[11] || px < bx[1] || px > bx[3] || py < bx[2] || py > bx[4]) continue;
      const t = boxTeamOf(bx, refs);
      if (t === "own" || t === "opp") inTeam = true;
      else inOther = t === "ref" ? "ref" : (inOther ?? "unk");
    }
    if (!inTeam && inOther) dropped.push({ frame: b.frame, reason: inOther === "ref" ? "ref_box" : "unk_box" });
    else kept.push(b);
  }
  return { kept, dropped };
}

// Keeps the ball where it was last marked by hand, up to `frame` (a goal kick or a corner: the ball waits on its spot
// while the taker gets ready). Adds a mark at `frame` on the same spot of the pitch (at its pixel in this frame, the
// camera may have moved) and joins both with a line whatever the time between them. Null without a previous mark or
// without calibration in either frame.
export function holdBall(file: TracksFile, edits: TrackEdits, frame: number): TrackEdits | null {
  const H = new Map(file.frames.map((fr) => [fr.frame, fr.H]));
  const prev = (edits.ball ?? []).filter((b) => b.frame < frame).sort((a, b) => b.frame - a.frame)[0];
  if (!prev) return null;
  const spot = pixelToPitch(file, H.get(prev.frame), prev.px, prev.py);
  const px = spot && pitchToPixel(file, H.get(frame), spot[0], spot[1]);
  if (!px) return null;
  const ball = [...(edits.ball ?? []).filter((b) => b.frame !== frame), { frame, px: Math.round(px[0] * 10) / 10, py: Math.round(px[1] * 10) / 10 }].sort((a, b) => a.frame - b.frame);
  const links = (edits.ballLinks ?? []).filter((l) => !(l.from === prev.frame && l.to === frame));
  return { ...edits, ball, ballLinks: [...links, { from: prev.frame, to: frame }] };
}

// One ball position per frame, with short stretches between known positions joined by a straight line on the
// processed frames. Longer stretches stay empty. Hand marks win: a tagged event (whose time and place are only
// roughly the ball's) is used only where no hand mark is within maxFillS, so it fills what was not marked instead of
// pulling the ball off its path.
export function ballPath(known: BallPoint[], fps: number, stride: number, maxFillS = BALL_FILL_S, links: { from: number; to: number }[] = [], states: BallStateRange[] = []): BallPoint[] {
  // Inside «no se ve» / «fuera» only hand marks stand: the tracker and the events are replaced by what the analyst said.
  const inState = (frame: number) => states.some((r) => inRange(r, frame));
  known = known.filter((p) => p.source === "manual" || !inState(p.frame));
  // A «fuera» stretch is never crossed by a line; a «no se ve» one is crossed whatever its length (the ball stayed in play).
  const crosses = (r: BallStateRange, a: number, b: number) => a < (r.to ?? Infinity) && b > r.from;
  const cut = (a: number, b: number) => states.some((r) => r.state === "out" && crosses(r, a, b));
  // Two known positions inside a line drawn by hand are joined whatever the time between them.
  const linked = (a: number, b: number) => links.some((l) => l.from <= a && b <= l.to) || states.some((r) => r.state === "hidden" && crosses(r, a, b));
  // Hand marks and the tracker's ball are precise: an event near either is left out.
  const precise = known.filter((p) => p.source === "manual" || p.source === "auto").map((p) => p.frame);
  const nearPrecise = (f: number) => precise.some((m) => Math.abs(m - f) / fps <= maxFillS);
  const byFrame = new Map<number, BallPoint>();
  for (const p of known) {
    if (p.source === "event" && nearPrecise(p.frame)) continue;
    const cur = byFrame.get(p.frame);
    if (!cur || BALL_RANK[p.source] > BALL_RANK[cur.source]) byFrame.set(p.frame, p);
  }
  const pts = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const out: BallPoint[] = [];
  pts.forEach((p, i) => {
    out.push(p);
    const next = pts[i + 1];
    if (!next || cut(p.frame, next.frame) || ((next.frame - p.frame) / fps > maxFillS && !linked(p.frame, next.frame))) return;
    for (let f = p.frame + stride; f < next.frame; f += stride) {
      const k = (f - p.frame) / (next.frame - p.frame);
      out.push({ frame: f, x: p.x + (next.x - p.x) * k, y: p.y + (next.y - p.y) * k, source: "interpolated" });
    }
  });
  return out;
}

// ---------------------------------------------------------------- several parts in one file

export interface Part {
  file: TracksFile;
  // Absent = the part has no corrections: its automatic identities are used as they are.
  edits?: TrackEdits;
}

// Between two parts in a row the tracker starts again, so everybody changes identity. A person seen at the very end
// of one part and one seen at the very start of the next are taken as the same when they are each other's nearest,
// close enough to have got there, of compatible teams, and nobody else is about as near.
export const LINK_EDGE_S = 0.5;
export const LINK_SLACK_M = 2;
export const LINK_SPEED_MS = 8;

export interface JoinOptions {
  colors?: Partial<JerseyColors>;
  // Cleaning of each person's path, applied after joining (so the hole at a boundary can be filled). null = as measured.
  smooth: { maxSpeedMs: number; maxFillS: number; windowS: number } | null;
  // Extra ball positions (from events), already on the pitch.
  ball?: BallPoint[];
}

export interface JoinedPerson {
  id: number;
  team: TeamCode;
  player_id: string | null;
  // Where she comes from: identity in each part ("<start>_<end>").
  sources: { part: string; id: number }[];
}

export interface Joined {
  schema_version: 2;
  kind: "tracks_fixed";
  match_id: string;
  video_id: string;
  fps: number;
  start_frame: number;
  end_frame: number;
  stride: number;
  // Real size of the venue (m): positions are normalised to 105 x 68, distances are measured in these meters.
  venue: { length_m: number; width_m: number } | null;
  parts: { start_frame: number; end_frame: number; corrected: boolean; linked_to_previous: number }[];
  smoothing: null | { max_speed_ms: number; max_fill_s: number; window_s: number; outliers: number; filled: number; openGaps: number };
  people: JoinedPerson[];
  ball: { frame: number; x: number; y: number; source: BallSource }[];
  frames: { frame: number; positions: { id: number; x: number; y: number; source: string; raw?: [number, number] }[] }[];
}

export const hasCorrections = (e: TrackEdits | undefined): boolean =>
  !!e &&
  (Object.keys(e.identity).length > 0 ||
    Object.keys(e.people).length > 0 ||
    e.removed.length > 0 ||
    e.splits.length > 0 ||
    e.manual.length > 0 ||
    (e.dropped ?? []).length > 0 ||
    (e.ball ?? []).length > 0);

const r2 = (v: number) => Math.round(v * 100) / 100;

// Joins parts of one video into a single corrected file. People with the same name are one person across parts;
// the unnamed are linked at each boundary between consecutive parts when it is clear who is who (see above).
// Throws an Error (message in Spanish, shown to the user) when the parts do not belong together.
export function joinParts(input: Part[], o: JoinOptions): Joined {
  if (input.length === 0) throw new Error("No hay partes que unir.");
  const parts = [...input].sort((a, b) => a.file.start_frame - b.file.start_frame);
  const first = parts[0].file;
  for (const [i, p] of parts.entries()) {
    const f = p.file;
    if (f.match_id !== first.match_id || f.video_id !== first.video_id) throw new Error("Las partes son de partidos o videos distintos.");
    if (f.stride !== first.stride || Math.abs(f.fps - first.fps) > 1e-6) throw new Error("Las partes se procesaron con distinto salto de cuadros.");
    if (i > 0 && f.start_frame < parts[i - 1].file.end_frame) throw new Error("Hay partes que se traslapan (¿la misma parte dos veces?).");
  }

  // Every person of every part is a node; groups of nodes are one person in the result.
  interface Node {
    part: number;
    id: number;
    team: TeamCode;
    name: string;
    points: TrackPoint[];
  }
  const nodes: Node[] = [];
  const perPart: number[][] = [];
  parts.forEach((p, k) => {
    const edits = p.edits ?? emptyEdits(editsKey(p.file));
    const paths = measuredPaths(p.file, edits);
    perPart.push([]);
    for (const q of people(p.file, edits, o.colors)) {
      const points = [...(paths.get(q.id) ?? [])].sort((a, b) => a.frame - b.frame);
      if (points.length === 0) continue; // never inside the pitch
      perPart[k].push(nodes.length);
      nodes.push({ part: k, id: q.id, team: q.team, name: q.player_id.trim(), points });
    }
  });

  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const groupName = new Map<number, string>();
  nodes.forEach((n, i) => n.name && groupName.set(i, n.name.toLowerCase()));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent[rb] = ra;
    const name = groupName.get(ra) ?? groupName.get(rb);
    if (name) groupName.set(ra, name);
  };
  // Same name, same person.
  const byName = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!n.name) return;
    const k = n.name.toLowerCase();
    const seen = byName.get(k);
    if (seen === undefined) byName.set(k, i);
    else union(seen, i);
  });

  // Boundaries between consecutive parts.
  const linked = parts.map(() => 0);
  for (let k = 1; k < parts.length; k++) {
    const [a, b] = [parts[k - 1].file, parts[k].file];
    if (b.start_frame - a.end_frame > a.stride) continue; // not in a row: nothing can be said
    const edge = LINK_EDGE_S * a.fps;
    const [mx, my] = metersPerUnit(a);
    const ends = perPart[k - 1].filter((i) => nodes[i].points[nodes[i].points.length - 1].frame >= a.end_frame - edge);
    const starts = perPart[k].filter((i) => nodes[i].points[0].frame <= b.start_frame + edge);
    const cost = (i: number, j: number): number | null => {
      const [p, q] = [nodes[i].points[nodes[i].points.length - 1], nodes[j].points[0]];
      const [ta, tb] = [nodes[i].team, nodes[j].team];
      if (ta !== "unk" && tb !== "unk" && ta !== tb) return null;
      const [na, nb] = [groupName.get(find(i)), groupName.get(find(j))];
      if (na && nb && na !== nb) return null;
      const d = Math.hypot((q.x - p.x) * mx, (q.y - p.y) * my);
      return d <= LINK_SLACK_M + (LINK_SPEED_MS * (q.frame - p.frame)) / a.fps ? d : null;
    };
    // Best and second best partner of each one, in both directions.
    const best = (from: number[], to: number[], c: (x: number, y: number) => number | null) =>
      new Map(
        from.map((x) => {
          const options = to.map((y) => ({ y, d: c(x, y) })).filter((v): v is { y: number; d: number } => v.d !== null);
          options.sort((u, v) => u.d - v.d);
          return [x, options] as const;
        }),
      );
    const fwd = best(ends, starts, cost);
    const back = best(starts, ends, (j, i) => cost(i, j));
    for (const [i, options] of fwd) {
      const top = options[0];
      if (!top) continue;
      const theirs = back.get(top.y) ?? [];
      const clear = (list: { d: number }[]) => list.length < 2 || list[1].d > list[0].d + 1;
      if (theirs[0]?.y === i && clear(options) && clear(theirs)) {
        union(i, top.y);
        linked[k]++;
      }
    }
  }

  // Groups -> people, numbered by first appearance.
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(i);
    else groups.set(r, [i]);
  });
  const ordered = [...groups.values()].sort((u, v) => nodes[u[0]].points[0].frame - nodes[v[0]].points[0].frame || nodes[u[0]].id - nodes[v[0]].id);
  const opt: SmoothOptions | null = o.smooth ? { fps: first.fps, stride: first.stride, metersPerUnit: metersPerUnit(first), ...o.smooth } : null;
  const totals = { outliers: 0, filled: 0, openGaps: 0 };
  const peopleOut: JoinedPerson[] = [];
  const byFrame = new Map<number, Joined["frames"][number]["positions"]>();
  ordered.forEach((members, n) => {
    const id = n + 1;
    const named = members.find((i) => nodes[i].name);
    const team = members.map((i) => nodes[i].team).find((t) => t !== "unk") ?? "unk";
    peopleOut.push({
      id,
      team,
      player_id: named !== undefined ? nodes[named].name : null,
      sources: members.map((i) => ({ part: `${parts[nodes[i].part].file.start_frame}_${parts[nodes[i].part].file.end_frame}`, id: nodes[i].id })),
    });
    let pts = members.flatMap((i) => nodes[i].points).sort((a, b) => a.frame - b.frame);
    if (opt) {
      const done = smoothTrack(pts, opt);
      pts = done.points;
      totals.outliers += done.report.outliers;
      totals.filled += done.report.filled;
      totals.openGaps += done.report.openGaps;
    }
    for (const q of pts) {
      const row = { id, x: r2(q.x), y: r2(q.y), source: q.source as string, ...(q.raw ? { raw: [r2(q.raw[0]), r2(q.raw[1])] as [number, number] } : {}) };
      const list = byFrame.get(q.frame);
      if (list) list.push(row);
      else byFrame.set(q.frame, [row]);
    }
  });

  const knownBall = [...(o.ball ?? []), ...parts.flatMap((p) => (p.edits ? manualBall(p.file, p.edits) : []))];
  const ballLinks = parts.flatMap((p) => p.edits?.ballLinks ?? []);
  const ballStates = parts.flatMap((p) => (p.edits ? ballStateRanges(p.edits) : []));
  const last = parts[parts.length - 1].file;
  return {
    schema_version: 2,
    kind: "tracks_fixed",
    match_id: first.match_id,
    video_id: first.video_id,
    fps: first.fps,
    start_frame: first.start_frame,
    end_frame: last.end_frame,
    stride: first.stride,
    venue: first.venue?.length_m && first.venue?.width_m ? { length_m: first.venue.length_m, width_m: first.venue.width_m } : null,
    parts: parts.map((p, k) => ({ start_frame: p.file.start_frame, end_frame: p.file.end_frame, corrected: hasCorrections(p.edits), linked_to_previous: linked[k] })),
    smoothing: o.smooth ? { max_speed_ms: o.smooth.maxSpeedMs, max_fill_s: o.smooth.maxFillS, window_s: o.smooth.windowS, ...totals } : null,
    people: peopleOut,
    ball: ballPath(knownBall, first.fps, first.stride, BALL_FILL_S, ballLinks, ballStates).map((b) => ({ frame: b.frame, x: r2(b.x), y: r2(b.y), source: b.source, ...(b.aerial ? { aerial: true } : {}) })),
    ...(ballStates.length ? { ball_states: ballStates } : {}),
    // The processed frames of every part, plus the frames filled in the hole between two parts.
    frames: [...new Set([...parts.flatMap((p) => p.file.frames.map((fr) => fr.frame)), ...byFrame.keys()])]
      .sort((a, b) => a - b)
      .map((frame) => ({ frame, positions: byFrame.get(frame) ?? [] })),
  };
}

// How much of the time in play has a ball, and where it is missing. A mark (by hand or from an event) covers its sample
// (outHalf to each side, at least its own frame),
// two marks less than fillS apart cover what lies between them (the straight line drawn there), and `out` are the
// moments reviewed as "out of play / not in sight", each covering outHalf frames to each side: they are left out of the
// count. Stretches missing shorter than two processed frames are not reported.
export function ballCoverage(o: {
  marks: number[];
  out: number[];
  from: number;
  to: number;
  fps: number;
  stride: number;
  outHalf: number;
  fillS?: number;
  links?: { from: number; to: number }[];
}): { share: number; missing: [number, number][] } {
  const fill = (o.fillS ?? BALL_FILL_S) * o.fps;
  const merge = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const [a, b] of list.sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const clip = ([a, b]: [number, number]): [number, number] | null => {
    const x = Math.max(o.from, a);
    const y = Math.min(o.to, b);
    return y > x ? [x, y] : null;
  };
  const marks = [...new Set(o.marks)].sort((a, b) => a - b);
  const covered = merge(
    [
      // A mark covers its sample as a reviewed "out" does: half a step to each side (at least its own frame). Otherwise a
      // sliver is left between an "out" and the next mark.
      ...marks.map((m) => [m - Math.max(o.stride / 2, o.outHalf), m + Math.max(o.stride / 2, o.outHalf)] as [number, number]),
      ...marks.slice(1).flatMap((m, i) => (m - marks[i] <= fill ? [[marks[i], m] as [number, number]] : [])),
      ...(o.links ?? []).map((l) => [l.from, l.to] as [number, number]),
    ].flatMap((x) => {
      const c = clip(x);
      return c ? [c] : [];
    }),
  );
  const outs = merge(
    o.out
      .map((f) => [f - o.outHalf, f + o.outHalf] as [number, number])
      .flatMap((x) => {
        const c = clip(x);
        return c ? [c] : [];
      }),
  );
  // In play and without a ball: the stretch minus what is covered minus what is out.
  const taken = merge([...covered, ...outs]);
  const missing: [number, number][] = [];
  let at = o.from;
  for (const [a, b] of taken) {
    if (a - at >= 2 * o.stride) missing.push([at, a]);
    at = Math.max(at, b);
  }
  if (o.to - at >= 2 * o.stride) missing.push([at, o.to]);
  const len = (l: [number, number][]) => l.reduce((n, [a, b]) => n + (b - a), 0);
  const inPlay = Math.max(1, o.to - o.from - len(outs));
  return { share: Math.max(0, Math.min(1, 1 - len(missing) / inPlay)), missing };
}

// ---------------------------------------------------------------- what the camera sees

// The part of the pitch in the image of a frame, as a polygon in the normalised pitch: the image border taken to the
// pitch. Above the horizon the image shows no ground, so each column starts at the highest row that lands on the
// ground within `reachM` meters of the pitch. Null without calibration or when almost nothing lands.
export function viewPolygon(file: TracksFile, H: number[] | null | undefined, steps = 16, reachM = 40): [number, number][] | null {
  if (!H) return null;
  const w = file.image_w;
  const h = file.image_h;
  // Oriented once (as pixelToPitch does on every call), then pixels -> real meters -> normalised pitch.
  const Ho = orient(H, [[w / 2, h * 0.8]]) ?? H;
  const sx = PITCH.length / (file.venue?.length_m ?? PITCH.length);
  const sy = PITCH.width / (file.venue?.width_m ?? PITCH.width);
  const lx = reachM * sx;
  const ly = reachM * sy;
  const at = (x: number, y: number): [number, number] | null => {
    const m = apply(Ho, [x, y]);
    if (!m) return null;
    const p: [number, number] = [m[0] * sx, m[1] * sy];
    return p[0] > -lx && p[0] < PITCH.length + lx && p[1] > -ly && p[1] < PITCH.width + ly ? p : null;
  };
  // Top: per column, the first row (from the top) that lands near the pitch.
  const top: [number, number][] = [];
  const rows = 32;
  for (let i = 0; i <= steps; i++) {
    const x = (w * i) / steps;
    for (let r = 0; r <= rows; r++) {
      const p = at(x, (h * r) / rows);
      if (p) {
        top.push(p);
        break;
      }
    }
  }
  const bottom: [number, number][] = [];
  for (let i = steps; i >= 0; i--) {
    const p = at((w * i) / steps, h);
    if (p) bottom.push(p);
  }
  const poly = [...top, ...bottom];
  return poly.length >= 3 ? poly.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number]) : null;
}
