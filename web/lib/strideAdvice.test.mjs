import test from "node:test";
import assert from "node:assert/strict";
import { strideAdvice } from "./trackingSettings.ts";
import { readVideoFps, videoMasks } from "./matchYaml.ts";

test("30 fps with 1 of every 3 is the usual step: no warning", () => {
  assert.equal(strideAdvice(30, 3), null);
  assert.equal(strideAdvice(29.97, 3), null);
});
test("60 fps with 1 of every 3 is twice as often: suggests 6", () => {
  const a = strideAdvice(60, 3);
  assert.equal(a?.suggested, 6);
  assert.ok(Math.abs((a?.factor ?? 0) - 2) < 1e-9);
});
test("unknown fps or the suggested stride already set: nothing to say", () => {
  assert.equal(strideAdvice(null, 3), null);
  assert.equal(strideAdvice(60, 6), null);
});

const yaml = `match_id: x
videos:
  - video_id: v1
    fps: 60
    mask: [[20, 25, 670, 78], [1138, 36, 1247, 130]]
  - video_id: v2
    fps: 30
`;
test("fps and masks are read per video", () => {
  assert.equal(readVideoFps(yaml, "v1"), 60);
  assert.equal(readVideoFps(yaml, "v2"), 30);
  assert.equal(readVideoFps(yaml, "v9"), null);
  assert.deepEqual(videoMasks(yaml), [{ videoId: "v1", rects: [[20, 25, 670, 78], [1138, 36, 1247, 130]] }]);
});
