import assert from "node:assert/strict";
import { test } from "node:test";
import { linkModelNotice, linkModelStatus } from "./linkModel.ts";
import { runArgv, runPaths, validateRunArgs, errorMessage } from "./runTask.ts";

const f = (name, mtime = 100) => ({ name, dir: false, mtime });

test("linkModelStatus: partes con etiquetas y su track, videos en orden", () => {
  const s = linkModelStatus([f("labels_v1_0_9.json"), f("tracks_v1_0_9.json"), f("labels_v2_0_9.json"), f("tracks_v2_0_9.json"), f("labels_v1_9_20.json"), f("labels_v3_0_9.json"), f("tracks_v3_0_9.json"), { name: "auto", dir: true }]);
  assert.equal(s.hasModel, false);
  // labels_v1_9_20 no tiene tracks_: no cuenta (igual que en Python).
  assert.deepEqual(s.labelParts, ["v1_0_9", "v2_0_9", "v3_0_9"]);
  assert.deepEqual(s.videos, ["v1", "v2", "v3"]);
  assert.deepEqual(linkModelStatus(null).labelParts, []);
});

test("linkModelNotice: falta, sin etiquetas, reentrenar y nada", () => {
  const withLabels = [f("labels_v1_0_9.json", 200), f("tracks_v1_0_9.json"), f("labels_v1_9_20.json", 300), f("tracks_v1_9_20.json")];
  const missing = linkModelNotice(linkModelStatus(withLabels));
  assert.equal(missing.kind, "missing");
  assert.equal(missing.canTrain, true);
  assert.match(missing.text, /2 partes con etiquetas: v1_0_9, v1_9_20/);
  assert.match(missing.text, /~8 min/);
  const none = linkModelNotice(linkModelStatus([f("tracks_v1_0_9.json")]));
  assert.equal(none.kind, "no-labels");
  assert.equal(none.canTrain, false);
  assert.match(none.text, /corrige y guarda una parte/);
  // Modelo de mtime 250: solo la parte de 300 es más nueva.
  const stale = linkModelNotice(linkModelStatus([...withLabels, f("link_model.json", 250)]));
  assert.equal(stale.kind, "stale");
  assert.match(stale.text, /1 parte corregida más nueva/);
  assert.equal(linkModelNotice(linkModelStatus([...withLabels, f("link_model.json", 999)])), null);
  assert.equal(linkModelNotice(linkModelStatus([f("link_model.json", 1)])), null);
});

test("tarea linkmodel: lista blanca, argv y rutas", () => {
  const auto = validateRunArgs({ task: "linkmodel", match: "m1", part: "modelo" });
  assert.equal(auto.ok, true);
  assert.deepEqual(runArgv(auto.args), ["-m", "sportsan.tracking.links_eval", "--match", "m1", "--train", "auto"]);
  const v = validateRunArgs({ task: "linkmodel", match: "m1", part: "modelo", videos: ["v1", "v2", "v1"] });
  assert.deepEqual(runArgv(v.args).slice(-2), ["--train", "v1,v2"]);
  for (const bad of [
    { task: "linkmodel", match: "m1", part: "v1_0_9" },
    { task: "linkmodel", match: "m1", part: "modelo", videos: ["v1;x"] },
    { task: "linkmodel", match: "m1", part: "modelo", videos: "v1" },
    { task: "fill", match: "m1", part: "b", videos: ["v1"] },
  ])
    assert.equal(validateRunArgs(bad).ok, false, JSON.stringify(bad));
  assert.equal(runPaths("m1", "linkmodel", "modelo").progress, "matches/m1/tracking/revision/progreso_linkmodel_modelo.log");
  assert.match(errorMessage("SystemExit: No hay con qué entrenar: ...", 1), /No hay con qué entrenar|corrige y guarda/);
});
