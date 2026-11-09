import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide, emptySuggest, eventOfDetection, fillBallBlockers, fillBallChecks, fmtEta, lastAutoRun, parseQuickSummary, parseSuggest, pendingSuggestions, planLines, quickIsCurrent, quickVerdict,
  runAutoEvents, stampOfEvent, withoutRun, countSamples,
} from "./processes.ts";
import { isQuickStage, parsePipelineState, pipelineArgv, pipelineFailMessage, pipelinePaths, pipelineView, stageName, validatePipelineArgs } from "./runTask.ts";

const det = (id, t, type = "corner", team = "own", extra = {}) => ({
  id, type, video_id: "v1", segment_id: "s1", t_video: t, x: 100.04, y: 2, team, player: null, detail: "", rule: "r", rule_version: "1", confidence: "high", flags: [], ...extra,
});
const ev = (id, t, type = "corner", team = "own", extra = {}) => ({
  event_id: id, match_id: "m", video_id: "v1", t_video: t, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, detail: null, note: null, ...extra,
});

// ------------------------------------------------------------------------------------------------- pipeline args
test("validatePipelineArgs: lista blanca de los dos comandos", () => {
  const q = validatePipelineArgs({ command: "tracking", match: "2026_09_25_tec_ccm_vs_anahuac", video: "v1", quick: true, quickS: 45, bandMarginM: 4 });
  assert.equal(q.ok, true);
  assert.deepEqual(pipelineArgv(q.args), ["-m", "sportsan.tracking.pipeline", "tracking", "--match", "2026_09_25_tec_ccm_vs_anahuac", "--video", "v1", "--quick", "--quick-s", "45", "--band-margin", "4"]);
  const p = validatePipelineArgs({ command: "tracking", match: "a", plan: true });
  assert.deepEqual(pipelineArgv(p.args), ["-m", "sportsan.tracking.pipeline", "tracking", "--match", "a", "--plan"]);
  const r = validatePipelineArgs({ command: "tracking", match: "a", resume: true });
  assert.deepEqual(pipelineArgv(r.args), ["-m", "sportsan.tracking.pipeline", "tracking", "--match", "a", "--resume"]);
  const f = validatePipelineArgs({ command: "fill-ball", match: "a", model: "weights/ball_model_x.pt", accept: 0.9, unnamedCost: 3, seg: { maxCost: 1.5, rejectClose: false } });
  assert.deepEqual(pipelineArgv(f.args), [
    "-m", "sportsan.tracking.pipeline", "fill-ball", "--match", "a", "--model", "weights/ball_model_x.pt", "--accept", "0.9", "--unnamed-cost", "3", "--seg-max-cost", "1.5", "--seg-reject-close", "no",
  ]);
});

test("validatePipelineArgs: rechaza lo que no es de la lista", () => {
  for (const bad of [
    null,
    { command: "rm -rf", match: "a" },
    { command: "tracking", match: "a b" },
    { command: "tracking", match: "../a" },
    { command: "tracking", match: "a", video: "v1;ls" },
    { command: "tracking", match: "a", quick: "yes" },
    { command: "tracking", match: "a", quick: true, force: true },
    { command: "fill-ball", match: "a", quick: true },
    { command: "tracking", match: "a", quickS: 30 },
    { command: "tracking", match: "a", quick: true, quickS: 5 },
    { command: "tracking", match: "a", bandMarginM: 40 },
    { command: "fill-ball", match: "a", bandMarginM: 3 },
    { command: "fill-ball", match: "a", model: "../../evil.pt" },
    { command: "fill-ball", match: "a", model: "weights/ball_model.pt --x" },
    { command: "tracking", match: "a", model: "weights/ball_model.pt" },
    { command: "fill-ball", match: "a", accept: 0.5 },
    { command: "fill-ball", match: "a", unnamedCost: 99 },
    { command: "fill-ball", match: "a", seg: { maxCost: 99 } },
    { command: "fill-ball", match: "a", seg: { otro: 1 } },
    { command: "tracking", match: "a", seg: { maxCost: 1 } },
  ])
    assert.equal(validatePipelineArgs(bad).ok, false, JSON.stringify(bad));
});

