import assert from "node:assert/strict";
import { test } from "node:test";
import { POSSESSION_DEFAULTS } from "./possession.ts";
import { TECH_GROUPS, diffFromDefaults, possessionParamsOf, resetTech, techChanged, techSummary, withTechParam } from "./tech.ts";
import { PARAM_FIELDS } from "./playgroundPossession.ts";

const match = { match_id: "m", name: "m" };

test("el defecto del tiempo de control es 0.3 s y el de distancia 2 m", () => {
  assert.equal(POSSESSION_DEFAULTS.controlS, 0.3);
  assert.equal(POSSESSION_DEFAULTS.controlM, 2);
  assert.equal(POSSESSION_DEFAULTS.stillS, 4);
});

test("sin tech, el partido usa los defectos; con tech, solo cambia lo tocado", () => {
  assert.deepEqual(possessionParamsOf(match), POSSESSION_DEFAULTS);
  assert.deepEqual(possessionParamsOf(null), POSSESSION_DEFAULTS);
  const m = withTechParam(match, "controlM", 3);
  assert.deepEqual(m.tech, { possession: { controlM: 3 } });
  const p = possessionParamsOf(m);
  assert.equal(p.controlM, 3);
  assert.equal(p.controlS, 0.3);
  assert.deepEqual(techChanged(m), ["controlM"]);
});

test("volver al defecto quita el campo; restablecer quita tech", () => {
  const a = withTechParam(withTechParam(match, "controlM", 3), "stillS", 8);
  assert.deepEqual(techChanged(a).sort(), ["controlM", "stillS"]);
  const b = withTechParam(a, "controlM", POSSESSION_DEFAULTS.controlM);
  assert.deepEqual(b.tech, { possession: { stillS: 8 } });
  const c = resetTech(a);
  assert.equal("tech" in c, false);
  assert.equal(withTechParam(match, "controlM", 2).tech, undefined);
});

test("valores inválidos o fuera de rango en un respaldo se ignoran", () => {
  const m = { ...match, tech: { possession: { controlM: 99, controlS: "x", holdS: 5, nada: 1, joinSegments: false } } };
  const p = possessionParamsOf(m);
  assert.equal(p.controlM, POSSESSION_DEFAULTS.controlM);
  assert.equal(p.controlS, POSSESSION_DEFAULTS.controlS);
  assert.equal(p.holdS, 5);
  assert.equal(p.joinSegments, false);
});

test("cada parámetro editable está en un grupo, una sola vez", () => {
  const keys = TECH_GROUPS.flatMap((g) => g.keys);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of PARAM_FIELDS) assert.ok(keys.includes(f.key), `falta ${f.key}`);
});

test("diffFromDefaults y techSummary", () => {
  assert.deepEqual(diffFromDefaults(POSSESSION_DEFAULTS), {});
  assert.equal(techSummary(match), "Parámetros por defecto");
  assert.match(techSummary(withTechParam(match, "controlS", 0.5)), /tiempo para controlar 0.5 s/);
});
