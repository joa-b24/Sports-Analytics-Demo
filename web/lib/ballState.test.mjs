import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixed } from "./fixedExport.ts";
import { ballPath, ballStateAt, ballStateAtFrame, ballStateRanges, manualBall } from "./parts.ts";
import { touches } from "./positions.ts";
import { possessionIntervals } from "./possession.ts";
import { editsKey, emptyEdits, removeBallState, setBall, setBallState, toggleAerial } from "./tracks.ts";

// The three states of the ball: visible (a mark), «no se ve» (hidden) and «fuera» (out).

const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1];
const part = {
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 150, stride: 3, image_w: 1050, image_h: 680,
  frames: Array.from({ length: 50 }, (_, i) => ({ frame: i * 3, H, boxes: [] })),
};
const E = () => emptyEdits(editsKey(part));
// Pixel of a point of the pitch on this plain-scale calibration: 10 px per meter.
const px = (x, y) => [x * 10, y * 10];
const mark = (e, frame, x, y) => setBall(e, frame, ...px(x, y));

test("states are marks: a visible mark replaces a state of its frame and a state replaces the mark; undoing is a plain edit", () => {
  let e = mark(E(), 30, 40, 30);
  e = setBallState(e, 60, "out");
  assert.deepEqual(e.ballStates, [{ frame: 60, state: "out" }]);
  e = setBallState(e, 30, "hidden"); // the visible mark of frame 30 goes
  assert.deepEqual((e.ball ?? []).map((b) => b.frame), []);
  e = mark(e, 30, 41, 30); // and comes back replacing the state
  assert.deepEqual(e.ballStates, [{ frame: 60, state: "out" }]);
  assert.deepEqual(removeBallState(e, 60).ballStates, []);
  // The aerial flag lives on the visible mark, survives moving it, and is not set without a mark.
  assert.equal(toggleAerial(E(), 30), null);
  const a = toggleAerial(e, 30);
  assert.equal(a.ball[0].aerial, true);
  assert.equal(mark(a, 30, 45, 30).ball[0].aerial, true);
  assert.equal(toggleAerial(a, 30).ball[0].aerial, undefined);
  assert.equal(manualBall(part, a)[0].aerial, true);
});

test("ranges last until the next mark of any kind; the end of the part leaves them open", () => {
  let e = mark(E(), 0, 10, 30);
  e = setBallState(e, 30, "out");
  e = mark(e, 60, 50, 30);
  e = setBallState(e, 90, "hidden");
  e = setBallState(e, 120, "out");
  const r = ballStateRanges(e);
  assert.deepEqual(r, [
    { from: 30, to: 60, state: "out" },
    { from: 90, to: 120, state: "hidden" },
    { from: 120, to: null, state: "out" },
  ]);
  assert.equal(ballStateAtFrame(r, 0), "visible");
  assert.equal(ballStateAtFrame(r, 30), "out");
  assert.equal(ballStateAtFrame(r, 57), "out");
  assert.equal(ballStateAtFrame(r, 60), "visible");
  assert.equal(ballStateAtFrame(r, 100), "hidden");
  assert.equal(ballStateAtFrame(r, 149), "out");
});

test("ballPath: «fuera» is never crossed by a line and drops the tracker; «no se ve» is crossed whatever its length", () => {
  const k = (frame, x, source = "manual") => ({ frame, x, y: 30, source });
  const known = [k(0, 10), k(45, 30, "auto"), k(300, 60)]; // 10 s apart: normally empty
  // Out from 30 to 150: nothing inside, no line to the mark after.
  const out = ballPath(known, 30, 3, 3, [], [{ from: 30, to: 150, state: "out" }]);
  assert.ok(out.every((b) => b.frame <= 27 || b.frame >= 300 || b.source === "manual"));
  assert.ok(!out.some((b) => b.frame === 45)); // the tracker's point inside the stretch is replaced by what the analyst said
  assert.ok(!out.some((b) => b.source === "interpolated" && b.frame > 30 && b.frame < 300));
  // Hidden: the ball stays in play, so it is joined to the next mark even beyond 3 s, always as interpolated.
  const hid = ballPath(known, 30, 3, 3, [], [{ from: 30, to: 300, state: "hidden" }]);
  assert.ok(hid.some((b) => b.frame === 150 && b.source === "interpolated"));
  assert.ok(!hid.some((b) => b.frame === 45 && b.source === "auto"));
  // Without states nothing changes.
  assert.equal(ballPath(known, 30, 3).filter((b) => b.source === "interpolated").length > 0, true);
});

