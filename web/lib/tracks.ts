import type { TrackEdits } from "./types";

// Correction of automatic tracks: who is who. The file written by `sportsan.tracking.process` proposes an identity
// for every track; the person's edits (merge, split, discard, team, shirt number, hand-marked positions) are kept
// apart and applied on top, so the file is never modified and every edit can be undone.
// Pure functions: no storage, no React.

// One detection: [track_id, x1, y1, x2, y2, conf, lab_l, lab_a, lab_b, x, y, on_pitch, team, identity].
export type DetBox = [number, number, number, number, number, number, number, number, number, number | null, number | null, boolean, string, number?];

export interface TracksFile {
  match_id: string;
  video_id: string;
  fps: number;
  start_frame: number;
  end_frame: number;
  stride: number;
  image_w: number;
  image_h: number;
  venue?: { length_m?: number; width_m?: number };
  frames: { frame: number; H?: number[] | null; boxes: DetBox[] }[];
  // Written by sportsan.tracking.process; older or synthetic files may not have them.
  schema_version?: number;
  tracker?: string;
}

export type TeamCode = "own" | "opp" | "ref" | "unk";
export interface JerseyColors {
  own: string;
  opp: string;
  ref: string;
  // Goalkeepers wear a different kit; they still count for their team.
  own_gk?: string;
  opp_gk?: string;
}
export const JERSEY_KEYS = ["own", "opp", "ref", "own_gk", "opp_gk"] as const;
export type JerseyKey = (typeof JERSEY_KEYS)[number];
const KEY_TEAM: Record<JerseyKey, TeamCode> = { own: "own", opp: "opp", ref: "ref", own_gk: "own", opp_gk: "opp" };

export const editsKey = (f: Pick<TracksFile, "match_id" | "video_id" | "start_frame" | "end_frame">) =>
  `${f.match_id}|${f.video_id}|${f.start_frame}_${f.end_frame}`;

export const emptyEdits = (key: string): TrackEdits => ({ key, identity: {}, people: {}, removed: [], splits: [], manual: [], dropped: [] });

// Boxes left out one by one (see TrackEdits.dropped), as a set of "<track>:<frame>".
export const droppedSet = (edits: TrackEdits): Set<string> => new Set((edits.dropped ?? []).map((d) => `${d.track}:${d.frame}`));
export const isDropped = (set: Set<string>, box: DetBox, frame: number) => set.has(`${box[0]}:${frame}`);

// ---------------------------------------------------------------- colour (same Lab scale as OpenCV: 0-255, a/b centred on 128)

export function hexToLab(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const xyz = [
    0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2],
    0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2],
    0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2],
  ];
  const f = [xyz[0] / 0.95047, xyz[1], xyz[2] / 1.08883].map((v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116));
  return [((116 * f[1] - 16) * 255) / 100, 500 * (f[0] - f[1]) + 128, 200 * (f[1] - f[2]) + 128];
}

export function labToHex(lab: number[]): string {
  const L = (lab[0] * 100) / 255;
  const fy = (L + 16) / 116;
  const f = [fy + (lab[1] - 128) / 500, fy, fy - (lab[2] - 128) / 200];
  const white = [0.95047, 1, 1.08883];
  const xyz = f.map((v, i) => (v ** 3 > 0.008856 ? v ** 3 : (v - 16 / 116) / 7.787) * white[i]);
  const lin = [
    3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2],
    -0.969266 * xyz[0] + 1.8760108 * xyz[1] + 0.041556 * xyz[2],
    0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2],
  ];
  return (
    "#" +
    lin
      .map((v) => Math.min(1, Math.max(0, v)))
      .map((v) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v))
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

// Same rule and values as sportsan/tracking/team.py: to decide a team the lightness counts in full (it is what tells
// two dark kits apart, such as blue and black), the nearest kit must be closer than MAX_COLOR_DISTANCE, and the
// nearest kit of another team at least TEAM_MARGIN times farther. Otherwise no team.
export const MAX_COLOR_DISTANCE = 40;
export const TEAM_MARGIN = 1.3;
const TEAM_L_WEIGHT = 1;

export const colorDistance = (a: number[], b: number[], lWeight = 0.5) => Math.hypot(lWeight * (a[0] - b[0]), a[1] - b[1], a[2] - b[2]);

