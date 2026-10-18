import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishEvents,
  boxEntries,
  crosses,
  finalThirdEntries,
  firstPass,
  goalKicks,
  laneOf,
  playTime,
  recoveryHeight,
  setPieces,
  shotBreakdown,
  timeBins,
  transitions,
} from "./analysis.ts";

let n = 0;
const ev = (t_video, type, team, extra = {}) => ({
  event_id: `e${n++}`, match_id: "m", t_video, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, detail: null, note: null, ...extra,
});

test("transitions: windows are per team and per direction", () => {
  const events = [
    ev(100, "loss", "own"),
    ev(110, "shot", "opp"), // within 15 s: counts against own
    ev(200, "loss", "own"),
    ev(205, "recovery", "own"), // counterpress within 8 s
    ev(300, "loss", "own"),
    ev(320, "goal", "opp"), // 20 s later: too late
    ev(400, "recovery", "own", { x: 80, y: 30 }),
    ev(412, "shot", "own"),
    ev(500, "recovery", "own"),
    ev(505, "shot", "opp"), // a shot by the other team does not count
  ];
  const t = transitions(events, "own");
  assert.deepEqual(t.lossToShotAgainst, { k: 1, n: 3 });
  assert.deepEqual(t.counterpress, { k: 1, n: 3 });
  // Recoveries: 205, 400, 500. Only the one at 400 ends in an own shot.
  assert.deepEqual(t.recoveryToShot, { k: 1, n: 3 });
  assert.equal(t.recoveriesToShot[0].t_video, 400);
  assert.deepEqual(transitions(events, "opp").lossToShotAgainst, { k: 0, n: 0 });
});

test("transitions do not depend on the order of the input", () => {
  const events = [ev(110, "shot", "opp"), ev(100, "loss", "own")];
  assert.deepEqual(transitions(events, "own").lossToShotAgainst, { k: 1, n: 1 });
});

test("tiros: un gol, su tiro y su penal son una sola acción; un gol sin tiro no es tiro; un tiro libre o un penal solos tampoco", () => {
  const events = [
    // Penalty scored, tagged three times (goal, shot and penalty) at nearly the same moment.
    ev(100, "penalty", "own"),
    ev(101, "goal", "own"),
    ev(100.5, "shot", "own", { outcome: "on_target" }),
    ev(200, "shot", "own", { outcome: "off_target" }),
    ev(300, "shot", "own", { outcome: "blocked" }),
    ev(400, "shot", "own"),
    // A goal without a shot (own goal of the other team, a deflection).
    ev(500, "goal", "own"),
    // A free kick crossed into the box: not a shot.
    ev(600, "free_kick", "own", { outcome: "cleared" }),
    // A shot that went in tagged without its result: on target because of its goal.
    ev(700, "shot", "own"),
    ev(703, "goal", "own"),
    ev(6, "shot", "opp", { outcome: "on_target" }),
  ];
  assert.deepEqual(shotBreakdown(events, "own"), { total: 5, goals: 3, goalsWithoutShot: 1, onTarget: 2, offTarget: 1, blocked: 1, unknown: 1 });
  // One mark per finish on the maps: 5 shots (2 of them goals) and the goal without a shot.
  const marks = finishEvents(events).filter((e) => e.team === "own");
  assert.equal(marks.length, 6);
  assert.equal(marks.filter((e) => e.type === "goal").length, 3);
  // A goal links to one shot only: two goals right after one shot leave the second without a shot.
  assert.equal(shotBreakdown([ev(10, "shot", "own"), ev(11, "goal", "own"), ev(12, "goal", "own")], "own").goalsWithoutShot, 1);
});

test("lanes are seen by the attacking team", () => {
  assert.equal(laneOf(ev(1, "cross", "own", { x: 90, y: 5 })), "left");
  assert.equal(laneOf(ev(1, "cross", "own", { x: 90, y: 60 })), "right");
  assert.equal(laneOf(ev(1, "cross", "opp", { x: 10, y: 5 })), "right");
  assert.equal(laneOf(ev(1, "cross", "own", { x: 90, y: 34 })), "center");
  assert.equal(laneOf(ev(1, "cross", "own")), null);
  const entries = finalThirdEntries(
    [ev(1, "final_third_entry", "own", { x: 72, y: 5 }), ev(2, "final_third_entry", "own", { x: 72, y: 34 }), ev(3, "final_third_entry", "own"), ev(4, "final_third_entry", "opp", { x: 30, y: 5 })],
    "own",
  );
  assert.deepEqual(entries, { left: 1, center: 1, right: 0, missing: 1, total: 3 });
});

