import assert from "node:assert/strict";
import { test } from "node:test";
import { SMOOTH_DEFAULTS, dropJumps, fillGaps, smoothRuns, smoothTrack } from "./smooth.ts";

// 30 fps video, 1 of every 3 frames processed (10 positions per second), on a 105 x 68 venue (1 unit = 1 m).
const O = { fps: 30, stride: 3, metersPerUnit: [1, 1], ...SMOOTH_DEFAULTS };
const pt = (frame, x, y, source = "auto") => ({ frame, x, y, source });
// A player running along x at `v` m/s from x0, one point per processed frame.
const run = (f0, n, x0, v, y = 30) => Array.from({ length: n }, (_, i) => pt(f0 + i * 3, x0 + (v * i * 3) / 30, y));

test("a micro-jump is removed and the hole it leaves is filled on the line", () => {
  const pts = run(0, 11, 20, 4);
  pts[5] = pt(15, 22 + 6, 30 + 5); // one frame, 8 m away: would need ~80 m/s in and out
  const { points, report } = smoothTrack(pts, { ...O, windowS: 0 });
  assert.deepEqual(report, { outliers: 1, filled: 1, openGaps: 0 });
  const fixed = points.find((p) => p.frame === 15);
  assert.equal(fixed.source, "interpolated");
  assert.ok(Math.abs(fixed.x - 22) < 1e-9 && Math.abs(fixed.y - 30) < 1e-9);
});

test("a real change of direction is not taken for a jump", () => {
  // Sprinting at 8 m/s and turning back: fast, but each step is possible.
  const pts = [...run(0, 6, 20, 8), ...run(18, 6, 20 + 8 * 0.5, -8)];
  assert.equal(dropJumps(pts, O).removed, 0);
});

test("a hand-marked position is never removed, however far it is", () => {
  const pts = run(0, 7, 20, 2);
  pts[3] = pt(9, 40, 50, "manual");
  assert.equal(dropJumps(pts, O).removed, 0);
});

test("short holes are filled and labelled; long ones stay empty", () => {
  // Seen until frame 30, lost for 1.2 s, seen again from frame 66 while jogging at 3 m/s.
  const pts = [...run(0, 11, 20, 3), ...run(66, 5, 20 + 3 * 2.2, 3)];
  const short = fillGaps(pts, O);
  assert.equal(short.open, 0);
  assert.equal(short.filled, 11); // frames 33, 36, ... 63
  const added = short.points.filter((p) => p.source === "interpolated");
  assert.deepEqual(added.map((p) => p.frame), [33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63]);
  // On the straight line between the last and the next known position.
  assert.ok(Math.abs(added[5].x - (23 + 3 * 0.6)) < 1e-9);

  // The same hole lasting 4 s: she was simply not seen. Nothing is made up.
  const long = fillGaps([...run(0, 11, 20, 3), ...run(150, 5, 35, 3)], O);
  assert.deepEqual([long.filled, long.open], [0, 1]);
});

test("a hole that nobody could have covered is not filled, even if it is short", () => {
  // 30 m in one second: that is two different people joined by mistake, not a hole to draw a line across.
  const pts = [...run(0, 6, 20, 0), ...run(45, 6, 50, 0)];
  const r = fillGaps(pts, O);
  assert.deepEqual([r.filled, r.open], [0, 1]);
});

test("smoothing takes out the jitter and leaves a straight run where it was", () => {
  const straight = run(0, 21, 20, 5);
  const smooth = smoothRuns(straight, O);
  // A constant-speed run is unchanged by a centred average.
  assert.ok(smooth.every((p, i) => Math.abs(p.x - straight[i].x) < 1e-9));

  const noisy = straight.map((p, i) => ({ ...p, y: p.y + (i % 2 ? 0.6 : -0.6) })); // +-0.6 m zig-zag
  const out = smoothRuns(noisy, O);
  const spread = (list) => Math.max(...list.slice(2, -2).map((p) => Math.abs(p.y - 30)));
  assert.ok(spread(out) < 0.25 && Math.abs(spread(noisy) - 0.6) < 1e-9);
  // The measured position is kept next to the smoothed one, and the ends are not touched.
  assert.deepEqual(out[5].raw, [noisy[5].x, noisy[5].y]);
  assert.equal(out[0].raw, undefined);
  assert.equal(out[0].y, noisy[0].y);
});

test("smoothing does not reach across a hole that was left open", () => {
  const pts = [...run(0, 5, 20, 0, 30), ...run(150, 5, 20, 0, 40)];
  const out = smoothRuns(pts, O);
  assert.ok(out.slice(0, 5).every((p) => p.y === 30) && out.slice(5).every((p) => p.y === 40));
});

test("a hand mark pulls the path more than a detection, and wins when both exist in a frame", () => {
  const pts = [pt(0, 20, 30), pt(3, 20, 30), pt(6, 20, 30), pt(6, 20, 33, "manual"), pt(9, 20, 30), pt(12, 20, 30)];
  const { points } = smoothTrack(pts, O);
  assert.equal(points.length, 5);
  const mid = points.find((p) => p.frame === 6);
  assert.equal(mid.source, "manual");
  assert.ok(mid.y > 31.5); // stays close to where the person put it
});

test("a short excursion of a few points is taken out; a real change of place is not", () => {
  const pts = run(0, 15, 20, 2);
  for (const k of [6, 7, 8]) pts[k] = pt(k * 3, 35, 45); // 0.3 s far away, then back on her way
  const { points, removed } = dropJumps(pts, O);
  assert.equal(removed, 3);
  assert.ok(points.every((p) => p.x < 30));
  // Running away and staying there is not an excursion.
  const away = [...run(0, 6, 20, 2), ...run(18, 8, 35, 2).map((p) => ({ ...p, y: 45 }))];
  assert.equal(dropJumps(away, O).removed, 0);
});

