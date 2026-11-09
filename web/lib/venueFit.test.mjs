import assert from "node:assert/strict";
import { test } from "node:test";
import {
  corners,
  dragCorner,
  dragEdge,
  dragHandle,
  fitRect,
  goalSegments,
  imageToModel,
  impliedMeasures,
  modelDistance,
  modelToImage,
  rectScale,
  referenceGroups,
  resizeToSpec,
  rotateRect,
  stripeBands,
  REFERENCE_GROUPS,
} from "./venueFit.ts";
import { buildVenue } from "./venue.ts";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const closePt = (a, b, eps = 1e-6) => assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps, `${a} != ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

// Always a rectangle: consecutive sides are perpendicular.
function assertRect(r) {
  const c = corners(r);
  for (let i = 0; i < 4; i++) {
    const a = sub(c[(i + 1) % 4], c[i]);
    const b = sub(c[(i + 2) % 4], c[(i + 1) % 4]);
    close(dot(a, b), 0, 1e-6);
  }
}

test("la cancha inicial tiene las proporciones de la sede y cabe en la imagen", () => {
  const r = fitRect(1000, 600, 100, 65);
  close(r.lpx / r.wpx, 100 / 65);
  assert.ok(r.lpx <= 700 + 1e-9 && r.wpx <= 420 + 1e-9);
  close(rectScale(r, 100, 65), r.lpx / 100);
});

test("metros -> imagen -> metros, con giro y volteo", () => {
  const r = { cx: 400, cy: 300, angle: 0.4, lpx: 500, wpx: 320, flip: true };
  closePt(imageToModel(r, 100, 65, modelToImage(r, 100, 65, [37, 21])), [37, 21]);
  // Sin girar ni voltear, la esquina lejana izquierda queda arriba a la izquierda.
  const flat = { cx: 400, cy: 300, angle: 0, lpx: 500, wpx: 320, flip: false };
  closePt(modelToImage(flat, 100, 65, [0, 0]), [150, 140]);
  closePt(modelToImage(flat, 100, 65, [100, 65]), [650, 460]);
});

test("arrastrar una esquina deja fija la opuesta y no deforma", () => {
  const r = { cx: 400, cy: 300, angle: 0.3, lpx: 500, wpx: 320, flip: false };
  const opposite = corners(r)[0];
  const moved = dragCorner(r, 2, [800, 700]);
  assertRect(moved);
  closePt(corners(moved)[0], opposite);
  close(moved.angle, r.angle);
  // La esquina no cruza al otro lado: se queda con el lado mínimo.
  const crossed = dragCorner(r, 2, opposite);
  assert.ok(crossed.lpx >= 4 && crossed.wpx >= 4);
  assertRect(crossed);
});

test("arrastrar el medio de un lado cambia solo esa medida", () => {
  const r = { cx: 400, cy: 300, angle: -0.2, lpx: 500, wpx: 320, flip: true };
  const left = corners(r)[0];
  const e1 = dragEdge(r, 1, [1000, 300]);
  assertRect(e1);
  close(e1.wpx, r.wpx);
  closePt(corners(e1)[0], left);
  const e2 = dragEdge(r, 2, [400, 0]);
  close(e2.lpx, r.lpx);
  assertRect(e2);
});

test("girar sobre el centro y arrastrar con desfase no salta", () => {
  const r = { cx: 0, cy: 0, angle: 0, lpx: 100, wpx: 50, flip: false };
  const t = rotateRect(r, [10, 0], [0, 10]);
  close(t.angle, Math.PI / 2);
  close(t.cx, 0);
  // Tomar la esquina 3 px a un lado y soltarla en el mismo sitio no cambia nada.
  const same = dragHandle(r, "c2", [53, 25], [53, 25]);
  close(same.lpx, 100);
  close(same.wpx, 50);
  const moved = dragHandle(r, "body", [5, 5], [15, -5]);
  closePt([moved.cx, moved.cy], [10, -10]);
});

test("medidas leídas de los lados: con escala, absolutas; sin escala, el ancho sale de la proporción", () => {
  const r = { cx: 0, cy: 0, angle: 0, lpx: 500, wpx: 320, flip: false };
  const abs = impliedMeasures(r, 100, 5);
  close(abs.length, 100);
  close(abs.width, 64);
  assert.equal(abs.absolute, true);
  const rel = impliedMeasures(r, 100, null);
  close(rel.width, 64);
  assert.equal(rel.absolute, false);
  const resized = resizeToSpec(r, 105, 68, 4);
  close(resized.lpx, 420);
  close(resized.wpx, 272);
});

test("la portería se mide en metros a través de la cancha calzada", () => {
  const r = { cx: 500, cy: 300, angle: 0.5, lpx: 1000, wpx: 650, flip: false };
  const a = modelToImage(r, 100, 65, [0, 28.84]);
  const b = modelToImage(r, 100, 65, [0, 36.16]);
  close(modelDistance(r, 100, 65, a, b), 7.32, 1e-9);
  const g = goalSegments(100, 65, 7.32);
  closePt(g[1][0], [100, 28.84]);
  assert.equal(goalSegments(100, 65, undefined), null);
});

test("franjas del pasto: alternas, recortadas a la cancha", () => {
  const bands = stripeBands({ axis: "across", width_m: 10, offset_m: 5 }, 100, 65);
  assert.deepEqual(bands[0], [5, 0, 15, 65]);
  assert.deepEqual(bands[1], [25, 0, 35, 65]);
  assert.deepEqual(stripeBands({ axis: "across", width_m: 10, offset_m: 15 }, 100, 65)[0], [0, 0, 5, 65]);
  assert.ok(bands.every((b) => b[0] >= 0 && b[2] <= 100));
  const along = stripeBands({ axis: "along", width_m: 13, offset_m: 0 }, 100, 65);
  assert.deepEqual(along[0], [0, 0, 100, 13]);
  assert.equal(along.length, 3);
  assert.deepEqual(stripeBands({ axis: "along", width_m: 0, offset_m: 0 }, 100, 65), []);
});

test("cada grupo de referencia encuentra sus puntos en el modelo de la sede", () => {
  const venue = buildVenue({ venue_id: "x", name: "x", kind: "football_overlay", length_m: 100, width_m: 65, soccer_color: "#fff", grid_color: "#ccc" });
  for (const g of REFERENCE_GROUPS) assert.ok(venue.landmarks.some((l) => g.ids(l.id, l.group)), g.id);
  const corners4 = venue.landmarks.filter((l) => REFERENCE_GROUPS.find((g) => g.id === "corners").ids(l.id, l.group));
  assert.equal(corners4.length, 4);
  assert.deepEqual(
    referenceGroups("soccer").map((g) => g.id),
    ["corners", "mid", "boxes"],
  );
});