// Nearest reference kit, or null when none is close enough, the decision has no margin, or no kit is set.
export function kitOfColor(lab: number[], colors: Partial<JerseyColors> | undefined): JerseyKey | null {
  const dist: { key: JerseyKey; d: number }[] = [];
  for (const key of JERSEY_KEYS) {
    const ref = colors?.[key] ? hexToLab(colors[key] as string) : null;
    if (ref) dist.push({ key, d: colorDistance(lab, ref, TEAM_L_WEIGHT) });
  }
  dist.sort((x, y) => x.d - y.d);
  const best = dist[0];
  if (!best || best.d > MAX_COLOR_DISTANCE) return null;
  const other = dist.find((x) => KEY_TEAM[x.key] !== KEY_TEAM[best.key]);
  if (other && other.d < TEAM_MARGIN * best.d) return null;
  return best.key;
}

// ---------------------------------------------------------------- team from the file itself

// Shirt colour of each team as the program measured it: median of the boxes it gave that team (column 12). The colours
// picked by hand on the video are brighter than what is measured on a torso, so comparing measured with measured is
// what tells teams apart reliably.
export type FileTeamRefs = Partial<Record<"own" | "opp" | "ref", number[]>>;
const refsCache = new WeakMap<TracksFile, FileTeamRefs>();
export function fileTeamRefs(file: TracksFile): FileTeamRefs {
  const hit = refsCache.get(file);
  if (hit) return hit;
  const out = computeTeamRefs(file);
  refsCache.set(file, out);
  return out;
}
function computeTeamRefs(file: TracksFile): FileTeamRefs {
  const labs: Record<string, number[][]> = { own: [], opp: [], ref: [] };
  for (const fr of file.frames) for (const b of fr.boxes) if (b[11] && labs[b[12]]) labs[b[12]].push([b[6], b[7], b[8]]);
  const out: FileTeamRefs = {};
  for (const t of ["own", "opp", "ref"] as const) {
    if (labs[t].length >= 10) out[t] = [0, 1, 2].map((i) => median(labs[t].map((l) => l[i])));
  }
  return out;
}

// Team of one box against those references: the nearest, with full lightness and the same margin as teamOfColor.
export function boxTeam(lab: number[], refs: FileTeamRefs): TeamCode {
  const dist = (Object.entries(refs) as [TeamCode, number[]][]).map(([t, r]) => ({ t, d: colorDistance(lab, r, 1) })).sort((a, b) => a.d - b.d);
  if (!dist.length || dist[0].d > MAX_COLOR_DISTANCE) return "unk";
  if (dist[1] && dist[1].d < TEAM_MARGIN * dist[0].d) return "unk";
  return dist[0].t;
}

// boxTeam of a box of a file: it never changes with the edits, so it is worked out once per box.
const boxTeamCache = new WeakMap<DetBox, TeamCode>();
export function boxTeamOf(box: DetBox, refs: FileTeamRefs): TeamCode {
  let t = boxTeamCache.get(box);
  if (t === undefined) {
    t = boxTeam([box[6], box[7], box[8]], refs);
    boxTeamCache.set(box, t);
  }
  return t;
}

// A person takes the team of most of her boxes (at least TEAM_SHARE of the decided ones, and 3 of them).
export const TEAM_SHARE = 0.6;
function majority(votes: Map<TeamCode, number>): TeamCode | null {
  let best: TeamCode | null = null;
  let n = 0;
  let total = 0;
  for (const [t, k] of votes) {
    total += k;
    if (k > n) [best, n] = [t, k];
  }
  return best && total >= 3 && n / total >= TEAM_SHARE ? best : null;
}

