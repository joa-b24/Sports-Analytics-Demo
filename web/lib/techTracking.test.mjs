import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyEventReview } from "./eventReview.ts";
import { TRACKING_DEFAULTS, TRACKING_FIELDS, ballRequestOf, clampTracking, fillRequestOf, matchOfFolder, resetTracking, reviewFigures, trackingChanged, trackingFieldOf, trackingParamsOf, withTrackingParam } from "./techTracking.ts";

const match = { match_id: "m", name: "m" };

test("defaults de la analista", () => {
  assert.deepEqual(trackingParamsOf(match), TRACKING_DEFAULTS);
  assert.deepEqual(trackingParamsOf(null), TRACKING_DEFAULTS);
  const d = TRACKING_DEFAULTS;
  assert.deepEqual([d.fillMaxCost, d.fillMinEntryP, d.fillInternalP, d.fillRejectClose, d.unnamedCost, d.doubtMinP, d.doubtMaxCost], [1, 0.8, 0.995, true, 2, 0.8, 1]);
  assert.deepEqual([d.greenMinS, d.greenMaxS, d.ballAcceptP, d.ballJumpMs, d.gStepS, d.searchMarginM], [2, 7, 0.95, 30, 1, 3]);
  // Cada campo tiene su defecto dentro de su rango.
  for (const f of TRACKING_FIELDS) assert.ok(d[f.key] >= f.min && d[f.key] <= f.max, f.key);
});

test("guardar solo lo tocado, volver al defecto lo quita y restablecer borra todo", () => {
  const a = withTrackingParam(match, "gStepS", 2);
  assert.deepEqual(a.tech, { tracking: { gStepS: 2 } });
  assert.equal(trackingParamsOf(a).gStepS, 2);
  const b = withTrackingParam(a, "fillRejectClose", false);
  assert.deepEqual(trackingChanged(b).sort(), ["fillRejectClose", "gStepS"]);
  assert.deepEqual(withTrackingParam(b, "gStepS", 1).tech, { tracking: { fillRejectClose: false } });
  assert.equal(resetTracking(b).tech, undefined);
  // No toca lo que otros guardaron en tech.
  const c = withTrackingParam({ ...match, tech: { possession: { controlM: 3 } } }, "gStepS", 3);
  assert.deepEqual(c.tech, { possession: { controlM: 3 }, tracking: { gStepS: 3 } });
  assert.deepEqual(resetTracking(c).tech, { possession: { controlM: 3 } });
});

test("validación: valores fuera de rango o mal tipados se ignoran; el rango verde no se invierte", () => {
  const bad = { ...match, tech: { tracking: { gStepS: 99, ballAcceptP: "0.9", fillMaxCost: NaN, greenMinS: 5, nope: 1, fillRejectClose: "no" } } };
  const p = trackingParamsOf(bad);
  assert.equal(p.gStepS, 1);
  assert.equal(p.ballAcceptP, 0.95);
  assert.equal(p.fillMaxCost, 1);
  assert.equal(p.fillRejectClose, true);
  assert.equal(p.greenMinS, 5);
  // Mínimo mayor que máximo en un respaldo a mano: vuelve a 2 y 7.
  const inv = { ...match, tech: { tracking: { greenMinS: 10, greenMaxS: 4 } } };
  assert.deepEqual([trackingParamsOf(inv).greenMinS, trackingParamsOf(inv).greenMaxS], [2, 7]);
  // Desde la interfaz, un mínimo por encima del máximo se rechaza.
  assert.equal(withTrackingParam(match, "greenMinS", 8), match);
  assert.equal(withTrackingParam(match, "greenMaxS", 1.5), match);
  assert.ok(withTrackingParam(match, "greenMaxS", 10) !== match);
  const f = trackingFieldOf("gStepS");
  assert.equal(clampTracking(f, 50, 1), 10);
  assert.equal(clampTracking(f, 0, 1), 0.2);
  assert.equal(clampTracking(f, NaN, 1), 1);
});

