import type { Pt } from "./homography.ts";

// Placing a venue model (meters, lib/venue.ts) over a top-down image, such as a satellite capture: a similarity (move,
// turn, uniform scale) plus an optional mirror, because a top view has no near or far side and the image may show
// the venue either way up. Pure functions: no storage, no React.

export interface Placement {
  // Image pixel of the model origin (far-left corner of the soccer pitch).
  tx: number;
  ty: number;
  // Turn of the model x axis in the image (radians) and pixels per meter.
  angle: number;
  scale: number;
  // Model y goes the other way in the image.
  flip: boolean;
}

export function toImage(p: Placement, [x, y]: Pt): Pt {
  const yy = p.flip ? -y : y;
  const c = Math.cos(p.angle) * p.scale;
  const s = Math.sin(p.angle) * p.scale;
  return [p.tx + c * x - s * yy, p.ty + s * x + c * yy];
}

export function toModel(p: Placement, [u, v]: Pt): Pt {
  const dx = u - p.tx;
  const dy = v - p.ty;
  const c = Math.cos(p.angle) / p.scale;
  const s = Math.sin(p.angle) / p.scale;
  const x = c * dx + s * dy;
  const yy = -s * dx + c * dy;
  return [x, p.flip ? -yy : yy];
}

// The placement that puts model points a and b on image points ia and ib. Null when the two points coincide.
export function placementFromTwo(a: Pt, b: Pt, ia: Pt, ib: Pt, flip: boolean): Placement | null {
  const ma: Pt = [a[0], flip ? -a[1] : a[1]];
  const mb: Pt = [b[0], flip ? -b[1] : b[1]];
  const dm = Math.hypot(mb[0] - ma[0], mb[1] - ma[1]);
  const di = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]);
  if (dm < 1e-9 || di < 1e-9) return null;
  const angle = Math.atan2(ib[1] - ia[1], ib[0] - ia[0]) - Math.atan2(mb[1] - ma[1], mb[0] - ma[0]);
  const scale = di / dm;
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return { tx: ia[0] - (c * ma[0] - s * ma[1]), ty: ia[1] - (s * ma[0] + c * ma[1]), angle, scale, flip };
}

// Fine adjustments, all around a pivot of the model (the centre of the pitch, say) so that it stays where it is.
// Move: meters along the model axes. Turn: radians. Scale: a factor.
export function nudge(p: Placement, pivot: Pt, change: { dx?: number; dy?: number; turn?: number; zoom?: number }): Placement {
  const at = toImage(p, pivot);
  const angle = p.angle + (change.turn ?? 0);
  const scale = p.scale * (change.zoom ?? 1);
  const turned = { ...p, angle, scale };
  // Keep the pivot on the same pixel, then move it along the model axes.
  const now = toImage(turned, pivot);
  const moved = { ...turned, tx: turned.tx + at[0] - now[0], ty: turned.ty + at[1] - now[1] };
  if (!change.dx && !change.dy) return moved;
  const target = toImage(moved, [pivot[0] + (change.dx ?? 0), pivot[1] + (change.dy ?? 0)]);
  const from = toImage(moved, pivot);
  return { ...moved, tx: moved.tx + target[0] - from[0], ty: moved.ty + target[1] - from[1] };
}
