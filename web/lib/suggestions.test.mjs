import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatesFor, dropRange, pendingSuggestions, personTimeline, rejectSuggestion, separateRange } from "./suggestions.ts";
import { editsKey, emptyEdits, hexToLab, identityOf, merge, people } from "./tracks.ts";

const BLUE = hexToLab("#2a4fb0");
const BLACK = hexToLab("#1a1a1a");
const box = (track, x, y, lab = BLUE, team = "own") => [track, x * 10, 300, x * 10 + 20, 360, 0.9, ...lab, x, y, true, team, track];
// 105 x 68 venue, 30 fps, 1 of every 3 frames, 4 s. Rivals far away, so the file has measured colours for both teams.
function file(build) {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ frame: i * 3, H: null, boxes: [box(90, 90, 60, BLACK, "opp"), box(91, 92, 62, BLACK, "opp"), ...build(i)] });
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 120, stride: 3, image_w: 1920, image_h: 1080, frames };
}
const E = (f) => emptyEdits(editsKey(f));

test("a piece that starts where she would be is suggested; one from the other team or out of reach is not", () => {
  // Track 1 walks at 2 m/s and ends at frame 57; track 2 starts 0.5 s later where she would be; track 3 at the same
  // time 20 m away; track 4 nearby but in the rival's shirt.
  const f = file((i) => [
    ...(i < 20 ? [box(1, 30 + 0.2 * i, 30)] : []),
    ...(i >= 25 ? [box(2, 30 + 0.2 * i, 30)] : []),
    ...(i >= 25 ? [box(3, 50, 50)] : []),
    ...(i >= 25 ? [box(4, 30 + 0.2 * i, 31, BLACK, "opp")] : []),
  ]);
  const e = E(f);
  const s = pendingSuggestions(f, e, people(f, e));
  const fromOne = s.filter((x) => x.from === 1);
  assert.deepEqual(fromOne.map((x) => x.to), [2]);
  assert.ok(fromOne[0].cost < 1 && fromOne[0].gapS === 0.6);

  // Accepted: it disappears and nothing else points at the absorbed piece.
  const joined = merge(e, 1, 2);
  assert.ok(!pendingSuggestions(f, joined, people(f, joined)).some((x) => x.to === 2 || x.from === 2));
  // Rejected: it does not come back, and the pair is kept for the labels.
  const no = rejectSuggestion(e, fromOne[0]);
  assert.ok(!pendingSuggestions(f, no, people(f, no)).some((x) => x.from === 1 && x.to === 2));
  assert.deepEqual(no.rejected, [[1, 2]]);
  // Candidates of one person, both ways.
  const c = candidatesFor(f, e, people(f, e), 1);
  assert.deepEqual(c.next.map((x) => x.to), [2]);
  assert.deepEqual(candidatesFor(f, e, people(f, e), 2).prev.map((x) => x.from), [1]);
});

test("a file without suggestions or people gives an empty queue", () => {
  const f = file(() => []);
  const e = E(f);
  assert.deepEqual(pendingSuggestions(f, e, people(f, e)).filter((s) => s.from < 90), []);
});

test("a stretch of her line can be left out, or taken out as another person", () => {
  const f = file(() => [box(1, 30, 30)]);
  const e = E(f);
  const dropped = dropRange(e, f, 1, 30, 39);
  assert.equal(dropped.dropped.length, 4);
  assert.ok(!personTimeline(f, dropped, 1).some((p) => p.frame >= 30 && p.frame <= 39));

  const { edits: sep, identity } = separateRange(e, f, 1, 30, 39);
  const idAt = (frame) => identityOf(f.frames[frame / 3].boxes[2], frame, sep);
  assert.equal(idAt(27), 1);
  assert.equal(idAt(42), 1);
  assert.equal(idAt(30), identity);
  assert.equal(idAt(39), identity);
  assert.notEqual(identity, 1);
});