test("las peticiones al CLI llevan solo lo que difiere del defecto; el balón siempre su probabilidad", () => {
  assert.deepEqual(fillRequestOf(match), {});
  const m = withTrackingParam(withTrackingParam(withTrackingParam(match, "fillMaxCost", 1.5), "unnamedCost", 3), "fillRejectClose", false);
  assert.deepEqual(fillRequestOf(m), { unnamedCost: 3, seg: { maxCost: 1.5, rejectClose: false } });
  assert.deepEqual(ballRequestOf(match), { accept: 0.95 });
  assert.deepEqual(ballRequestOf(withTrackingParam(match, "ballAcceptP", 0.9)), { accept: 0.9 });
});

test("matchOfFolder", () => {
  const ms = [{ folder: "a" }, { folder: "b" }, {}];
  assert.equal(matchOfFolder(ms, "b"), ms[1]);
  assert.equal(matchOfFolder(ms, undefined), undefined);
  assert.equal(matchOfFolder(ms, "zz"), undefined);
});

test("veredicto de los eventos automáticos: precisión sobre lo revisado", () => {
  const r = (id, type, verdict) => ({ id, type, video_id: "v1", t_video: 1, x: 0, y: 0, team: "own", rule_version: "1", verdict, note: "", at: "" });
  const f = { ...emptyEventReview("v1"), min_reviews: 3, reviews: [r("1", "corner", "correct"), r("2", "corner", "correct"), r("3", "corner", "correct"), r("4", "throw_in", "correct"), r("5", "throw_in", "incorrect"), r("6", "goal_kick", "incorrect"), r("7", "goal_kick", "incorrect"), r("8", "goal_kick", "incorrect")] };
  const fig = reviewFigures([f]);
  assert.equal(fig.corner.verdict, "pass");
  assert.equal(fig.corner.precision, 1);
  assert.equal(fig.throw_in.verdict, "few");
  assert.equal(fig.goal_kick.verdict, "redefine");
  assert.equal(fig.penalty.verdict, "none");
  assert.equal(fig.penalty.precision, null);
  assert.equal(reviewFigures([]).corner.verdict, "none");
});

test("el umbral de salto del balón sale de Detalles técnicos", async () => {
  const { ballJumpFrames } = await import("./parts.ts");
  const pts = [0, 3, 6].map((frame, i) => ({ frame, x: i === 1 ? 4 : 0, y: 0, source: "auto" })); // 40 m/s hacia fuera y de vuelta
  assert.ok(ballJumpFrames(pts, 30).has(3));
  assert.equal([...ballJumpFrames(pts, 30, 1, 1, 1, trackingParamsOf(withTrackingParam(match, "ballJumpMs", 50)).ballJumpMs)].length, 0);
});

test("aceptar seguras y muestras: defectos (apagado, 0.98, 45 s, 8) y validación", () => {
  const d = TRACKING_DEFAULTS;
  assert.deepEqual([d.autoAcceptP, d.autoAcceptOn, d.sampleGapS, d.sampleMinPlayers], [0.98, false, 45, 8]);
  const f = trackingFieldOf("autoAcceptP");
  assert.deepEqual([f.min, f.max], [0.9, 0.999]);
  const a = withTrackingParam(withTrackingParam(match, "autoAcceptOn", true), "autoAcceptP", 0.99);
  assert.deepEqual(a.tech, { tracking: { autoAcceptOn: true, autoAcceptP: 0.99 } });
  assert.equal(trackingParamsOf(a).autoAcceptOn, true);
  // Volver al defecto lo quita.
  assert.equal(withTrackingParam(withTrackingParam(a, "autoAcceptOn", false), "autoAcceptP", 0.98).tech, undefined);
  // Fuera de rango o mal tipado: se ignora.
  const bad = { ...match, tech: { tracking: { autoAcceptP: 0.5, sampleGapS: 1, sampleMinPlayers: 40, autoAcceptOn: "sí" } } };
  assert.deepEqual([trackingParamsOf(bad).autoAcceptP, trackingParamsOf(bad).sampleGapS, trackingParamsOf(bad).sampleMinPlayers, trackingParamsOf(bad).autoAcceptOn], [0.98, 45, 8, false]);
  // No viajan al CLI del relleno.
  assert.deepEqual(fillRequestOf(a), {});
});
