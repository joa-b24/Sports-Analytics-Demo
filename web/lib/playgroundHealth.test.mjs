import assert from "node:assert/strict";
import { test } from "node:test";
import { currentReviews, sumReviews, accuracyMetric, ballIndicator, ballMeasuredByVideo, lightOf, passesIndicator, possessionCover, possessionIndicator, worstLight } from "./playgroundHealth.ts";

const S = (o) => ({ video_id: "v1", t0: 0, t1: 1, src: "manual", kind: "control", ...o });

test("lightOf: umbrales 80 y 50, sin dato sin color", () => {
  assert.equal(lightOf(0.8), "green");
  assert.equal(lightOf(0.79), "amber");
  assert.equal(lightOf(0.5), "amber");
  assert.equal(lightOf(0.49), "red");
  assert.equal(lightOf(null), "none");
  assert.equal(lightOf(NaN), "none");
  assert.equal(worstLight(["green", "none", "amber"]), "amber");
  assert.equal(worstLight([]), "none");
});

test("balón medido: sobre cuadros vivos, por video, sin contar los muertos", () => {
  const rows = ballMeasuredByVideo([S({}), S({ src: "auto" }), S({ src: "interp" }), S({ src: "interp", kind: "dead" }), S({ video_id: "v2", src: "interp" })], (v) => `Video ${v}`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].alive_s, 3);
  assert.ok(Math.abs(rows[0].share - 2 / 3) < 1e-9);
  assert.equal(rows[1].share, 0);
  const ind = ballIndicator(rows);
  assert.equal(ind.metrics[0].light, "amber");
  assert.equal(ind.metrics[1].light, "red");
  assert.match(ind.metrics[0].label, /Video v1/);
});

test("sin partes: el balón no inventa cifra", () => {
  const ind = ballIndicator([]);
  assert.equal(ind.metrics[0].light, "none");
  assert.match(ind.metrics[0].text, /sin partes/);
});

test("acierto: sin revisiones es sin revisar; con pocas nunca verde", () => {
  assert.equal(accuracyMetric("R", "Pases", { reviewed: 0, correct: 0 }).light, "none");
  assert.match(accuracyMetric("R", "Pases", { reviewed: 0, correct: 0 }).text, /sin revisar/);
  const few = accuracyMetric("R", "Pases", { reviewed: 5, correct: 5 });
  assert.equal(few.light, "amber");
  assert.ok(few.note);
  assert.equal(accuracyMetric("R", "Pases", { reviewed: 30, correct: 27 }).light, "green");
  assert.equal(accuracyMetric("R", "Pases", { reviewed: 30, correct: 10 }).light, "red");
  assert.match(accuracyMetric("R", "Pases", { reviewed: 30, correct: 27 }).text, /revisados: 30 · correctos: 27 \(90 %/);
});

test("posesión: cobertura, contacto y revisión; sin resumen todo es sin dato", () => {
  const ind = possessionIndicator({ coverage: 0.9, contact_coverage: 0.4 }, { reviewed: 0, correct: 0 });
  assert.deepEqual(ind.metrics.map((m) => m.light), ["green", "red", "none"]);
  const empty = possessionIndicator(null, { reviewed: 0, correct: 0 });
  assert.deepEqual(empty.metrics.map((m) => m.light), ["none", "none", "none"]);
  assert.equal(passesIndicator({ reviewed: 12, correct: 12 }).metrics[0].light, "green");
  assert.match(ind.rule, /80 %/);
});

test("possessionCover: siempre dice sobre qué cobertura y avisa si es baja", () => {
  const ok = possessionCover({ coverage: 0.82, contact_coverage: 0.61 });
  assert.match(ok.text, /82 % del tiempo vivo/);
  assert.match(ok.text, /61 %/);
  assert.equal(ok.warning, null);
  const low = possessionCover({ coverage: 0.4, contact_coverage: 0.2 });
  assert.ok(low.warning);
  assert.match(possessionCover(null).text, /desconocida/);
  assert.equal(possessionCover(null).warning, null);
  assert.ok(possessionCover({ coverage: 0.9, contact_coverage: 0.3 }).warning);
});

test("revisiones de otros parámetros no cuentan y se avisa", () => {
  const c = currentReviews([{ id: "a", verdict: "correct" }, { id: "b", verdict: "incorrect" }, { id: "z", verdict: "correct" }], new Set(["a", "b"]));
  assert.deepEqual(c, { reviewed: 2, correct: 1, stale: 1 });
  const m = accuracyMetric("R", "Intervalos", sumReviews([c, { reviewed: 0, correct: 0, stale: 2 }]));
  assert.match(m.note, /3 revisiones/);
  assert.equal(m.light, "amber");
});
