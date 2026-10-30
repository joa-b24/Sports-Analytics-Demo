import type { CameraCut } from "./types.ts";

// Cuts of the broadcast and frozen pictures. A cut is a limit of the part, not movement: the people "jump" across it, and
// nothing is joined, filled, smoothed or measured across it. Pure functions, no storage, no React.

// Whether the step from frame `a` to frame `b` (a < b) goes across a cut.
export function crossesCut(cuts: readonly CameraCut[] | undefined, a: number, b: number): boolean {
  if (!cuts || cuts.length === 0) return false;
  return cuts.some((c) => a < c.from && b > c.to);
}

// Whether a frame is inside a frozen stretch (its positions are repeats of the last real picture).
export function inFrozen(cuts: readonly CameraCut[] | undefined, frame: number): boolean {
  return !!cuts && cuts.some((c) => c.kind === "freeze" && frame >= c.from && frame <= c.to);
}

// Adds a cut (replacing any that overlaps it), in order.
export function addCut(cuts: readonly CameraCut[] | undefined, cut: CameraCut): CameraCut[] {
  const rest = (cuts ?? []).filter((c) => c.to < cut.from - 1 || c.from > cut.to + 1);
  return [...rest, cut].sort((a, b) => a.from - b.from);
}

export function removeCut(cuts: readonly CameraCut[] | undefined, from: number): CameraCut[] {
  return (cuts ?? []).filter((c) => c.from !== from);
}

// The nearest cut at or before `frame` + `slack`, or after: for showing "this is a marked cut" near the cursor.
export function cutNear(cuts: readonly CameraCut[] | undefined, frame: number, slack: number): CameraCut | null {
  return (cuts ?? []).find((c) => frame >= c.from - slack && frame <= c.to + slack) ?? null;
}

// Positions of a part as the frames the tracker saw: used to detect a frozen picture from the data alone.
export interface FrozenInput {
  frame: number;
  // Pitch positions of the boxes in that frame, by raw track.
  at: Map<number, [number, number]>;
}

export const FREEZE_MIN_BOXES = 5;
export const FREEZE_SHARE = 0.8;
// Positions this close (normalised pitch units) in two consecutive processed frames are the same picture.
export const FREEZE_EPS = 0.005;

// Frozen stretches: runs of consecutive processed frames where almost every box is exactly where it was. A moving
// picture never repeats that many positions to the thousandth. Returns [from, to] of the frames that repeat the one before.
export function frozenRuns(frames: FrozenInput[]): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  let last = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].at;
    const b = frames[i].at;
    let both = 0;
    let same = 0;
    for (const [track, p] of b) {
      const q = a.get(track);
      if (!q) continue;
      both++;
      if (Math.abs(p[0] - q[0]) <= FREEZE_EPS && Math.abs(p[1] - q[1]) <= FREEZE_EPS) same++;
    }
    const frozen = both >= FREEZE_MIN_BOXES && same >= FREEZE_SHARE * both;
    if (frozen) {
      if (start === null) start = frames[i].frame;
      last = frames[i].frame;
    } else if (start !== null) {
      out.push([start, last]);
      start = null;
    }
  }
  if (start !== null) out.push([start, last]);
  return out;
}
