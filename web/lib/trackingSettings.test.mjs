import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings, testVerdict, writeSettings } from "./trackingSettings.ts";

const YAML = `match_id: partido_x
kind: own
analysis_stride: 3

# Cámara amplia
detector: {model: yolo11s_1280_openvino_model, tiles: 2, band: auto}

jersey_colors: {own: "#080a04"}
`;

test("reads the detector line and the stride", () => {
  assert.deepEqual(readSettings(YAML), { model: "yolo11s_1280_openvino_model", tiles: 2, band: "auto", conf: 0.2, stride: 3 });
  assert.equal(readSettings(null).model, "yolo11n_1280_openvino_model");
});

test("writes them back without touching anything else", () => {
  const out = writeSettings(YAML, { model: "yolo11s_openvino_model", tiles: 1, band: "all", conf: 0.25, stride: 2 });
  assert.match(out, /^detector: \{model: yolo11s_openvino_model, tiles: 1, conf: 0.25\}$/m);
  assert.match(out, /^analysis_stride: 2$/m);
  assert.match(out, /^# Cámara amplia$/m);
  assert.match(out, /^jersey_colors: \{own: "#080a04"\}$/m);
  assert.deepEqual(readSettings(out), { model: "yolo11s_openvino_model", tiles: 1, band: "all", conf: 0.25, stride: 2 });
});

test("adds the lines when the file has none", () => {
  const out = writeSettings("match_id: y\nkind: rival\n", { model: "yolo11n_openvino_model", tiles: 1, band: "auto", conf: 0.2, stride: 3 });
  assert.match(out, /^match_id: y\nanalysis_stride: 3$/m);
  assert.match(out, /detector: \{model: yolo11n_openvino_model, tiles: 1, band: auto, conf: 0.2\}\n$/);
});

test("the verdict of a short test", () => {
  const base = { frames: 300, boxes_median: 22, on_pitch_median: 20, calibrated_share: 0.95, identities: 24, ms_per_frame: 300, estimate_s: 9000, part: "", start_s: 0, end_s: 30, model: "", tiles: 1, conf: 0.2, stride: 3, created: "" };
  assert.equal(testVerdict(base).tone, "ok");
  assert.equal(testVerdict({ ...base, on_pitch_median: 8 }).tone, "bad");
  assert.equal(testVerdict({ ...base, on_pitch_median: 13 }).tone, "warn");
  assert.equal(testVerdict({ ...base, calibrated_share: 0.3 }).tone, "bad");
});
