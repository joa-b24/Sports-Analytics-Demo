import assert from "node:assert/strict";
import { test } from "node:test";
import { acwr, isSensitiveColumn, loadMethod, sessionLoads } from "./load.ts";

const row = (date, player_id, metrics, session_id = "s") => ({ date, session_id, player_id, metrics });

test("session load is RPE x minutes and is never estimated when one of them is missing", () => {
  const rows = sessionLoads([
    row("2026-10-01", "Ana", { rpe: 6, duration_min: 90 }),
    row("2026-10-01", "Bea", { rpe: 7 }), // no watch: takes the duration of the session
    row("2026-10-01", "Cris", { duration_min: 80 }), // did not answer the RPE
    row("2026-10-02", "Ana", { rpe: 5 }, "s2"), // nobody recorded that session
  ]);
  assert.deepEqual(rows.map((r) => [r.player_id, r.load, r.durationFrom]), [
    ["Ana", 540, "own"],
    ["Bea", 7 * 85, "session"], // median of 90 and 80
    ["Cris", null, "own"],
    ["Ana", null, null],
  ]);
});

// One session of load `l` on each given day offset before 2026-10-28.
const days = (player, offsets, l) =>
  offsets.map((o) => {
    const d = new Date(Date.UTC(2026, 9, 28 - o)).toISOString().slice(0, 10);
    return { date: d, session_id: "s", player_id: player, rpe: 1, duration_min: l, durationFrom: "own", load: l };
  });

test("ACWR: last 7 days over the weekly mean of the last 28", () => {
  // 100 per week for four weeks: ratio 1.
  const steady = days("Ana", [0, 7, 14, 21], 100);
  // Same history, but 200 this week: acute 200, chronic (200+100+100+100)/4 = 125.
  const spike = [...days("Bea", [7, 14, 21], 100), ...days("Bea", [0], 200)];
  const r = acwr([...steady, ...spike]);
  assert.equal(r.asOf, "2026-10-28");
  const byId = Object.fromEntries(r.players.map((p) => [p.player_id, p]));
  assert.equal(byId.Ana.ratio, 1);
  assert.equal(byId.Bea.ratio, 1.6);
  assert.equal(r.players[0].player_id, "Bea"); // highest first
});

test("ACWR is withheld until the history reaches the fourth week", () => {
  const short = days("Ana", [0, 3, 7, 10], 100); // ten days of data
  const p = acwr(short).players[0];
  assert.equal(p.ratio, null);
  assert.equal(p.historyDays, 10);
  assert.equal(acwr(days("Ana", [0, 21], 100)).players[0].ratio !== null, true);
});

test("loads older than 28 days and rows without load are ignored", () => {
  const rows = [...days("Ana", [0, 7, 14, 21], 100), ...days("Ana", [40], 900), { date: "2026-10-27", session_id: "s", player_id: "Ana", rpe: null, duration_min: 60, durationFrom: "own", load: null }];
  assert.equal(acwr(rows).players[0].ratio, 1);
  assert.deepEqual(acwr([]), { asOf: null, players: [] });
});

test("health columns are recognised by name", () => {
  for (const c of ["illness", "enfermedad", "period", "ciclo_menstrual", "mood", "estado_de_animo", "molestia"]) assert.equal(isSensitiveColumn(c), true, c);
  for (const c of ["rpe", "sleep_q", "stress", "fatigue", "soreness", "energy", "duration_min", "sprints"]) assert.equal(isSensitiveColumn(c), false, c);
});

test("without RPE the load can come from Strava's relative effort", () => {
  const s = (date, m) => ({ date, session_id: date, player_id: "Joana", metrics: m });
  const rows = [s("2026-10-01", { duration_min: 90, relative_effort: 120 }), s("2026-10-02", { duration_min: 60 })];
  assert.equal(loadMethod(rows), "relative_effort");
  assert.deepEqual(sessionLoads(rows, "relative_effort").map((r) => r.load), [120, null]);
  assert.equal(loadMethod([...rows, s("2026-10-03", { rpe: 6, duration_min: 50 })]), "rpe");
  assert.equal(loadMethod([s("2026-10-03", { duration_min: 50 })]), null);
});
