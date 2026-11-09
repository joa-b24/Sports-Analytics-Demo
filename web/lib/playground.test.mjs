import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addNegative, addSample, clickToPx, emptySamples, mainSource, parseMetrics, parseSamples, partKey, partNotes, probabilityBands, removeAt,
  sampleStats, setShadow, sourceShares, stepPoint, suggestInstants, totalShares,
} from "./playground.ts";

const file = {
  frames: [{ frame: 0 }, { frame: 3 }, { frame: 6 }, { frame: 9 }],
  ball: [{ frame: 0, source: "manual" }, { frame: 3, source: "auto" }, { frame: 6, source: "interpolated" }, { frame: 99, source: "auto" }],
};

test("sourceShares: cuenta por cuadro muestreado; sin balón es «ninguno»; fuera de los cuadros no cuenta", () => {
  const s = sourceShares(file);
  assert.equal(s.total, 4);
  assert.deepEqual(s.counts, { manual: 1, auto: 1, event: 0, interpolated: 1, none: 1 });
  assert.equal(mainSource(s), "manual");
});

test("mainSource: solo interpolado y ninguno", () => {
  assert.equal(mainSource(sourceShares({ frames: [{ frame: 0 }], ball: [{ frame: 0, source: "interpolated" }] })), "interpolated");
  assert.equal(mainSource(sourceShares({ frames: [{ frame: 0 }], ball: [] })), "none");
  assert.equal(mainSource(sourceShares({ frames: [{ frame: 0 }], ball: [{ frame: 0, source: "raro" }] })), "interpolated");
});

test("partNotes: sin fixed, auto más nuevo, auto sin usar", () => {
  assert.equal(partNotes({ part: "v2_0_1", hasFixed: false, shares: null, autoMtime: null, fixedMtime: null }).length, 1);
  const s = sourceShares(file);
  assert.equal(partNotes({ part: "p", hasFixed: true, shares: s, autoMtime: 5, fixedMtime: 9 }).length, 0);
  assert.match(partNotes({ part: "p", hasFixed: true, shares: s, autoMtime: 10, fixedMtime: 9 })[0], /más nuevo/);
  const none = sourceShares({ frames: [{ frame: 0 }], ball: [] });
  assert.match(partNotes({ part: "p", hasFixed: true, shares: none, autoMtime: 10, fixedMtime: 9 })[0], /no usa/);
});

test("totalShares suma solo las partes con tracks_fixed", () => {
  const t = totalShares([
    { part: "a", hasFixed: true, shares: sourceShares(file), autoMtime: null, fixedMtime: null },
    { part: "b", hasFixed: false, shares: null, autoMtime: null, fixedMtime: null },
  ]);
  assert.equal(t.total, 4);
});

test("partKey", () => {
  assert.equal(partKey("tracks_fixed_v2_10870_31699.json"), "v2_10870_31699");
  assert.equal(partKey("tracks_v3_0_6890.json"), "v3_0_6890");
  assert.equal(partKey("ball_auto_v2_1_2.json"), "v2_1_2");
  assert.equal(partKey("tracks_v2_index.json"), null);
});

test("muestras: añadir, reemplazar en el mismo instante, negativos, sombra y borrar", () => {
  let f = emptySamples("v2", 30);
  f = addSample(f, 10, [100.04, 200.06], false);
  f = addSample(f, 20, [5, 6], true);
  f = setShadow(f, 20, [7, 9]);
  assert.deepEqual(f.samples[1].shadow_px, [7, 9]);
  f = setShadow(f, 10, [1, 1]);
  assert.equal(f.samples[0].shadow_px, null, "la sombra solo es de aéreas");
  f = addNegative(f, 10.05);
  assert.equal(f.samples.length, 1, "un negativo reemplaza a la muestra del mismo instante");
  assert.equal(f.negatives.length, 1);
  f = addSample(f, 10.05, [1, 2], false);
  assert.equal(f.negatives.length, 0);
  f = removeAt(f, 20);
  assert.equal(f.samples.length, 1);
  assert.deepEqual(f.samples[0].px, [1, 2]);
});

