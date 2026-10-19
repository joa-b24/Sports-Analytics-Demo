import type { Pt } from "./homography.ts";
import type { VenueSpec } from "./types.ts";

// Fitting a venue model over a top-down image (satellite capture, drone photo). The soccer pitch is a rectangle in
// the image that is always a rectangle: it can move, turn and change each side, never shear. Model meters map into it
// with one scale per axis, so the sides can be fitted to the paint and then read back as meters. Pure functions: no
// storage, no React.

export type VenueLayer = NonNullable<VenueSpec["layers"]>[number];

export interface PitchRect {
  // Image pixel of the pitch centre, turn of the length axis (radians) and sides in image pixels.
  cx: number;
  cy: number;
  angle: number;
  lpx: number;
  wpx: number;
  // The near sideline (model y = width) is on the other side of the length axis.
  flip: boolean;
}

// Corners in model order: 0 far-left (0, 0), 1 far-right (L, 0), 2 near-right (L, W), 3 near-left (0, W).
// Edges: 0 far sideline, 1 right goal line, 2 near sideline, 3 left goal line.
export type Handle = "body" | "rot" | `c${0 | 1 | 2 | 3}` | `e${0 | 1 | 2 | 3}`;

const MIN_SIDE = 4;
const CORNER: Pt[] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];
const EDGE: Pt[] = [
  [0, -0.5],
  [0.5, 0],
  [0, 0.5],
  [-0.5, 0],
];

const axes = (r: PitchRect): [Pt, Pt] => {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const f = r.flip ? -1 : 1;
  return [
    [c, s],
    [-s * f, c * f],
  ];
};
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

// Normalised pitch position (-0.5..0.5 on each axis, beyond for points outside the pitch) -> image pixel.
function fromLocal(r: PitchRect, [nu, nv]: Pt): Pt {
  const [ax, ay] = axes(r);
  const u = nu * r.lpx;
  const v = nv * r.wpx;
  return [r.cx + ax[0] * u + ay[0] * v, r.cy + ax[1] * u + ay[1] * v];
}

function toLocal(r: PitchRect, [px, py]: Pt): Pt {
  const [ax, ay] = axes(r);
  const d: Pt = [px - r.cx, py - r.cy];
  return [dot(d, ax) / r.lpx, dot(d, ay) / r.wpx];
}

export const modelToImage = (r: PitchRect, L: number, W: number, [x, y]: Pt): Pt => fromLocal(r, [x / L - 0.5, y / W - 0.5]);

export function imageToModel(r: PitchRect, L: number, W: number, p: Pt): Pt {
  const [nu, nv] = toLocal(r, p);
  return [(nu + 0.5) * L, (nv + 0.5) * W];
}

export const corners = (r: PitchRect): Pt[] => CORNER.map((c) => fromLocal(r, c));
export const edgeMids = (r: PitchRect): Pt[] => EDGE.map((e) => fromLocal(r, e));
// The turn handle sits beyond the middle of the far sideline.
export const rotHandle = (r: PitchRect, gap: number): Pt => {
  const [, ay] = axes(r);
  const m = fromLocal(r, EDGE[0]);
  return [m[0] - ay[0] * gap, m[1] - ay[1] * gap];
};

export function handlePoint(r: PitchRect, h: Handle, gap = 30): Pt {
  if (h === "body") return [r.cx, r.cy];
  if (h === "rot") return rotHandle(r, gap);
  return (h[0] === "c" ? corners(r) : edgeMids(r))[Number(h[1])];
}

// The drawn pitch for a first look: centred, level, as large as fits in 70 % of the image, with the venue proportions.
export function fitRect(imgW: number, imgH: number, L: number, W: number): PitchRect {
  const k = Math.min((imgW * 0.7) / L, (imgH * 0.7) / W);
  return { cx: imgW / 2, cy: imgH / 2, angle: 0, lpx: L * k, wpx: W * k, flip: false };
}

// Pixels per meter of a rectangle drawn for a venue of L x W: the geometric mean of both sides, so that a rectangle
// with the venue proportions gives exactly its scale.
export const rectScale = (r: PitchRect, L: number, W: number) => Math.sqrt((r.lpx * r.wpx) / (L * W));

// Redraw for new measures: same centre and turn, sides from the measures at `pxPerM` pixels per meter.
export const resizeToSpec = (r: PitchRect, L: number, W: number, pxPerM: number): PitchRect => ({
  ...r,
  lpx: Math.max(MIN_SIDE, L * pxPerM),
  wpx: Math.max(MIN_SIDE, W * pxPerM),
});

// Drag a corner: the opposite corner stays, the turn stays, each side follows the pointer along its own axis.
// The corner cannot cross to the other side (that would mirror the model).
export function dragCorner(r: PitchRect, i: number, p: Pt): PitchRect {
  const [ax, ay] = axes(r);
  const o = fromLocal(r, CORNER[(i + 2) % 4]);
  const d: Pt = [p[0] - o[0], p[1] - o[1]];
  const su = Math.sign(CORNER[i][0]);
  const sv = Math.sign(CORNER[i][1]);
  const lpx = Math.max(MIN_SIDE, dot(d, ax) * su);
  const wpx = Math.max(MIN_SIDE, dot(d, ay) * sv);
  const cx = o[0] + (ax[0] * su * lpx + ay[0] * sv * wpx) / 2;
  const cy = o[1] + (ax[1] * su * lpx + ay[1] * sv * wpx) / 2;
  return { ...r, cx, cy, lpx, wpx };
}

