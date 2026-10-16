import { boxTeamOf, dropBoxes, droppedSet, fileTeamRefs, identityOf, isDropped, merge, splitPerson, type Person, type TeamCode, type TracksFile } from "./tracks.ts";
import { PITCH, type TrackEdits } from "./types.ts";

// The work of the correction table, made a queue: joins it proposes ("this piece goes on as that player") to accept
// or reject with one key, and what can be done with a stretch of one person's line. Pure functions.

// A piece can continue another if it starts at most this long (s) after the other ends, no farther than she could run
// (SLACK_M plus RUN_MS per second), and neither has a shirt of the other team.
export const MAX_GAP_S = 3;
export const RUN_MS = 8;
export const SLACK_M = 2;
// Velocity at the end of a person: over her last second.
const VELOCITY_S = 1;

export interface Suggestion {
  // `to` would become part of `from` (from ends, to starts later).
  from: number;
  to: number;
  cost: number;
  frameFrom: number;
  frameTo: number;
  gapS: number;
  distM: number;
}

interface End {
  frame: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Worked out once per state of the edits (the table asks for it on every selection).
const endsCache = new WeakMap<TrackEdits, { file: TracksFile; value: Map<number, { first: End; last: End }> }>();
function endsOf(file: TracksFile, edits: TrackEdits) {
  const hit = endsCache.get(edits);
  if (hit && hit.file === file) return hit.value;
  const value = ends(file, edits);
  endsCache.set(edits, { file, value });
  return value;
}

// First and last positions (m) of each person on the pitch, and her velocity when she ends.
function ends(file: TracksFile, edits: TrackEdits): Map<number, { first: End; last: End }> {
  const sx = (file.venue?.length_m ?? PITCH.length) / PITCH.length;
  const sy = (file.venue?.width_m ?? PITCH.width) / PITCH.width;
  const drop = droppedSet(edits);
  const pts = new Map<number, { frame: number; x: number; y: number }[]>();
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame) || !b[11] || b[9] === null || b[10] === null) continue;
      const id = identityOf(b, fr.frame, edits);
      const list = pts.get(id) ?? [];
      if (list[list.length - 1]?.frame !== fr.frame) list.push({ frame: fr.frame, x: b[9] * sx, y: b[10] * sy });
      pts.set(id, list);
    }
  }
  const out = new Map<number, { first: End; last: End }>();
  for (const [id, list] of pts) {
    const last = list[list.length - 1];
    const recent = list.filter((p) => (last.frame - p.frame) / file.fps <= VELOCITY_S);
    const dt = (last.frame - recent[0].frame) / file.fps;
    const v = recent.length >= 3 && dt >= 0.2 ? { vx: (last.x - recent[0].x) / dt, vy: (last.y - recent[0].y) / dt } : { vx: 0, vy: 0 };
    const speed = Math.hypot(v.vx, v.vy);
    if (speed > RUN_MS) [v.vx, v.vy] = [(v.vx * RUN_MS) / speed, (v.vy * RUN_MS) / speed];
    out.set(id, { first: { ...list[0], vx: 0, vy: 0 }, last: { ...last, ...v } });
  }
  return out;
}

// Every credible join (one piece continuing another), most likely first. Rejected pairs and different teams are left out.
export function allPairs(file: TracksFile, edits: TrackEdits, ppl: Person[], skip: Set<number> = new Set(), only?: number): Suggestion[] {
  const e = endsOf(file, edits);
  const rejected = new Set((edits.rejected ?? []).map(([a, b]) => `${a}:${b}`));
  const team = new Map(ppl.map((p) => [p.id, p.team]));
  const live = ppl.filter((p) => !skip.has(p.id) && e.has(p.id));
  const out: Suggestion[] = [];
  for (const a of live) {
    const A = e.get(a.id)!;
    for (const b of live) {
      if (a.id === b.id || (only !== undefined && a.id !== only && b.id !== only)) continue;
      const B = e.get(b.id)!;
      const gap = (B.first.frame - A.last.frame) / file.fps;
      if (gap <= 0 || gap > MAX_GAP_S || b.first <= a.last) continue;
      const ta = team.get(a.id) as TeamCode;
      const tb = team.get(b.id) as TeamCode;
      if (ta !== "unk" && tb !== "unk" && ta !== tb) continue;
      if (rejected.has(`${a.id}:${b.id}`) || rejected.has(`${b.id}:${a.id}`)) continue;
      const dist = Math.hypot(B.first.x - A.last.x, B.first.y - A.last.y);
      if (dist > SLACK_M + RUN_MS * gap) continue;
      const miss = Math.hypot(B.first.x - (A.last.x + A.last.vx * gap), B.first.y - (A.last.y + A.last.vy * gap));
      out.push({ from: a.id, to: b.id, cost: Math.round((miss + 0.5 * gap) * 100) / 100, frameFrom: A.last.frame, frameTo: B.first.frame,
        gapS: Math.round(gap * 100) / 100, distM: Math.round(dist * 100) / 100 });
    }
  }
  return out.sort((x, y) => x.cost - y.cost || x.from - y.from || x.to - y.to);
}