export function teamOfColor(lab: number[], colors: Partial<JerseyColors> | undefined): TeamCode {
  const kit = kitOfColor(lab, colors);
  return kit ? KEY_TEAM[kit] : "unk";
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------------------------------------------------------------- identities

// Identity of a detection after the edits. A split sends a track to a new identity from a frame on.
// The splits of each track, sorted by frame, built once per list of splits (identityOf runs for every box).
const splitIndex = new WeakMap<TrackEdits["splits"], Map<number, TrackEdits["splits"]>>();
function splitsOf(edits: TrackEdits, track: number): TrackEdits["splits"] | undefined {
  let index = splitIndex.get(edits.splits);
  if (!index) {
    index = new Map();
    for (const s of edits.splits) {
      const list = index.get(s.track) ?? [];
      list.push(s);
      index.set(s.track, list);
    }
    for (const list of index.values()) list.sort((a, b) => a.frame - b.frame);
    splitIndex.set(edits.splits, index);
  }
  return index.get(track);
}

export function identityOf(box: DetBox, frame: number, edits: TrackEdits): number {
  const track = box[0];
  let split: TrackEdits["splits"][number] | null = null;
  for (const s of splitsOf(edits, track) ?? []) {
    if (s.frame > frame) break;
    split = s;
  }
  const base = split ? split.identity : (edits.identity[String(track)] ?? box[13] ?? track);
  // A merge moves the whole identity, including the pieces created by splits.
  return edits.identity[`i${base}`] ?? base;
}

export interface Person {
  id: number;
  team: TeamCode;
  // True when the team was set by hand, not read from the shirt colour.
  teamByHand: boolean;
  // Her shirt matches the goalkeeper kit of her team.
  keeper: boolean;
  player_id: string;
  // Marked as reviewed by the person: nothing left to fix.
  done: boolean;
  // Frames (video frame numbers) where this person has a box or a hand-marked position.
  frames: number[];
  first: number;
  last: number;
  // Raw tracks that make up this person.
  tracks: number[];
  lab: [number, number, number];
  // Stretches between first and last appearance without any position, as [from, to] frames.
  gaps: [number, number][];
  onPitchShare: number;
  // Frames where this person has more than one box: she cannot be in two places, so one of them is somebody else.
  conflicts: number[];
}

// Everyone in the file after the edits, in order of appearance. Discarded identities are left out.
export function people(file: TracksFile, edits: TrackEdits, colors?: Partial<JerseyColors>, minGapS = 0.5): Person[] {
  const acc = new Map<number, { frames: Set<number>; tracks: Set<number>; labs: number[][]; inside: number; n: number; twice: number[]; votes: Map<TeamCode, number>; fileVotes: Map<TeamCode, number> }>();
  const get = (id: number) => {
    let p = acc.get(id);
    if (!p) acc.set(id, (p = { frames: new Set(), tracks: new Set(), labs: [], inside: 0, n: 0, twice: [], votes: new Map(), fileVotes: new Map() }));
    return p;
  };
  const refs = fileTeamRefs(file);
  const vote = (m: Map<TeamCode, number>, t: TeamCode) => t !== "unk" && m.set(t, (m.get(t) ?? 0) + 1);
  const drop = droppedSet(edits);
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame)) continue;
      const p = get(identityOf(b, fr.frame, edits));
      if (p.frames.has(fr.frame) && p.twice[p.twice.length - 1] !== fr.frame) p.twice.push(fr.frame);
      p.frames.add(fr.frame);
      p.tracks.add(b[0]);
      p.labs.push([b[6], b[7], b[8]]);
      vote(p.votes, boxTeamOf(b, refs));
      vote(p.fileVotes, b[12] as TeamCode);
      p.n++;
      if (b[11]) p.inside++;
    }
  }
  for (const m of edits.manual) get(m.identity).frames.add(m.frame);

  const removed = new Set(edits.removed);
  const out: Person[] = [];
  for (const [id, p] of acc) {
    if (removed.has(id)) continue;
    const frames = [...p.frames].sort((a, b) => a - b);
    const lab = (p.labs.length ? [0, 1, 2].map((i) => median(p.labs.map((l) => l[i]))) : [0, 128, 128]) as [number, number, number];
    const meta = edits.people[String(id)] ?? {};
    const gaps: [number, number][] = [];
    for (let i = 1; i < frames.length; i++) {
      if ((frames[i] - frames[i - 1]) / file.fps >= Math.max(minGapS, (file.stride * 1.5) / file.fps)) gaps.push([frames[i - 1], frames[i]]);
    }
    out.push({
      id,
      // By hand; else by her boxes against the colours measured in this file; else as the program proposed; else by
      // the colours picked on the video (older files without teams).
      team: (meta.team as TeamCode | undefined) ?? majority(p.votes) ?? majority(p.fileVotes) ?? teamOfColor(lab, colors),
      teamByHand: meta.team !== undefined,
      keeper: (kitOfColor(lab, colors) ?? "").endsWith("_gk"),
      player_id: meta.player_id ?? "",
      done: meta.done === true,
      frames,
      first: frames[0],
      last: frames[frames.length - 1],
      tracks: [...p.tracks].sort((a, b) => a - b),
      lab,
      gaps,
      onPitchShare: p.n ? p.inside / p.n : 0,
      conflicts: p.twice,
    });
  }
  return out.sort((a, b) => a.first - b.first || a.id - b.id);
}

