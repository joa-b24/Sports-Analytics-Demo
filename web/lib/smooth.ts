// Cleaning of one person's path on the pitch before exporting the corrected tracks. Pure functions.
//
// Three steps, each with a stated rule, and nothing is filled in silently: every position says where it comes from.
//   1. Micro-jumps: a point that would need an impossible speed to reach AND to leave is a detection error. It is
//      removed (and then treated as a hole).
//   2. Holes: a short hole between two known positions is filled with a straight line, only if the person could
//      really have covered that distance. Those positions are marked "interpolated". Long holes stay empty: she was
//      not seen, and where she went is not known.
//   3. Jitter: a small centred weighted average over each unbroken stretch. Hand-marked positions weigh more.

export type PointSource = "auto" | "manual" | "interpolated";

export interface TrackPoint {
  frame: number;
  // Normalised pitch (105 x 68).
  x: number;
  y: number;
  source: PointSource;
  // Position before smoothing, for measured points whose position was moved.
  raw?: [number, number];
}

export interface SmoothOptions {
  fps: number;
  // Frames between two processed frames.
  stride: number;
  // Real meters per unit of the normalised pitch, along x and y (venue length / 105, venue width / 68).
  metersPerUnit: [number, number];
  // Fastest a player can move (m/s). Sprint peaks are around 8-9 m/s.
  maxSpeedMs: number;
  // Longest hole that is filled (s).
  maxFillS: number;
  // Width of the smoothing window (s). 0 = no smoothing.
  windowS: number;
}

export const SMOOTH_DEFAULTS = { maxSpeedMs: 9, maxFillS: 2, windowS: 0.5 };

export interface SmoothReport {
  // Points removed as micro-jumps.
  outliers: number;
  // Positions added inside short holes.
  filled: number;
  // Holes left empty: too long, or impossible to cover at a human speed.
  openGaps: number;
}

function speed(a: TrackPoint, b: TrackPoint, o: SmoothOptions): number {
  const dt = Math.abs(b.frame - a.frame) / o.fps;
  if (dt === 0) return Infinity;
  return Math.hypot((b.x - a.x) * o.metersPerUnit[0], (b.y - a.y) * o.metersPerUnit[1]) / dt;
}

// One point per frame (a hand-marked one wins over a detection), in time order.
function dedupe(points: TrackPoint[]): TrackPoint[] {
  const byFrame = new Map<number, TrackPoint>();
  for (const p of points) {
    const cur = byFrame.get(p.frame);
    if (!cur || (p.source === "manual" && cur.source !== "manual")) byFrame.set(p.frame, p);
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

// Step 1. A point is a micro-jump when both the way in and the way out are too fast, while going straight from the
// previous point to the next one is not. Hand-marked points are never removed.
export function dropJumps(points: TrackPoint[], o: SmoothOptions): { points: TrackPoint[]; removed: number } {
  let pts = points;
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    const keep = pts.filter((p, i) => {
      if (p.source === "manual" || i === 0 || i === pts.length - 1) return true;
      const a = pts[i - 1];
      const b = pts[i + 1];
      return !(speed(a, p, o) > o.maxSpeedMs && speed(p, b, o) > o.maxSpeedMs && speed(a, b, o) <= o.maxSpeedMs);
    });
    if (keep.length === pts.length) break;
    removed += pts.length - keep.length;
    pts = keep;
  }
  // Short excursions: a few points that jump away too fast and later jump back, while going straight from the point
  // before to the point after is possible. Usually the feet of a box were hidden and landed metres away.
  const maxPts = Math.max(2, Math.round((EXCURSION_MAX_S * o.fps) / o.stride));
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    if (pts[i].source === "manual" || speed(a, pts[i], o) <= o.maxSpeedMs) continue;
    for (let k = i + 1; k < Math.min(pts.length, i + maxPts + 1); k++) {
      const inside = pts.slice(i, k);
      if (inside.some((q) => q.source === "manual")) break;
      if (speed(pts[k - 1], pts[k], o) > o.maxSpeedMs && speed(a, pts[k], o) <= o.maxSpeedMs) {
        removed += inside.length;
        pts = [...pts.slice(0, i), ...pts.slice(k)];
        break;
      }
    }
  }
  return { points: pts, removed };
}

// Longest excursion (s) that is taken out as a wrong position (see dropJumps).
export const EXCURSION_MAX_S = 0.5;

// Step 2. Fills the holes that are short and physically possible, one position per processed frame.
export function fillGaps(points: TrackPoint[], o: SmoothOptions): { points: TrackPoint[]; filled: number; open: number } {
  const out: TrackPoint[] = [];
  let filled = 0;
  let open = 0;
  points.forEach((p, i) => {
    out.push(p);
    const next = points[i + 1];
    if (!next || next.frame - p.frame <= o.stride * 1.5) return;
    const dt = (next.frame - p.frame) / o.fps;
    if (dt > o.maxFillS || speed(p, next, o) > o.maxSpeedMs) {
      open++;
      return;
    }
    for (let f = p.frame + o.stride; f < next.frame - o.stride * 0.5; f += o.stride) {
      const w = (f - p.frame) / (next.frame - p.frame);
      out.push({ frame: f, x: p.x + (next.x - p.x) * w, y: p.y + (next.y - p.y) * w, source: "interpolated" });
      filled++;
    }
  });
  return { points: out, filled, open };
}

// Step 3. Centred triangular average inside each unbroken stretch. The ends of a stretch use a narrower window, so
// the path is not pulled inwards. Interpolated points are left on their straight line, which is already smooth.
export function smoothRuns(points: TrackPoint[], o: SmoothOptions): TrackPoint[] {
  const half = Math.floor(Math.max(1, Math.round((o.windowS * o.fps) / o.stride)) / 2);
  if (o.windowS <= 0 || half < 1) return points;
  const out: TrackPoint[] = [];
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && points[i].frame - points[i - 1].frame <= o.stride * 1.5) continue;
    const run = points.slice(start, i);
    run.forEach((p, k) => {
      const h = Math.min(half, k, run.length - 1 - k);
      if (h === 0 || p.source === "interpolated") return out.push(p);
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = -h; j <= h; j++) {
        const q = run[k + j];
        const w = (h + 1 - Math.abs(j)) * (q.source === "manual" ? 3 : 1);
        sx += q.x * w;
        sy += q.y * w;
        sw += w;
      }
      out.push({ ...p, x: sx / sw, y: sy / sw, raw: [p.x, p.y] });
    });
    start = i;
  }
  return out;
}

export function smoothTrack(points: TrackPoint[], o: SmoothOptions): { points: TrackPoint[]; report: SmoothReport } {
  const jumps = dropJumps(dedupe(points), o);
  const gaps = fillGaps(jumps.points, o);
  return { points: smoothRuns(gaps.points, o), report: { outliers: jumps.removed, filled: gaps.filled, openGaps: gaps.open } };
}
