import assert from "node:assert/strict";
import { test } from "node:test";
import { faceOff, lastOwnMatch, nextRival, pendingTasks, rivalDossier, teamKey } from "./home.ts";
import { EMPTY_REPORT } from "./types.ts";

// Synthetic data only.
let n = 0;
const ev = (match_id, type, team, extra = {}) => ({
  event_id: `e${n++}`, match_id, video_id: "v1", t_video: n, period: 1, type, team, player_id: null, x: 50, y: 30, outcome: null, detail: null, note: null, ...extra,
});
const match = (match_id, kind, date, focus_team, other_team, resumen = "") => ({
  match_id, name: `${focus_team} vs ${other_team}`, kind, date, focus_team, other_team, youtube_id: "", report: { ...EMPTY_REPORT, resumen },
});
const step = (state, text = "") => ({ state, text });
const steps = (tag, segments) => ({ tag, segments, calibration: step("optional"), tracking: step("optional"), ball: step("optional"), plays: step("optional"), board: step("optional"), analysis: step("todo"), report: step("todo") });

test("teamKey ignora mayúsculas, acentos y espacios", () => {
  assert.equal(teamKey("  Anáhuac  Norte "), teamKey("anahuac norte"));
});

test("último partido propio: el más reciente con eventos", () => {
  const ms = [match("a", "own", "2026-09-01", "Nos", "X"), match("b", "own", "2026-09-20", "Nos", "Y"), match("c", "rival", "2026-10-01", "R", "Z")];
  assert.equal(lastOwnMatch(ms, [ev("a", "shot", "own")]).match_id, "a");
  assert.equal(lastOwnMatch(ms, []).match_id, "b");
  assert.equal(lastOwnMatch([], []), null);
  assert.equal(nextRival(ms), "R");
});

test("expediente del rival: une sus videos, cuenta tiros y goles solo de los etiquetados y encuentra los antecedentes", () => {
  const ms = [
    match("r1", "rival", "2026-09-10", "UP", "A", "Presiona alto. Pierde balones."),
    match("r2", "rival", "2026-09-17", "up", "B"),
    match("r3", "rival", "2026-09-18", "Otro", "C"),
    match("o1", "own", "2026-09-05", "Nos", "Úp"),
  ];
  const events = [
    ev("r1", "goal", "own"),
    ev("r1", "shot", "own", { outcome: "on_target" }),
    ev("r1", "goal", "opp"),
    ev("o1", "goal", "opp"),
  ];
  const d = rivalDossier("UP", ms, events);
  assert.deepEqual(d.videos.map((v) => v.match.match_id), ["r2", "r1"]);
  assert.equal(d.videos[0].score, null);
  assert.deepEqual(d.videos[1].score, { for: 1, against: 1 });
  assert.equal(d.tagged, 1);
  assert.equal(d.goalsFor, 1);
  assert.equal(d.goalsAgainst, 1);
  assert.ok(d.shots >= 1);
  assert.equal(d.lead.text, "Presiona alto.");
  assert.deepEqual(d.meetings.map((m) => [m.match.match_id, m.score]), [["o1", { own: 0, opp: 1 }]]);
  assert.equal(d.demo, false);
});

test("barras enfrentadas: porcentajes contra 100, conteos contra el mayor", () => {
  assert.deepEqual(faceOff(65, 35, "%"), [0.65, 0.35]);
  assert.deepEqual(faceOff(4, 2), [1, 0.5]);
  assert.deepEqual(faceOff(0, 0), [0, 0]);
});

test("pendientes: eventos, tramos y resumen, sin videos de referencia", () => {
  const ms = [match("a", "own", "2026-09-01", "Nos", "X"), match("b", "rival", "2026-09-20", "R", "Y", "Ya escrito."), match("c", "reference", "2026-10-01", "Z", "W")];
  const tasks = pendingTasks([
    { match: ms[0], steps: steps(step("partial", "3 por revisar"), step("todo", "sin marcar")), events: 5 },
    { match: ms[1], steps: steps(step("done"), step("partial")), events: 2 },
    { match: ms[2], steps: steps(step("todo"), step("todo")), events: 0 },
  ]);
  assert.deepEqual(
    tasks.map((t) => [t.match.match_id, t.step, t.mode, t.label]),
    [
      ["b", "segments", "captura", "Terminar tramos"],
      ["a", "tag", "captura", "Revisar eventos"],
      ["a", "segments", "captura", "Marcar tramos"],
      ["a", "report", "analisis", "Escribir el resumen"],
    ],
  );
});

test("pendientes: sin eventos por revisar pero con destinos faltantes", () => {
  const [t] = pendingTasks([{ match: match("a", "own", "2026-09-01", "Nos", "X", "Hecho."), steps: steps(step("partial", "9 eventos · 0 por revisar · 2 sin destino"), step("done")), events: 9 }]);
  assert.equal(t.label, "Completar destinos");
  assert.equal(t.text, "9 eventos · 2 sin destino");
});