// ---------------------------------------------------------------- edits (each returns a new TrackEdits)

// `from` becomes part of `into`: same person. Team and number of `into` win; those of `from` fill what is missing.
export function merge(edits: TrackEdits, into: number, from: number): TrackEdits {
  if (into === from) return edits;
  const identity = { ...edits.identity, [`i${from}`]: into };
  // Identities that had already been merged into `from` follow it.
  for (const [k, v] of Object.entries(identity)) if (v === from) identity[k] = into;
  const a = edits.people[String(into)] ?? {};
  const b = edits.people[String(from)] ?? {};
  const joined = { ...b, ...a };
  delete joined.done;
  const peopleNext = { ...edits.people, [String(into)]: joined };
  delete peopleNext[String(from)];
  return {
    ...edits,
    identity,
    people: peopleNext,
    removed: edits.removed.filter((r) => r !== from),
    manual: edits.manual.map((m) => (m.identity === from ? { ...m, identity: into } : m)),
  };
}

// An identity number that nobody has yet.
export function freshIdentity(edits: TrackEdits, file: TracksFile): number {
  let max = 0;
  for (const fr of file.frames) for (const b of fr.boxes) max = Math.max(max, b[0], b[13] ?? 0);
  for (const s of edits.splits) max = Math.max(max, s.identity);
  for (const m of edits.manual) max = Math.max(max, m.identity);
  for (const v of Object.values(edits.identity)) max = Math.max(max, v);
  return max + 1;
}

// Frames where two people are present at the same time. Two people who coincide cannot be the same one.
export function overlap(a: Person, b: Person): number[] {
  const other = new Set(b.frames);
  return a.frames.filter((f) => other.has(f));
}

// Two boxes of one frame are one player detected twice when the smaller lies mostly inside the bigger one in the image
// (a box within a box, or two near-identical boxes). Judged in pixels, not on the pitch: when the detector draws the
// feet of the two boxes differently, their positions on the pitch can be metres apart although it is one person.
export const SAME_BOX_OVERLAP = 0.6;

export function boxOverlap(a: DetBox, b: DetBox): number {
  const w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const h = Math.min(a[4], b[4]) - Math.max(a[2], b[2]);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min((a[3] - a[1]) * (a[4] - a[2]), (b[3] - b[1]) * (b[4] - b[2]));
  return smaller > 0 ? (w * h) / smaller : 0;
}

export function samePlayer(a: DetBox, b: DetBox): boolean {
  return boxOverlap(a, b) >= SAME_BOX_OVERLAP;
}

export interface Clash {
  // Frames where the two people have boxes in the same place: one player detected twice.
  same: number[];
  // Frames where their boxes are apart: really two people on the pitch at once.
  apart: number[];
  // In the `same` frames, the box to leave out (the less confident of the two).
  drop: { track: number; frame: number }[];
}

// What happens in the frames where two people (or the two boxes of one person, with a === b) appear together.
export function clash(file: TracksFile, edits: TrackEdits, a: number, b: number): Clash {
  const out: Clash = { same: [], apart: [], drop: [] };
  const dropped = droppedSet(edits);
  for (const fr of file.frames) {
    const live = fr.boxes.filter((x) => !isDropped(dropped, x, fr.frame));
    const mine = live.filter((x) => identityOf(x, fr.frame, edits) === a);
    const theirs = a === b ? mine.slice(1) : live.filter((x) => identityOf(x, fr.frame, edits) === b);
    const first = a === b ? mine.slice(0, 1) : mine;
    if (first.length === 0 || theirs.length === 0) continue;
    // Every box must sit on the first one to call the frame a double detection.
    const keep = [...first, ...theirs].reduce((best, x) => (x[5] > best[5] ? x : best));
    const others = [...first, ...theirs].filter((x) => x !== keep);
    if (others.every((x) => samePlayer(keep, x))) {
      out.same.push(fr.frame);
      for (const x of others) out.drop.push({ track: x[0], frame: fr.frame });
    } else out.apart.push(fr.frame);
  }
  return out;
}