// Drag the middle of a side: the opposite side stays, only that dimension changes.
export function dragEdge(r: PitchRect, i: number, p: Pt): PitchRect {
  const [ax, ay] = axes(r);
  const o = fromLocal(r, EDGE[(i + 2) % 4]);
  const alongLength = i % 2 === 1;
  const a = alongLength ? ax : ay;
  const sign = Math.sign(alongLength ? EDGE[i][0] : EDGE[i][1]);
  const size = Math.max(MIN_SIDE, dot([p[0] - o[0], p[1] - o[1]], a) * sign);
  const cx = o[0] + (a[0] * sign * size) / 2;
  const cy = o[1] + (a[1] * sign * size) / 2;
  return alongLength ? { ...r, cx, cy, lpx: size } : { ...r, cx, cy, wpx: size };
}

// Turn around the centre by the angle the pointer swept since `from`.
export function rotateRect(start: PitchRect, from: Pt, p: Pt): PitchRect {
  const a0 = Math.atan2(from[1] - start.cy, from[0] - start.cx);
  const a1 = Math.atan2(p[1] - start.cy, p[0] - start.cx);
  return { ...start, angle: start.angle + a1 - a0 };
}

export const moveRect = (start: PitchRect, from: Pt, p: Pt): PitchRect => ({ ...start, cx: start.cx + p[0] - from[0], cy: start.cy + p[1] - from[1] });

// One step of a handle drag: where the drag started (`start`, `from`) and where the pointer is now.
export function dragHandle(start: PitchRect, h: Handle, from: Pt, p: Pt): PitchRect {
  if (h === "body") return moveRect(start, from, p);
  if (h === "rot") return rotateRect(start, from, p);
  // Corners and edges move by the pointer offset, so grabbing a handle slightly off its centre does not jump.
  const at = handlePoint(start, h);
  const q: Pt = [at[0] + p[0] - from[0], at[1] + p[1] - from[1]];
  return h[0] === "c" ? dragCorner(start, Number(h[1]), q) : dragEdge(start, Number(h[1]), q);
}

// The sides of the fitted rectangle read as meters. With a scale (a scale bar measured on the image) both sides are
// absolute; without one, the length is taken as right and only the width follows from the proportions.
export function impliedMeasures(r: PitchRect, L: number, pxPerM: number | null): { length: number; width: number; absolute: boolean } {
  if (pxPerM && pxPerM > 0) return { length: r.lpx / pxPerM, width: r.wpx / pxPerM, absolute: true };
  return { length: L, width: (L * r.wpx) / r.lpx, absolute: false };
}

// Meters between two image points, read through the fitted rectangle (each axis with its own scale).
export function modelDistance(r: PitchRect, L: number, W: number, a: Pt, b: Pt): number {
  const ma = imageToModel(r, L, W, a);
  const mb = imageToModel(r, L, W, b);
  return Math.hypot(mb[0] - ma[0], mb[1] - ma[1]);
}

export const segLength = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// The shaded bands of a stripes layer, clipped to the pitch, as [x0, y0, x1, y1] in meters. "across": bands
// parallel to the goal lines (they cut the length); "along": parallel to the sidelines. Every other band is shaded,
// starting with the one that begins at `offset_m`.
export function stripeBands(layer: { axis: "across" | "along"; width_m: number; offset_m: number }, L: number, W: number): [number, number, number, number][] {
  const span = layer.axis === "across" ? L : W;
  const w = layer.width_m;
  if (!(w > 0.2) || !(span > 0)) return [];
  const out: [number, number, number, number][] = [];
  // First shaded band that still reaches the pitch.
  let start = layer.offset_m - Math.ceil((layer.offset_m + w) / (2 * w)) * 2 * w;
  for (; start < span; start += 2 * w) {
    const a = Math.max(0, start);
    const b = Math.min(span, start + w);
    if (b - a < 1e-6) continue;
    out.push(layer.axis === "across" ? [a, 0, b, W] : [0, a, L, b]);
  }
  return out;
}

// Groups of reference points to check by eye against the image. `ids` picks the venue landmarks of each group.
export interface ReferenceGroup {
  id: string;
  label: string;
  overlayOnly: boolean;
  ids: (landmarkId: string, group: "football" | "hash" | "soccer") => boolean;
}

export const REFERENCE_GROUPS: ReferenceGroup[] = [
  { id: "hash", label: "Marcas interiores de americano", overlayOnly: true, ids: (_, g) => g === "hash" },
  { id: "yard", label: "Líneas de yarda y bandas de americano", overlayOnly: true, ids: (_, g) => g === "football" },
  { id: "corners", label: "Esquinas de la cancha", overlayOnly: false, ids: (id) => /^sc_[lr]_c[fn]$/.test(id) },
  { id: "mid", label: "Media cancha y círculo central", overlayOnly: false, ids: (id) => /^sc_(c|h[fn]|c[fnlr])$/.test(id) },
  { id: "boxes", label: "Áreas y puntos penales", overlayOnly: false, ids: (id) => /^sc_[lr]_(p[fn]|pg[fn]|g[fn]|ps)$/.test(id) },
];

export const referenceGroups = (kind: VenueSpec["kind"]) => REFERENCE_GROUPS.filter((g) => kind === "football_overlay" || !g.overlayOnly);

// Goal mouths at both ends, as model segments on the goal lines. Null when the goal width has not been measured.
export function goalSegments(L: number, W: number, goalWidth: number | undefined): [Pt, Pt][] | null {
  if (!goalWidth || !(goalWidth > 0)) return null;
  const y0 = W / 2 - goalWidth / 2;
  const y1 = W / 2 + goalWidth / 2;
  return [
    [
      [0, y0],
      [0, y1],
    ],
    [
      [L, y0],
      [L, y1],
    ],
  ];
}
