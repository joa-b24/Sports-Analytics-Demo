import assert from "node:assert/strict";
import { test } from "node:test";
import { addCut, crossesCut, frozenRuns, inFrozen, removeCut } from "./cameraCuts.ts";

test("crossesCut: un corte es un límite entre dos cuadros", () => {
  const cuts = [{ from: 30, to: 29, kind: "cut" }];
  assert.equal(crossesCut(cuts, 27, 30), true);
  assert.equal(crossesCut(cuts, 24, 27), false);
  assert.equal(crossesCut(cuts, 30, 33), false);
  assert.equal(crossesCut(undefined, 27, 30), false);
});

test("congelado: el tramo repetido se descarta y lo cruza el paso de antes a después", () => {
  const cuts = [{ from: 12, to: 20, kind: "freeze" }];
  assert.equal(inFrozen(cuts, 15), true);
  assert.equal(inFrozen(cuts, 21), false);
  assert.equal(crossesCut(cuts, 9, 21), true);
  assert.equal(crossesCut(cuts, 9, 12), false);
});

test("addCut / removeCut mantienen el orden y reemplazan lo que se traslapa", () => {
  let c = addCut(undefined, { from: 30, to: 29, kind: "cut" });
  c = addCut(c, { from: 10, to: 9, kind: "cut" });
  assert.deepEqual(c.map((x) => x.from), [10, 30]);
  c = addCut(c, { from: 29, to: 35, kind: "freeze" });
  assert.deepEqual(c.map((x) => x.from), [10, 29]);
  assert.deepEqual(removeCut(c, 10).map((x) => x.from), [29]);
});

test("frozenRuns: casi todas las cajas en el mismo sitio dos cuadros seguidos", () => {
  const at = (dx) => new Map([1, 2, 3, 4, 5, 6].map((t) => [t, [t * 5 + dx, 30]]));
  const frames = [
    { frame: 0, at: at(0) },
    { frame: 3, at: at(1) },
    { frame: 6, at: at(1) },
    { frame: 9, at: at(1) },
    { frame: 12, at: at(2) },
  ];
  assert.deepEqual(frozenRuns(frames), [[6, 9]]);
  // Pocas cajas: no se puede decidir.
  assert.deepEqual(frozenRuns([{ frame: 0, at: new Map([[1, [1, 1]]]) }, { frame: 3, at: new Map([[1, [1, 1]]]) }]), []);
});
