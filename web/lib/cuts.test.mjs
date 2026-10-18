import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHint, applyTeamCuts, cutHints } from "./cuts.ts";
import { editsKey, emptyEdits, hexToLab, identityOf, people } from "./tracks.ts";

const BLUE = hexToLab("#2a4fb0");
const BLACK = hexToLab("#1a1a1a");
// 105 x 68 venue (1 unit = 1 m), 30 fps, 1 of every 3 frames. The program said who is "own" and "opp" (column 12).
const box = (track, x, y, lab, team, identity = track) => [track, 0, 0, 10, 30, 0.9, ...lab, x, y, true, team, identity];
function file(build) {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ frame: i * 3, H: null, boxes: build(i) });
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 120, stride: 3, image_w: 1920, image_h: 1080, frames };
}
// Background players so the file has measured colours for both teams.
const crowd = () => [box(50, 10, 10, BLUE, "own"), box(51, 90, 60, BLACK, "opp"), box(52, 12, 12, BLUE, "own"), box(53, 92, 58, BLACK, "opp")];

test("a jump of 12 m in 0.1 s is a place to cut; walking is not", () => {
  const f = file((i) => [...crowd(), box(1, i < 20 ? 30 + 0.2 * i : 46 + 0.2 * i, 30, BLUE, "own")]);
  const hints = cutHints(f, emptyEdits(editsKey(f))).filter((h) => h.person === 1);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].kind, "jump");
  assert.equal(hints[0].frame, 60);
  assert.ok(hints[0].meters > 12);
});

test("an excursion of a few frames to somebody else is taken out, and she goes on as herself", () => {
  // Frames 15-17 of track 1 are boxes of a player 15 m away; then back on her way.
  const f = file((i) => [...crowd(), box(1, 15 <= i && i <= 17 ? 60 : 30 + 0.2 * i, 30, BLUE, "own")]);
  const e = emptyEdits(editsKey(f));
  const [h] = cutHints(f, e).filter((x) => x.person === 1);
  assert.equal(h.kind, "excursion");
  assert.deepEqual([h.frame, h.until], [45, 54]);
  const fixed = applyHint(e, f, h);
  const idAt = (frame) => identityOf(f.frames[frame / 3].boxes[4], frame, fixed);
  assert.equal(idAt(42), 1);
  assert.equal(idAt(54), 1);
  assert.notEqual(idAt(45), 1);
  assert.equal(idAt(48), idAt(45));
  assert.deepEqual(cutHints(f, fixed).filter((x) => x.person === 1), []);
});

test("a person whose shirt changes team half way is cut where it changes", () => {
  const f = file((i) => [...crowd(), box(1, 30 + 0.2 * i, 30, i < 20 ? BLUE : BLACK, "own")]);
  const e = emptyEdits(editsKey(f));
  const [h] = cutHints(f, e).filter((x) => x.person === 1);
  assert.deepEqual([h.kind, h.frame, h.from, h.to], ["team", 60, "own", "opp"]);
  const fixed = applyHint(e, f, h);
  const teams = people(f, fixed).filter((p) => p.tracks.includes(1)).map((p) => p.team).sort();
  assert.deepEqual(teams, ["opp", "own"]);
});

test("the team of a person comes from the colours measured in the file, not from the picked ones", () => {
  // Picked colours far from what was measured: the person is still own, by her boxes.
  const f = file(() => [...crowd(), box(1, 30, 30, BLUE, "own")]);
  const p = people(f, emptyEdits(editsKey(f)), { own: "#ff00ff", opp: "#00ff00" }).find((x) => x.id === 1);
  assert.equal(p.team, "own");
});

test("all changes of shirt at once: one person with two changes ends as three", () => {
  // Track 1 wears blue, then black from frame 13, then blue again from frame 27.
  const f = file((i) => [...crowd(), box(1, 30 + 0.1 * i, 30, i < 13 || i >= 27 ? BLUE : BLACK, i < 13 || i >= 27 ? "own" : "opp")]);
  const e = emptyEdits(editsKey(f));
  const hints = cutHints(f, e).filter((h) => h.person === 1 && h.kind === "team");
  assert.equal(hints.length, 2);
  const r = applyTeamCuts(e, f, hints);
  assert.equal(r.cuts, 2);
  const ids = new Set(f.frames.map((fr) => identityOf(fr.boxes[4], fr.frame, r.edits)));
  assert.equal(ids.size, 3);
  assert.equal(identityOf(f.frames[0].boxes[4], 0, r.edits), 1);
});

