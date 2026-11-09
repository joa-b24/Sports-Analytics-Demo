import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptAuto, autoFramesIn, autoTracklets, jumpStops, rejectAuto, rejectOffLine, removeMarksIn, setAirIn, stepJump } from "./ballEdit.ts";
import { ballPath, manualBall } from "./parts.ts";
import { editsKey, emptyEdits, toggleAir } from "./tracks.ts";

const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1];
const file = { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, image_w: 1050, image_h: 680, frames: Array.from({ length: 100 }, (_, i) => ({ frame: i * 3, H, boxes: [] })) };
const E = () => emptyEdits(editsKey(file));
const auto = (list) => ({ frames: list.map(([frame, px, py]) => ({ frame, px, py, p: 0.9 })), ask: [] });

test("tracklets: chain close detections, split at jumps and long gaps", () => {
  const a = auto([[0, 100, 100], [3, 105, 100], [6, 110, 102], [9, 600, 400], [12, 604, 402], [200, 610, 400]]);
  const t = autoTracklets(a, E(), 30, 3);
  assert.deepEqual(t.map((x) => x.frames), [[0, 3, 6], [9, 12], [200]]);
});

test("rejecting and accepting detections; hand marks and rejected ones leave the live list", () => {
  const a = auto([[0, 1, 1], [3, 2, 2], [6, 3, 3]]);
  let e = rejectAuto(E(), [3]);
  assert.deepEqual(autoFramesIn(a, e, 0, 6), [0, 6]);
  e = acceptAuto(e, a, [0, 3]);
  assert.deepEqual(e.ball.map((b) => b.frame), [0, 3]);
  assert.deepEqual(autoFramesIn(a, e, 0, 6), [6]);
});

test("a line by hand rejects the detections that are not on it", () => {
  let e = { ...E(), ball: [{ frame: 0, px: 100, py: 100 }, { frame: 30, px: 400, py: 100 }] };
  const a = auto([[3, 130, 100], [6, 160, 300], [15, 250, 102]]);
  const r = rejectOffLine(e, a, 0, 30);
  assert.equal(r.n, 1);
  assert.deepEqual(r.edits.ballRejected, [6]);
});

test("removing marks of a range takes their lines too", () => {
  let e = { ...E(), ball: [{ frame: 0, px: 1, py: 1 }, { frame: 9, px: 1, py: 1 }, { frame: 30, px: 1, py: 1 }], ballLinks: [{ from: 9, to: 30 }] };
  e = removeMarksIn(e, 5, 12);
  assert.deepEqual(e.ball.map((b) => b.frame), [0, 30]);
  assert.deepEqual(e.ballLinks, []);
});

test("jump stops: both frames of each jump, in order, and stepping", () => {
  const stops = jumpStops([{ before: 30, frame: 60 }, { before: 6, frame: 9 }]);
  assert.deepEqual(stops, [6, 9, 30, 60]);
  assert.equal(stepJump(stops, 9, 1), 30);
  assert.equal(stepJump(stops, 9, -1), 6);
  assert.equal(stepJump(stops, 60, 1), null);
  assert.equal(stepJump(stops, 6, -1), null);
});

test("a mark in the air is placed between the marks on the ground, NaN (left out) without both", () => {
  let e = { ...E(), ball: [{ frame: 0, px: 100, py: 100 }, { frame: 15, px: 300, py: 50, air: true }, { frame: 30, px: 500, py: 100 }] };
  const m = manualBall(file, e);
  const mid = m.find((p) => p.frame === 15);
  assert.ok(mid.air && mid.aerial);
  assert.ok(Math.abs(mid.x - 30) < 1e-6); // halfway between 10 and 50 m
  e = { ...E(), ball: [{ frame: 0, px: 100, py: 100 }, { frame: 15, px: 300, py: 50, air: true }] };
  assert.equal(manualBall(file, e).some((p) => p.frame === 15), false);
});

test("flight: plain interpolation is not air; a stretch with an air mark is, with a lift", () => {
  const plain = ballPath([{ frame: 0, x: 10, y: 10, source: "manual" }, { frame: 30, x: 50, y: 10, source: "manual" }], 30, 3);
  assert.equal(plain.some((p) => p.air), false);
  const fly = ballPath([{ frame: 0, x: 10, y: 10, source: "manual" }, { frame: 15, x: 30, y: 10, source: "manual", air: true, aerial: true }, { frame: 30, x: 50, y: 10, source: "manual" }], 30, 3);
  const inner = fly.filter((p) => p.frame > 0 && p.frame < 30);
  assert.ok(inner.every((p) => p.air && p.lift > 0));
  assert.equal(fly[0].air, undefined);
  const top = fly.find((p) => p.frame === 15);
  assert.ok(top.lift >= fly.find((p) => p.frame === 3).lift);
});

test("air flag toggles and ranges", () => {
  let e = { ...E(), ball: [{ frame: 3, px: 1, py: 1 }, { frame: 6, px: 1, py: 1 }] };
  e = toggleAir(e, 3);
  assert.equal(e.ball[0].air, true);
  e = setAirIn(e, 0, 10, true);
  assert.deepEqual(e.ball.map((b) => !!b.air), [true, true]);
  e = setAirIn(e, 0, 10, false);
  assert.deepEqual(e.ball.map((b) => !!b.air), [false, false]);
  assert.equal(toggleAir(e, 99), null);
});