test("sampleStats: reparto suelo/aéreo y meta de 100", () => {
  let f = emptySamples("v2", 30);
  for (let i = 0; i < 100; i++) f = addSample(f, i, [1, 1], i % 4 === 0);
  const s = sampleStats(f);
  assert.equal(s.total, 100);
  assert.equal(s.aerial, 25);
  assert.equal(s.ground, 75);
  assert.equal(s.reached, true);
  assert.equal(s.aerialShare, 0.25);
  assert.equal(sampleStats(emptySamples("v2", 30)).aerialShare, null);
});

test("parseSamples: formato del contrato con Python, y descarta lo roto", () => {
  const f = addNegative(addSample(emptySamples("v2", 29.97), 5, [1, 2], true), 9);
  const back = parseSamples(JSON.stringify(f), "v2", 30);
  assert.deepEqual(Object.keys(back), ["kind", "video_id", "fps", "samples", "negatives"]);
  assert.deepEqual(back, f);
  assert.equal(parseSamples("no es json", "v2", 30).samples.length, 0);
  assert.equal(parseSamples(JSON.stringify({ kind: "otro" }), "v2", 30).samples.length, 0);
  const bad = parseSamples(JSON.stringify({ kind: "ball_samples", samples: [{ t_video: 1, px: [1] }, { t_video: 2, px: [3, 4] }], negatives: [{ t_video: "x" }] }), "v2", 30);
  assert.equal(bad.samples.length, 1);
  assert.equal(bad.negatives.length, 0);
});

test("suggestInstants: reparte entre partes, hacia donde faltan muestras, sin repetir", () => {
  const parts = [
    { key: "v2_0_3000", video_id: "v2", fps: 30, start_frame: 0, end_frame: 3000 },
    { key: "v2_6000_9000", video_id: "v2", fps: 30, start_frame: 6000, end_frame: 9000 },
  ];
  const s = suggestInstants(parts, [], 6);
  assert.equal(s.length, 6);
  assert.equal(s.filter((x) => x.part === "v2_0_3000").length, 3);
  assert.equal(new Set(s.map((x) => x.t_video)).size, 6);
  // First part already full of samples: the new ones go to the other.
  const existing = Array.from({ length: 10 }, (_, i) => ({ t_video: 5 + i * 9 }));
  const t = suggestInstants(parts, existing, 4);
  assert.equal(t.every((x) => x.part === "v2_6000_9000"), true);
  assert.deepEqual(suggestInstants(parts, [], 0), []);
  assert.deepEqual(suggestInstants([], [], 3), []);
});

test("parseMetrics: solo valores reales; lo ausente es null", () => {
  assert.equal(parseMetrics(null), null);
  assert.equal(parseMetrics('{"kind":"otro"}'), null);
  const m = parseMetrics('{"kind":"ball_metrics","n_train":80,"n_val":20,"ground":{"n":15,"precision":0.9},"aerial":{"n":5,"precision":null}}');
  assert.equal(m.ground.precision, 0.9);
  assert.equal(m.aerial.precision, null);
  assert.equal(m.trained_at, null);
  assert.equal(parseMetrics('{"kind":"ball_metrics","ground":{"precision":7}}').ground.precision, null);
});

test("bandas de probabilidad y navegación entre puntos", () => {
  const pts = [{ frame: 30, px: 1, py: 1, p: 0.999 }, { frame: 60, px: 1, py: 1, p: 0.96 }, { frame: 90, px: 1, py: 1, p: 0.9 }];
  assert.deepEqual(probabilityBands(pts), { high: 1, mid: 1, low: 1 });
  assert.equal(stepPoint(pts, 30, 1, 1).frame, 60);
  assert.equal(stepPoint(pts, 30, 2, -1).frame, 30);
  assert.equal(stepPoint(pts, 30, 3, 1), null);
});

test("clickToPx: imagen completa y centrada en la caja", () => {
  assert.deepEqual(clickToPx({ w: 960, h: 540 }, { w: 1920, h: 1080 }, { x: 480, y: 270 }), [960, 540]);
  // Caja más alta que el video: barras arriba y abajo.
  assert.deepEqual(clickToPx({ w: 960, h: 740 }, { w: 1920, h: 1080 }, { x: 0, y: 100 }), [0, 0]);
  assert.equal(clickToPx({ w: 960, h: 740 }, { w: 1920, h: 1080 }, { x: 10, y: 50 }), null);
  assert.equal(clickToPx({ w: 0, h: 0 }, { w: 1920, h: 1080 }, { x: 1, y: 1 }), null);
});
