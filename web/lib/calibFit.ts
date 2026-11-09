import { apply, fitHomography, multiply, type Homography, type Pt } from "./homography.ts";

// Calibration with circles: where the paint is worn, an arc of the centre circle (or of the penalty arc) is often all
// there is. Seen in perspective a circle is an ellipse, and five or more clicks along any part of it say almost as
// much about the camera as three reference points; with two lines it can be enough on its own.
// The fit is numerical (Levenberg-Marquardt) over everything at once: clicked points (and points where two marked
// lines cross), each click of a marked line (its distance to that line of the model) and each click on an arc (its
// distance to the circle of the model). Everything in meters of the venue. Pure functions.

export interface ArcInput {
  // Clicks on the arc, in pixels.
  pts: Pt[];
  // Centre and radius of its circle in the model (meters).
  c: Pt;
  r: number;
}
export interface LineInput {
  // Clicks on the line, in pixels.
  pts: Pt[];
  // Two points of the line in the model (meters).
  ma: Pt;
  mb: Pt;
}
export interface HybridInput {
  points: { px: Pt; m: Pt }[];
  lines: LineInput[];
  arcs: ArcInput[];
}
export interface HybridFit {
  // Image pixels -> venue meters, as fitHomography.
  H: Homography;
  // Root mean square of every residual (meters), and of each kind.
  rms: number;
  points: number[];
  lines: number[];
  arcs: number[];
}

// Minimum clicks on an arc for it to count.
export const ARC_MIN = 5;

// ------------------------------------------------------------------ small linear algebra

// Gaussian elimination with partial pivoting (n x n). Null when singular.
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Eigenvector of the smallest eigenvalue of a symmetric matrix (Jacobi rotations).
function smallestEigenvector(S: number[][]): number[] {
  const n = S.length;
  const A = S.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (A[i][i] < A[best][best]) best = i;
  return V.map((row) => row[best]);
}

// ------------------------------------------------------------------ ellipse

export interface Ellipse {
  center: Pt;
  // Half axes (pixels) and the angle of the first one (radians).
  a: number;
  b: number;
  angle: number;
}

// Ellipse through some points (algebraic least squares on normalised coordinates). Null if they do not draw one.
export function fitEllipse(pts: Pt[]): Ellipse | null {
  if (pts.length < 5) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sc = Math.max(1e-9, Math.sqrt(pts.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / pts.length));
  const S = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const p of pts) {
    const x = (p[0] - mx) / sc;
    const y = (p[1] - my) / sc;
    const row = [x * x, x * y, y * y, x, y, 1];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) S[i][j] += row[i] * row[j];
  }
  const [A, B, C, D, E, F] = smallestEigenvector(S);
  const disc = B * B - 4 * A * C;
  if (!(disc < 0)) return null;
  const x0 = (2 * C * D - B * E) / disc;
  const y0 = (2 * A * E - B * D) / disc;
  const val = A * x0 * x0 + B * x0 * y0 + C * y0 * y0 + D * x0 + E * y0 + F;
  const angle = 0.5 * Math.atan2(B, A - C);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const l1 = A * ca * ca + B * ca * sa + C * sa * sa;
  const l2 = A * sa * sa - B * ca * sa + C * ca * ca;
  if (!(-val / l1 > 0) || !(-val / l2 > 0)) return null;
  return { center: [x0 * sc + mx, y0 * sc + my], a: Math.sqrt(-val / l1) * sc, b: Math.sqrt(-val / l2) * sc, angle };
}

// A first guess from an arc: the ends of the ellipse's axes taken as the circle's left, right, far and near points
// (the camera looks across the pitch, far side up, length along the image). Only a starting point for the fit.
export function guessFromArc(arc: ArcInput): { px: Pt; m: Pt }[] {
  const e = fitEllipse(arc.pts);
  if (!e) return [];
  const ends = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((t) => {
    const ax = Math.cos(t) * e.a;
    const ay = Math.sin(t) * e.b;
    return [e.center[0] + ax * Math.cos(e.angle) - ay * Math.sin(e.angle), e.center[1] + ax * Math.sin(e.angle) + ay * Math.cos(e.angle)] as Pt;
  });
  const byX = [...ends].sort((p, q) => p[0] - q[0]);
  const byY = [...ends].sort((p, q) => p[1] - q[1]);
  const [cx, cy] = arc.c;
  const r = arc.r;
  return [
    { px: byX[0], m: [cx - r, cy] },
    { px: byX[3], m: [cx + r, cy] },
    { px: byY[0], m: [cx, cy - r] },
    { px: byY[3], m: [cx, cy + r] },
  ];
}

