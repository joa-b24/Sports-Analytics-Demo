// Quick review: names given on sample frames (one every few seconds) spread to the whole part. Pure functions.
//
// The program's identities are the starting pieces. A name given to a box names its piece. Then:
//  1. a piece with two different names between two samples is cut at the most likely crossing between them (the frame
//     where it comes closest to another box: measured on the corrected parts, nearly every change of person happens
//     with somebody within 1-2 m);
//  2. a player is in one place at a time: a piece that carries a name and is still there when that name is given to
//     another box is cut at the crossing between its own last sample and that one;
//  3. a piece only keeps a name until the next sample where it could have been confirmed: if it is still visible at
//     a sample and nobody confirmed it, it is cut at the crossing before that sample (the analyst decides, not the
//     program);
//  4. pieces with the same name are one person, unless they are seen at the same time in different places.
// The name "-" says "nobody of interest" (a duplicate box, somebody off the pitch): it stops a name from spreading.
import { droppedSet, freshIdentity, identityOf, isDropped, merge, samePlayer, setPerson, splitPerson, type DetBox, type Person, type TeamCode, type TracksFile } from "./tracks.ts";
import { ballCoverage } from "./parts.ts";
import type { TrackEdits } from "./types.ts";

export const NOBODY = "-";
export const SAMPLE_S = 3;

export interface QuickLabel {
  frame: number;
  // Column 0 of the box (the raw track): with the frame, it names one box of the file.
  track: number;
  name: string;
  team?: "own" | "opp";
}

interface Obs {
  frame: number;
  box: DetBox;
}
export interface Segment {
  id: number;
  from: number;
  to: number;
  name: string | null;
  team: "own" | "opp" | null;
  labels: number;
}
export interface QuickModel {
  // `${frame}:${track}` -> name, for every box the model names.
  nameOf: Map<string, string>;
  segments: Segment[];
  // Cut frames by identity of the base edits (frames >= cut belong to the next piece).
  cuts: Map<number, number[]>;
  // Names seen twice at once in different places, left unnamed in one of them.
  conflicts: { name: string; frame: number }[];
}

// Processed frames of a part closest to one every `everyS` seconds.
export function sampleFrames(file: TracksFile, everyS = SAMPLE_S): number[] {
  const frames = file.frames.map((f) => f.frame);
  if (frames.length === 0) return [];
  const out: number[] = [];
  const step = everyS * file.fps;
  let j = 0;
  for (let t = frames[0]; t <= frames[frames.length - 1]; t += step) {
    while (j < frames.length - 1 && Math.abs(frames[j + 1] - t) <= Math.abs(frames[j] - t)) j++;
    if (out[out.length - 1] !== frames[j]) out.push(frames[j]);
  }
  return out;
}

const key = (frame: number, track: number) => `${frame}:${track}`;

// Who is who in the program's proposal: the same for every name given, so it is worked out once per base.
interface Index {
  rows: Map<number, DetBox[]>;
  obs: Map<number, Obs[]>;
  idAt: Map<string, number>;
}
const indexCache = new WeakMap<TrackEdits, { file: TracksFile; index: Index }>();
function indexOf(file: TracksFile, base: TrackEdits): Index {
  const hit = indexCache.get(base);
  if (hit && hit.file === file) return hit.index;
  const drop = droppedSet(base);
  const rows = new Map(file.frames.map((fr) => [fr.frame, fr.boxes.filter((b) => !isDropped(drop, b, fr.frame))]));
  const obs = new Map<number, Obs[]>();
  const idAt = new Map<string, number>();
  for (const fr of file.frames)
    for (const b of rows.get(fr.frame) ?? []) {
      const id = identityOf(b, fr.frame, base);
      idAt.set(key(fr.frame, b[0]), id);
      let list = obs.get(id);
      if (!list) obs.set(id, (list = []));
      list.push({ frame: fr.frame, box: b });
    }
  const index = { rows, obs, idAt };
  indexCache.set(base, { file, index });
  return index;
}