// Leaves out the given boxes (the second detection of a player in a frame).
export function dropBoxes(edits: TrackEdits, boxes: { track: number; frame: number }[]): TrackEdits {
  const seen = droppedSet(edits);
  const added = boxes.filter((d) => !seen.has(`${d.track}:${d.frame}`));
  return added.length ? { ...edits, dropped: [...(edits.dropped ?? []), ...added] } : edits;
}

// Takes a whole raw track out of whatever person it was part of: it becomes a person of its own.
// Used when one identity shows two boxes in the same frame and the wrong one has to go.
export function separateTrack(edits: TrackEdits, track: number, file: TracksFile): { edits: TrackEdits; identity: number } {
  const identity = freshIdentity(edits, file);
  return {
    edits: { ...edits, identity: { ...edits.identity, [String(track)]: identity }, splits: edits.splits.filter((s) => s.track !== track) },
    identity,
  };
}

// Only the stretch of one raw track that a person has around `frame` (its boxes in a row, with holes of at most
// `maxGapS`) becomes somebody else; the rest of that track keeps the identity it had. For two boxes of one person in
// one frame: the wrong one goes, the good stretches before and after it stay, and so do the cuts already made.
export function separateRun(edits: TrackEdits, file: TracksFile, track: number, frame: number, maxGapS = 0.5): { edits: TrackEdits; identity: number } | null {
  const person = (() => {
    const fr = file.frames.find((f) => f.frame === frame);
    const b = fr?.boxes.find((x) => x[0] === track);
    return b ? identityOf(b, frame, edits) : null;
  })();
  if (person === null) return null;
  // The frames of this track that belong to that person, in order.
  const mine: { frame: number; box: DetBox }[] = [];
  for (const fr of file.frames) {
    const b = fr.boxes.find((x) => x[0] === track);
    if (b && identityOf(b, fr.frame, edits) === person) mine.push({ frame: fr.frame, box: b });
  }
  const i = mine.findIndex((m) => m.frame === frame);
  if (i < 0) return null;
  const gap = maxGapS * file.fps;
  let a = i;
  while (a > 0 && mine[a].frame - mine[a - 1].frame <= gap) a--;
  let b = i;
  while (b < mine.length - 1 && mine[b + 1].frame - mine[b].frame <= gap) b++;
  const identity = freshIdentity(edits, file);
  const splits = [...edits.splits, { track, frame: mine[a].frame, identity }];
  // After the stretch, the track goes back to what it was there (if it goes on at all).
  const after = file.frames.find((f) => f.frame > mine[b].frame && f.boxes.some((x) => x[0] === track));
  if (after) {
    const box = after.boxes.find((x) => x[0] === track) as DetBox;
    splits.push({ track, frame: after.frame, identity: identityOf(box, after.frame, edits) });
  }
  return { edits: { ...edits, splits }, identity };
}

// The stretch [a, b] of one raw track (frames inclusive) goes to `identity`; the rest of the track keeps what it was
// (hand cuts inside the stretch are replaced, the one after it stays as it was). Null when the track has no box there.
// One new TrackEdits: applying it is one action for the undo. Used by the one-click joins of the anchors mode.
export function assignStretch(edits: TrackEdits, file: TracksFile, track: number, a: number, b: number, identity: number): TrackEdits | null {
  const frames = file.frames.filter((f) => f.boxes.some((x) => x[0] === track)).map((f) => f.frame);
  const inside = frames.filter((f) => f >= a && f <= b);
  if (inside.length === 0) return null;
  const fa = inside[0];
  const nf = frames.find((f) => f > b);
  const kept = edits.splits.filter((s) => s.track !== track || s.frame < fa || s.frame >= (nf ?? Number.POSITIVE_INFINITY));
  const added: TrackEdits["splits"] = [];
  if (nf !== undefined) {
    const bx = file.frames.find((f) => f.frame === nf)?.boxes.find((x) => x[0] === track) as DetBox;
    // Back to what the track was there before this change.
    added.push({ track, frame: nf, identity: identityOf(bx, nf, edits) });
  }
  added.push({ track, frame: fa, identity });
  return { ...edits, splits: [...kept.filter((s) => !(s.track === track && added.some((x) => x.frame === s.frame))), ...added] };
}