// ------------------------------------------------------------------ the fit

const clicksOf = (input: HybridInput): Pt[] => [...input.points.map((p) => p.px), ...input.lines.flatMap((l) => l.pts), ...input.arcs.flatMap((a) => a.pts)];

// Number of residuals: what has to reach the 8 unknowns of a homography (with some to spare).
export function constraintCount(input: HybridInput): number {
  return input.points.length * 2 + input.lines.reduce((n, l) => n + l.pts.length, 0) + input.arcs.reduce((n, a) => n + (a.pts.length >= ARC_MIN ? a.pts.length : 0), 0);
}

function residuals(Hn: number[], input: HybridInput, norm: (p: Pt) => Pt): { all: number[]; points: number[]; lines: number[]; arcs: number[] } {
  const map = (p: Pt): Pt | null => {
    const [u, v] = norm(p);
    const w = Hn[6] * u + Hn[7] * v + 1;
    if (!(w > 1e-6)) return null;
    return [(Hn[0] * u + Hn[1] * v + Hn[2]) / w, (Hn[3] * u + Hn[4] * v + Hn[5]) / w];
  };
  const BIG = 1e3;
  const points: number[] = [];
  const lines: number[] = [];
  const arcs: number[] = [];
  const all: number[] = [];
  for (const p of input.points) {
    const m = map(p.px);
    const dx = m ? m[0] - p.m[0] : BIG;
    const dy = m ? m[1] - p.m[1] : BIG;
    all.push(dx, dy);
    points.push(Math.hypot(dx, dy));
  }
  for (const l of input.lines) {
    const ux = l.mb[0] - l.ma[0];
    const uy = l.mb[1] - l.ma[1];
    const len = Math.hypot(ux, uy) || 1;
    for (const q of l.pts) {
      const m = map(q);
      const d = m ? ((m[0] - l.ma[0]) * uy - (m[1] - l.ma[1]) * ux) / len : BIG;
      all.push(d);
      lines.push(Math.abs(d));
    }
  }
  for (const a of input.arcs) {
    if (a.pts.length < ARC_MIN) continue;
    for (const q of a.pts) {
      const m = map(q);
      const d = m ? Math.hypot(m[0] - a.c[0], m[1] - a.c[1]) - a.r : BIG;
      all.push(d);
      arcs.push(Math.abs(d));
    }
  }
  return { all, points, lines, arcs };
}

const sumSq = (v: number[]) => v.reduce((s, x) => s + x * x, 0);

