// «Empezar de cero esta parte» of the anchors mode: what the browser forgets of a part. Pure functions.
import type { PartReview, TrackEdits } from "./types.ts";

const clone = (e: TrackEdits): TrackEdits => JSON.parse(JSON.stringify(e)) as TrackEdits;


// What the browser forgets of a part: the resolved doubts (the rest of the table stays). A comparison A/B saved by the
// old comparison tab (State.reviews) is tolerated: then the edits go back to its snapshot and it is removed, the stopwatch of that part and the
// skipped anchors (preference keys returned for the caller to clear).
export function resetPart<T extends { trackEdits: TrackEdits[]; reviews?: PartReview[] }>(
  state: T,
  key: string,
  part: string,
  folder: string,
  timing: { part?: string }[],
): { state: T; timing: { part?: string }[]; prefKeys: string[]; summary: { review: boolean; doubts: number; timing: number } } {
  const review = (state.reviews ?? []).find((r) => r.key === key);
  const cur = state.trackEdits.find((e) => e.key === key);
  const doubts = new Set([...(cur?.anchorDoubts ?? []), ...(review?.A.edits?.anchorDoubts ?? []), ...(review?.B.edits?.anchorDoubts ?? [])]).size;
  let next: TrackEdits | undefined;
  if (review) next = clone(review.base);
  else if (cur) {
    next = { ...cur };
    delete next.anchorDoubts;
  }
  const trackEdits = next ? [...state.trackEdits.filter((e) => e.key !== key), next] : state.trackEdits;
  const kept = timing.filter((t) => t.part !== part);
  return {
    state: { ...state, trackEdits, reviews: (state.reviews ?? []).filter((r) => r.key !== key) },
    timing: kept,
    prefKeys: [`anchors:skipped:${folder}:${part}`, `anchors:skipped:${folder}:${part}:ejemplo`],
    summary: { review: !!review, doubts, timing: timing.length - kept.length },
  };
}