// `reviewed`: the sample frames the analyst has already gone through. Only those can cut a name that was not confirmed;
// on the others the model proposes, and the analyst confirms or fixes.
export function quickModel(file: TracksFile, base: TrackEdits, labels: QuickLabel[], reviewed: number[]): QuickModel {
  const samples = [...reviewed].sort((a, b) => a - b);
  const { rows, obs, idAt } = indexOf(file, base);

  // The frame in (a, b] where this identity comes closest to another box, relative to its own height.
  const crossing = (id: number, a: number, b: number): number => {
    let best = b;
    let bestD = Infinity;
    for (const o of obs.get(id) ?? []) {
      if (o.frame <= a || o.frame > b) continue;
      const h = Math.max(1, o.box[4] - o.box[2]);
      const fx = (o.box[1] + o.box[3]) / 2;
      for (const x of rows.get(o.frame) ?? []) {
        if (x === o.box || idAt.get(key(o.frame, x[0])) === id) continue;
        const d = Math.hypot((x[1] + x[3]) / 2 - fx, x[4] - o.box[4]) / h;
        if (d < bestD) {
          bestD = d;
          best = o.frame;
        }
      }
    }
    return best;
  };

  // Labels on boxes that exist, by identity, in time order.
  const lab = labels
    .map((l) => ({ ...l, id: idAt.get(key(l.frame, l.track)) }))
    .filter((l): l is QuickLabel & { id: number } => l.id !== undefined)
    .sort((a, b) => a.frame - b.frame);
  const cuts = new Map<number, number[]>();
  const addCut = (id: number, c: number) => {
    const list = cuts.get(id) ?? [];
    const first = obs.get(id)?.[0]?.frame ?? c;
    if (c <= first || list.includes(c)) return;
    cuts.set(id, [...list, c].sort((x, y) => x - y));
  };
  const segOf = (id: number, frame: number) => (cuts.get(id) ?? []).filter((c) => c <= frame).length;
  const present = (id: number, frame: number) => (obs.get(id) ?? []).some((o) => o.frame === frame);

  // 1. Different names on one piece.
  const byId = new Map<number, (QuickLabel & { id: number })[]>();
  for (const l of lab) byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  for (const [id, ls] of byId)
    for (let i = 1; i < ls.length; i++) if (ls[i].name !== ls[i - 1].name) addCut(id, crossing(id, ls[i - 1].frame, ls[i].frame));

  // Labels of each piece (identity + segment), recomputed after each round of cuts.
  const pieces = () => {
    const out = new Map<string, (QuickLabel & { id: number })[]>();
    for (const l of lab) {
      const k = `${l.id}#${segOf(l.id, l.frame)}`;
      out.set(k, [...(out.get(k) ?? []), l]);
    }
    return out;
  };

  // 2. One place at a time; 3. a name lasts until the next sample where it was not confirmed.
  for (let round = 0; round < 3; round++) {
    let changed = false;
    const ps = pieces();
    for (const [k, ls] of ps) {
      const name = ls[0].name;
      const id = ls[0].id;
      const firstL = ls[0].frame;
      const lastL = ls[ls.length - 1].frame;
      if (name !== NOBODY) {
        for (const l of lab) {
          if (l.name !== name || `${l.id}#${segOf(l.id, l.frame)}` === k || !present(id, l.frame) || segOf(id, l.frame) !== segOf(id, firstL)) continue;
          if (l.frame > lastL) addCut(id, crossing(id, lastL, l.frame));
          else if (l.frame < firstL) addCut(id, crossing(id, l.frame, firstL));
          else continue;
          changed = true;
        }
      }
      const next = samples.find((s) => s > lastL);
      const labelled = (s: number) => lab.some((l) => l.frame === s && l.id === id);
      if (next !== undefined && present(id, next) && segOf(id, next) === segOf(id, lastL) && !labelled(next)) {
        addCut(id, crossing(id, lastL, next));
        changed = true;
      }
      const prev = [...samples].reverse().find((s) => s < firstL);
      if (prev !== undefined && present(id, prev) && segOf(id, prev) === segOf(id, firstL) && !labelled(prev)) {
        addCut(id, crossing(id, prev, firstL));
        changed = true;
      }
    }
    if (!changed) break;
  }

  const boxesIn = (id: number, from: number, to: number) => (obs.get(id) ?? []).filter((o) => o.frame >= from && o.frame <= to);
  const build = (): Segment[] => {
    const ps = pieces();
    const out: Segment[] = [];
    for (const [id, list] of obs) {
      const cs = cuts.get(id) ?? [];
      const bounds = [list[0].frame, ...cs, list[list.length - 1].frame + 1];
      for (let k = 0; k + 1 < bounds.length; k++) {
        const ls = ps.get(`${id}#${k}`) ?? [];
        const name = ls[0]?.name ?? null;
        out.push({ id, from: bounds[k], to: bounds[k + 1] - 1, name: name === NOBODY ? null : name, team: ls.find((l) => l.team)?.team ?? null, labels: ls.length });
      }
    }
    return out;
  };
  const labelsOf = (s: Segment) => lab.filter((l) => l.id === s.id && l.frame >= s.from && l.frame <= s.to);

  // 4. One place at a time across pieces. Of two pieces with one name seen apart at once, the one with fewer labels
  // gives up the overlapping stretch: cut there if it lies beyond its labels, else it loses the name.
  const conflicts: QuickModel["conflicts"] = [];
  let segments = build();
  for (let round = 0; round < 3; round++) {
    let changed = false;
    const named = new Map<string, Segment[]>();
    for (const sg of segments) if (sg.name) named.set(sg.name, [...(named.get(sg.name) ?? []), sg]);
    for (const [name, list] of named) {
      const kept: Segment[] = [];
      for (const sg of [...list].sort((a, b) => b.labels - a.labels)) {
        const mine = new Map(boxesIn(sg.id, sg.from, sg.to).map((o) => [o.frame, o.box]));
        const hits = kept.flatMap((k) => boxesIn(k.id, k.from, k.to)).filter((o) => mine.has(o.frame) && !samePlayer(o.box, mine.get(o.frame) as DetBox));
        if (hits.length === 0) {
          kept.push(sg);
          continue;
        }
        const ls = labelsOf(sg);
        const o1 = Math.min(...hits.map((o) => o.frame));
        const o2 = Math.max(...hits.map((o) => o.frame));
        if (ls.length && o1 > ls[ls.length - 1].frame) addCut(sg.id, o1);
        else if (ls.length && o2 < ls[0].frame) addCut(sg.id, (file.frames.find((f) => f.frame > o2)?.frame ?? o2 + 1));
        else {
          conflicts.push({ name, frame: o1 });
          sg.name = null;
          continue;
        }
        changed = true;
      }
    }
    if (!changed) break;
    segments = build();
  }

  // 5. A name goes on to a piece that starts right where a named one ended (under a second later, within a box
  // height in the image) when it is the only one there; and back to one that ended right before a named one started.
  // Only to pieces with no label of their own; the next sample confirms it or fixes it.
  const gap = file.fps;
  const first = (sg: Segment) => boxesIn(sg.id, sg.from, sg.to)[0];
  const last = (sg: Segment) => {
    const b = boxesIn(sg.id, sg.from, sg.to);
    return b[b.length - 1];
  };
  const near = (a: Obs, b: Obs) => {
    const h = Math.max(1, a.box[4] - a.box[2], b.box[4] - b.box[2]);
    return Math.hypot((a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2, a.box[4] - b.box[4]) <= 1.5 * h;
  };
  // Only across the program's own boundaries: a piece the model cut on purpose (not confirmed) does not get it back.
  const idStart = (sg: Segment) => sg.from === obs.get(sg.id)?.[0]?.frame;
  const idEnd = (sg: Segment) => {
    const list = obs.get(sg.id) ?? [];
    return sg.to === list[list.length - 1]?.frame;
  };
  for (let hop = 0; hop < 4; hop++) {
    let changed = false;
    const unnamed = segments.filter((sg) => !sg.name && sg.labels === 0);
    const busy = (name: string, from: number, to: number) =>
      segments.some((sg) => sg.name === name && sg.from <= to && sg.to >= from);
    for (const sg of segments.filter((x) => x.name)) {
      const end = last(sg);
      const after = idEnd(sg) ? unnamed.filter((u) => idStart(u) && u.from > end.frame && u.from - end.frame <= gap && near(end, first(u))) : [];
      if (after.length === 1 && !busy(sg.name as string, after[0].from, after[0].to)) {
        after[0].name = sg.name;
        after[0].team = sg.team;
        changed = true;
      }
      const start = first(sg);
      const before = idStart(sg) ? unnamed.filter((u) => !u.name && idEnd(u) && u.to < start.frame && start.frame - u.to <= gap && near(last(u), start)) : [];
      if (before.length === 1 && !busy(sg.name as string, before[0].from, before[0].to)) {
        before[0].name = sg.name;
        before[0].team = sg.team;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nameOf = new Map<string, string>();
  for (const sg of segments) if (sg.name) for (const o of boxesIn(sg.id, sg.from, sg.to)) nameOf.set(key(o.frame, o.box[0]), sg.name);
  return { nameOf, segments, cuts, conflicts };
}

// The model as edits of the correction table: cuts, joins by name, names and teams. Starts from `base` (whose cuts
// and joins it keeps); everything can be undone in the table.
export function applyQuick(file: TracksFile, base: TrackEdits, model: QuickModel): TrackEdits {
  let edits = base;
  // The identity each piece ends up with: cutting from the last cut backwards, the identity keeps the first piece.
  const finalId = new Map<string, number>();
  for (const [id, cs] of model.cuts) {
    for (const c of [...cs].sort((a, b) => b - a)) {
      const r = splitPerson(edits, id, c, file);
      if (!r) continue;
      edits = r.edits;
      finalId.set(`${id}@${c}`, r.identity);
    }
  }
  // A piece starts either where its identity starts (it keeps the identity) or at one of its cuts.
  const idOf = (s: Segment) => ((model.cuts.get(s.id) ?? []).includes(s.from) ? (finalId.get(`${s.id}@${s.from}`) ?? s.id) : s.id);
  const byName = new Map<string, Segment[]>();
  for (const s of model.segments) if (s.name) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  for (const [name, list] of byName) {
    const ids = [...new Set(list.map(idOf))];
    const into = ids[0];
    for (const id of ids.slice(1)) edits = merge(edits, into, id);
    const team = list.find((s) => s.team)?.team as TeamCode | undefined;
    edits = setPerson(edits, into, { player_id: name, ...(team ? { team } : {}) });
  }
  return edits;
}

// ------------------------------------------------------------------------------------------- one player at a time
//
// Following one player, the only moments worth a look are those where the tracker could have handed her over to
// somebody else: right after she crosses a player of her own team (or of either team for longer than a second; a
// quick crossing with a rival is safe because the shirts tell them apart), when she reappears after more than a
// second lost, and where the model passed her name on to a new piece. Elsewhere her track is trusted.

// Two boxes cross when their feet are closer than this, in box heights.
export const CROSS_D = 1.0;
// A crossing with a rival shorter than this (s) is safe.
export const RIVAL_SAFE_S = 1.0;
// How long after a crossing ends she is shown (s): far enough for the two boxes to be apart.
const AFTER_S = 0.4;

export interface Checkpoint {
  frame: number;
  kind: "crossing" | "reappears" | "passed_on" | "lost";
  // Her box there according to the model; null when the model has lost her.
  track: number | null;
}

export function nextCheckpoint(
  file: TracksFile,
  base: TrackEdits,
  model: QuickModel,
  name: string,
  teamOf: (b: DetBox) => TeamCode,
  team: "own" | "opp",
  after: number,
  crossD = CROSS_D,
): Checkpoint | null {
  const { rows, obs } = indexOf(file, base);
  const segs = model.segments.filter((s) => s.name === name).sort((a, b) => a.from - b.from);
  const mine = segs
    .flatMap((s) => (obs.get(s.id) ?? []).filter((o) => o.frame >= s.from && o.frame <= s.to).map((o) => ({ ...o, seg: s })))
    .filter((o) => o.frame > after)
    .sort((a, b) => a.frame - b.frame);
  const frames = file.frames.map((f) => f.frame);
  const at = (f: number) => frames.find((x) => x >= f) ?? null;
  const show = (f: number, kind: Checkpoint["kind"]): Checkpoint | null => {
    // The first frame from `f` where the model still has her; if it has lost her, the frame itself.
    const g = mine.find((o) => o.frame >= f);
    if (g && g.frame - f <= file.fps) return { frame: g.frame, kind, track: g.box[0] };
    const h = at(f);
    return h === null ? null : { frame: h, kind: "lost", track: null };
  };
  if (mine.length === 0) {
    const f = at(after + file.stride);
    return f === null || f >= file.end_frame ? null : { frame: f, kind: "lost", track: null };
  }
  let crossing: { same: boolean; since: number } | null = null;
  let prev: (typeof mine)[number] | null = null;
  for (const o of mine) {
    if (prev) {
      if (o.frame - prev.frame > file.fps) return show(o.frame + AFTER_S * file.fps, "reappears");
      if (o.seg !== prev.seg && o.seg.labels === 0) return show(o.frame + AFTER_S * file.fps, "passed_on");
    }
    const h = Math.max(1, o.box[4] - o.box[2]);
    const fx = (o.box[1] + o.box[3]) / 2;
    let same = false;
    let rival = false;
    for (const x of rows.get(o.frame) ?? []) {
      if (x === o.box || samePlayer(o.box, x) || !x[11]) continue;
      const d = Math.hypot((x[1] + x[3]) / 2 - fx, x[4] - o.box[4]) / h;
      if (d >= crossD) continue;
      const t = teamOf(x);
      if (t === team || t === "unk") same = true;
      else rival = true;
    }
    if (same || rival) {
      if (!crossing) crossing = { same, since: o.frame };
      else crossing.same = crossing.same || same;
    } else if (crossing) {
      const long = (o.frame - crossing.since) / file.fps > RIVAL_SAFE_S;
      if (crossing.same || long) return show(o.frame + AFTER_S * file.fps, "crossing");
      crossing = null;
    }
    prev = o;
  }
  const last = mine[mine.length - 1].frame;
  const f = at(last + file.stride);
  return f === null || f >= file.end_frame ? null : { frame: f, kind: "lost", track: null };
}

// ------------------------------------------------------------------------------------------- when a part is done

// The quick review only speeds the correction up: a part is complete when at least PLAYERS_DONE players (10: the
// goalkeeper may never be in frame) have been checked in the table (named and ticked as complete) and the ball review
// has gone through (almost) every sample of the part. Players marked at the end of the quick review are counted apart.
export const PLAYERS_DONE = 10;
export const BALL_DONE_SHARE = 0.95;
export interface PartSpan {
  start_frame: number;
  end_frame: number;
  fps: number;
}
export function partStatus(
  edits: Pick<TrackEdits, "quick" | "ballReview"> & Partial<Pick<TrackEdits, "people" | "ball" | "ballLinks">>,
  part: PartSpan & { stride?: number },
  // Frames with a ball besides the hand marks (tagged events), when known: the same count as the ball strip.
  extraBall: number[] = [],
): { quick: number; players: number; ball: number; complete: boolean } {
  const quick = new Set(edits.quick?.done ?? []).size;
  // Checked: named and ticked as complete in the table.
  const players = new Set(Object.values(edits.people ?? {}).flatMap((p) => (p.done && p.player_id ? [p.player_id] : []))).size;
  // Share of the time in play with a ball (lib/parts.ts ballCoverage): what was reviewed as out does not count.
  const every = edits.ballReview?.every ?? 1;
  const marks = [...(edits.ball ?? []).map((b) => b.frame), ...extraBall];
  const halfStep = (every * part.fps) / 2;
  const out = (edits.ballReview?.seen ?? []).filter((f) => !marks.some((m) => Math.abs(m - f) <= halfStep));
  const ball = ballCoverage({ marks, out, from: part.start_frame, to: part.end_frame, fps: part.fps, stride: part.stride ?? 3, outHalf: halfStep, links: edits.ballLinks }).share;
  return { quick, players, ball, complete: players >= PLAYERS_DONE && ball >= BALL_DONE_SHARE };
}

// What is left over once a part is complete: everybody without a name of our team (our players all have one), the
// rival pieces shorter than a second, and every referee and everybody without a team. People with a name stay.
export function leftovers(ppl: Person[], fps: number, stride: number): number[] {
  const seconds = (p: Person) => (p.frames.length * stride) / fps;
  return ppl
    .filter((p) => !p.player_id)
    .filter((p) => p.team === "own" || p.team === "ref" || p.team === "unk" || (p.team === "opp" && seconds(p) < 1))
    .map((p) => p.id);
}
// How many people have a name in the table: the quick review has been applied when there are enough.
export const namedCount = (ppl: Person[]) => ppl.filter((p) => p.player_id).length;

// The model added to the table as it is now, instead of rebuilding it: the boxes the review gives to a player become
// hers. People already checked (ticked) in the table are left exactly as they are: no box taken from them, none added. Each stretch
// of a raw track that changes hands is cut out of whoever had it (the rest of that person stays) and joined to the
// player. Returns the edits, and how many stretches moved and how many were kept for a checked person.
export function applyQuickOnto(
  file: TracksFile,
  current: TrackEdits,
  base: TrackEdits,
  model: QuickModel,
  checked: Set<number>,
): { edits: TrackEdits; moved: number; kept: number } {
  const { obs } = indexOf(file, base);
  let edits = current;
  let moved = 0;
  let kept = 0;
  // Who already carries each name in the table.
  const idOfName = new Map<string, number>();
  for (const [id, m] of Object.entries(current.people)) if (m.player_id) idOfName.set(m.player_id, Number(id));
  // The frames of each track, to find where a stretch of it ends.
  const trackFrames = new Map<number, number[]>();
  for (const fr of file.frames) for (const b of fr.boxes) trackFrames.set(b[0], [...(trackFrames.get(b[0]) ?? []), fr.frame]);
  const boxAt = (track: number, frame: number) => file.frames.find((f) => f.frame === frame)?.boxes.find((b) => b[0] === track);
  for (const sg of model.segments) {
    if (!sg.name) continue;
    const name = sg.name;
    const boxes = (obs.get(sg.id) ?? []).filter((o) => o.frame >= sg.from && o.frame <= sg.to);
    // Stretches of one track with one owner in the table now.
    const byTrack = new Map<number, Obs[]>();
    for (const o of boxes) byTrack.set(o.box[0], [...(byTrack.get(o.box[0]) ?? []), o]);
    for (const [track, list] of byTrack) {
      const runs: { owner: number; from: number; to: number }[] = [];
      for (const o of list.sort((a, b) => a.frame - b.frame)) {
        const owner = identityOf(o.box, o.frame, edits);
        const last = runs[runs.length - 1];
        if (last && last.owner === owner) last.to = o.frame;
        else runs.push({ owner, from: o.frame, to: o.frame });
      }
      for (const r of runs) {
        const target = idOfName.get(name);
        if (r.owner === target) continue;
        // A checked player is left exactly as she is: nothing taken from her, nothing added to her.
        if (checked.has(r.owner) || (target !== undefined && checked.has(target))) {
          kept += 1;
          continue;
        }
        // Cut the stretch out: from its first frame the track is a new identity, after its last it goes back to what
        // it was there.
        const frames = trackFrames.get(track) ?? [];
        const after = frames.find((f) => f > r.to);
        const back = after !== undefined ? boxAt(track, after) : undefined;
        const backId = back && after !== undefined ? identityOf(back, after, edits) : null;
        const fresh = freshIdentity(edits, file);
        const splits = [...edits.splits, { track, frame: r.from, identity: fresh }];
        if (after !== undefined && backId !== null) splits.push({ track, frame: after, identity: backId });
        edits = { ...edits, splits };
        if (target === undefined) {
          edits = setPerson(edits, fresh, { player_id: name, ...(sg.team ? { team: sg.team } : {}) });
          idOfName.set(name, fresh);
        } else edits = merge(edits, target, fresh);
        moved += 1;
      }
    }
  }
  return { edits, moved, kept };
}
