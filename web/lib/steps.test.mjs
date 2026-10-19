import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSteps } from "./steps.ts";

const seg = (start, end, tipo = "juego") => ({ segment_id: "", start, end, tipo });
const ev = (extra = {}) => ({ event_id: String(Math.random()), match_id: "m", t_video: 1, period: 1, type: "foul", team: "own", player_id: null, x: 10, y: 10, outcome: null, detail: null, note: null, ...extra });
const base = { videoIds: ["v1"], segmentsByVideo: {}, events: [], plays: [], trackEdits: [], files: null };

test("an empty match: everything to do, calibration and tracking optional", () => {
  const s = matchSteps(base);
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.state])), {
    calibration: "optional", segments: "todo", tracking: "optional", ball: "optional", tag: "todo", plays: "optional", board: "optional", analysis: "todo", report: "todo",
  });
});

test("a match on its way", () => {
  const s = matchSteps({
    ...base,
    folder: "f",
    venueId: "cueva",
    segmentsByVideo: { v1: [seg(0, 300), seg(300, 330, "pausa"), seg(330, 630), seg(630, null)] },
    events: [ev(), ev({ x: null }), ev({ type: "shot", outcome: "on_target" })],
    plays: [{ keyframes: [1] }, { keyframes: [] }],
    trackEdits: [{ key: "f|v1|0_9000", identity: { 1: 2 }, people: {}, removed: [], splits: [], manual: [] }, { key: "f|v1|9900_18900", identity: {}, people: {}, removed: [], splits: [], manual: [] }],
    files: { tracking: ["library_v1.npz", "tracks_v1_0_9000.json", "tracks_v1_9900_18900.json", "tracks_v1_index.json", "tracks_fixed_v1_0_9000.json", "team_metrics_v1.json"] },
  });
  assert.deepEqual(s.calibration, { state: "done", text: "biblioteca 1 de 1" });
  assert.deepEqual(s.segments, { state: "done", text: "2 tramos · 10 min de juego" });
  assert.deepEqual(s.tracking, { state: "partial", text: "2 parte(s) de 2 tramos · 1 corregida(s)" });
  assert.deepEqual(s.tag, { state: "partial", text: "3 eventos · 1 por revisar · 1 sin destino" });
  assert.deepEqual(s.plays, { state: "partial", text: "1 de 2 animadas" });
  assert.deepEqual(s.ball, { state: "todo", text: "0 de 2 partes con balón" });
  assert.equal(s.analysis.text, "con forma del equipo");
});

test("a part corrected in the browser but not saved to the folder is not done", () => {
  const s = matchSteps({
    ...base,
    folder: "f",
    trackEdits: [{ key: "f|v1|0_9000", identity: { 1: 2 }, people: {}, removed: [], splits: [], manual: [] }],
    files: { tracking: ["tracks_v1_0_9000.json"] },
  });
  assert.deepEqual(s.tracking, { state: "partial", text: "1 parte(s) · 1 corregida(s) · 1 sin guardar" });
});
