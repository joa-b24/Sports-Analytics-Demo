import type { BallAuto } from "./parts.ts";
import type { TrackEdits } from "./types.ts";

// Edits of the ball on the correction desk, as pure functions on TrackEdits (so Ctrl + Z undoes them like the rest):
// the tracker's detections taken out one by one or by stretch, accepted as hand marks, the detections that do not lie on
// a line drawn by hand, the flag «en el aire» on a range of marks, and the two frames that bound an impossible jump.

// The tracker's detections that still count: not rejected by hand and not replaced by a hand mark.
export function liveAuto(auto: BallAuto | null, edits: Pick<TrackEdits, "ball" | "ballRejected">): BallAuto["frames"] {
  if (!auto) return [];
  const rejected = new Set(edits.ballRejected ?? []);
  const hand = new Set((edits.ball ?? []).map((b) => b.frame));
  return auto.frames.filter((a) => !rejected.has(a.frame) && !hand.has(a.frame)).sort((a, b) => a.frame - b.frame);
}

export interface Tracklet {
  from: number;
  to: number;
  frames: number[];
}

// Detections chained into «tracklets»: consecutive ones less than `maxGapS` apart in time and `maxStepPx` apart per
// processed step in the image. A detection that does not follow the previous one opens its own tracklet (a shoe, a
// painted number, a head show up as short isolated ones).
export function autoTracklets(auto: BallAuto | null, edits: Pick<TrackEdits, "ball" | "ballRejected">, fps: number, stride: number, maxGapS = 1, maxStepPx = 45): Tracklet[] {
  const live = liveAuto(auto, edits);
  const out: Tracklet[] = [];
  let prev: BallAuto["frames"][number] | null = null;
  for (const a of live) {
    const last = out[out.length - 1];
    const steps = prev ? Math.max(1, Math.round((a.frame - prev.frame) / stride)) : 1;
    const near = prev && (a.frame - prev.frame) / fps <= maxGapS && Math.hypot(a.px - prev.px, a.py - prev.py) <= maxStepPx * steps;
    if (last && near) {
      last.to = a.frame;
      last.frames.push(a.frame);
    } else out.push({ from: a.frame, to: a.frame, frames: [a.frame] });
    prev = a;
  }
  return out;
}

// Live detections between two frames (inclusive).
export const autoFramesIn = (auto: BallAuto | null, edits: Pick<TrackEdits, "ball" | "ballRejected">, from: number, to: number): number[] =>
  liveAuto(auto, edits).filter((a) => a.frame >= from && a.frame <= to).map((a) => a.frame);

// Takes detections out (they are not the ball). They stay in the file; the desk ignores them.
export function rejectAuto(edits: TrackEdits, frames: number[]): TrackEdits {
  if (frames.length === 0) return edits;
  return { ...edits, ballRejected: [...new Set([...(edits.ballRejected ?? []), ...frames])].sort((a, b) => a - b) };
}

// Detections accepted as hand marks (the analyst checked them): they count as hers from then on.
export function acceptAuto(edits: TrackEdits, auto: BallAuto | null, frames: number[]): TrackEdits {
  if (!auto || frames.length === 0) return edits;
  const want = new Set(frames);
  const have = new Set((edits.ball ?? []).map((b) => b.frame));
  const add = auto.frames.filter((a) => want.has(a.frame) && !have.has(a.frame)).map((a) => ({ frame: a.frame, px: Math.round(a.px * 10) / 10, py: Math.round(a.py * 10) / 10 }));
  if (add.length === 0) return edits;
  return { ...edits, ball: [...(edits.ball ?? []), ...add].sort((a, b) => a.frame - b.frame) };
}

// Hand marks between two frames (inclusive) taken out, with the lines that touched them.
export function removeMarksIn(edits: TrackEdits, from: number, to: number): TrackEdits {
  const gone = new Set((edits.ball ?? []).filter((b) => b.frame >= from && b.frame <= to).map((b) => b.frame));
  if (gone.size === 0) return edits;
  const links = (edits.ballLinks ?? []).filter((l) => !gone.has(l.from) && !gone.has(l.to));
  return { ...edits, ball: (edits.ball ?? []).filter((b) => !gone.has(b.frame)), ...(edits.ballLinks ? { ballLinks: links } : {}) };
}

// Flag (or unflag) «en el aire» on the hand marks of a range.
export function setAirIn(edits: TrackEdits, from: number, to: number, air: boolean): TrackEdits {
  let changed = false;
  const ball = (edits.ball ?? []).map((b) => {
    if (b.frame < from || b.frame > to || !!b.air === air) return b;
    changed = true;
    const { air: _a, ...rest } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
    return air ? { ...rest, air: true } : rest;
  });
  return changed ? { ...edits, ball } : edits;
}

// When two marks are joined by hand (a straight line), the tracker's detections between them that are not on that line
// (more than `tolPx` from where the straight line puts the ball in the image) are not the ball: they are rejected.
// Returns the edits and how many were rejected.
export function rejectOffLine(edits: TrackEdits, auto: BallAuto | null, from: number, to: number, tolPx = 70): { edits: TrackEdits; n: number } {
  const a = (edits.ball ?? []).find((b) => b.frame === from);
  const b = (edits.ball ?? []).find((m) => m.frame === to);
  if (!auto || !a || !b || to <= from) return { edits, n: 0 };
  const bad = liveAuto(auto, edits)
    .filter((d) => d.frame > from && d.frame < to)
    .filter((d) => {
      const k = (d.frame - from) / (to - from);
      return Math.hypot(d.px - (a.px + (b.px - a.px) * k), d.py - (a.py + (b.py - a.py) * k)) > tolPx;
    })
    .map((d) => d.frame);
  return { edits: rejectAuto(edits, bad), n: bad.length };
}

// The two frames that bound each impossible jump, in order (the last good position and the one it jumps to): the stops
// of the jump navigation.
export function jumpStops(jumps: { before?: number; frame: number }[]): number[] {
  const s = new Set<number>();
  for (const j of jumps) {
    if (j.before !== undefined) s.add(j.before);
    s.add(j.frame);
  }
  return [...s].sort((a, b) => a - b);
}

// Next (dir 1) or previous (dir -1) stop from `frame`, strictly after / before it. Null at the ends.
export function stepJump(stops: number[], frame: number, dir: 1 | -1): number | null {
  if (dir === 1) return stops.find((s) => s > frame) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < frame) return stops[i];
  return null;
}
