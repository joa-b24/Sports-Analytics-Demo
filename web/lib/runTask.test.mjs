import assert from "node:assert/strict";
import { test } from "node:test";
import { doubtFocus, focusBoxes, suggestionFocus } from "./anchors.ts";
import { errorMessage, parseProgress, runArgv, runPaths, runStatus, validateRunArgs } from "./runTask.ts";

test("validateRunArgs: lista blanca estricta", () => {
  const ok = validateRunArgs({ task: "suggest", match: "2026_09_25_tec_ccm_vs_anahuac", part: "v1_6414_13699", perMin: 3 });
  assert.equal(ok.ok, true);
  assert.deepEqual(runArgv(ok.args), ["-m", "sportsan.tracking.anchors", "suggest", "--match", "2026_09_25_tec_ccm_vs_anahuac", "--part", "v1_6414_13699", "--per-min", "3"]);
  assert.equal(validateRunArgs({ task: "suggest", match: "a", part: "b", perMin: "hybrid" }).ok, true);
  for (const bad of [
    null,
    { task: "rm", match: "a", part: "b" },
    { task: "fill", match: "a b", part: "b" },
    { task: "fill", match: "a;del", part: "b" },
    { task: "fill", match: "../x", part: "b" },
    { task: "fill", match: "a", part: "b&c" },
    { task: "fill", match: "a.b", part: "b" },
    { task: "suggest", match: "a", part: "b", perMin: 6 },
    { task: "suggest", match: "a", part: "b", perMin: "0" },
    { task: "suggest", match: "a", part: "b", perMin: "2 --x" },
  ])
    assert.equal(validateRunArgs(bad).ok, false, JSON.stringify(bad));
  // fill no lleva --per-min.
  const f = validateRunArgs({ task: "fill", match: "a", part: "b", perMin: 2 });
  assert.deepEqual(runArgv(f.args), ["-m", "sportsan.tracking.anchors", "fill", "--match", "a", "--part", "b"]);
});

test("parseProgress: última línea del log de anchors_cli", () => {
  const log = "10:00:00 lectura 0/1 0% ETA nans (total 0s)\n10:00:03 candidatos 40/120 33% ETA 12s (total 5s)\n";
  assert.deepEqual(parseProgress(log), { phase: "candidatos", done: 40, total: 120, pct: 33, eta_s: 12 });
  assert.deepEqual(parseProgress("10:00:00 lectura 0/1 0% ETA nans (total 0s)"), { phase: "lectura", done: 0, total: 1, pct: 0, eta_s: null });
  assert.equal(parseProgress(""), null);
  assert.equal(parseProgress("Traceback (most recent call last):"), null);
});

test("runStatus: estados y mensaje corto", () => {
  const prog = "10:00:03 relleno 1/2 50% ETA 4s (total 5s)";
  assert.equal(runStatus(null, "", "", false).state, "idle");
  assert.equal(runStatus({ state: "running", started: 0, pid: 1 }, prog, "", true).pct, 50);
  assert.equal(runStatus({ state: "running", started: 0, pid: 1 }, prog, "", false).state, "error");
  const d = runStatus({ state: "done", started: 0, code: 0 }, prog, "", false);
  assert.equal(d.state, "done");
  assert.equal(d.pct, 100);
  const e = runStatus({ state: "error", started: 0, code: 1 }, prog, "Traceback...\nFileNotFoundError: tracks_v1.json", false);
  assert.equal(e.state, "error");
  assert.match(e.message, /Falta un archivo/);
  assert.ok(!e.message.includes("Traceback"));
  assert.equal(errorMessage("ValueError: x", 2), "Python terminó con error (código 2).");
});