test("the export carries the states, the aerial flag, and no ball inside «fuera»", () => {
  let e = mark(E(), 0, 10, 30);
  e = setBallState(e, 30, "out");
  e = mark(e, 90, 60, 30);
  e = toggleAerial(e, 90);
  e = setBallState(e, 120, "hidden");
  const { out } = buildFixed(part, e, { smooth: null });
  assert.deepEqual(out.ball_states, [
    { from: 30, to: 90, state: "out" },
    { from: 120, to: null, state: "hidden" },
  ]);
  assert.ok(!out.ball.some((b) => b.frame >= 30 && b.frame < 90));
  assert.equal(out.ball.find((b) => b.frame === 90).aerial, true);
  assert.equal(out.ball.find((b) => b.frame === 90).source, "manual");
  // ballStateAt, for whoever reads the file.
  const f = out;
  const parts = [{ file: f }];
  assert.equal(ballStateAt(parts, "v1", 0.5), "visible");
  assert.equal(ballStateAt(parts, "v1", 1.5), "out");
  assert.equal(ballStateAt(parts, "v1", 3.1), "visible");
  assert.equal(ballStateAt(parts, "v1", 4.2), "hidden");
  assert.equal(ballStateAt(parts, "v2", 1), null);
  assert.equal(ballStateAt(parts, "v1", 99), null);
  // A file saved before the states existed is all visible.
  assert.equal(ballStateAt([{ file: { ...f, ball_states: undefined } }], "v1", 1.5), "visible");
});

const fixed = ({ n = 40, people, at, ball = [], ball_states }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  venue: { length_m: 105, width_m: 68 }, people, ball, ...(ball_states ? { ball_states } : {}),
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });
const parts = (f) => [{ file: f, ownRight: true }];
const NS = { stillS: 1e9 };

test("possession: «fuera» is dead, no team and no credit even with a player on the spot; the next visible mark starts anew", () => {
  // Ana stands where the ball left the pitch. The ball is marked at (50, 30) until frame 29, out from 30 to 89, back at 90.
  const people = [P(1, "own", "Ana")];
  const at = () => [q(1, 50.5, 30)];
  const ball = [];
  for (let f = 0; f < 30; f += 3) ball.push({ frame: f, x: 50, y: 30, source: "manual" });
  for (let f = 90; f < 120; f += 3) ball.push({ frame: f, x: 50, y: 30, source: "manual" });
  const f = fixed({ at, people, ball, ball_states: [{ from: 30, to: 90, state: "out" }] });
  const r = possessionIntervals(parts(f), {}, NS);
  const inOut = r.samples.filter((s) => s.t0 >= 1 - 1e-9 && s.t1 <= 3 + 1e-9);
  assert.ok(inOut.length > 0);
  assert.ok(inOut.every((s) => s.team === "none" && s.kind === "dead" && s.notes.includes("out")));
  assert.ok(r.samples.filter((s) => s.t1 <= 1 + 1e-9).every((s) => s.team === "own"));
  assert.ok(r.samples.filter((s) => s.t0 >= 3 - 1e-9).every((s) => s.team === "own"));
  // The same file without the stretch: a continuous possession (the control of Ana would run through it).
  const none = possessionIntervals(parts({ ...f, ball_states: undefined, ball: [...ball, ...Array.from({ length: 20 }, (_, i) => ({ frame: 30 + i * 3, x: 50, y: 30, source: "manual" }))] }), {}, NS);
  assert.ok(none.samples.filter((s) => s.t0 >= 1 && s.t1 <= 3).every((s) => s.team === "own"));
});

test("possession: «no se ve» is never a measured contact, even if the file still has a measured ball inside it", () => {
  const people = [P(1, "own", "Ana")];
  const ball = Array.from({ length: 40 }, (_, i) => ({ frame: i * 3, x: 50, y: 30, source: "manual" }));
  const f = fixed({ people, at: () => [q(1, 50.5, 30)], ball });
  const base = possessionIntervals(parts(f), {}, NS);
  assert.ok(base.samples.some((s) => s.contact));
  const hid = possessionIntervals(parts({ ...f, ball_states: [{ from: 0, to: null, state: "hidden" }] }), {}, NS);
  assert.ok(hid.samples.every((s) => !s.contact));
  assert.ok(hid.samples.every((s) => s.team === "none" || s.notes.includes("no_measured_touch") || s.kind !== "control"));
});

test("an aerial mark (the shadow on the ground) is never a touch, even right next to a player", () => {
  const people = [P(1, "own", "Ana")];
  const ball = Array.from({ length: 40 }, (_, i) => ({ frame: i * 3, x: 50, y: 30, source: "manual", aerial: true }));
  const f = fixed({ people, at: () => [q(1, 50.5, 30)], ball });
  assert.equal(touches(f).length, 0);
  assert.ok(possessionIntervals(parts(f), {}, NS).samples.every((s) => !s.contact && s.team === "none"));
  assert.equal(touches({ ...f, ball: ball.map((b) => ({ frame: b.frame, x: b.x, y: b.y, source: b.source })) }).length, 40);
});
