import assert from "node:assert/strict";
import { test } from "node:test";
import { behindBallAtLosses, heatmap, inferOwnAttacksRight, parseFixed, passNetwork, passesAndTurnovers, positionsAt, touches } from "./positions.ts";

// A corrected part: 30 fps, one of every 3 frames. `at(i)` gives the positions of processed frame i.
const fixed = ({ n = 10, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });

test("reads only corrected parts", () => {
  assert.equal(parseFixed('{"kind":"tracks_px","frames":[]}'), null);
  assert.equal(parseFixed("no"), null);
  assert.ok(parseFixed(JSON.stringify(fixed({ people: [], at: () => [] }))));
});

test("the direction of play comes from where each team spends its time", () => {
  const people = [P(1, "own"), P(2, "opp")];
  const left = fixed({ n: 300, people, at: () => [q(1, 30, 30), q(2, 70, 30)] });
  assert.equal(inferOwnAttacksRight(left), true);
  const right = fixed({ n: 300, people, at: () => [q(1, 70, 30), q(2, 30, 30)] });
  assert.equal(inferOwnAttacksRight(right), false);
  assert.equal(inferOwnAttacksRight(fixed({ n: 10, people, at: () => [q(1, 30, 30), q(2, 70, 30)] })), null);
  assert.equal(inferOwnAttacksRight(fixed({ n: 300, people, at: () => [q(1, 50, 30), q(2, 52, 30)] })), null);
});

test("heat map: seconds per cell, team attacking right, interpolated left out", () => {
  const f = fixed({ people: [P(1, "own", "Ana"), P(2, "opp")], at: (i) => [q(1, 100, 60, i < 5 ? "auto" : "interpolated"), q(2, 10, 10)] });
  const h = heatmap([{ file: f, ownRight: true }], "own", null, 2, 2);
  assert.ok(Math.abs(h.total - 0.5) < 1e-9);
  assert.ok(Math.abs(h.seconds[3] - 0.5) < 1e-9);
  const mirrored = heatmap([{ file: f, ownRight: false }], "own", null, 2, 2);
  assert.ok(Math.abs(mirrored.seconds[0] - 0.5) < 1e-9);
  assert.equal(heatmap([{ file: f, ownRight: true }], "own", "Otra", 2, 2).total, 0);
});

test("who has the ball, passes and changes of team", () => {
  // Ana (1) has it, passes to Bea (2), who loses it to an opponent (3).
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 60, 30)];
  const ball = [
    { frame: 0, x: 20.5, y: 30, source: "manual" },
    { frame: 3, x: 30, y: 30, source: "interpolated" }, // in flight: nobody
    { frame: 6, x: 39.5, y: 30, source: "manual" },
    { frame: 9, x: 59, y: 30, source: "manual" },
  ];
  const f = fixed({ people, at, ball });
  assert.deepEqual(touches(f).map((t) => t.id), [1, 2, 3]);
  const r = passesAndTurnovers(f);
  assert.deepEqual(r.passes.map((p) => [p.from, p.to]), [[1, 2]]);
  assert.deepEqual(r.turnovers, [{ frame: 9, lost: "own" }]);
  const net = passNetwork([{ file: f, ownRight: true }], "own");
  assert.deepEqual(net.edges, [{ a: "Ana", b: "Bea", count: 1 }]);
  assert.equal(net.passes, 1);
  assert.equal(net.unnamed, 0);
});

test("a ball between two rivals at the same distance belongs to nobody", () => {
  const f = fixed({ people: [P(1, "own"), P(3, "opp")], at: () => [q(1, 20, 30), q(3, 21, 30)], ball: [{ frame: 0, x: 20.5, y: 30, source: "manual" }] });
  assert.equal(touches(f).length, 0);
});

test("players behind the ball when it is lost: tagged losses and changes read from the ball", () => {
  // Own players at x 10, 30 and 80; the ball lost at x 50 (event) => 2 behind of 3 seen.
  const people = [P(1, "own"), P(2, "own"), P(4, "own"), P(3, "opp")];
  const at = () => [q(1, 10, 30), q(2, 30, 30), q(4, 80, 30), q(3, 85, 30)];
  const f = fixed({ n: 100, people, at });
  const ev = { event_id: "e", match_id: "m", video_id: "v1", t_video: 1, period: 1, type: "loss", team: "own", player_id: null, x: 50, y: 30, outcome: null, note: null };
  const r = behindBallAtLosses([{ file: f, ownRight: true }], [ev]);
  assert.deepEqual(r.map((b) => [b.behind, b.seen, b.source]), [[2, 3, "event"]]);
  // Mirrored video: the same players are now 95, 75 and 25 from the left; seen attacking right they are as before.
  const m = fixed({ n: 100, people, at: () => [q(1, 95, 38), q(2, 75, 38), q(4, 25, 38), q(3, 20, 38)] });
  assert.deepEqual(behindBallAtLosses([{ file: m, ownRight: false }], [ev]).map((b) => b.behind), [2]);
  // A change of team read from the followed ball, with no tagged loss.
  const g = fixed({ n: 10, people, at, ball: [{ frame: 0, x: 80.5, y: 30, source: "manual" }, { frame: 3, x: 84.5, y: 30, source: "manual" }] });
  assert.deepEqual(behindBallAtLosses([{ file: g, ownRight: true }], []).map((b) => [b.behind, b.source]), [[3, "ball"]]);
});

test("positions of a moment are joined between processed frames", () => {
  const f = fixed({ people: [P(1, "own", "Ana")], at: (i) => [q(1, 10 + i, 30)], ball: [{ frame: 0, x: 5, y: 5, source: "manual" }, { frame: 3, x: 8, y: 5, source: "manual" }] });
  const s = positionsAt({ file: f, ownRight: true }, 2 / 30);
  assert.ok(Math.abs(s.players[0].x - (10 + 2 / 3)) < 1e-9);
  assert.equal(s.players[0].label, "Ana");
  assert.ok(Math.abs(s.ball[0] - 7) < 1e-9);
  assert.equal(positionsAt({ file: f, ownRight: true }, 5), null);
});