test("focusBoxes: todas las cajas de una duda, y las que faltan", () => {
  const shown = [
    { b: [10, 0, 0, 1, 1], id: 1 },
    { b: [11, 0, 0, 1, 1], id: 2 },
    { b: [12, 0, 0, 1, 1], id: 1 },
  ];
  const name = (id) => (id === 1 ? "Ana" : id === 2 ? "Bea" : undefined);
  // «En dos sitios»: Ana tiene dos cajas; el trozo 11 es otra.
  const r = focusBoxes(doubtFocus({ frame: 5, track: 11, players: ["Ana"] }).marks, shown, name);
  assert.deepEqual(r.found.map((f) => [f.b[0], f.mark.label]), [[10, "1"], [12, "1"], [11, "2"]]);
  assert.equal(r.missing.length, 0);
  // El trozo de la duda es una caja de su jugadora: ya marcada, no falta.
  const r2 = focusBoxes(doubtFocus({ frame: 5, track: 10, players: ["Ana", "Carla"] }).marks, shown, name);
  assert.deepEqual(r2.missing.map((m) => m.what), ["Carla"]);
  assert.deepEqual(r2.same.map((x) => [x.mark.what, x.as.label]), [["trozo 10", "1"]]);
  const r3 = focusBoxes(suggestionFocus({ frame: 5, track: 99 }).marks, shown, name);
  assert.equal(r3.found.length, 0);
  assert.equal(r3.missing[0].what, "trozo 99");
});

test("the experimental fill (variant exp) has its own argument and files", () => {
  const v = validateRunArgs({ task: "fill", match: "m_1", part: "v1_0_9", variant: "exp" });
  assert.ok(v.ok);
  assert.deepEqual(runArgv(v.args).slice(-2), ["--variant", "exp"]);
  assert.equal(validateRunArgs({ task: "suggest", match: "m", part: "p", variant: "exp" }).ok, false);
  assert.equal(validateRunArgs({ task: "fill", match: "m", part: "p", variant: "x; rm" }).ok, false);
  assert.match(runPaths("m", "fill", "p", "exp").record, /run_fill_p_exp\.json$/);
});

test("reset whitelist: only anchors/links of the part and its fill logs", async () => {
  const { resettableFile } = await import("./runTask.ts");
  const P = "v2_34220_45027";
  for (const n of [`anchors_${P}.json`, `links_${P}.json`, `links_${P}_exp.json`, `links_${P}_A.json`]) assert.ok(resettableFile("auto", P, n), n);
  for (const n of [`suggest_${P}.json`, `tracks_${P}.json`, `labels_${P}.json`, `links_v2_34220_450270.json`, `links_${P}.json.bak`, `../links_${P}.json`, `links_${P}_a.b.json`]) assert.equal(resettableFile("auto", P, n), false, n);
  for (const n of [`progreso_fill_${P}.log`, `run_fill_${P}_exp.json`, `run_fill_${P}.log`]) assert.ok(resettableFile("revision", P, n), n);
  for (const n of [`progreso_suggest_${P}.log`, `run_fill_${P}.json.old`, `union_f1.md`]) assert.equal(resettableFile("revision", P, n), false, n);
  assert.equal(resettableFile("auto", "../x", "anchors_../x.json"), false);
});

test("refine: lista blanca, sin variante, argumentos y registro propios", () => {
  const v = validateRunArgs({ task: "refine", match: "2026_09_25_tec_ccm_vs_anahuac", part: "v2_34220_45027", perMin: 3 });
  assert.equal(v.ok, true);
  assert.deepEqual(runArgv(v.args), ["-m", "sportsan.tracking.refine", "--match", "2026_09_25_tec_ccm_vs_anahuac", "--part", "v2_34220_45027"]);
  assert.equal(validateRunArgs({ task: "refine", match: "m", part: "p", variant: "exp" }).ok, false);
  assert.equal(validateRunArgs({ task: "refine", match: "m", part: "../p" }).ok, false);
  assert.equal(validateRunArgs({ task: "refine; rm", match: "m", part: "p" }).ok, false);
  const p = runPaths("m", "refine", "v2_1_2");
  assert.equal(p.progress, "matches/m/tracking/revision/progreso_refine_v2_1_2.log");
  assert.equal(p.record, "matches/m/tracking/revision/run_refine_v2_1_2.json");
  assert.equal(parseProgress("10:00:00 calibración 1/1 100% ETA 0s (total 3s)")?.phase, "calibración");
});
