import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM_S0_MS, applyFix, profile, smoothPath, verdict } from "./jumpReview.ts";

// A player jogging at 3 m/s along x, one position every 0.1 s, from -3 s to +3 s.
const jog = () => Array.from({ length: 61 }, (_, i) => [Math.round((i * 0.1 - 3) * 10) / 10, 30 + 3 * (i * 0.1), 20]);
const VENUE = { length_m: 105, width_m: 68 };

test("pico: the positions from the jump until she jumps back are taken out", () => {
  const p = jog();
  // From 0 to +0.2 s the box is on somebody 8 m away.
  for (const q of p) if (q[0] >= 0 && q[0] <= 0.2) q[2] = 28;
  const fixed = applyFix(p, "pico");
  assert.equal(fixed.length, p.length - 3);
  assert.ok(fixed.every((q) => q[2] === 20));
});

test("antes and prolongado remove the stretch before or after the jump", () => {
  const p = jog();
  for (const q of p) if (q[0] < 0 && q[0] >= -0.5) q[2] = 28;
  const before = applyFix(p, "antes");
  assert.ok(before.every((q) => q[2] === 20));
  const after = applyFix(jog(), "prolongado");
  assert.ok(after.every((q) => q[0] < 0));
});

test("a marked wrong stretch wins over the answer", () => {
  const out = applyFix(jog(), "camara", { from: 0.3, to: -0.1 });
  assert.ok(out.every((q) => q[0] < -0.12 || q[0] > 0.32));
});

test("a steady jog passes; a start to 30 km/h within a second does not", () => {
  const steady = verdict(profile(smoothPath(jog(), VENUE)));
  assert.ok(steady.ok);
  assert.ok(Math.abs(steady.top_kmh - 10.8) < 0.5);
  // Standing still, then 8.4 m/s from 0 on.
  const burst = Array.from({ length: 61 }, (_, i) => {
    const t = Math.round((i * 0.1 - 3) * 10) / 10;
    return [t, 30 + (t > 0 ? 8.4 * t : 0), 20];
  });
  const v = verdict(profile(burst));
  assert.ok(v.impossible_starts > 0);
  assert.equal(v.over_speed, false);
  assert.ok(TEAM_S0_MS * 3.6 > 30);
});
