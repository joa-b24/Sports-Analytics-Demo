import { anomalyKey, playerAnomalies, type Anomaly } from "./anomalies.ts";
import { series } from "./cuts.ts";
import { canBridge } from "./smooth.ts";
import { dropRange } from "./suggestions.ts";
import { dropBoxes, droppedSet, identityOf, isDropped, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

// «Quitar saltos» of the correction table (Q / Alt + Q and «quitar hasta aquí»): take out the box after the jump, or the
// one before it, and keep the change only if it settles the warning without leaving a hole the export cannot fill.
// Measured on 277 warnings of three parts (matches/.../tracking/revision/relleno_base.md): the box after the jump is
// the wrong one 90 % of the times it settles anything (15 % of the warnings), the one before 67 % (13 %). Pure functions.

export type JumpSide = "next" | "prev";
export type JumpStatus = "ok" | "persists" | "hole" | "none";
export interface JumpFix {
  status: JumpStatus;
  side: JumpSide;
  // The edits with the box taken out (equal to the input when the status is not "ok").
  edits: TrackEdits;
  removed: number;
  // First and last frame taken out.
  frames: [number, number];
  // The jump is between boxes of two raw tracks: taking the previous one out asks for a click first.
  needsConfirm: boolean;
  // Raw tracks of the box before and the box after the jump.
  tracks: [number | null, number | null];
}

// The warnings of jumps (players) still to look at.
export function jumpCount(file: TracksFile, edits: TrackEdits): number {
  const ok = new Set(edits.anomalyOk ?? []);
  return playerAnomalies(file, edits).filter((a) => a.kind === "player" && !ok.has(anomalyKey(a))).length;
}

// Raw track of the live box of `person` in a frame, or null.
export function trackAt(file: TracksFile, edits: TrackEdits, person: number, frame: number): number | null {
  const drop = droppedSet(edits);
  const fr = file.frames.find((f) => f.frame === frame);
  const b = fr?.boxes.find((x) => !isDropped(drop, x, frame) && identityOf(x, frame, edits) === person);
  return b ? b[0] : null;
}

export function tryJumpFix(file: TracksFile, edits: TrackEdits, a: Anomaly, side: JumpSide): JumpFix {
  const none = (): JumpFix => ({ status: "none", side, edits, removed: 0, frames: [a.frame, a.frame], needsConfirm: false, tracks: [null, null] });
  if (a.kind !== "player" || a.person === undefined) return none();
  const person = a.person;
  const stride = file.stride;
  const tracks: [number | null, number | null] = [a.before !== undefined ? trackAt(file, edits, person, a.before) : null, trackAt(file, edits, person, a.frame)];
  let from: number;
  let to: number;
  if (side === "next") {
    from = a.frame;
    to = (a.until ?? a.frame + stride) - 1;
  } else {
    if (a.before === undefined) return none();
    from = to = a.before;
  }
  const handMarks = edits.manual.filter((m) => m.identity === person && m.frame >= from && m.frame <= to).length;
  let next = dropRange(edits, file, person, from, to);
  const boxes = (next.dropped ?? []).length - (edits.dropped ?? []).length;
  if (handMarks) next = { ...next, manual: next.manual.filter((m) => !(m.identity === person && m.frame >= from && m.frame <= to)) };
  const removed = boxes + handMarks;
  if (removed === 0) return { ...none(), tracks };
  const fail = (status: JumpStatus): JumpFix => ({ status, side, edits, removed: 0, frames: [from, to], needsConfirm: false, tracks });
  // The warning must be gone: no jump left from the same departure point or landing at the same frame.
  const again = playerAnomalies(file, next).some((x) => x.kind === "player" && x.person === person && ((a.before !== undefined && x.before === a.before) || x.frame === a.frame));
  if (again) return fail("persists");
  // No new hole: the two boxes that become neighbours must be walkable within what the export fills.
  const obs = series(file, next).get(person) ?? [];
  const p = [...obs].reverse().find((o) => o.frame < from);
  const n = obs.find((o) => o.frame > to);
  if (p && n && !canBridge(Math.hypot(n.x - p.x, n.y - p.y), (n.frame - p.frame) / file.fps)) return fail("hole");
  return { status: "ok", side, edits: next, removed, frames: [from, to], needsConfirm: side === "prev" && tracks[0] !== null && tracks[1] !== null && tracks[0] !== tracks[1], tracks };
}

// Q: the box after the jump; if the warning stays, the one before (which asks for a click when the jump is between two
// tracks). `fix` is null when neither settles it.
export function quitJump(file: TracksFile, edits: TrackEdits, a: Anomaly): { fix: JumpFix | null; next: JumpStatus; prev: JumpStatus } {
  const n = tryJumpFix(file, edits, a, "next");
  if (n.status === "ok") return { fix: n, next: "ok", prev: "none" };
  const p = tryJumpFix(file, edits, a, "prev");
  return { fix: p.status === "ok" ? p : null, next: n.status, prev: p.status };
}

export const TRIM_GAP_S = 2;

// «Quitar hasta aquí»: for the jumps one box does not settle. `before`: her run on the track of the box before the jump
// (from where it started to that box); `after`: her run on the track of the box after it (from there to where it ends).
// A run goes on across holes of at most TRIM_GAP_S. Returns null when she has nothing there.
export function trimAtJump(file: TracksFile, edits: TrackEdits, a: Anomaly, dir: "before" | "after"): { edits: TrackEdits; removed: number; track: number; from: number; to: number } | null {
  if (a.kind !== "player" || a.person === undefined) return null;
  const at = dir === "before" ? a.before : a.frame;
  if (at === undefined) return null;
  const track = trackAt(file, edits, a.person, at);
  if (track === null) return null;
  const drop = droppedSet(edits);
  const frames: number[] = [];
  for (const fr of file.frames) {
    const b = fr.boxes.find((x) => x[0] === track);
    if (b && !isDropped(drop, b, fr.frame) && identityOf(b, fr.frame, edits) === a.person) frames.push(fr.frame);
  }
  const i = frames.indexOf(at);
  if (i < 0) return null;
  const gap = TRIM_GAP_S * file.fps;
  let lo = i;
  let hi = i;
  if (dir === "before") while (lo > 0 && frames[lo] - frames[lo - 1] <= gap) lo--;
  else while (hi < frames.length - 1 && frames[hi + 1] - frames[hi] <= gap) hi++;
  const run = dir === "before" ? frames.slice(lo, i + 1) : frames.slice(i, hi + 1);
  return { edits: dropBoxes(edits, run.map((frame) => ({ track, frame }))), removed: run.length, track, from: run[0], to: run[run.length - 1] };
}