// Frames of [a, b] where `person` already has a live box, other than those of `exceptTrack` (a stretch given to her must
// not collide with them).
export function personFramesIn(file: TracksFile, edits: TrackEdits, person: number, a: number, b: number, exceptTrack?: number): number[] {
  const drop = droppedSet(edits);
  const out: number[] = [];
  for (const fr of file.frames) {
    if (fr.frame < a || fr.frame > b) continue;
    if (fr.boxes.some((x) => x[0] !== exceptTrack && !isDropped(drop, x, fr.frame) && identityOf(x, fr.frame, edits) === person)) out.push(fr.frame);
  }
  return out;
}

// A hole of a person is "off camera" when she was at the edge of the image just before losing her or just after
// finding her again: she went out of frame (or came back into it), and nothing can be fixed there. The other holes
// happened in the middle of the image: there she was probably visible, and another piece of hers may be missing.
export const EDGE_SHARE = 0.03;
const framesIndex = new WeakMap<TracksFile, Map<number, TracksFile["frames"][number]>>();
export function offCamera(file: TracksFile, edits: TrackEdits, person: number, gap: [number, number]): boolean {
  let index = framesIndex.get(file);
  if (!index) framesIndex.set(file, (index = new Map(file.frames.map((f) => [f.frame, f]))));
  const m = EDGE_SHARE * (file.image_w || 1920);
  const W = file.image_w || 1920;
  const H = file.image_h || 1080;
  const atEdge = (frame: number) => {
    const box = index?.get(frame)?.boxes.find((b) => identityOf(b, frame, edits) === person);
    return box ? box[1] <= m || box[2] <= m || box[3] >= W - m || box[4] >= H - m : false;
  };
  return atEdge(gap[0]) || atEdge(gap[1]);
}

// From `frame` on, this PERSON is somebody else: whatever she has from that frame onwards (the rest of the track she
// is on, and any later track that had been joined to her) becomes a new person. Works on any frame between her first
// and last appearance, also inside a hole where she has no box: that is usually where a wrong join happened.
// Returns the edits and the new identity, or null when she has nothing from that frame on (or nothing before it).
export function splitPerson(edits: TrackEdits, person: number, frame: number, file: TracksFile): { edits: TrackEdits; identity: number } | null {
  // First frame, at or after `frame`, of each of her tracks; and whether she has anything before.
  const from = new Map<number, number>();
  let before = false;
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (identityOf(b, fr.frame, edits) !== person) continue;
      if (fr.frame < frame) before = true;
      else if (!from.has(b[0])) from.set(b[0], fr.frame);
    }
  }
  const manualAfter = edits.manual.some((m) => m.identity === person && m.frame >= frame);
  if (edits.manual.some((m) => m.identity === person && m.frame < frame)) before = true;
  if (!before || (from.size === 0 && !manualAfter)) return null;
  const identity = freshIdentity(edits, file);
  const added = [...from].map(([track, f]) => ({ track, frame: f, identity }));
  return {
    edits: {
      ...edits,
      // A split of the same track at the same frame is replaced; later splits of that track stay as they were.
      splits: [...edits.splits.filter((s) => !added.some((n) => n.track === s.track && n.frame === s.frame)), ...added],
      manual: edits.manual.map((m) => (m.identity === person && m.frame >= frame ? { ...m, identity } : m)),
    },
    identity,
  };
}

// From `frame` on, `track` is somebody else (the tracker swapped two players). Returns the edits and the new identity.
export function split(edits: TrackEdits, track: number, frame: number, file: TracksFile): { edits: TrackEdits; identity: number } {
  const identity = freshIdentity(edits, file);
  return { edits: { ...edits, splits: [...edits.splits.filter((s) => !(s.track === track && s.frame === frame)), { track, frame, identity }] }, identity };
}

export function setPerson(edits: TrackEdits, id: number, patch: { team?: TeamCode | null; player_id?: string; done?: boolean }): TrackEdits {
  const cur = { ...(edits.people[String(id)] ?? {}) };
  if (patch.team === null) delete cur.team;
  else if (patch.team !== undefined) cur.team = patch.team;
  if (patch.player_id !== undefined) cur.player_id = patch.player_id;
  if (patch.done === true) cur.done = true;
  else if (patch.done === false) delete cur.done;
  return { ...edits, people: { ...edits.people, [String(id)]: cur } };
}

