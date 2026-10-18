import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowHead, curvePath, hull, isValidAnnotation, keyframePositions, labelPoint, resolve, resolveAll } from "./annotations.ts";

// Synthetic positions only.
const kfs = [
  { t: 0, pos: { o1: [10, 10], o2: [20, 50], r1: [60, 30], ball: [10, 10] } },
  { t: 2, pos: { o1: [30, 20], o2: [20, 30], r1: [60, 30], ball: [30, 20] } },
];
const ctx = keyframePositions(kfs);
const ann = (kind, anchors, extra = {}) => ({ id: `a_${kind}`, kind, anchors, t_in: 0, t_out: 3, style: { color: "accent" }, ...extra });
const tok = (identity) => ({ kind: "player", identity });
const pt = (x, y) => ({ kind: "pitch", x, y });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps, `${a} != ${b}`);

test("un ancla de ficha sigue a la ficha: en los fotogramas clave y interpolada entre ellos", () => {
  const a = ann("arrow", [tok("o1"), pt(50, 10)], { t_out: 3 });
  close(resolve(a, 0, ctx).points[0], [10, 10]);
  close(resolve(a, 1, ctx).points[0], [20, 15]);
  close(resolve(a, 2, ctx).points[0], [30, 20]);
  // The fixed end does not move.
  close(resolve(a, 1, ctx).points[1], [50, 10]);
  assert.deepEqual(resolve(a, 1, ctx).players, ["o1", null]);
  assert.equal(resolve(a, 1, ctx).space, "pitch");
});

test("fuera de t_in a t_out el dibujo no sale; t_out ya no cuenta", () => {
  const a = ann("highlight", [tok("o2")], { t_in: 0.5, t_out: 1.5 });
  assert.equal(resolve(a, 0.4, ctx), null);
  assert.ok(resolve(a, 0.5, ctx));
  assert.ok(resolve(a, 1.49, ctx));
  assert.equal(resolve(a, 1.5, ctx), null);
  assert.equal(resolveAll([a, ann("text", [pt(1, 1)])], 1.6, ctx).length, 1);
});

test("una ficha sin posición oculta todo el dibujo: nunca se completa con un punto inventado", () => {
  assert.equal(resolve(ann("line", [tok("o1"), tok("o9")]), 1, ctx), null);
  assert.equal(resolve(ann("highlight", [tok("o9")]), 1, ctx), null);
});

test("texto en pantalla: queda en coordenadas de pantalla", () => {
  const r = resolve(ann("text", [{ kind: "screen", x: 0.1, y: 0.9 }], { style: { color: "ink", label: "Presión" } }), 1, ctx);
  assert.equal(r.space, "screen");
  close(r.points[0], [0.1, 0.9]);
});

test("validez: anclas por tipo, resaltar solo a una ficha, pantalla solo para texto, t_out después de t_in", () => {
  assert.ok(isValidAnnotation(ann("arrow", [pt(1, 1), pt(2, 2), pt(3, 1)])));
  assert.ok(!isValidAnnotation(ann("arrow", [pt(1, 1)])));
  assert.ok(!isValidAnnotation(ann("zone", [pt(1, 1), pt(2, 2)])));
  assert.ok(!isValidAnnotation(ann("highlight", [pt(1, 1)])));
  assert.ok(!isValidAnnotation(ann("line", [pt(1, 1), { kind: "screen", x: 0.5, y: 0.5 }])));
  assert.ok(!isValidAnnotation(ann("text", [pt(1, 1)], { t_in: 2, t_out: 2 })));
});

test("línea entre fichas: va a lo ancho de la cancha en orden aunque se crucen", () => {
  // At t=0: o1 at y 10, r1 at 30, o2 at 50.
  const a = ann("line", [tok("o2"), tok("r1"), tok("o1")]);
  assert.deepEqual(resolve(a, 0, ctx).players, ["o1", "r1", "o2"]);
  // At t=2 o2 (y 30) and r1 (y 30) tie: ordered by x then.
  assert.deepEqual(resolve(a, 2, ctx).players, ["o1", "o2", "r1"]);
});

test("zona con fichas: el contorno se recalcula en cada momento", () => {
  const a = ann("zone", [tok("o1"), tok("o2"), tok("r1"), pt(25, 35)]);
  // At t=0 the fixed point is inside the triangle of the three players: the outline is theirs.
  const at0 = resolve(a, 0, ctx);
  assert.equal(at0.points.length, 3);
  assert.ok(!at0.players.includes(null));
  // At t=2 o2 and r1 have moved up to y 30: the point is outside and becomes a corner.
  const at2 = resolve(a, 2, ctx);
  assert.equal(at2.points.length, 4);
  assert.ok(at2.players.includes(null));
});

test("geometría: contorno convexo, curva por los puntos, punta de flecha y punto del rótulo", () => {
  const h = hull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10]]);
  assert.equal(h.length, 4);
  assert.ok(!h.some((p) => p[0] === 5 && p[1] === 5));
  assert.equal(curvePath([[0, 0], [10, 0]]), "M0 0L10 0");
  assert.match(curvePath([[0, 0], [5, 5], [10, 0]]), /^M0 0C.*C.* 10 0$/);
  const head = arrowHead([[0, 0], [10, 0]], 2);
  close(head[0], [10, 0]);
  close(head[1], [8, 1.1]);
  close(head[2], [8, -1.1]);
  assert.equal(arrowHead([[1, 1], [1, 1]], 2), null);
  close(labelPoint({ kind: "arrow", points: [[0, 0], [10, 0]] }), [5, 0]);
  close(labelPoint({ kind: "zone", points: [[0, 0], [10, 0], [10, 10], [0, 10]] }), [5, 5]);
});