test("estado de pipeline: lectura, proceso muerto y reanudar", () => {
  assert.equal(parsePipelineState(null), null);
  assert.equal(parsePipelineState("{no json"), null);
  assert.equal(parsePipelineState('{"state":"otro"}'), null);
  const s = parsePipelineState('{"state":"running","stage":"process","video":"v1","part":"v1_0_900","pct":42.5,"eta_s":600,"started":100,"pid":77,"message":"x"}');
  assert.equal(s.pct, 42.5);
  assert.equal(pipelineView(s, true).state, "running");
  const dead = pipelineView(s, false);
  assert.equal(dead.state, "error");
  assert.equal(dead.stale, true);
  assert.equal(dead.resumable, true);
  assert.equal(dead.eta_s, null);
  const err = pipelineView(parsePipelineState('{"state":"error","message":"Fallaron 1"}'), false);
  assert.equal(err.resumable, true);
  assert.equal(err.stale, false);
  const done = pipelineView(parsePipelineState('{"state":"done","pct":100}'), false);
  assert.equal(done.state, "done");
  assert.equal(done.resumable, false);
  assert.equal(pipelineView(null, false).state, "idle");
  // The percentage is kept inside 0-100 whatever the file says.
  assert.equal(parsePipelineState('{"state":"running","pct":250}').pct, 100);
});

test("rutas, etapas y mensajes de fallo", () => {
  const p = pipelinePaths("m", "fill-ball");
  assert.equal(p.state, "matches/m/tracking/revision/pipeline_fill-ball.json");
  assert.equal(p.progress, "matches/m/tracking/revision/progreso_pipeline_fill-ball.log");
  assert.equal(p.quick, "matches/m/tracking/revision/quick");
  assert.equal(isQuickStage("quick_report"), true);
  assert.equal(isQuickStage("process"), false);
  assert.equal(stageName("fill"), "Relleno de identidades");
  assert.equal(stageName("rara"), "rara");
  assert.match(pipelineFailMessage("Precondición: falta el modelo\nPrecondición: otra", 2), /falta el modelo/);
  assert.match(pipelineFailMessage("", 130), /reanudar/);
  assert.match(pipelineFailMessage("", 3), /omitió/);
  assert.match(pipelineFailMessage("ModuleNotFoundError: x", 1), /\.venv/);
});

// ------------------------------------------------------------------------------------------------- quick report
test("informe de la prueba rápida: cifras que faltan se quedan faltando", () => {
  const sum = JSON.stringify({
    created: "2026-10-27T10:00:00", video_id: "v1", part: "v1_0_1800", start_s: 0, end_s: 60,
    process: { calibrated_share: 0.97, on_pitch_median: 18, identities: 31 },
    calibration_check: {
      samples: 2, to_review: 1,
      rows: [
        { start: 0, end: 300, found: 10, wanted: 10, dropped: [], neighbours_m: 0.4, worst_m: 0.9, refs_m: 0.8, missing: 0, frames: 10 },
        { start: 900, end: 1200, found: 3, wanted: 10, dropped: [1, 2], neighbours_m: 1.8, worst_m: 3, refs_m: null, missing: 4, frames: 10 },
      ],
    },
    suggest: { chains: 40, suggestions: 12 }, link_model: true, files: ["calib_v1_0_300.json", "check.txt", "tracks_v1_index.json"],
  });
  const q = parseQuickSummary(sum);
  assert.equal(q.samples, 2);
  assert.deepEqual(q.rows.map((r) => r.ok), [true, false]);
  assert.equal(q.rows[1].dropped, 2);
  assert.equal(q.boxesMedian, null);
  assert.equal(q.msPerFrame, null);
  assert.deepEqual(q.calibFiles, ["calib_v1_0_300.json"]);
  assert.equal(quickVerdict(q).tone, "warn");
  assert.equal(parseQuickSummary("nada"), null);
  assert.equal(parseQuickSummary(null), null);
  // Without a single figure the verdict does not claim anything good.
  assert.equal(quickVerdict(parseQuickSummary("{}")).tone, "warn");
  const bad = parseQuickSummary(JSON.stringify({ process: { calibrated_share: 0.2, on_pitch_median: 20 }, calibration_check: { samples: 1, rows: [] } }));
  assert.equal(quickVerdict(bad).tone, "bad");
});

test("el informe vale para la corrida que lo escribió, no para una completa posterior", () => {
  assert.equal(quickIsCurrent({ created: "2026-10-27T10:00:00" }, Date.parse("2026-10-27T09:59:00") / 1000), true);
  assert.equal(quickIsCurrent({ created: "2026-10-27T10:00:00" }, Date.parse("2026-10-27T11:00:00") / 1000), false);
  assert.equal(quickIsCurrent({ created: "" }, 5), false);
});

