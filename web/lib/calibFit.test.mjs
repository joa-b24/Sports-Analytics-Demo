import assert from "node:assert/strict";
import { test } from "node:test";
import { constraintPoints, fitEllipse, fitHybrid } from "./calibFit.ts";
import { apply, invert } from "./homography.ts";

// A camera from the near side: meters -> pixels with real perspective (far side up). Synthetic, no real venue.
const P = [14.0, -6.0, 300.0, 0.4, 9.0, 420.0, 0.0, -0.004, 1.0];
const toPx = (x, y) => apply(P, [x, y]);
const truth = invert(P);
const C = [52.5, 34];
const R = 9.15;
const arcPx = (from, to, n, noise = 0) => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  return Array.from({ length: n }, (_, i) => {
    const t = ((from + ((to - from) * i) / (n - 1)) * Math.PI) / 180;
    const p = toPx(C[0] + R * Math.cos(t), C[1] + R * Math.sin(t));
    return [p[0] + rnd(), p[1] + rnd()];
  });
};
const err = (H) => {
  const probe = [[30, 10], [52.5, 34], [80, 60], [20, 60], [90, 5]].map(([x, y]) => toPx(x, y));
  return Math.max(...probe.map((p) => {
    const a = apply(H, p);
    const b = apply(truth, p);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }));
};
// The near sideline (y = 68) and where the grass ends, 1 m beyond the far one (y = -1): two parallel lines.
const lines = [
  { pts: [toPx(30, 68), toPx(70, 68)], ma: [0, 68], mb: [105, 68] },
  { pts: [toPx(35, -1), toPx(75, -1)], ma: [0, -1], mb: [105, -1] },
];

test("elipse: centro y semiejes de un óvalo conocido, aunque solo se vea un pedazo", () => {
  const pts = Array.from({ length: 12 }, (_, i) => {
    const t = (i / 11) * Math.PI * 0.9;
    return [400 + 120 * Math.cos(t), 300 + 40 * Math.sin(t)];
  });
  const e = fitEllipse(pts);
  assert.ok(Math.hypot(e.center[0] - 400, e.center[1] - 300) < 1e-6);
  assert.deepEqual([Math.round(Math.max(e.a, e.b)), Math.round(Math.min(e.a, e.b))], [120, 40]);
  assert.equal(fitEllipse(Array.from({ length: 6 }, (_, i) => [i, 2 * i])), null);
});

test("el círculo central y dos líneas paralelas bastan para calibrar, sin un solo punto", () => {
  const f = fitHybrid({ points: [], lines, arcs: [{ pts: arcPx(0, 360, 16), c: C, r: R }] });
  assert.ok(f, "sin ajuste");
  assert.ok(err(f.H) < 0.01, `error ${err(f.H)}`);
  assert.ok(f.rms < 0.01);
});

test("con medio círculo y medio píxel de ruido el error queda bajo el metro", () => {
  const f = fitHybrid({ points: [], lines, arcs: [{ pts: arcPx(180, 360, 9, 0.5), c: C, r: R }] });
  assert.ok(f && err(f.H) < 1, `error ${f && err(f.H)}`);
});

test("sin suficientes datos no inventa", () => {
  assert.equal(fitHybrid({ points: [], lines: [lines[0]], arcs: [{ pts: arcPx(0, 90, 4), c: C, r: R }] }), null);
});

test("los clics de arcos y líneas salen como pares de puntos sobre el modelo", () => {
  const input = { points: [], lines, arcs: [{ pts: arcPx(0, 360, 8), c: C, r: R }] };
  const f = fitHybrid(input);
  const pairs = constraintPoints(f.H, input);
  assert.equal(pairs.length, 8 + 4);
  for (const p of pairs.filter((q) => q.kind === "arc")) assert.ok(Math.abs(Math.hypot(p.m[0] - C[0], p.m[1] - C[1]) - R) < 1e-9);
  for (const p of pairs.filter((q) => q.kind === "line")) assert.ok([68, -1].some((y) => Math.abs(p.m[1] - y) < 1e-9));
});