// Pending joins, most likely first. One per person that ends and one per person that starts (the best of each).
export function pendingSuggestions(file: TracksFile, edits: TrackEdits, ppl: Person[], skip: Set<number> = new Set()): Suggestion[] {
  const out = allPairs(file, edits, ppl, skip);
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  return out.filter((s) => {
    if (usedFrom.has(s.from) || usedTo.has(s.to)) return false;
    usedFrom.add(s.from);
    usedTo.add(s.to);
    return true;
  });
}

export function rejectSuggestion(edits: TrackEdits, s: Pick<Suggestion, "from" | "to">): TrackEdits {
  return { ...edits, rejected: [...(edits.rejected ?? []), [s.from, s.to]] };
}

// ---------------------------------------------------------------- a stretch of one person's line

// Her boxes between two frames (both included).
export function boxesInRange(file: TracksFile, edits: TrackEdits, person: number, from: number, to: number): { track: number; frame: number }[] {
  const drop = droppedSet(edits);
  const out: { track: number; frame: number }[] = [];
  for (const fr of file.frames) {
    if (fr.frame < from || fr.frame > to) continue;
    for (const b of fr.boxes) if (!isDropped(drop, b, fr.frame) && identityOf(b, fr.frame, edits) === person) out.push({ track: b[0], frame: fr.frame });
  }
  return out;
}

// Leave out her boxes of the stretch (wrong boxes: a box around two players, a few frames of somebody else).
export function dropRange(edits: TrackEdits, file: TracksFile, person: number, from: number, to: number): TrackEdits {
  return dropBoxes(edits, boxesInRange(file, edits, person, from, to));
}

// The stretch becomes a person of its own; she goes on as herself before and after it.
export function separateRange(edits: TrackEdits, file: TracksFile, person: number, from: number, to: number): { edits: TrackEdits; identity: number | null } {
  const first = splitPerson(edits, person, from, file);
  if (!first) {
    // Nothing before the stretch: split at its end and swap, so `person` keeps what comes after.
    const after = splitPerson(edits, person, to + 1, file);
    return after ? { edits: after.edits, identity: person } : { edits, identity: null };
  }
  const after = splitPerson(first.edits, first.identity, to + 1, file);
  return after ? { edits: merge(after.edits, person, after.identity), identity: first.identity } : first;
}

// Team of each of her boxes (against the colours measured in the file), for her timeline.
export function personTimeline(file: TracksFile, edits: TrackEdits, person: number): { frame: number; team: TeamCode; onPitch: boolean }[] {
  const refs = fileTeamRefs(file);
  const drop = droppedSet(edits);
  const out: { frame: number; team: TeamCode; onPitch: boolean }[] = [];
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame) || identityOf(b, fr.frame, edits) !== person) continue;
      out.push({ frame: fr.frame, team: boxTeamOf(b, refs), onPitch: b[11] });
      break;
    }
  }
  return out;
}

// For one person: who she could go on as (`next`, she is `from`) and who she could come from (`prev`, she is `to`),
// the `k` most likely of each. Nothing is applied: the person in the table chooses.
export function candidatesFor(file: TracksFile, edits: TrackEdits, ppl: Person[], id: number, k = 3): { next: Suggestion[]; prev: Suggestion[] } {
  const pairs = allPairs(file, edits, ppl, new Set(), id);
  return { next: pairs.filter((s) => s.from === id).slice(0, k), prev: pairs.filter((s) => s.to === id).slice(0, k) };
}