test("planLines y fmtEta", () => {
  const p = planLines("Plan (tracking):\n  v1:\n    process  ~5 min\n\nEstimado: ~12 min (aproximado)\n");
  assert.equal(p.estimate, "~12 min (aproximado)");
  assert.equal(p.lines.length, 4);
  assert.equal(planLines("").estimate, null);
  assert.equal(fmtEta(30), "menos de 1 min");
  assert.equal(fmtEta(600), "~10 min");
  assert.equal(fmtEta(3900), "~1 h 05 min");
  assert.equal(fmtEta(null), "");
});

// ------------------------------------------------------------------------------------------------- fill + ball
test("precondiciones del relleno y balón", () => {
  const facts = {
    tracking: ["tracks_v1_0_900.json", "tracks_v1_900_1800.json", "tracks_fixed_v1_0_900.json", "tracks_v1_index.json", "link_model.json"],
    auto: ["anchors_v1_0_900.json", "suggest_v1_0_900.json"],
    weights: ["yolo.pt", "ball_model.pt"],
    samples: { v1: 25 },
    videos: ["v1"],
  };
  const c = fillBallChecks(facts);
  const byId = Object.fromEntries(c.map((x) => [x.id, x]));
  assert.equal(byId.parts_v1.ok, true);
  assert.match(byId.parts_v1.detail, /^2 partes/);
  assert.match(byId.anchors_v1.detail, /1 de 2/);
  assert.equal(byId.ball_model.ok, true);
  assert.match(byId.samples_v1.detail, /25 marcas/);
  assert.deepEqual(fillBallBlockers(c), []);
  // No model: the samples matter (they train it) and the model blocks.
  const none = fillBallChecks({ ...facts, weights: [], samples: { v1: null }, auto: [] });
  assert.equal(fillBallBlockers(none).length, 3);
  assert.match(fillBallBlockers(none).join(" "), /Anclas de la analista/);
  // With a model, missing samples do not block.
  assert.deepEqual(fillBallBlockers(fillBallChecks({ ...facts, samples: { v1: null } })), []);
  assert.equal(countSamples('{"samples":[1,2,3]}'), 3);
  assert.equal(countSamples("{"), null);
  assert.equal(countSamples(null), null);
});

// ------------------------------------------------------------------------------------------------- events run
test("corrida de eventos: autorizados se crean, el resto son sugerencias, a mano no se toca", () => {
  const dets = [
    det("d1", 100, "corner", "own"), // authorised -> event
    det("d2", 200, "throw_in", "opp"), // not authorised -> suggestion
    det("d3", 300, "corner", "own"), // authorised but a manual corner is 1 s away -> duplicate
    det("d4", 400, "loss", "unk"), // no team -> suggestion even if authorised
    det("d5", 101, "corner", "own"), // 1 s after d1 -> duplicate of the new event
    det("d6", 500, "throw_in", "own", { video_id: "v1" }), // tagged by hand 2 s before -> duplicate, not suggested
  ];
  const manual = [ev("m1", 301, "corner", "own"), ev("m2", 498, "throw_in", "own")];
  const r = runAutoEvents({ dets, existing: manual, auto: ["corner", "loss"], matchId: "m", periodOf: () => 1, stamp: "abc" }, "T");
  assert.deepEqual(r.created.map((e) => e.event_id), ["auto-abc-d1"]);
  const e = r.created[0];
  assert.equal(e.auto, true);
  assert.equal(e.team, "own");
  assert.equal(e.x, 100);
  assert.equal(e.detail, null);
  assert.deepEqual(r.suggest.v1.items.map((d) => d.id), ["d2", "d4"]);
  assert.deepEqual(r.stats, { created: 1, suggestions: 2, duplicates: 3, noTeam: 1, decidedBefore: 0 });
  // The manual events are the same objects, nothing was added to or removed from them.
  assert.deepEqual(manual.map((x) => x.event_id), ["m1", "m2"]);
});

test("una segunda corrida no repite lo creado ni lo ya respondido", () => {
  const dets = [det("d1", 100, "corner", "own"), det("d2", 200, "throw_in", "opp"), det("d3", 700, "throw_in", "own")];
  const first = runAutoEvents({ dets, existing: [], auto: ["corner"], matchId: "m", periodOf: () => 1, stamp: "aaa" }, "T");
  const answered = decide(first.suggest.v1, "d2", "rejected");
  const second = runAutoEvents({ dets, existing: first.created, auto: ["corner"], matchId: "m", periodOf: () => 1, stamp: "bbb", prior: { v1: answered } }, "T2");
  assert.equal(second.created.length, 0);
  assert.equal(second.stats.duplicates, 1);
  assert.equal(second.stats.decidedBefore, 1);
  assert.deepEqual(second.suggest.v1.items.map((d) => d.id), ["d3"]);
  assert.equal(second.suggest.v1.decided.d2, "rejected");
});

