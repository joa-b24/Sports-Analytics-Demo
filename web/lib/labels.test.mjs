import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLabels, labelsName } from "./labels.ts";
import { dropBoxes, editsKey, emptyEdits, merge, setManual, setPerson, setRemoved, split, splitPerson } from "./tracks.ts";

const LAB = [100, 128, 128];
const box = (track, identity) => [track, 0, 0, 10, 30, 0.9, ...LAB, 50, 30, true, "unk", identity];
// 3 tracks, 5 processed frames (0, 3, ..., 12). Track 3 has no proposed identity (column 13 missing).
function file() {
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const t3 = [3, 0, 0, 10, 30, 0.9, ...LAB, 60, 30, true, "unk"];
    frames.push({ frame: i * 3, H: null, boxes: [box(1, 1), box(2, 2), t3] });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 15, stride: 3, image_w: 1920, image_h: 1080, frames, schema_version: 3, tracker: "botsort_pitch.yaml" };
}
const E = (f) => emptyEdits(editsKey(f));
const labelOf = (L, frame, track) => L.frames.find((x) => x.frame === frame).boxes.find((b) => b.track === track);

test("without edits the label is the proposed identity, or the track", () => {
  const f = file();
  const L = buildLabels(f, E(f), undefined, new Date("2026-10-14T00:00:00Z"));
  assert.equal(L.kind, "tracks_labels");
  assert.deepEqual(L.source, { schema_version: 3, tracker: "botsort_pitch.yaml", assoc: null });
  assert.equal(labelOf(L, 0, 1).label, 1);
  assert.equal(labelOf(L, 0, 3).label, 3);
  assert.equal(L.frames.reduce((n, fr) => n + fr.boxes.length, 0), 15);
  assert.equal(labelsName(f), "labels_v1_0_15.json");
});

test("merging, splitting, and merging after splitting", () => {
  const f = file();
  const merged = buildLabels(f, merge(E(f), 1, 2));
  assert.ok(merged.frames.every((fr) => labelOf(merged, fr.frame, 2).label === 1));

  const s = split(E(f), 1, 6, f);
  const L = buildLabels(f, s.edits);
  assert.equal(labelOf(L, 3, 1).label, 1);
  assert.equal(labelOf(L, 6, 1).label, s.identity);
  // The split piece joined to track 3's person moves with it.
  const both = buildLabels(f, merge(s.edits, 3, s.identity));
  assert.equal(labelOf(both, 9, 1).label, 3);
  assert.equal(labelOf(both, 0, 1).label, 1);
  const sp = splitPerson(E(f), 2, 9, f);
  assert.equal(labelOf(buildLabels(f, sp.edits), 12, 2).label, sp.identity);
});

test("dropped and removed boxes, hand marks, reviewed people, and no names", () => {
  const f = file();
  let e = dropBoxes(E(f), [{ track: 2, frame: 3 }]);
  e = setRemoved(e, 3, true);
  e = setManual(e, 1, 6, 812.5, 640);
  e = setPerson(e, 1, { player_id: "Zoe", done: true, team: "own" });
  e = { ...e, rejected: [[1, 2]] };
  const L = buildLabels(f, e);
  assert.deepEqual(labelOf(L, 3, 2), { track: 2, label: null, status: "dropped" });
  assert.deepEqual(labelOf(L, 0, 3), { track: 3, label: 3, status: "removed" });
  assert.deepEqual(labelOf(L, 0, 2), { track: 2, label: 2, status: "player" });
  assert.deepEqual(L.manual, [{ label: 1, frame: 6, px: 812.5, py: 640 }]);
  const p1 = L.people.find((p) => p.label === 1);
  assert.deepEqual(p1, { label: 1, team: "own", reviewed: true, named: true });
  assert.equal(L.people.find((p) => p.label === 2).reviewed, false);
  assert.deepEqual(L.rejected, [[1, 2]]);
  const text = JSON.stringify(L);
  assert.ok(!text.includes("player_id") && !text.includes("Zoe"));
});
