import assert from "node:assert/strict";
import { test } from "node:test";
import { frameLabel, frameOf, stepTime } from "./frameStep.ts";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("un cuadro a 29.97 fps cae en la rejilla del video, no en 1/30", () => {
  const fps = 30000 / 1001;
  const t = stepTime(10, fps, 1);
  near(t, Math.round(10 * fps + 1) / fps);
  assert.equal(frameOf(t, fps), Math.round(10 * fps) + 1);
  assert.ok(Math.abs(t - 10 - 1 / 30) > 1e-5);
});

test("diez cuadros, hacia atrás y topes del clip", () => {
  near(stepTime(5, 30, -10), 5 - 10 / 30);
  near(stepTime(5, 30, -100, 4.9), 4.9);
  near(stepTime(5, 30, 100, 0, 5.2), Math.floor(5.2 * 30) / 30);
});

test("la etiqueta da el cuadro del video y los cuadros desde el inicio del clip", () => {
  assert.equal(frameLabel(10.1, 30, 10), "cuadro 303 (+3)");
  assert.equal(frameLabel(9.9, 30, 10), "cuadro 297 (-3)");
});
