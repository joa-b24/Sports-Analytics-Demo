import assert from "node:assert/strict";
import { test } from "node:test";
import { nudge, placementFromTwo, toImage, toModel } from "./overlay.ts";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps, `${a} != ${b}`);

test("dos puntos colocan el modelo: caen justo donde se marcaron, con giro y escala", () => {
  const a = [0, 0];
  const b = [100, 0];
  const p = placementFromTwo(a, b, [50, 400], [50, 100], false);
  close(toImage(p, a), [50, 400]);
  close(toImage(p, b), [50, 100]);
  assert.ok(Math.abs(p.scale - 3) < 1e-9);
  // Model x points up in the image: model y (towards the camera) points right.
  close(toImage(p, [0, 10]), [80, 400]);
  close(toModel(p, toImage(p, [37, 21])), [37, 21]);
});

test("espejo: el mismo par de puntos con el modelo volteado deja la banda cercana del otro lado", () => {
  const p = placementFromTwo([0, 0], [100, 0], [50, 400], [50, 100], true);
  close(toImage(p, [100, 0]), [50, 100]);
  close(toImage(p, [0, 10]), [20, 400]);
  close(toModel(p, toImage(p, [37, 21])), [37, 21]);
  assert.equal(placementFromTwo([0, 0], [0, 0], [1, 1], [2, 2], false), null);
});

test("ajuste fino: girar y escalar dejan el pivote en su píxel; mover lo lleva a lo largo de los ejes del modelo", () => {
  const p = placementFromTwo([0, 0], [100, 0], [0, 0], [200, 0], false); // 2 px/m, no turn
  const pivot = [50, 32];
  const turned = nudge(p, pivot, { turn: 0.1, zoom: 1.01 });
  close(toImage(turned, pivot), toImage(p, pivot));
  assert.ok(Math.abs(turned.scale - 2.02) < 1e-9);
  const moved = nudge(p, pivot, { dx: 0.5, dy: -1 });
  close(toImage(moved, pivot), [101, 62]);
  // Flipped, +dy still moves along model y (which points up in the image).
  const f = placementFromTwo([0, 0], [100, 0], [0, 0], [200, 0], true);
  close(toImage(nudge(f, pivot, { dy: 1 }), pivot), [100, -66]);
});
