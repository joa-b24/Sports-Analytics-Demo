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

// Beyond this distance a shirt belongs to no team. Lightness counts half: shade changes it a lot and the hue little.
// Same rule and value as classify_team / MAX_COLOR_DISTANCE in process.py.
export const MAX_COLOR_DISTANCE = 40;

// Nearest reference kit, or null when none is close enough (or none is set).
export function kitOfColor(lab: number[], colors: Partial<JerseyColors> | undefined): JerseyKey | null {
  let best: JerseyKey | null = null;
  let bestD = MAX_COLOR_DISTANCE;
  for (const key of JERSEY_KEYS) {
    const ref = colors?.[key] ? hexToLab(colors[key] as string) : null;
    if (!ref) continue;
    const d = Math.hypot(0.5 * (lab[0] - ref[0]), lab[1] - ref[1], lab[2] - ref[2]);
    if (d <= bestD) {
      best = key;
      bestD = d;
    }
  }
  return best;
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
export function identityOf(box: DetBox, frame: number, edits: TrackEdits): number {
  const track = box[0];
  let split: TrackEdits["splits"][number] | null = null;
  for (const s of edits.splits) if (s.track === track && s.frame <= frame && (!split || s.frame > split.frame)) split = s;
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
  const acc = new Map<number, { frames: Set<number>; tracks: Set<number>; labs: number[][]; inside: number; n: number; twice: number[] }>();
  const get = (id: number) => {
    let p = acc.get(id);
    if (!p) acc.set(id, (p = { frames: new Set(), tracks: new Set(), labs: [], inside: 0, n: 0, twice: [] }));
    return p;
  };
  const drop = droppedSet(edits);
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame)) continue;
      const p = get(identityOf(b, fr.frame, edits));
      if (p.frames.has(fr.frame) && p.twice[p.twice.length - 1] !== fr.frame) p.twice.push(fr.frame);
      p.frames.add(fr.frame);
      p.tracks.add(b[0]);
      p.labs.push([b[6], b[7], b[8]]);
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
      team: (meta.team as TeamCode | undefined) ?? teamOfColor(lab, colors),
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
function freshIdentity(edits: TrackEdits, file: TracksFile): number {
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

// Two boxes closer than this (units of the pitch, about meters) in one frame are one player detected twice.
export const SAME_PLAYER_M = 2;

// Are two boxes of one frame the same player seen twice? By position on the pitch when both have one; otherwise by
// how close they are in the image, compared with their own size.
export function samePlayer(a: DetBox, b: DetBox, radius = SAME_PLAYER_M): boolean {
  if (a[9] !== null && a[10] !== null && b[9] !== null && b[10] !== null) return Math.hypot(a[9] - b[9], a[10] - b[10]) < radius;
  const size = Math.max(a[4] - a[2], b[4] - b[2]);
  return Math.hypot((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2, a[4] - b[4]) < 0.6 * size;
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
// in every frame where they appear, another person stands within `radius` units of the pitch. The rest were alone
// at least once: a real detection of someone, or a false one, but not a duplicate.
export function duplicatesAmong(file: TracksFile, edits: TrackEdits, ids: Set<number>, radius = 1.5): number[] {
  const near = new Map<number, boolean>();
  const gone = new Set(edits.removed);
  const drop = droppedSet(edits);
  for (const fr of file.frames) {
    const here = fr.boxes
      .filter((b) => b[9] !== null && b[10] !== null && !isDropped(drop, b, fr.frame))
      .map((b) => ({ id: identityOf(b, fr.frame, edits), x: b[9] as number, y: b[10] as number }))
      .filter((b) => !gone.has(b.id));
    for (const b of here) {
      if (!ids.has(b.id)) continue;
      const close = here.some((o) => o.id !== b.id && Math.hypot(o.x - b.x, o.y - b.y) < radius);
      near.set(b.id, (near.get(b.id) ?? true) && close);
    }
  }
  return [...near].filter(([, always]) => always).map(([id]) => id);
}

// A short piece fits a person when she could be there: within SAME_PLAYER_M plus what she can run in the time since
// (or until) her nearest known position, and no further in time than ABSORB_GAP_S.
export const ABSORB_SPEED_MS = 8;
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
          if (d >= SAME_PLAYER_M) ok = false;
          total += d;
        } else {
          // Her nearest known positions before and after this frame, when close enough in time.
          let prev: number | null = null;
          let next: number | null = null;
          for (const g of h.frames) {
            if (g < f) prev = g;
            else {
              next = g;
              break;
            }
          }
          const near = [prev, next].filter((g): g is number => g !== null && Math.abs(g - f) / file.fps <= ABSORB_GAP_S);
          if (near.length === 0) ok = false;
          for (const g of near) {
            if (dist(xy, h.at.get(g) as [number, number]) > SAME_PLAYER_M + (ABSORB_SPEED_MS * Math.abs(g - f)) / file.fps) ok = false;
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
  return { ...edits, ball: (edits.ball ?? []).filter((b) => b.frame !== frame) };
}

export function nearestFrame(file: Pick<TracksFile, "start_frame" | "end_frame" | "stride">, frame: number): number {
  const k = file.start_frame + Math.round((frame - file.start_frame) / file.stride) * file.stride;
  const last = file.start_frame + Math.floor((file.end_frame - 1 - file.start_frame) / file.stride) * file.stride;
  return Math.min(last, Math.max(file.start_frame, k));
}
