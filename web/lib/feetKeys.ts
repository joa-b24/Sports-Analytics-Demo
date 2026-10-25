import { droppedSet, identityOf, isDropped, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

// Feet marked on key frames (mode P of the correction table). The analyst clicks the feet on 2 or more frames of a
// stretch; in between, the offset from the bottom centre of the box to the click (Δ, pixels) is interpolated in time
// and added to the box of every frame, so the feet follow the box sideways and only its lower edge is corrected.
// Before the first key and after the last, the nearest Δ is held for at most HOLD_S seconds (fading out in the last
// RAMP_S). The result is stored as ordinary hand marks per frame (TrackEdits.manual, pixels): exports, animations and
// speeds take them to meters with the H of each frame, exactly like a mark clicked on that frame.
// Every mark of one stretch carries `fit` (its id); `key: true` the frames the analyst clicked, `key: false` the
// interpolated ones. Older marks have neither and are left alone. Pure functions: no storage, no React.

export const HOLD_S = 0.5;
export const RAMP_S = 0.2;

type Manual = TrackEdits["manual"][number];
export interface FeetKey {
  frame: number;
  px: number;
  py: number;
}

// Bottom centre of the person's box in a processed frame (the first one if she has two). Null without a box.
export function boxBottom(file: TracksFile, edits: TrackEdits, identity: number, frame: number): [number, number] | null {
  const fr = file.frames.find((f) => f.frame === frame);
  if (!fr) return null;
  const drop = droppedSet(edits);
  for (const b of fr.boxes) {
    if (isDropped(drop, b, frame) || identityOf(b, frame, edits) !== identity) continue;
    return [(b[1] + b[3]) / 2, b[4]];
  }
  return null;
}

export const fitKeys = (edits: TrackEdits, identity: number, fit: number): FeetKey[] =>
  edits.manual
    .filter((m) => m.identity === identity && m.fit === fit && m.key)
    .map((m) => ({ frame: m.frame, px: m.px, py: m.py }))
    .sort((a, b) => a.frame - b.frame);

export const fitMarks = (edits: TrackEdits, identity: number, fit: number): Manual[] =>
  edits.manual.filter((m) => m.identity === identity && m.fit === fit).sort((a, b) => a.frame - b.frame);

// A new stretch id, unique within the part.
export const newFitId = (edits: TrackEdits): number => edits.manual.reduce((m, x) => Math.max(m, x.fit ?? 0), 0) + 1;

// The stretch that covers this frame of the person, if any.
export function fitAt(edits: TrackEdits, identity: number, frame: number): number | null {
  const hit = edits.manual.find((m) => m.identity === identity && m.frame === frame && m.fit !== undefined);
  return hit?.fit ?? null;
}

// Δ for every processed frame of the stretch: interpolated between keys, held (and faded) outside them.
// Keys without a box in their frame have no Δ and do not count.
export function feetOffsets(file: TracksFile, edits: TrackEdits, identity: number, keys: FeetKey[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const known = keys
    .map((k) => {
      const b = boxBottom(file, edits, identity, k.frame);
      return b ? { frame: k.frame, d: [k.px - b[0], k.py - b[1]] as [number, number] } : null;
    })
    .filter((k): k is { frame: number; d: [number, number] } => k !== null)
    .sort((a, b) => a.frame - b.frame);
  if (known.length === 0) return out;
  const hold = HOLD_S * file.fps;
  const ramp = RAMP_S * file.fps;
  const first = known[0];
  const last = known[known.length - 1];
  const fade = (dist: number) => (dist <= hold - ramp ? 1 : Math.max(0, (hold - dist) / ramp));
  for (const fr of file.frames) {
    const f = fr.frame;
    if (f < first.frame - hold || f > last.frame + hold) continue;
    let d: [number, number];
    if (f <= first.frame) {
      const w = fade(first.frame - f);
      d = [first.d[0] * w, first.d[1] * w];
    } else if (f >= last.frame) {
      const w = fade(f - last.frame);
      d = [last.d[0] * w, last.d[1] * w];
    } else {
      let i = 0;
      while (known[i + 1].frame < f) i++;
      const a = known[i];
      const b = known[i + 1];
      const t = (f - a.frame) / (b.frame - a.frame);
      d = [a.d[0] + (b.d[0] - a.d[0]) * t, a.d[1] + (b.d[1] - a.d[1]) * t];
    }
    out.set(f, d);
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

// Rebuilds a stretch from its keys: every mark of the stretch goes and the keys plus the interpolated frames come
// back. Frames where the person already has a hand mark of her own (clicked one by one, or of another stretch) keep it.
export function applyFit(file: TracksFile, edits: TrackEdits, identity: number, fit: number, keys: FeetKey[]): TrackEdits {
  const rest = edits.manual.filter((m) => !(m.identity === identity && m.fit === fit));
  const keyFrames = new Set(keys.map((k) => k.frame));
  // A key replaces whatever hand mark was on its frame.
  const kept = rest.filter((m) => !(m.identity === identity && keyFrames.has(m.frame)));
  const taken = new Set(kept.filter((m) => m.identity === identity).map((m) => m.frame));
  const added: Manual[] = keys.map((k) => ({ identity, frame: k.frame, px: r1(k.px), py: r1(k.py), key: true, fit }));
  const base = { ...edits, manual: kept };
  for (const [f, d] of feetOffsets(file, base, identity, keys)) {
    if (keyFrames.has(f) || taken.has(f)) continue;
    const b = boxBottom(file, base, identity, f);
    if (!b) continue;
    added.push({ identity, frame: f, px: r1(b[0] + d[0]), py: r1(b[1] + d[1]), key: false, fit });
  }
  return { ...edits, manual: [...kept, ...added] };
}

// Adds a key (or moves the one on that frame) and rebuilds the stretch.
export const setKey = (file: TracksFile, edits: TrackEdits, identity: number, fit: number, key: FeetKey): TrackEdits =>
  applyFit(file, edits, identity, fit, [...fitKeys(edits, identity, fit).filter((k) => k.frame !== key.frame), key]);

export const removeKey = (file: TracksFile, edits: TrackEdits, identity: number, fit: number, frame: number): TrackEdits =>
  applyFit(file, edits, identity, fit, fitKeys(edits, identity, fit).filter((k) => k.frame !== frame));

// The whole stretch goes: keys and interpolated frames.
export const clearFit = (edits: TrackEdits, identity: number, fit: number): TrackEdits => ({
  ...edits,
  manual: edits.manual.filter((m) => !(m.identity === identity && m.fit === fit)),
});

export function fitCount(edits: TrackEdits, identity: number, fit: number): { keys: number; adjusted: number } {
  const all = fitMarks(edits, identity, fit);
  return { keys: all.filter((m) => m.key).length, adjusted: all.length };
}
