// The double boxes of a player in the correction table (two boxes of her in one frame, the yellow warning): which are
// left to look at, skipping one, and «Ninguna es ella». Pure functions: no storage, no React.
import { runAround } from "./anchors.ts";
import { dropBoxes, identityOf, type DetBox, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

export const twiceKey = (person: number, frame: number) => `${person}:${frame}`;

// Her frames with two boxes not skipped yet.
export function pendingTwice(conflicts: number[], person: number, edits: TrackEdits): number[] {
  const seen = new Set(edits.twiceSeen ?? []);
  return conflicts.filter((f) => !seen.has(twiceKey(person, f)));
}

// The next one after `frame` (or the first, going round); null when none is left.
export function nextTwice(pending: number[], frame: number): number | null {
  if (!pending.length) return null;
  return pending.find((f) => f > frame) ?? pending[0];
}

// «Siguiente / saltar»: remembered for this part, nothing edited.
export function skipTwice(edits: TrackEdits, person: number, frame: number): TrackEdits {
  return { ...edits, twiceSeen: [...new Set([...(edits.twiceSeen ?? []), twiceKey(person, frame)])] };
}

// «Ninguna es ella»: every box of hers in that frame is left out with its run ±half frames (the S of the doubts).
export function noneIsHer(edits: TrackEdits, file: TracksFile, person: number, frame: number, half: number): { edits: TrackEdits; boxes: number } {
  const fr = file.frames.find((f) => f.frame === frame);
  const tracks = (fr?.boxes ?? []).filter((b: DetBox) => identityOf(b, frame, edits) === person).map((b) => b[0]);
  const drops = tracks.flatMap((t) => runAround(file, t, frame, file.stride * 2, half).map((f) => ({ track: t, frame: f })));
  const next = dropBoxes(edits, drops);
  return { edits: next, boxes: (next.dropped ?? []).length - (edits.dropped ?? []).length };
}
