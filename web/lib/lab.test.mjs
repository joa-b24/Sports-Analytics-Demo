import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLE_LOG, SAMPLE_REPORT_A, SAMPLE_REPORT_B, compareMetrics, experimentOf, fmtDuration, jsonMetrics, kindOf, lineOf, numberOf, parseLog, parseReport, reportMetrics } from "./lab.ts";

test("lineOf y kindOf", () => {
  assert.equal(lineOf("union_f1.md"), "uniones");
  assert.equal(lineOf("progreso_ball_v1_1_2.log"), "balon");
  assert.equal(lineOf("L3_eventos.md"), "eventos");
  assert.equal(lineOf("metricas.md"), "mediciones");
  assert.equal(lineOf("zzz.md"), "otros");
  assert.equal(kindOf("a.err.log"), null);
  assert.equal(kindOf("ball_metrics_v1.json"), "metricas");
  assert.equal(experimentOf("matches/x/tracking", { name: "a.png", dir: false, size: 1 }), null);
  assert.equal(experimentOf("matches/x/tracking/revision", { name: "union_f1.md", dir: false, size: 1 })?.match, "x");
  assert.equal(experimentOf("matches", { name: "cola_balon.log", dir: false, size: 1 })?.match, "");
});

test("parseLog", () => {
  const p = parseLog(SAMPLE_LOG);
  assert.equal(p.pct, 80);
  assert.equal(p.etaS, 15);
  assert.equal(p.finished, false);
  assert.equal(parseLog("hola").pct, null);
  assert.equal(parseLog("03:59:20 listo 1/1 100% ETA 0s (total 667s)").finished, true);
  assert.equal(fmtDuration(75), "1 min 15 s");
  assert.equal(fmtDuration(null), "—");
});

test("numberOf", () => {
  assert.equal(numberOf("98.90 %"), 98.9);
  assert.equal(numberOf("—"), null);
  assert.equal(numberOf("sin cruce"), null);
});

test("comparar informes: lo que falta queda faltante", () => {
  const a = reportMetrics(parseReport(SAMPLE_REPORT_A));
  const b = reportMetrics(parseReport(SAMPLE_REPORT_B));
  const d = compareMetrics(a, b);
  const pur = d.find((x) => x.key.includes("Unión ≥ 0.9") && x.key.endsWith("Pureza"));
  assert.ok(Math.abs(pur.delta - 0.3) < 1e-9);
  b.delete("Uniones › Hoy › Pureza");
  const miss = compareMetrics(a, b).find((x) => x.key === "Uniones › Hoy › Pureza");
  assert.equal(miss.b, null);
  assert.equal(miss.delta, null);
});

test("jsonMetrics omite nulos", () => {
  const m = jsonMetrics({ ground: { n: 20, precision: null, recall: 0 } });
  assert.equal(m.get("ground.n"), 20);
  assert.equal(m.get("ground.recall"), 0);
  assert.equal(m.has("ground.precision"), false);
});