// Among the given people (usually the fragments of under a second), those that are a second box on somebody else:
// in every frame where they appear, their box lies mostly inside another person's box in the image (samePlayer). The
// rest were alone at least once: a real detection of someone, or a false one, but not a duplicate.
export function duplicatesAmong(file: TracksFile, edits: TrackEdits, ids: Set<number>): number[] {
  const near = new Map<number, boolean>();
  const gone = new Set(edits.removed);
  const drop = droppedSet(edits);
  for (const fr of file.frames) {
    const here = fr.boxes
      .filter((b) => !isDropped(drop, b, fr.frame))
      .map((b) => ({ id: identityOf(b, fr.frame, edits), b }))
      .filter((x) => !gone.has(x.id));
    for (const x of here) {
      if (!ids.has(x.id)) continue;
      const covered = here.some((o) => o.id !== x.id && samePlayer(o.b, x.b));
      near.set(x.id, (near.get(x.id) ?? true) && covered);
    }
  }
  return [...near].filter(([, always]) => always).map(([id]) => id);
}

// A short piece fits a person when she could be there: within ABSORB_SAME_M plus what she can run in the time since
// (or until) her nearest known position, and no further in time than ABSORB_GAP_S.
export const ABSORB_SPEED_MS = 8;
// On top of her box (m) when both are in the same frame.
export const ABSORB_SAME_M = 2;
export const ABSORB_GAP_S = 2;

export interface Absorb {
  from: number;
  into: number;
  // Frames the piece gives her that she did not have (0 = it only repeats boxes she already has).
  adds: number;
  // Mean distance (units of the pitch) between the piece and where she was, or was expected to be.
  cost: number;
}

// Short pieces that belong to somebody else: each sits on that person where she has a box, and where she has none
// (a hole, or just before or after she is seen) it is where she could be. A piece that fits two people about as well
// is left alone, and so is one whose shirt says another team.
export function suggestAbsorb(file: TracksFile, edits: TrackEdits, ppl: Person[], short: Set<number>): Absorb[] {
  const drop = droppedSet(edits);
  const pos = new Map<number, Map<number, [number, number]>>();
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (b[9] === null || b[10] === null || isDropped(drop, b, fr.frame)) continue;
      const id = identityOf(b, fr.frame, edits);
      let m = pos.get(id);
      if (!m) pos.set(id, (m = new Map()));
      if (!m.has(fr.frame)) m.set(fr.frame, [b[9], b[10]]);
    }
  }
  const hosts = ppl
    .filter((p) => !short.has(p.id) && pos.has(p.id))
    .map((p) => ({ p, at: pos.get(p.id) as Map<number, [number, number]>, frames: [...(pos.get(p.id) as Map<number, [number, number]>).keys()].sort((a, b) => a - b) }));
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const out: Absorb[] = [];
  for (const s of ppl) {
    const mine = pos.get(s.id);
    // Without a position in every frame there is nothing to compare.
    if (!short.has(s.id) || !mine || mine.size !== s.frames.length) continue;
    const fits: Absorb[] = [];
    for (const h of hosts) {
      if (s.team !== "unk" && h.p.team !== "unk" && s.team !== h.p.team) continue;
      let total = 0;
      let adds = 0;
      let ok = true;
      for (const [f, xy] of mine) {
        const there = h.at.get(f);
        if (there) {
          const d = dist(xy, there);
          if (d >= ABSORB_SAME_M) ok = false;
          total += d;
        } else {
          // Her nearest known positions before and after this frame, when close enough in time.
          // Binary search in her sorted frames.
          let lo = 0;
          let hi = h.frames.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (h.frames[mid] < f) lo = mid + 1;
            else hi = mid;
          }
          const prev: number | null = lo > 0 ? h.frames[lo - 1] : null;
          const next: number | null = lo < h.frames.length ? h.frames[lo] : null;
          const near = [prev, next].filter((g): g is number => g !== null && Math.abs(g - f) / file.fps <= ABSORB_GAP_S);
          if (near.length === 0) ok = false;
          for (const g of near) {
            if (dist(xy, h.at.get(g) as [number, number]) > ABSORB_SAME_M + (ABSORB_SPEED_MS * Math.abs(g - f)) / file.fps) ok = false;
          }
          if (!ok) break;
          let expected = h.at.get(near[0]) as [number, number];
          if (near.length === 2) {
            const [a, b] = [h.at.get(near[0]) as [number, number], h.at.get(near[1]) as [number, number]];
            const k = (f - near[0]) / (near[1] - near[0]);
            expected = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
          }
          total += dist(xy, expected);
          adds++;
        }
        if (!ok) break;
      }
      if (ok) fits.push({ from: s.id, into: h.p.id, adds, cost: total / mine.size });
    }
    fits.sort((a, b) => a.cost - b.cost);
    // Two people about as likely: do not guess.
    if (fits.length > 0 && (fits.length === 1 || fits[1].cost > fits[0].cost + 1)) out.push(fits[0]);
  }
  return out;
}

