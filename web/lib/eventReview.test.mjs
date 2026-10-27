import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEvents } from "./eventDetect.ts";
import {
  NO_EVENT_FILTER, addMissed, addWindow, allTypeStats, ballCoverage, emptyEventReview, eventSample, eventsAutoFile, filterEvents, parseEventReview, removeMissed, removeWindow, sceneOfEvent, setEventVerdict, typeStats,
  clampEventParam, fieldsOfType, EVENT_PARAM_FIELDS,
} from "./eventReview.ts";

const ev = (i, o = {}) => ({ id: `corner|v1|${i}.00|own`, type: "corner", video_id: "v1", segment_id: "s1", t_video: i, x: 104, y: 1, team: "own", player: null, detail: "", rule: "restart.corner", rule_version: "aaaa", confidence: "high", flags: [], ...o });
const many = (n, o = {}) => Array.from({ length: n }, (_, i) => ev(10 + i * 10, o));

test("precisión sobre lo revisado y veredicto: pocas revisiones, pasa, redefinir", () => {
  const dets = many(30);
  let f = emptyEventReview("v1");
  assert.equal(typeStats("corner", dets, f).verdict, "few");
  for (let i = 0; i < 19; i++) f = setEventVerdict(f, dets[i], "correct", "", "t");
  assert.equal(typeStats("corner", dets, f).verdict, "few");
  f = setEventVerdict(f, dets[19], "incorrect", " nota ", "t");
  let s = typeStats("corner", dets, f);
  assert.deepEqual([s.reviewed, s.correct, s.incorrect, s.precision, s.verdict], [20, 19, 1, 0.95, "pass"]);
  for (let i = 20; i < 30; i++) f = setEventVerdict(f, dets[i], "incorrect", "", "t");
  s = typeStats("corner", dets, f);
  assert.equal(s.verdict, "redefine");
  assert.equal(f.reviews.find((r) => r.id === dets[19].id).note, "nota");
  // El mínimo es configurable.
  assert.equal(typeStats("corner", dets, f, 40).verdict, "few");
  // Quitar la marca.
  assert.equal(setEventVerdict(f, dets[0], null, "").reviews.length, 29);
  assert.equal(allTypeStats(dets, f).find((x) => x.type === "loss").verdict, "few");
});

test("las revisiones de otra versión de la regla no cuentan y se avisan", () => {
  const dets = many(5);
  let f = emptyEventReview("v1");
  for (const d of dets) f = setEventVerdict(f, d, "correct", "", "t");
  const changed = dets.map((d) => ({ ...d, rule_version: "bbbb" }));
  const s = typeStats("corner", changed, f);
  assert.deepEqual([s.reviewed, s.stale], [0, 5]);
  // Misma versión pero la detección ya no sale: huérfana.
  const s2 = typeStats("corner", dets.slice(0, 3), f);
  assert.deepEqual([s2.reviewed, s2.orphan], [3, 2]);
  assert.equal(eventSample(changed, f, 3).length, 3);
});

test("recall solo dentro de las ventanas revisadas completas: encontradas / (encontradas + añadidas)", () => {
  const dets = many(10); // t = 10, 20, ... 100
  let f = emptyEventReview("v1");
  assert.equal(typeStats("corner", dets, f).recall, null);
  for (const d of dets) f = setEventVerdict(f, d, d.t_video === 30 ? "incorrect" : "correct", "", "t");
  f = addWindow(f, 15, 65);
  f = addMissed(f, "corner", 42.5, "no se detectó");
  f = addMissed(f, "corner", 90, "fuera de la ventana");
  f = addMissed(f, "loss", 40, "otro tipo");
  let s = typeStats("corner", dets, f);
  // En 15-65: 20, 40, 50, 60 correctas (30 incorrecta) + 1 añadida.
  assert.deepEqual([s.found, s.truth, s.recall], [4, 5, 0.8]);
  assert.equal(s.windowPending, 0);
  assert.equal(typeStats("loss", dets, f).recall, 0);
  // Sin revisar una detección dentro de la ventana, el recall avisa de que no es final.
  f = setEventVerdict(f, dets[3], null, "");
  s = typeStats("corner", dets, f);
  assert.equal(s.windowPending, 1);
  assert.equal(addWindow(f, 20, 20), null);
  assert.equal(addWindow(f, 30, 10), null);
  f = removeWindow(f, f.windows[0].id);
  assert.equal(typeStats("corner", dets, f).recall, null);
  f = removeMissed(f, f.missed[0].id);
  assert.equal(f.missed.length, 2);
});

