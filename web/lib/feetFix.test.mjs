import assert from "node:assert/strict";
import { test } from "node:test";
import { feetLine, feetPath, parseFeet } from "./feetFix.ts";

const feet = parseFeet(JSON.stringify({ part: "v2_1_9", fps: 30, stride: 3, boxes: { 34307: { 17: [921.8, 853.4], 13: [1006, 927.4] } } }));

test("la línea va a la altura de los pies corregidos y a lo ancho de la caja", () => {
  assert.deepEqual(feetLine(feet, 34307, 13, [980, 800, 1040, 940]), { x1: 980, x2: 1040, y: 927.4 });
});
test("solo las cajas con entrada llevan línea", () => {
  assert.equal(feetLine(feet, 34307, 99, [0, 0, 1, 1]), null);
  assert.equal(feetLine(feet, 34310, 13, [0, 0, 1, 1]), null);
  assert.equal(feetLine(null, 34307, 13, [0, 0, 1, 1]), null);
});
test("archivo ausente o roto: nada que dibujar", () => {
  assert.equal(parseFeet(null), null);
  assert.equal(parseFeet("{no"), null);
  assert.equal(parseFeet("{}"), null);
});
test("ruta del archivo", () => {
  assert.equal(feetPath("m1", "v2_1_9"), "matches/m1/tracking/tracks_v2_1_9.feet.json");
});