// Applies the suggestions one by one. Each is checked again against what the earlier ones changed: two pieces cannot
// fill the same frame of one person in different places. Returns how many were joined and the frames they gave.
export function applyAbsorb(file: TracksFile, edits: TrackEdits, list: Absorb[]): { edits: TrackEdits; joined: number; frames: number } {
  let next = edits;
  let joined = 0;
  let frames = 0;
  for (const a of [...list].sort((u, v) => u.cost - v.cost)) {
    const c = clash(file, next, a.into, a.from);
    if (c.apart.length > 0) continue;
    next = merge(dropBoxes(next, c.drop), a.into, a.from);
    joined++;
    frames += a.adds;
  }
  return { edits: next, joined, frames };
}

export function setRemovedMany(edits: TrackEdits, ids: number[]): TrackEdits {
  return { ...edits, removed: [...new Set([...edits.removed, ...ids])] };
}

export function setRemoved(edits: TrackEdits, id: number, removed: boolean): TrackEdits {
  return { ...edits, removed: removed ? [...new Set([...edits.removed, id])] : edits.removed.filter((r) => r !== id) };
}

// Hand-marked position (feet, in pixels) of a person in a frame where the detector lost her. One per person and frame.
export function setManual(edits: TrackEdits, identity: number, frame: number, px: number, py: number): TrackEdits {
  return { ...edits, manual: [...edits.manual.filter((m) => !(m.identity === identity && m.frame === frame)), { identity, frame, px, py }] };
}

export function removeManual(edits: TrackEdits, identity: number, frame: number): TrackEdits {
  return { ...edits, manual: edits.manual.filter((m) => !(m.identity === identity && m.frame === frame)) };
}

// Processed frame nearest to a video frame (only 1 of every `stride` frames has detections).
// Ball marked by hand (pixels) in a frame. One per frame.
export function setBall(edits: TrackEdits, frame: number, px: number, py: number): TrackEdits {
  return { ...edits, ball: [...(edits.ball ?? []).filter((b) => b.frame !== frame), { frame, px, py }].sort((a, b) => a.frame - b.frame) };
}

export function removeBall(edits: TrackEdits, frame: number): TrackEdits {
  // A line that ended or started at that mark goes with it.
  const links = (edits.ballLinks ?? []).filter((l) => l.from !== frame && l.to !== frame);
  return { ...edits, ball: (edits.ball ?? []).filter((b) => b.frame !== frame), ...(edits.ballLinks ? { ballLinks: links } : {}) };
}

// The ball goes in a straight line from the mark at `from` to the mark at `to` (a long pass, a ball in the air).
export function linkBall(edits: TrackEdits, from: number, to: number): TrackEdits {
  const [a, b] = from < to ? [from, to] : [to, from];
  const links = (edits.ballLinks ?? []).filter((l) => !(l.from === a && l.to === b));
  return { ...edits, ballLinks: [...links, { from: a, to: b }] };
}

export function nearestFrame(file: Pick<TracksFile, "start_frame" | "end_frame" | "stride">, frame: number): number {
  const k = file.start_frame + Math.round((frame - file.start_frame) / file.stride) * file.stride;
  const last = file.start_frame + Math.floor((file.end_frame - 1 - file.start_frame) / file.stride) * file.stride;
  return Math.min(last, Math.max(file.start_frame, k));
}

// The edits with the referees (by shirt, not set by hand) left out, for what is exported.
export function withoutReferees(file: TracksFile, edits: TrackEdits, colors?: Partial<JerseyColors>): TrackEdits {
  const refs = people(file, edits, colors).filter((p) => p.team === "ref" && !p.teamByHand).map((p) => p.id);
  return refs.length ? setRemovedMany(edits, refs) : edits;
}
