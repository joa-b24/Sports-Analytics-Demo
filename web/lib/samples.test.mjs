import assert from "node:assert/strict";
import { test } from "node:test";
import { findSamples, nameInSample, sampleBoxes, sampleFocus, sampleProgress, SAMPLE_COLORS } from "./samples.ts";
import { emptyEdits, dropBoxes } from "./tracks.ts";

const OWN = [120, 128, 128];
const OPP = [200, 128, 180];
// Frames every 3 from 0 to `end`; `own(frame)` = number of own boxes (tracks 1..n), plus 2 rivals always.
function mk(end, own) {
  const frames = [];
  for (let frame = 0; frame <= end; frame += 3) {
    const boxes = [];
    for (let i = 1; i <= own(frame); i++) boxes.push([i, i * 10, 0, i * 10 + 8, 30, 0.9, ...OWN, i, 5, true, "own"]);
    for (const t of [90, 91]) boxes.push([t, 0, 0, 8, 30, 0.9, ...OPP, 50, 20, true, "opp"]);
    frames.push({ frame, H: null, boxes });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: end, stride: 3, image_w: 1920, image_h: 1080, venue: { length_m: 105, width_m: 68 }, frames };
}

test("muestras: cuadros con muchas propias, separados, en orden de tiempo", () => {
  // 60 s; 9 propias a los 10 s y a los 12 s (juntos), 10 propias a los 40 s, 6 propias en el resto.
  const f = mk(60 * 30, (fr) => (fr === 300 || fr === 360 ? 9 : fr === 1200 ? 10 : 6));
  const s = findSamples(f, 20, 8);
  // Gana el de 10; del par cercano entra uno solo (el primero en empate).
  assert.deepEqual(s, [{ frame: 300, own: 9 }, { frame: 1200, own: 10 }]);
  // Separación menor: entran ambos del par.
  assert.deepEqual(findSamples(f, 1, 8).map((x) => x.frame), [300, 360, 1200]);
  // El mínimo se respeta, y los rivales no cuentan.
  assert.deepEqual(findSamples(f, 20, 11), []);
  assert.equal(findSamples(f, 20, 6).length >= 3, true);
  // Entre dos muestras siempre hay al menos la separación.
  const all = findSamples(f, 20, 6);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].frame - all[i - 1].frame >= 20 * 30);
});

test("muestras: un cuadro con más de 11 propias (cajas dobles) pesa menos que uno completo", () => {
  const f = mk(30 * 30, (fr) => (fr === 300 ? 14 : fr === 330 ? 11 : 9));
  const s = findSamples(f, 20, 8);
  assert.deepEqual(s.map((x) => x.frame), [330]);
  assert.equal(findSamples(f, 20, 8).length, 1);
  // Con solo uno de 14 y los demás de 9, el de 9 gana (pesa 9 contra 8) y el de 14 queda dentro de su separación.
  const g = mk(30 * 30, (fr) => (fr === 300 ? 14 : 9));
  assert.equal(findSamples(g, 20, 8).some((x) => x.frame === 300), false);
  assert.equal(findSamples(g, 20, 8)[0].frame, 0);
});

test("cajas de una muestra: nombre por ancla o por la mesa, descartadas fuera, orden de izquierda a derecha", () => {
  const f = mk(30, () => 4);
  const names = new Map([[2, "Bea"]]);
  const anchors = [{ frame: 0, track: 1, player: "Ana" }, { frame: 3, track: 3, player: "Cata" }];
  const b = sampleBoxes(f, emptyEdits("k"), 0, anchors, names);
  assert.deepEqual(b.map((x) => [x.track, x.name, x.anchored]), [[1, "Ana", true], [2, "Bea", false], [3, null, false], [4, null, false]]);
  assert.deepEqual(sampleProgress(b), { named: 2, total: 4 });
  // Una caja descartada no se ofrece.
  const dropped = dropBoxes(emptyEdits("k"), [{ track: 4, frame: 0 }]);
  assert.equal(sampleBoxes(f, dropped, 0, [], new Map()).length, 3);
  // «No es jugadora» no cuenta como jugadora a nombrar.
  const no = sampleBoxes(f, emptyEdits("k"), 0, [{ frame: 0, track: 4, player: "__no__" }], new Map());
  assert.deepEqual(sampleProgress(no), { named: 0, total: 3 });
  assert.deepEqual(sampleBoxes(f, emptyEdits("k"), 999, [], new Map()), []);
});

test("nombrar en la muestra: un ancla por caja y la misma jugadora no queda en dos cajas del cuadro", () => {
  const a0 = [{ frame: 0, track: 1, player: "Ana" }, { frame: 30, track: 1, player: "Ana" }];
  // Ana pasa a la caja 2 en el cuadro 0: la caja 1 de ese cuadro pierde el nombre; el cuadro 30 no se toca.
  const a1 = nameInSample(a0, { frame: 0, track: 2, player: "Ana" });
  assert.deepEqual(a1.map((x) => [x.frame, x.track, x.player]), [[0, 2, "Ana"], [30, 1, "Ana"]]);
  // Renombrar una caja reemplaza su ancla.
  const a2 = nameInSample(a1, { frame: 0, track: 2, player: "Bea" });
  assert.deepEqual(a2.map((x) => [x.frame, x.track, x.player]), [[0, 2, "Bea"], [30, 1, "Ana"]]);
  // «No es jugadora» puede repetirse en el cuadro.
  const a3 = nameInSample(nameInSample([], { frame: 0, track: 5, player: "__no__" }), { frame: 0, track: 6, player: "__no__" });
  assert.equal(a3.length, 2);
});

test("lo que se resalta en el video: una marca por caja, con color según su estado", () => {
  const f = mk(30, () => 3);
  const b = sampleBoxes(f, emptyEdits("k"), 0, [{ frame: 0, track: 1, player: "Ana" }], new Map());
  const focus = sampleFocus(0, b, 2, (n) => n.slice(0, 1));
  assert.equal(focus.frame, 0);
  assert.deepEqual(focus.marks.map((m) => [m.track, m.label, m.color]), [[1, "A", SAMPLE_COLORS.named], [2, "?", SAMPLE_COLORS.selected], [3, "?", SAMPLE_COLORS.open]]);
});
