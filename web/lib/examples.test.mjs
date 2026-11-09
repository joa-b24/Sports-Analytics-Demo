import assert from "node:assert/strict";
import { test } from "node:test";
import { addNegative, addPositive, addSkipped, answered, confirmDetection, counts, emptyExamples, nextPending, parseExamples, removeAnswer, trialDetections } from "./examples.ts";

const it = (id, t = 1) => ({ id, video_id: "v1", t_video: t });

test("a second answer replaces the first and undo removes it", () => {
  let f = addPositive(emptyExamples(), it("e1"), [10.04, 20.06], false);
  assert.deepEqual(f.positives[0].px, [10, 20.1]);
  f = addSkipped(f, it("e1"));
  assert.equal(f.positives.length, 0);
  assert.equal(answered(f, "e1"), "skipped");
  f = removeAnswer(f, "e1");
  assert.equal(answered(f, "e1"), null);
});

test("trial: a false positive becomes a negative, a good one a positive; counts", () => {
  let f = emptyExamples();
  f = addNegative(f, "v2", 30, { frame: 300, px: 100.26, py: 200, p: 0.9 }, "zapato");
  f = confirmDetection(f, "v2", 30, { frame: 303, px: 5, py: 6, p: 0.8 });
  assert.equal(f.negatives[0].t_video, 10);
  assert.equal(f.negatives[0].why, "zapato");
  assert.equal(f.positives[0].id, "t_v2_303");
  f = addNegative(f, "v2", 30, { frame: 303, px: 5, py: 6, p: 0.8 }, "yarda"); // changes its mind
  const c = counts(f);
  assert.equal(c.positives, 0);
  assert.equal(c.negatives, 2);
  assert.equal(c.byWhy.yarda, 1);
  assert.equal(c.missing, 100);
});

test("next pending wraps around and says when everything is answered", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  let f = addSkipped(addSkipped(emptyExamples(), it("b")), it("c"));
  assert.equal(nextPending(list, f, 1), 0);
  f = addSkipped(f, it("a"));
  assert.equal(nextPending(list, f, 0), -1);
});

test("parse tolerates garbage and keeps interpolated detections out of the trial", () => {
  assert.deepEqual(parseExamples("no json"), emptyExamples());
  assert.deepEqual(parseExamples(JSON.stringify({ kind: "otro" })), emptyExamples());
  assert.equal(trialDetections([{ frame: 6, px: 0, py: 0, p: 1, tier: "interp" }, { frame: 3, px: 0, py: 0, p: 1, tier: "seguro" }]).length, 1);
});
