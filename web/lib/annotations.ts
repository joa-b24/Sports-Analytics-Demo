// Drawings over a play: on the board (seen from above) and, from phase 2 on, over the video. A drawing is kept in
// pitch meters or tied to a player, never in pixels, so the same drawing serves both views (over the video it is
// projected with the homography of each frame). Only text may sit in screen coordinates. Pure functions, no storage,
// no React.
import { invert, type Homography } from "./homography.ts";
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

// How a highlight marks a player: an oval on the ground, an arrow over her head, or nothing (only her label). The old
// «box» no longer exists: a clip that had it opens with the oval (lib/clips.ts migrateEdit).
export const HIGHLIGHT_SHAPES = ["oval", "arrow", "none"] as const;
export type HighlightShape = (typeof HIGHLIGHT_SHAPES)[number];
export const HIGHLIGHT_SHAPE_LABELS: Record<HighlightShape, string> = { oval: "Óvalo", arrow: "Flecha", none: "Ninguno" };

// Which side of the marked player her label sits on.
export const LABEL_SIDES = ["up", "down", "left", "right"] as const;
export type LabelSide = (typeof LABEL_SIDES)[number];
export const LABEL_SIDE_LABELS: Record<LabelSide, string> = { up: "Arriba", down: "Abajo", left: "Izquierda", right: "Derecha" };

