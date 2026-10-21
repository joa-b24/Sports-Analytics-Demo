import assert from "node:assert/strict";
import { test } from "node:test";
import { IX, crossing, landmarksWith, linePoints, namedLines } from "./calibLines.ts";
import { apply, fitHomography } from "./homography.ts";
import { buildVenue } from "./venue.ts";

const soccer = buildVenue({ venue_id: "v", name: "Prueba", kind: "soccer", length_m: 100, width_m: 64, soccer_color: "#fff", grid_color: "#ccc" });
const overlay = buildVenue({ venue_id: "w", name: "Prueba", kind: "football_overlay", length_m: 100, width_m: 65, soccer_color: "#ff0", grid_color: "#ccc" });

test("las líneas del modelo salen de sus puntos y siguen las medidas de la sede", () => {
  const ls = namedLines(soccer);
  const box = ls.find((l) => l.id === "s_box_l");
  assert.deepEqual([box.a[0], box.b[0]], [16.5, 16.5]);
  const custom = buildVenue({ ...soccer.spec, box_depth_m: 15 });
  assert.equal(namedLines(custom).find((l) => l.id === "s_box_l").a[0], 15);
  assert.ok(namedLines(overlay).some((l) => l.id === "f_yl0"));
  assert.ok(!ls.some((l) => l.family === "football"));
});

test("cruce de dos rectas, y nada si son paralelas", () => {
  assert.deepEqual(crossing([0, 0], [10, 0], [5, -5], [5, 5]), [5, 0]);
  assert.equal(crossing([0, 0], [10, 0], [0, 1], [10, 1.1]), null);
});

test("dos líneas marcadas dan el punto donde se cruzan, aunque quede fuera del cuadro", () => {
  // A camera: model meters -> pixels through a known homography (the inverse of a fit on 4 points).
  const model = [[0, 0], [100, 0], [100, 64], [0, 64]];
  const image = [[200, 300], [1700, 280], [1900, 1000], [0, 1040]];
  const toPx = fitHomography(model, image);
  const px = (x, y) => apply(toPx, [x, y]);
  // The far sideline seen between x = 30 and 60, and the left box front seen near the camera only.
  const lines = [
    { line_id: "s_side_f", a: px(30, 0), b: px(60, 0) },
    { line_id: "s_box_l", a: px(16.5, 40), b: px(16.5, 50) },
  ];
  const pts = linePoints(soccer, lines);
  assert.equal(pts.length, 1);
  const p = pts[0];
  assert.equal(p.landmark.id, `${IX}s_box_l+s_side_f`);
  assert.deepEqual([p.landmark.x, p.landmark.y].map((v) => Math.round(v * 100) / 100), [16.5, 0]);
  const truth = px(16.5, 0);
  assert.ok(Math.hypot(p.px - truth[0], p.py - truth[1]) < 1e-6);
});

test("las paralelas no dan punto y las ids de las anclas se resuelven con sus líneas", () => {
  const lines = [
    { line_id: "s_side_f", a: [0, 0], b: [10, 0] },
    { line_id: "s_side_n", a: [0, 100], b: [10, 100] },
    { line_id: "s_half", a: [50, 0], b: [50, 100] },
  ];
  const pts = linePoints(soccer, lines);
  assert.equal(pts.length, 2);
  const map = landmarksWith(soccer, lines);
  assert.ok(map.has(`${IX}s_half+s_side_f`) && map.has("sc_c"));
});

test("las líneas extra de la sede (borde del pasto) entran como líneas y cruzan con las de la cancha", () => {
  const v = buildVenue({ ...soccer.spec, ref_lines: [{ id: "pasto", label: "Fin del pasto lejano", axis: "along", at_m: -1 }] });
  const l = namedLines(v).find((x) => x.id === "r_pasto");
  assert.equal(l.label, "Fin del pasto lejano");
  assert.equal(l.a[1], -1);
  assert.equal(l.exact, false);
  const pts = linePoints(v, [
    { line_id: "r_pasto", a: [0, 100], b: [100, 100] },
    { line_id: "s_half", a: [50, 0], b: [50, 300] },
  ]);
  assert.deepEqual([pts[0].landmark.x, pts[0].landmark.y], [50, -1]);
});
