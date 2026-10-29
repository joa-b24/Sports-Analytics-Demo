import test from "node:test";
import assert from "node:assert/strict";
import { measuredKits, rowsOfTracks, unclaimed } from "./kitColors.ts";

const rows = (track, lab, n, onPitch = true) => Array.from({ length: n }, () => ({ track, lab, onPitch }));
// The case of the rival goalkeeper: picked as a vivid red, measured as a duller raspberry.
const colors = { own: "#ffffff", opp: "#028dff", opp_gk: "#e8021f", ref: "#ff80f7" };

test("tracks of one kit are one group, the bigger first; short ones and off-pitch ones are left out", () => {
  const out = measuredKits(
    [...rows(1, [238, 129, 125], 60), ...rows(2, [236, 129, 126], 50), ...rows(3, [114, 178, 130], 196), ...rows(4, [120, 120, 120], 5), ...rows(5, [50, 128, 128], 80, false)],
    colors,
  );
  assert.deepEqual(out.map((k) => k.tracks), [1, 2]);
  assert.equal(out[0].boxes, 196);
  assert.equal(out[1].boxes, 110);
});

test("the measured raspberry is claimed by no kit: it is far from the vivid red picked by eye", () => {
  const [k] = measuredKits(rows(3, [114, 178, 130], 196), colors);
  assert.equal(k.kit, null);
  assert.equal(k.nearest.key, "opp_gk");
  assert.ok(k.nearest.d > 40);
  assert.ok(unclaimed(k));
  assert.match(k.hex, /^#[0-9a-f]{6}$/);
});

test("once the measured colour is the reference, the group is claimed by that kit", () => {
  const [k] = measuredKits(rows(3, [114, 178, 130], 196), colors);
  const [again] = measuredKits(rows(3, [114, 178, 130], 196), { ...colors, opp_gk: k.hex });
  assert.equal(again.kit, "opp_gk");
  assert.ok(!unclaimed(again));
});

test("with no references nothing is claimed and nothing is unclaimed", () => {
  const [k] = measuredKits(rows(1, [238, 129, 125], 60), {});
  assert.equal(k.kit, null);
  assert.equal(k.nearest, null);
  assert.ok(!unclaimed(k));
});

test("rows are read from the boxes of a tracks file", () => {
  const file = { frames: [{ boxes: [[7, 0, 0, 10, 10, 0.9, 114, 178, 130, 1, 2, true, "unk", 7], [8, 0, 0, 1, 1, 0.9, "x", 1, 1, 1, 1, false]] }] };
  assert.deepEqual(rowsOfTracks(file), [{ track: 7, lab: [114, 178, 130], onPitch: true }]);
});