test("muestra repartida por tipo: completa lo que falta para el mínimo, sin revisadas, determinista", () => {
  const dets = [...many(40), ...many(4, { type: "loss", id: undefined }).map((e, i) => ({ ...e, type: "loss", id: `loss|v1|${e.t_video}.00|own` }))];
  let f = emptyEventReview("v1");
  f = setEventVerdict(f, dets[0], "correct", "", "t");
  const s = eventSample(dets, f);
  assert.equal(s.filter((e) => e.type === "corner").length, 19);
  assert.equal(s.filter((e) => e.type === "loss").length, 4);
  assert.ok(!s.some((e) => e.id === dets[0].id));
  assert.deepEqual(s, eventSample(dets, f));
  // Repartida en el partido: la última está cerca del final.
  const c = s.filter((e) => e.type === "corner");
  assert.ok(c[c.length - 1].t_video > 300);
  assert.equal(eventSample(dets, f, 5, 3).filter((e) => e.type === "corner").length, 3);
});

test("archivos: leer y escribir las revisiones; un archivo dañado empieza vacío; filtros", () => {
  const dets = many(4);
  let f = emptyEventReview("v1");
  f = setEventVerdict(f, dets[0], "correct", "", "t");
  f = addMissed(f, "loss", 12, "x", "t");
  f = addWindow(f, 0, 50, "t");
  const back = parseEventReview(JSON.stringify(f), "v1");
  assert.deepEqual(back, f);
  assert.equal(parseEventReview("{no", "v1").reviews.length, 0);
  assert.equal(parseEventReview(null, "v1").min_reviews, 20);
  assert.equal(filterEvents(dets, { ...NO_EVENT_FILTER, state: "pending" }, f).length, 3);
  assert.equal(filterEvents(dets, { ...NO_EVENT_FILTER, state: "correct" }, f).length, 1);
  assert.equal(filterEvents([...dets, ev(99, { team: "opp", id: "z" })], { ...NO_EVENT_FILTER, team: "opp" }, f).length, 1);
  const auto = eventsAutoFile("v1", dets, "t");
  assert.equal(auto.events.length, 4);
  assert.equal(auto.rule_versions.corner, "aaaa");
});

test("cobertura de balón por parte: solo cuenta lo cercano a una marca medida dentro de los tramos de juego", () => {
  const n = 100; // 10 s a 0.1 s
  const frames = Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: [] }));
  const ball = frames.map((fr, i) => ({ frame: fr.frame, x: 50, y: 34, source: i === 10 ? "manual" : "interpolated" }));
  const file = { kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, people: [], ball, frames };
  const [r] = ballCoverage([{ file, ownRight: true }], { v1: [{ segment_id: "s", start: 0, end: 10, tipo: "juego" }] }, 2);
  // Marca en t = 1 s: cubre de 0 a 3 s.
  assert.ok(Math.abs(r.covered_s - 3.1) < 0.2, `cubierto ${r.covered_s}`);
  assert.equal(r.play_s, 10);
  assert.ok(r.share > 0.25 && r.share < 0.4);
  assert.equal(r.manual, 1);
});

test("parámetros: cada tipo muestra solo los suyos y los valores quedan dentro de los límites", () => {
  assert.ok(fieldsOfType("cross").some((f) => f.key === "crossLateralM"));
  assert.ok(!fieldsOfType("corner").some((f) => f.key === "crossLateralM"));
  const f = EVENT_PARAM_FIELDS.find((x) => x.key === "restS");
  assert.equal(clampEventParam(f, 99, 1.5), f.max);
  assert.equal(clampEventParam(f, NaN, 1.5), 1.5);
});

test("escena de una detección: posiciones en ese instante, o nada si ninguna parte la cubre", () => {
  const frames = Array.from({ length: 20 }, (_, i) => ({ frame: i * 3, positions: [{ id: 1, x: 10 + i, y: 20, source: "auto" }] }));
  const file = { kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 60, stride: 3, people: [{ id: 1, team: "own", player_id: "Ana", tracks: [1] }], ball: [{ frame: 6, x: 30, y: 30, source: "manual" }], frames };
  const parts = [{ file, ownRight: true }];
  const sc = sceneOfEvent(parts, { video_id: "v1", t_video: 0.2 });
  assert.equal(sc.dots.length, 1);
  assert.equal(sceneOfEvent(parts, { video_id: "v1", t_video: 50 }), null);
  assert.equal(detectEvents(parts, {}, []).length, 0);
});