export interface AnnotationStyle {
  // A name of the palette (lib/palette.ts) or a free «#rrggbb».
  color: string;
  dashed?: boolean;
  label?: string;
  // Highlights only. Absent = oval.
  shape?: HighlightShape;
  // Where the label sits, and a nudge from there in px of a 1080-high frame (a presentation offset: the drawing itself
  // stays in meters or tied to the player). Absent = the clip's side, no nudge.
  label_side?: LabelSide;
  label_dx?: number;
  label_dy?: number;
  // The label of this drawing is not shown.
  label_off?: boolean;
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

export type LabelMode = "name" | "number" | "none";

// What a clip needs from the tracking of its part, copied when the edit is saved so that the render (Python) draws
// exactly what the app shows: the calibration of each processed frame and the positions of the people seen in the clip.
export interface ClipSnapshot {
  fps: number;
  stride: number;
  image_w: number;
  image_h: number;
  // Real size of the venue (m): H goes to real meters, the drawings are in the normalised 105 x 68 pitch.
  venue: { length_m: number; width_m: number };
  // [frame, H]: H image px -> real venue meters (row-major), null where the frame has no calibration.
  homographies: [number, number[] | null][];
  people: { id: number; team: string; player_id: string | null; number: number | null }[];
  // By identity: [frame, x, y, source] in the normalised pitch as tracks_fixed has it (not mirrored).
  tracks: Record<string, [number, number, number, string][]>;
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
  label_mode: LabelMode;
  // Side of the label for every drawing that does not choose its own (absent = up), the players whose label is removed
  // (identities), the shape a new highlight takes, and the palette overrides in force when it was saved (for the render).
  label_side?: LabelSide;
  hidden_labels?: (number | string)[];
  highlight_shape?: HighlightShape;
  palette?: Record<string, string>;
  // The play it was made from, if any.
  play_id?: string;
  // tracks_fixed (or tracks, if the part was not corrected) file whose identities the `player` anchors use.
  fixed_file?: string | null;
  snapshot?: ClipSnapshot | null;
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

// Points along the same curve as curvePath, `perStretch` points per stretch between two given points. Straight with two.
export function sampleCurve(points: Pt[], perStretch = 12): Pt[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const out: Pt[] = [[points[0][0], points[0][1]]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let k = 1; k <= perStretch; k++) {
      const u = k / perStretch;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u ** 2;
      const d = u ** 3;
      out.push([a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0], a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1]]);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- clip with freezes

// The output clip, in order: stretches of video and stops. Stops do not count as video time.
export interface TimelineSpan {
  kind: "video" | "freeze";
  // Seconds of the output clip.
  out0: number;
  out1: number;
  // Seconds of the video (the same at both ends of a stop).
  v0: number;
  v1: number;
  freeze: Freeze | null;
}
export interface ClipTimeline {
  spans: TimelineSpan[];
  duration: number;
}

// Stops that fall inside the clip, in order (one per instant: a second one at the same time is left out).
export function clipFreezes(edit: Pick<ClipEdit, "t_start" | "t_end" | "freezes">): Freeze[] {
  const out: Freeze[] = [];
  for (const f of [...edit.freezes].sort((a, b) => a.t - b.t))
    if (f.t >= edit.t_start && f.t <= edit.t_end && f.duration_s > 0 && !out.some((g) => Math.abs(g.t - f.t) < 1e-6)) out.push(f);
  return out;
}

export function timeline(edit: Pick<ClipEdit, "t_start" | "t_end" | "freezes">): ClipTimeline {
  const spans: TimelineSpan[] = [];
  let v = edit.t_start;
  let out = 0;
  const video = (to: number) => {
    if (to > v + 1e-9) {
      spans.push({ kind: "video", out0: out, out1: out + (to - v), v0: v, v1: to, freeze: null });
      out += to - v;
      v = to;
    }
  };
  for (const f of clipFreezes(edit)) {
    video(f.t);
    spans.push({ kind: "freeze", out0: out, out1: out + f.duration_s, v0: f.t, v1: f.t, freeze: f });
    out += f.duration_s;
  }
  video(edit.t_end);
  return { spans, duration: out };
}

// Where the output clip is at output time `t`: the video time, and the stop it is in (with the seconds into it).
export function atOutput(tl: ClipTimeline, t: number): { t_video: number; freeze: Freeze | null; elapsed: number } {
  const span = tl.spans.find((s) => t >= s.out0 && t < s.out1) ?? tl.spans[tl.spans.length - 1];
  if (!span) return { t_video: 0, freeze: null, elapsed: 0 };
  if (span.kind === "freeze") return { t_video: span.v0, freeze: span.freeze, elapsed: Math.min(t, span.out1) - span.out0 };
  return { t_video: Math.min(span.v1, span.v0 + Math.max(0, t - span.out0)), freeze: null, elapsed: 0 };
}

// Output time at which the video reaches `t_video` (before the stop there, if any).
export function outputOf(tl: ClipTimeline, t_video: number): number {
  for (const s of tl.spans) if (s.kind === "video" && t_video >= s.v0 && t_video <= s.v1) return s.out0 + (t_video - s.v0);
  return t_video <= (tl.spans[0]?.v0 ?? 0) ? 0 : tl.duration;
}

// How many drawings of a stop's `reveal` are shown `elapsed` seconds into it: one by one, evenly, the first after a
// moment of the bare frame and the last with time left to see them all.
export function revealCount(f: Freeze, elapsed: number): number {
  const n = f.reveal.length;
  if (n === 0) return 0;
  return Math.max(0, Math.min(n, Math.floor(elapsed / (f.duration_s / (n + 1)))));
}

// Drawings at a moment of the clip: those visible then, minus the ones of the current stop not revealed yet.
export function clipDrawingsAt(
  edit: Pick<ClipEdit, "annotations">,
  t_video: number,
  ctx: ResolveContext,
  stop: { freeze: Freeze; shown: number } | null,
): Resolved[] {
  const hidden = new Set(stop ? stop.freeze.reveal.slice(stop.shown) : []);
  return resolveAll(
    // A drawing that breaks its own rules (an edited or imported file) is left out, as in the render.
    edit.annotations.filter((a) => !hidden.has(a.id) && isValidAnnotation(a)),
    t_video,
    ctx,
  );
}

// ------------------------------------------------------------------------------------------------ projection

// Sizes of what is drawn over the video, for a frame 1080 px high (scaled with its height). The render uses the same.
export const DRAW_PX = { stroke: 5, text: 40, label: 30, outline: 6 };
// Sizes on the grass (normalised meters): the ring at the feet and the arrow head.
export const DRAW_M = { ring: 1.2, head: 2 };

// The shape of a highlight; anything unknown (an old «box») is read as the oval.
export const highlightShape = (style: Pick<AnnotationStyle, "shape">): HighlightShape => (HIGHLIGHT_SHAPES as readonly string[]).includes(style.shape as string) ? (style.shape as HighlightShape) : "oval";

export interface Venue {
  length_m: number;
  width_m: number;
}
export type ToImage = (p: Pt) => Pt | null;

// Normalised pitch (105 x 68) -> pixels of the frame, through H (pixels -> real venue meters). The sign of the inverse
// is chosen so that the centre of the pitch is in front of the camera; a point behind it gives null. Null without H.
export function pitchToImage(H: Homography | null | undefined, venue: Venue): ToImage | null {
  if (!H) return null;
  const inv = invert(H);
  if (!inv) return null;
  const sx = venue.length_m / 105;
  const sy = venue.width_m / 68;
  const s = inv[6] * (venue.length_m / 2) + inv[7] * (venue.width_m / 2) + inv[8] < 0 ? -1 : 1;
  const m = inv.map((v) => v * s);
  return ([x, y]) => {
    const X = x * sx;
    const Y = y * sy;
    const w = m[6] * X + m[7] * Y + m[8];
    if (!(w > 1e-9)) return null;
    return [(m[0] * X + m[1] * Y + m[2]) / w, (m[3] * X + m[4] * Y + m[5]) / w];
  };
}

export interface Projected {
  id: string;
  kind: AnnotationKind;
  style: AnnotationStyle;
  // Polylines in pixels; `closed` ones are polygons (the ring at the feet, a zone).
  paths: Pt[][];
  closed: boolean;
  head: Pt[] | null;
  // A text drawing, or the label of another drawing: where its baseline goes (centred) and what it says.
  text: { at: Pt; value: string; anchor?: "start" | "middle" | "end" } | null;
}

// What project() needs to place labels: the clip's side and the players whose label is removed.
export interface LabelOpts {
  side?: LabelSide;
  hidden?: ReadonlySet<string>;
}

// A drawing over the video frame. Drawings on the grass follow the perspective point by point (a ring at the feet is an
// ellipse, an arrow bends with the pitch). Hidden (null) when any point cannot be placed, or without calibration; a
// text in screen coordinates stays. `labelOf` gives the label of a player (by the clip's label mode) or null.
export function project(
  r: Resolved,
  toImage: ToImage | null,
  image: { w: number; h: number },
  labelOf?: (id: number | string) => string | null,
  lab: LabelOpts = {},
): Projected | null {
  const k = image.h / 1080;
  const base: Projected = { id: r.id, kind: r.kind, style: r.style, paths: [], closed: false, head: null, text: null };
  if (r.space === "screen") return { ...base, text: { at: [r.points[0][0] * image.w, r.points[0][1] * image.h], value: r.style.label || "Texto" } };
  if (!toImage) return null;
  const proj = (ps: Pt[]): Pt[] | null => {
    const out: Pt[] = [];
    for (const p of ps) {
      const q = toImage(p);
      if (!q) return null;
      out.push(q);
    }
    return out;
  };
  const labelAt = (p: Pt | null, who: string | null, anchor?: "start" | "middle" | "end") => {
    const value = r.style.label_off ? "" : [who, r.style.label].filter(Boolean).join(" · ");
    if (!value || !p) return null;
    const at: Pt = [p[0] + (r.style.label_dx ?? 0) * k, p[1] + (r.style.label_dy ?? 0) * k];
    return anchor && anchor !== "middle" ? { at, value, anchor } : { at, value };
  };
  const above = (p: Pt | null): Pt | null => (p ? [p[0], p[1] - 12 * k] : null);
  if (r.kind === "text") {
    const at = toImage(r.points[0]);
    return at ? { ...base, text: { at, value: r.style.label || "Texto" } } : null;
  }
  if (r.kind === "highlight") {
    const [cx, cy] = r.points[0];
    const ring = proj(Array.from({ length: 32 }, (_, i): Pt => [cx + DRAW_M.ring * Math.cos((i / 32) * 2 * Math.PI), cy + DRAW_M.ring * Math.sin((i / 32) * 2 * Math.PI)]));
    if (!ring) return null;
    const player = r.players[0];
    const hidden = player !== null && lab.hidden?.has(String(player));
    const who = player !== null && labelOf && !hidden ? labelOf(player) : null;
    const shape = highlightShape(r.style);
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = ring.reduce((a, p) => (p[1] < a[1] ? p : a), ring[0]);
    const bottom = ring.reduce((a, p) => (p[1] > a[1] ? p : a), ring[0]);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = right - left;
    // A person is about 1.75 m tall and the ring 2.4 m across: the arrow floats above the head at that scale.
    const bodyH = (w / (2 * DRAW_M.ring)) * 1.75;
    // The oval is on the ground; an arrow or nothing leaves the label at the head or the feet.
    const headY = mid - bodyH;
    const cxp = (left + right) / 2;
    const side = r.style.label_side ?? lab.side ?? "up";
    const roof = shape === "arrow" ? headY - w * 0.55 : shape === "none" ? headY : top[1];
    const at: Record<LabelSide, [Pt, "start" | "middle" | "end"]> = {
      up: [[shape === "oval" ? top[0] : cxp, roof - 12 * k], "middle"],
      down: [[bottom[0], bottom[1] + 34 * k], "middle"],
      left: [[left - 12 * k, mid + 10 * k], "end"],
      right: [[right + 12 * k, mid + 10 * k], "start"],
    };
    const text = labelAt(at[side][0], who, at[side][1]);
    if (shape === "oval") return { ...base, paths: [ring], closed: true, text };
    if (shape === "none") return { ...base, text };
    const tipY = headY - w * 0.12;
    const size = w * 0.4;
    return { ...base, head: [[cxp, tipY], [cxp - size / 2, tipY - size * 0.85], [cxp + size / 2, tipY - size * 0.85]], text };
  }
  if (r.kind === "arrow") {
    const curve = sampleCurve(r.points);
    const head = arrowHead(curve, DRAW_M.head);
    if (!head) return null;
    const body: Pt[] = [...curve.slice(0, -1), [(head[1][0] + head[2][0]) / 2, (head[1][1] + head[2][1]) / 2]];
    const pb = proj(body);
    const ph = proj(head);
    return pb && ph ? { ...base, paths: [pb], head: ph, text: labelAt(above(toImage(labelPoint(r))), null) } : null;
  }
  const pts = proj(r.points);
  if (!pts) return null;
  return { ...base, paths: [pts], closed: r.kind === "zone", text: labelAt(above(toImage(labelPoint(r))), null) };
}
