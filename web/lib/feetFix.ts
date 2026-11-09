// Feet recalculated by Python (tracks_<part>.feet.json): only the boxes whose feet point changed, in video pixels.
// The table can draw a thin dotted line at that height over the box, so it is visible which boxes were corrected.
export interface FeetFile {
  part: string;
  fps: number;
  stride: number;
  // frame -> track id -> [x_px, y_px] of the corrected feet.
  boxes: Record<string, Record<string, [number, number]>>;
}

export const feetPath = (folder: string, part: string) => `matches/${folder}/tracking/tracks_${part}.feet.json`;

// null for anything that is not that file (a missing or broken file simply draws nothing).
export function parseFeet(text: string | null): FeetFile | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || !d.boxes || typeof d.boxes !== "object") return null;
    return { part: String(d.part ?? ""), fps: Number(d.fps) || 0, stride: Number(d.stride) || 1, boxes: d.boxes };
  } catch {
    return null;
  }
}

// The dotted line of a box: at the corrected feet height, across the width of the box. Null when that box was not
// recalculated (or the point is not a number).
export function feetLine(feet: FeetFile | null, frame: number, track: number, box: readonly [number, number, number, number]): { x1: number; x2: number; y: number } | null {
  const p = feet?.boxes[String(frame)]?.[String(track)];
  if (!p || !Number.isFinite(p[1])) return null;
  return { x1: box[0], x2: box[2], y: p[1] };
}
