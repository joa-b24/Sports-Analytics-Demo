// Planar homography from point pairs. Pure functions: no storage, no React.
// Convention: H maps image pixels -> venue meters, row-major [h0..h8], same as calib_* in the data contract.

export type Pt = [number, number];
export type Homography = number[];

// Gaussian elimination with partial pivoting. Returns null when the system is singular.
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
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

// Similarity that moves the centroid to the origin and the mean distance to sqrt(2) (Hartley).
function normalizer(pts: Pt[]): { T: number[]; Tinv: number[] } {
  const n = pts.length;
  const cx = pts.reduce((a, p) => a + p[0], 0) / n;
  const cy = pts.reduce((a, p) => a + p[1], 0) / n;
  const d = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], Tinv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}

export function multiply(A: number[], B: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return out;
}

export function invert(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) return null;
  return [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map(
    (v) => v / det,
  );
}

// A homography is defined up to scale, sign included. `apply` treats w > 0 as "in front of the camera", so the sign is
// chosen to make that true for the reference points. Null when they fall on both sides of the horizon.
export function orient(H: Homography, pts: Pt[]): Homography | null {
  const w = pts.map((p) => H[6] * p[0] + H[7] * p[1] + H[8]);
  if (w.every((v) => v > 1e-9)) return H;
  if (w.every((v) => v < -1e-9)) return H.map((v) => -v);
  return null;
}

// The calibration of a frame between two calibrated ones (only 1 of every few frames is processed): both matrices scaled
// so that H[8] = 1 and blended linearly. Close in time, the camera barely moves and this is indistinguishable from
// computing it. Null when a matrix cannot be scaled.
export function lerpHomography(A: Homography, B: Homography, t: number): Homography | null {
  if (Math.abs(A[8]) < 1e-12 || Math.abs(B[8]) < 1e-12) return null;
  return A.map((a, i) => (a / A[8]) * (1 - t) + (B[i] / B[8]) * t);
}

// Returns null when the point maps to infinity or behind the camera.
export function apply(H: Homography, p: Pt): Pt | null {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  if (!(w > 1e-9)) return null;
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

// Least-squares homography src -> dst from 4 or more pairs. Null if there are too few points or they are degenerate
// (for example, all on one line).
export function fitHomography(src: Pt[], dst: Pt[]): Homography | null {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  for (let i = 0; i < n; i++) {
    const [x, y] = apply(ns.T, src[i]) as Pt;
    const [u, v] = apply(nd.T, dst[i]) as Pt;
    const rows: [number[], number][] = [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ];
    for (const [row, rhs] of rows) {
      for (let a = 0; a < 8; a++) {
        Atb[a] += row[a] * rhs;
        for (let b = 0; b < 8; b++) AtA[a][b] += row[a] * row[b];
      }
    }
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const H = multiply(nd.Tinv, multiply([...h, 1], ns.T));
  const scale = Math.max(...H.map(Math.abs));
  if (!Number.isFinite(scale) || scale < 1e-300) return null;
  // A valid calibration keeps every clicked point on the same side of the horizon.
  return orient(
    H.map((v) => v / scale),
    src,
  );
}

// Inverse of a fitted homography (meters -> pixels), oriented with the reference points in meters.
export function invertFor(H: Homography, dst: Pt[]): Homography | null {
  const inv = invert(H);
  return inv ? orient(inv, dst) : null;
}

export interface FitQuality {
  // Distance between each projected source point and its target, in target units (meters).
  residuals: number[];
  rms: number;
  // Error of each point when the homography is fitted without it. Null with fewer than 5 points or a degenerate subset.
  leaveOneOut: (number | null)[];
}

export function fitQuality(H: Homography, src: Pt[], dst: Pt[]): FitQuality {
  const dist = (Hm: Homography, i: number) => {
    const p = apply(Hm, src[i]);
    return p ? Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) : Infinity;
  };
  const residuals = src.map((_, i) => dist(H, i));
  const rms = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / Math.max(residuals.length, 1));
  const leaveOneOut = src.map((_, i) => {
    if (src.length < 5) return null;
    const Hi = fitHomography(
      src.filter((_, k) => k !== i),
      dst.filter((_, k) => k !== i),
    );
    return Hi ? dist(Hi, i) : null;
  });
  return { residuals, rms, leaveOneOut };
}
