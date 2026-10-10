// Run with: node --test lib/   (Node 24 strips the TypeScript types on import)
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, fitHomography, fitQuality, invert, invertFor, orient } from "./homography.ts";

// A plausible camera: pixels -> meters, with real perspective terms.
const TRUE_H = [0.031, 0.094, -12.4, -0.002, 0.171, -31.0, 0.00001, 0.0021, 1];
const PIXELS = [
  [120, 420], [960, 400], [1800, 430], [300, 700], [1500, 720], [900, 1000], [200, 1040], [1700, 980],
];
const METERS = PIXELS.map((p) => apply(TRUE_H, p));

test("recovers a known homography from exact points", () => {
  const H = fitHomography(PIXELS, METERS);
  assert.ok(H);
  const q = fitQuality(H, PIXELS, METERS);
  assert.ok(q.rms < 1e-6, `rms ${q.rms}`);
  assert.ok(q.leaveOneOut.every((e) => e !== null && e < 1e-5));
  const probe = apply(H, [1000, 600]);
  const truth = apply(TRUE_H, [1000, 600]);
  assert.ok(Math.hypot(probe[0] - truth[0], probe[1] - truth[1]) < 1e-6);
});

test("works with exactly four points and reports no leave-one-out", () => {
  const H = fitHomography(PIXELS.slice(0, 4), METERS.slice(0, 4));
  assert.ok(H);
  const q = fitQuality(H, PIXELS.slice(0, 4), METERS.slice(0, 4));
  assert.ok(q.rms < 1e-6);
  assert.deepEqual(q.leaveOneOut, [null, null, null, null]);
});

test("a misplaced point shows up in the leave-one-out error", () => {
  const bad = PIXELS.map((p, i) => (i === 3 ? [p[0] + 60, p[1] - 40] : p));
  const H = fitHomography(bad, METERS);
  assert.ok(H);
  const q = fitQuality(H, bad, METERS);
  const worst = q.leaveOneOut.indexOf(Math.max(...q.leaveOneOut));
  assert.equal(worst, 3);
});

test("rejects too few or collinear points", () => {
  assert.equal(fitHomography(PIXELS.slice(0, 3), METERS.slice(0, 3)), null);
  const line = [[0, 0], [100, 100], [200, 200], [300, 300], [400, 400]];
  assert.equal(fitHomography(line, line), null);
});

test("works when the horizon is inside the image", () => {
  // w = 1 - 0.0022 * y: the pixel origin and the pitch (y > 455) are on opposite sides of the horizon.
  const cam = orient([0.05, 0.02, -40, 0.001, -0.09, 20, 0.00002, -0.0022, 1], [[960, 800]]);
  const px = [[130, 616], [880, 597], [1705, 573], [218, 980], [1000, 945], [1720, 912]];
  const m = px.map((p) => apply(cam, p));
  assert.ok(m.every(Boolean));
  const H = fitHomography(px, m);
  assert.ok(H);
  assert.ok(fitQuality(H, px, m).rms < 1e-6);
  const Hinv = invertFor(H, m);
  const back = apply(Hinv, m[4]);
  assert.ok(Math.hypot(back[0] - 1000, back[1] - 945) < 1e-5);
  // Points above the horizon are not on the pitch.
  assert.equal(apply(H, [960, 100]), null);
});

test("invert undoes apply", () => {
  const inv = invert(TRUE_H);
  const m = apply(TRUE_H, [640, 512]);
  const back = apply(inv, m);
  assert.ok(Math.hypot(back[0] - 640, back[1] - 512) < 1e-6);
});
