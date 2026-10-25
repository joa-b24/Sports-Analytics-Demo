import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFit, clearFit, feetOffsets, fitAt, fitCount, fitKeys, newFitId, removeKey, setKey } from "./feetKeys.ts";
import { measuredPaths } from "./parts.ts";
import { editsKey, emptyEdits, setManual } from "./tracks.ts";

const LAB = [100, 128, 128];
// Box of track 1 in processed frame i: moves 10 px right per frame, bottom at y = 300.
const box = (i) => [1, 100 + i * 10, 200, 120 + i * 10, 300, 0.9, ...LAB, 0, 0, true, "unk", 1];
// 30 fps, every frame processed (stride 1), 60 frames; H changes with the frame (a camera pan: x shifts by frame/10 m).
const Hof = (f) => [0.1, 0, -f / 10, 0, 0.1, 0, 0, 0, 1];
const file = {
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 60, stride: 1, image_w: 1050, image_h: 680,
  frames: Array.from({ length: 60 }, (_, i) => ({ frame: i, H: Hof(i), boxes: [box(i)] })),
};
const E = () => emptyEdits(editsKey(file));
const at = (edits, frame) => edits.manual.find((m) => m.identity === 1 && m.frame === frame);

test("Δ is interpolated between keys and the feet follow the box sideways", () => {
  // Frame 20: bottom centre (310, 300), click 10 px lower. Frame 30: (410, 300), click 30 px lower.
  const e = applyFit(file, E(), 1, 1, [{ frame: 20, px: 310, py: 310 }, { frame: 30, px: 410, py: 330 }]);
  const m = at(e, 25);
  assert.equal(m.key, false);
  assert.equal(m.px, 360);
  assert.equal(m.py, 320);
  assert.equal(at(e, 20).key, true);
});

test("outside the keys Δ is held at most 0.5 s, fading out, and not beyond", () => {
  const e = applyFit(file, E(), 1, 1, [{ frame: 20, px: 310, py: 310 }, { frame: 30, px: 410, py: 330 }]);
  // 0.3 s after the last key (9 frames): full Δ.
  assert.equal(at(e, 39).py, 330);
  // 0.5 s = 15 frames: faded to the box itself; frame 46 has nothing.
  assert.equal(at(e, 45).py, 300);
  assert.equal(at(e, 46), undefined);
  assert.equal(at(e, 4), undefined);
  assert.ok(at(e, 5));
});

test("one key: its Δ, constant ±0.5 s", () => {
  const d = feetOffsets(file, E(), 1, [{ frame: 30, px: 410, py: 320 }]);
  assert.deepEqual(d.get(25), [0, 20]);
  assert.deepEqual(d.get(36), [0, 20]);
  assert.equal(d.has(14), false);
  assert.equal(d.has(46), false);
});

test("keys are added, moved, removed, and the stretch cleared at once", () => {
  const fit = newFitId(E());
  let e = setKey(file, E(), 1, fit, { frame: 20, px: 310, py: 310 });
  e = setKey(file, e, 1, fit, { frame: 30, px: 410, py: 330 });
  e = setKey(file, e, 1, fit, { frame: 30, px: 410, py: 340 });
  assert.equal(fitKeys(e, 1, fit).length, 2);
  assert.equal(fitAt(e, 1, 25), fit);
  assert.deepEqual(fitCount(e, 1, fit), { keys: 2, adjusted: 41 });
  e = removeKey(file, e, 1, fit, 30);
  assert.equal(fitKeys(e, 1, fit).length, 1);
  e = clearFit(e, 1, fit);
  assert.equal(e.manual.length, 0);
});

test("marks clicked one by one stay, and the interpolated ones go to meters with the H of each frame", () => {
  let e = setManual(E(), 1, 25, 999, 999);
  e = applyFit(file, e, 1, 1, [{ frame: 20, px: 310, py: 310 }, { frame: 30, px: 410, py: 330 }]);
  assert.deepEqual([at(e, 25).px, at(e, 25).fit], [999, undefined]);
  assert.equal(clearFit(e, 1, 1).manual.length, 1);
  const path = measuredPaths(file, e).get(1);
  const p26 = path.find((p) => p.frame === 26 && p.source === "manual");
  // Pixel (370, 322): x = 37 - 2.6 m, y = 32.2 m.
  assert.ok(Math.abs(p26.x - 34.4) < 1e-6 && Math.abs(p26.y - 32.2) < 1e-6);
});
