import assert from "node:assert/strict";
import { test } from "node:test";
import { fullWindows, periodAt, withFullMark } from "./videos.ts";

const v = { video_id: "v1", youtube_id: "x", label: "" };

test("a full video needs its four marks, in order; with less it is read as one half", () => {
  assert.equal(fullWindows(v), null);
  assert.equal(fullWindows({ ...v, full: { h1_start: 0, h1_end: 600 } }), null);
  assert.equal(fullWindows({ ...v, full: { h1_start: 0, h1_end: 600, h2_start: 500, h2_end: 900 } }), null); // second half before the first ends
  assert.deepEqual(fullWindows({ ...v, full: { h1_start: 10, h1_end: 600, h2_start: 900, h2_end: 1500 } }), { h1: [10, 600], h2: [900, 1500] });
});

test("periodAt: by the marks in a full video, by the period of the video otherwise", () => {
  const full = { ...v, full: { h1_start: 0, h1_end: 600, h2_start: 900, h2_end: 1500 } };
  assert.equal(periodAt(full, 0, 100), 1);
  assert.equal(periodAt(full, 0, 700), 1); // before the middle of the break (750)
  assert.equal(periodAt(full, 0, 800), 2);
  assert.equal(periodAt({ ...v, period: 2 }, 0, 5), 2);
  assert.equal(periodAt(v, 1, 5), 2);
});

test("withFullMark sets and removes one mark", () => {
  const a = withFullMark(v, "h1_start", 12);
  assert.equal(a.full.h1_start, 12);
  assert.equal(withFullMark(a, "h1_start", undefined).full.h1_start, undefined);
});