// Levenberg-Marquardt from a starting homography. Works in pixel coordinates centred on the clicks and scaled, with
// h8 = 1 there (the clicks are on the pitch, in front of the camera).
function refine(H0: Homography, input: HybridInput, o: Pt, s: number): number[] | null {
  const norm = (p: Pt): Pt => [(p[0] - o[0]) / s, (p[1] - o[1]) / s];
  // Hn = H0 * N^-1, where N maps pixels to normalised coordinates.
  const Ninv = [s, 0, o[0], 0, s, o[1], 0, 0, 1];
  let Hn = multiply(H0, Ninv);
  if (Math.abs(Hn[8]) < 1e-12) return null;
  Hn = Hn.map((v) => v / Hn[8]);
  let h = Hn.slice(0, 8);
  let r = residuals(h, input, norm).all;
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let it = 0; it < 200; it++) {
    const J: number[][] = r.map(() => new Array<number>(8).fill(0));
    for (let k = 0; k < 8; k++) {
      const eps = 1e-6 * (Math.abs(h[k]) + 1e-3);
      const hp = [...h];
      hp[k] += eps;
      const rp = residuals(hp, input, norm).all;
      for (let i = 0; i < r.length; i++) J[i][k] = (rp[i] - r[i]) / eps;
    }
    const JtJ = Array.from({ length: 8 }, (_, a) => Array.from({ length: 8 }, (_, b) => J.reduce((t, row) => t + row[a] * row[b], 0)));
    const Jtr = Array.from({ length: 8 }, (_, a) => J.reduce((t, row, i) => t + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(
        A,
        Jtr.map((v) => -v),
      );
      if (!step) {
        lambda *= 10;
        continue;
      }
      const hn = h.map((v, k) => v + step[k]);
      const rn = residuals(hn, input, norm).all;
      const cn = sumSq(rn);
      if (cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        h = hn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
        if (rel < 1e-10) it = 1e9;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  // Back to pixel coordinates: H = Hn * N.
  const N = [1 / s, 0, -o[0] / s, 0, 1 / s, -o[1] / s, 0, 0, 1];
  return multiply([...h, 1], N);
}

// The fit with points, lines and arcs. `guess`: a homography to start from (the usual fit of the points, when there is
// one); the ellipse of each arc gives other starts, and the best result wins. Null without enough constraints.
export function fitHybrid(input: HybridInput, guess: Homography | null = null): HybridFit | null {
  if (constraintCount(input) < 9) return null;
  const clicks = clicksOf(input);
  const o: Pt = [clicks.reduce((a, p) => a + p[0], 0) / clicks.length, clicks.reduce((a, p) => a + p[1], 0) / clicks.length];
  const s = Math.max(1, Math.sqrt(clicks.reduce((a, p) => a + (p[0] - o[0]) ** 2 + (p[1] - o[1]) ** 2, 0) / clicks.length));
  const starts: Homography[] = [];
  if (guess) starts.push(guess);
  const pts = input.points;
  for (const arc of input.arcs) {
    if (arc.pts.length < ARC_MIN) continue;
    const g = [...pts, ...guessFromArc(arc)];
    const H = fitHomography(
      g.map((p) => p.px),
      g.map((p) => p.m),
    );
    if (H) starts.push(H);
  }
  if (pts.length >= 4) {
    const H = fitHomography(
      pts.map((p) => p.px),
      pts.map((p) => p.m),
    );
    if (H) starts.push(H);
  }
  let best: { H: number[]; cost: number } | null = null;
  for (const H0 of starts) {
    const H = refine(H0, input, o, s);
    if (!H) continue;
    const r = residuals(
      multiply(H, [s, 0, o[0], 0, s, o[1], 0, 0, 1]).map((v, _, all) => v / all[8]).slice(0, 8),
      input,
      (p) => [(p[0] - o[0]) / s, (p[1] - o[1]) / s],
    );
    const cost = sumSq(r.all);
    if (Number.isFinite(cost) && (!best || cost < best.cost)) best = { H, cost };
  }
  if (!best) return null;
  const H = best.H.map((v) => v / best.H[8]);
  const norm = (p: Pt): Pt => [(p[0] - o[0]) / s, (p[1] - o[1]) / s];
  const Hn = multiply(H, [s, 0, o[0], 0, s, o[1], 0, 0, 1]);
  const r = residuals(
    Hn.map((v) => v / Hn[8]).slice(0, 8),
    input,
    norm,
  );
  const n = r.points.length + r.lines.length + r.arcs.length;
  const rms = Math.sqrt((sumSq(r.points) + sumSq(r.lines) + sumSq(r.arcs)) / Math.max(1, n));
  // Same sign convention as fitHomography: the clicks in front of the camera.
  const Hp = apply(H, o) ? H : H.map((v) => -v);
  return { H: Hp, rms, points: r.points, lines: r.lines, arcs: r.arcs };
}

// The arcs and lines of a fit as plain point pairs (each click and the nearest point of its circle or line in the
// model), for whoever only reads points (sportsan.tracking.propagate and the library).
export function constraintPoints(H: Homography, input: Pick<HybridInput, "lines" | "arcs">): { px: Pt; m: Pt; kind: "arc" | "line"; index: number }[] {
  const out: { px: Pt; m: Pt; kind: "arc" | "line"; index: number }[] = [];
  input.arcs.forEach((a, index) => {
    if (a.pts.length < ARC_MIN) return;
    for (const q of a.pts) {
      const m = apply(H, q);
      if (!m) continue;
      const d = Math.hypot(m[0] - a.c[0], m[1] - a.c[1]) || 1;
      out.push({ px: q, m: [a.c[0] + ((m[0] - a.c[0]) * a.r) / d, a.c[1] + ((m[1] - a.c[1]) * a.r) / d], kind: "arc", index });
    }
  });
  input.lines.forEach((l, index) => {
    const ux = l.mb[0] - l.ma[0];
    const uy = l.mb[1] - l.ma[1];
    const len2 = ux * ux + uy * uy || 1;
    for (const q of l.pts) {
      const m = apply(H, q);
      if (!m) continue;
      const t = ((m[0] - l.ma[0]) * ux + (m[1] - l.ma[1]) * uy) / len2;
      out.push({ px: q, m: [l.ma[0] + t * ux, l.ma[1] + t * uy], kind: "line", index });
    }
  });
  return out;
}