test("deshacer la corrida quita solo sus eventos", () => {
  const mine = ev("auto-1abc-d1", 10, "corner", "own", { auto: true });
  const older = ev("auto-0zzz-d9", 50, "foul", "opp", { auto: true });
  const hand = ev("e_123", 70, "corner", "own");
  // Looks like an automatic id but was not flagged: it is a hand event and stays.
  const odd = ev("auto-1abc-x", 90, "shot", "own");
  const list = [mine, older, hand, odd];
  assert.equal(stampOfEvent(mine), "1abc");
  assert.equal(stampOfEvent(hand), null);
  assert.equal(stampOfEvent(odd), null);
  const last = lastAutoRun(list);
  assert.equal(last.stamp, "1abc");
  assert.deepEqual(last.ids, ["auto-1abc-d1"]);
  assert.deepEqual(withoutRun(list, "1abc").map((e) => e.event_id), ["auto-0zzz-d9", "e_123", "auto-1abc-x"]);
  assert.equal(lastAutoRun([hand]), null);
});

test("sugerencias pendientes: sin responder y sin duplicar lo que ya se etiquetó", () => {
  let f = { ...emptySuggest("v1"), items: [det("a", 10, "throw_in", "own"), det("b", 20, "corner", "opp"), det("c", 30, "foul", "unk")] };
  assert.deepEqual(pendingSuggestions(f, []).map((d) => d.id), ["a", "b", "c"]);
  f = decide(f, "a", "accepted");
  assert.deepEqual(pendingSuggestions(f, [ev("x", 21, "corner", "opp")]).map((d) => d.id), ["c"]);
  f = decide(f, "a", null);
  assert.equal(pendingSuggestions(f, []).length, 3);
  assert.equal(parseSuggest("{", "v1").items.length, 0);
  assert.equal(parseSuggest(JSON.stringify({ kind: "otra" }), "v1").items.length, 0);
  const round = parseSuggest(JSON.stringify(f), "v1");
  assert.equal(round.items.length, 3);
});

test("eventOfDetection: sin equipo no hay evento, el detalle solo si es del catálogo", () => {
  assert.equal(eventOfDetection(det("a", 1, "loss", "unk"), "m", 1, "e1", false), null);
  const c = eventOfDetection(det("a", 1.04, "corner", "opp", { detail: "short", x_end: 90.26, y_end: 20 }), "m", 2, "e1", false);
  assert.equal(c.detail, "short");
  assert.equal(c.period, 2);
  assert.equal(c.x_end, 90.3);
  assert.equal(c.auto, undefined);
  const l = eventOfDetection(det("a", 1, "loss", "own", { detail: "rara" }), "m", 1, "e2", true);
  assert.equal(l.detail, null);
  assert.equal(l.auto, true);
  assert.match(l.note, /^Automático/);
});

// ------------------------------------------------------------------------------------------------- salto del balón por partido
test("el salto máximo del balón de Detalles técnicos llega a los estados del balón, la posesión y la exportación", async () => {
  const { ballStates } = await import("./positions.ts");
  const { possessionIntervals } = await import("./possession.ts");
  const bp = (frame, x, y = 30) => ({ frame, x, y, source: "auto" });
  const f = {
    kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 30, stride: 3, people: [],
    ball: [bp(0, 10), bp(3, 10), bp(6, 60), bp(9, 10), bp(12, 10)],
    frames: [0, 3, 6, 9, 12].map((frame) => ({ frame, positions: [] })),
  };
  // 50 units in 0.1 s is a jump at the default 30 m/s, and is not at 5000 m/s.
  assert.equal(ballStates(f).some((s) => s.jump), true);
  assert.equal(ballStates(f, 5000).some((s) => s.jump), false);
  const seg = { v1: [{ segment_id: "s", tipo: "juego", start: 0, end: 1, label: "" }] };
  assert.doesNotThrow(() => possessionIntervals([{ file: f, ownRight: true, dir: "given" }], seg, {}, undefined, 5000));
});