test("box entries that end in a shot", () => {
  const events = [ev(10, "box_entry", "own"), ev(18, "shot", "own"), ev(100, "box_entry", "own"), ev(130, "shot", "own")];
  assert.deepEqual(boxEntries(events, "own"), { k: 1, n: 2 });
});

test("set pieces, crosses, goal kicks and first pass keep the untagged apart", () => {
  const events = [
    ev(1, "corner", "own", { outcome: "shot", detail: "inswing" }),
    ev(2, "corner", "own", { outcome: "cleared" }),
    ev(3, "corner", "own"),
    ev(4, "free_kick", "own", { outcome: "play_on" }),
    ev(5, "cross", "own", { outcome: "shot", x: 95, y: 60 }),
    ev(6, "cross", "own", { x: 95, y: 5 }),
    ev(7, "goal_kick", "own", { detail: "long", outcome: "lost" }),
    ev(8, "goal_kick", "own", { detail: "short" }),
    ev(9, "recovery", "own", { detail: "forward" }),
    ev(10, "recovery", "own"),
  ];
  const sp = setPieces(events, "own");
  assert.deepEqual(sp.corners, { total: 3, counts: { shot: 1, cleared: 1, play_on: 0 }, unknown: 1 });
  assert.deepEqual(sp.delivery, { total: 3, counts: { inswing: 1, outswing: 0, short: 0 }, unknown: 2 });
  assert.equal(sp.freeKicks.counts.play_on, 1);
  const cr = crosses(events, "own");
  assert.equal(cr.outcome.counts.shot, 1);
  assert.deepEqual(cr.lanes, { left: 1, center: 0, right: 1, missing: 0 });
  const gk = goalKicks(events, "own");
  assert.deepEqual(gk.length.counts, { short: 1, long: 1 });
  assert.deepEqual(gk.outcome, { total: 2, counts: { kept: 0, lost: 1 }, unknown: 1 });
  assert.deepEqual(firstPass(events, "own"), { total: 2, counts: { forward: 1, backward: 0 }, unknown: 1 });
});

test("recovery height is measured from the goal each team defends", () => {
  const events = [ev(1, "recovery", "own", { x: 90, y: 30 }), ev(2, "recovery", "own", { x: 10, y: 30 }), ev(3, "recovery", "opp", { x: 10, y: 30 }), ev(4, "recovery", "own")];
  assert.deepEqual(recoveryHeight(events, "own"), { own: 1, middle: 0, rival: 1, missing: 1 });
  assert.deepEqual(recoveryHeight(events, "opp"), { own: 0, middle: 0, rival: 1, missing: 0 });
});

const SEGS = [
  { segment_id: "s01", start: 0, end: 180, tipo: "pausa" },
  { segment_id: "s02", start: 180, end: 2880, tipo: "juego" }, // 45 min
  { segment_id: "s03", start: 2880, end: 3780, tipo: "pausa" },
  { segment_id: "s04", start: 3780, end: null, tipo: "juego" },
];

test("play time skips pauses and is null outside play", () => {
  assert.equal(playTime(SEGS, 100), null);
  assert.equal(playTime(SEGS, 180), 0);
  assert.equal(playTime(SEGS, 780), 600);
  assert.equal(playTime(SEGS, 3000), null);
  assert.equal(playTime(SEGS, 3840), 2700 + 60);
});

test("time bins use minutes of play and leave out events in a pause", () => {
  const events = [
    ev(200, "shot", "own"), // 0:20 of play
    ev(480, "recovery", "opp"), // 5:00 -> second 5-minute bin
    ev(3000, "shot", "own"), // half-time
    ev(3840, "box_entry", "own"), // 46:00 of play
  ];
  const five = timeBins(events, SEGS, 5);
  assert.equal(five.basis, "juego");
  assert.equal(five.skipped, 1);
  assert.equal(five.bins.length, 10);
  assert.equal(five.bins[0].own.shots, 1);
  assert.equal(five.bins[1].opp.recoveries, 1);
  assert.equal(five.bins[9].label, "45–50′");
  assert.equal(five.bins[9].own.entries, 1);
  assert.equal(timeBins(events, SEGS, 10).bins.length, 5);
});

test("without marked stretches the bins fall back to video minutes and say so", () => {
  const events = [ev(1000, "shot", "own"), ev(1000 + 11 * 60, "shot", "opp")];
  const b = timeBins(events, [], 10);
  assert.equal(b.basis, "video");
  assert.equal(b.bins.length, 2);
  assert.equal(b.bins[1].opp.shots, 1);
});
