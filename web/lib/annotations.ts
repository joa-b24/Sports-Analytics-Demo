// Drawings over a play: on the board (seen from above) and, from phase 2 on, over the video. A drawing is kept in
// pitch meters or tied to a player, never in pixels, so the same drawing serves both views (over the video it is
// projected with the homography of each frame). Only text may sit in screen coordinates. Pure functions, no storage,
// no React.
import { interpolate } from "./stats.ts";
import type { Keyframe } from "./types.ts";

export type Pt = [number, number];

// player: follows a person. `identity` is a number for an identity of tracks_fixed and a string for a token of a
// board ("o3", "ball"). pitch: a fixed point in normalised meters (105 x 68). screen: 0..1 of the frame, text only.
export type Anchor =
  | { kind: "player"; identity: number | string }
  | { kind: "pitch"; x: number; y: number }
  | { kind: "screen"; x: number; y: number };

export const ANNOTATION_KINDS = ["highlight", "arrow", "line", "zone", "text"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export const ANNOTATION_LABELS: Record<AnnotationKind, string> = {
  highlight: "Resaltar",
  arrow: "Flecha",
  line: "Línea",
  zone: "Zona",
  text: "Texto",
};

// Names of the drawing colours. Each view turns them into its own value (CSS tokens in the app, BGR in the render),
// so a drawing never stores a hex code.
export const DRAW_COLORS = ["accent", "warn", "danger", "ok", "ink"] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];

export interface AnnotationStyle {
  color: string;
  dashed?: boolean;
  label?: string;
}

// highlight: 1 player. arrow: origin and end (+ points in between to curve it). line: 2 or more (a defensive line
// between players). zone: a polygon of 3 or more. text: 1.
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  anchors: Anchor[];
  // Seconds of the video (or of the board). Visible from t_in up to, not including, t_out.
  t_in: number;
  t_out: number;
  style: AnnotationStyle;
}

// The image stops at t for duration_s; the drawings in `reveal` appear one by one during the stop.
export interface Freeze {
  t: number;
  duration_s: number;
  reveal: string[];
}

export interface ClipEdit {
  edit_id: string;
  match_id: string;
  video_id: string;
  t_start: number;
  t_end: number;
  title: string;
  freezes: Freeze[];
  annotations: Annotation[];
  // How players are labelled.
  label_mode: "name" | "number" | "none";
}

// [min, max] number of anchors of each kind.
export const ARITY: Record<AnnotationKind, [number, number]> = {
  highlight: [1, 1],
  arrow: [2, Infinity],
  line: [2, Infinity],
  zone: [3, Infinity],
  text: [1, 1],
};

export function isValidAnnotation(a: Annotation): boolean {
  const [lo, hi] = ARITY[a.kind] ?? [Infinity, 0];
  if (a.anchors.length < lo || a.anchors.length > hi) return false;
  if (!(a.t_out > a.t_in)) return false;
  if (a.kind === "highlight" && a.anchors[0].kind !== "player") return false;
  // Screen coordinates are only for text: everything else lives on the grass.
  if (a.kind !== "text" && a.anchors.some((x) => x.kind === "screen")) return false;
  return true;
}

export const visibleAt = (a: Pick<Annotation, "t_in" | "t_out">, t: number) => t >= a.t_in && t < a.t_out;

// Where a player is at time t, in pitch meters, or null when it is not known (not seen, or seen too long ago).
export type PositionOf = (identity: number | string, t: number) => Pt | null;
export interface ResolveContext {
  positionOf: PositionOf;
}

export interface Resolved {
  id: string;
  kind: AnnotationKind;
  style: AnnotationStyle;
  // pitch: points in meters. screen: 0..1 of the frame (text only).
  space: "pitch" | "screen";
  points: Pt[];
  // The player each point follows, or null for a fixed point (in the same order as `points`).
  players: (number | string | null)[];
}

// Geometry of a drawing at time t, or null when it is hidden: outside t_in..t_out, or one of its players has no
// position then. A drawing is never completed with a guessed point.
export function resolve(a: Annotation, t: number, ctx: ResolveContext): Resolved | null {
  if (!visibleAt(a, t)) return null;
  let pts: { p: Pt; who: number | string | null }[] = [];
  for (const an of a.anchors) {
    if (an.kind === "player") {
      const p = ctx.positionOf(an.identity, t);
      if (!p) return null;
      pts.push({ p, who: an.identity });
    } else pts.push({ p: [an.x, an.y], who: null });
  }
  const allPlayers = pts.every((q) => q.who !== null);
  // Built from players, a line goes across the pitch in order (they swap places while they move) and a zone is the
  // outline around them, recomputed every frame.
  if (a.kind === "line" && allPlayers) pts = [...pts].sort((u, v) => u.p[1] - v.p[1] || u.p[0] - v.p[0]);
  if (a.kind === "zone" && pts.some((q) => q.who !== null)) {
    const h = hull(pts.map((q) => q.p));
    pts = h.map((p) => pts.find((q) => q.p === p)!);
  }
  return {
    id: a.id,
    kind: a.kind,
    style: a.style,
    space: a.anchors.some((x) => x.kind === "screen") ? "screen" : "pitch",
    points: pts.map((q) => q.p),
    players: pts.map((q) => q.who),
  };
}

export const resolveAll = (list: Annotation[], t: number, ctx: ResolveContext): Resolved[] =>
  list.flatMap((a) => resolve(a, t, ctx) ?? []);

// Positions of the tokens of a board: its keyframes interpolated (lib/stats.ts). A token absent from the keyframes
// is not on the board.
export function keyframePositions(keyframes: Keyframe[]): ResolveContext {
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  return {
    positionOf: (id, t) => {
      const p = interpolate(sorted, t)?.[String(id)];
      return p ? [p[0], p[1]] : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------------- geometry

// Convex outline, counter-clockwise in screen axes (y down), without repeated points. Returns the same array items.
export function hull(points: Pt[]): Pt[] {
  const ps = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (ps.length < 3) return ps;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...ps].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// SVG path through the points: straight with two, a smooth curve through every point with more (Catmull-Rom).
export function curvePath(points: Pt[]): string {
  if (points.length === 0) return "";
  const f = (v: number) => Math.round(v * 100) / 100;
  if (points.length === 2) return `M${f(points[0][0])} ${f(points[0][1])}L${f(points[1][0])} ${f(points[1][1])}`;
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// Head of an arrow that ends at the last point: tip, left and right corners. The direction is that of the last
// stretch (for a curve, from the point before the end), so the head follows the curve.
export function arrowHead(points: Pt[], size: number): [Pt, Pt, Pt] | null {
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  const from = points[points.length - 2];
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const back: Pt = [tip[0] - ux * size, tip[1] - uy * size];
  const w = size * 0.55;
  return [tip, [back[0] - uy * w, back[1] + ux * w], [back[0] + uy * w, back[1] - ux * w]];
}

// Where a label of a drawing goes: the middle of an arrow or a line, the centre of a zone, the point of the rest.
export function labelPoint(r: Pick<Resolved, "kind" | "points">): Pt {
  const ps = r.points;
  if (r.kind === "zone") return [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  if (r.kind === "arrow" || r.kind === "line") {
    const i = Math.floor((ps.length - 1) / 2);
    const a = ps[i];
    const b = ps[Math.min(ps.length - 1, i + 1)];
    return ps.length % 2 === 1 && ps.length > 2 ? ps[i] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return ps[0];
}
