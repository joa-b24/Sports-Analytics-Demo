import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTwice, noneIsHer, pendingTwice, skipTwice } from "./doubles.ts";
import { emptyEdits, merge, people, setPerson } from "./tracks.ts";

const box = (track, x) => [track, 0, 0, 10, 30, 0.9, 50, 0, 0, x, 30, true, "unk"];
// Ana is track 1 all along; track 2 is joined to her by mistake and sits at frames 30-45 (two boxes there).
function file() {
  const frames = [];
  for (let f = 0; f <= 90; f += 3) {
    const boxes = [box(1, 10)];
    if (f >= 30 && f <= 45) boxes.push(box(2, 60));
    frames.push({ frame: f, H: null, boxes });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 90, stride: 3, image_w: 1920, image_h: 1080, frames };
}
const ana = () => merge(setPerson(emptyEdits("k"), 1, { player_id: "Ana" }), 1, 2);

test("skipping a double box remembers it and goes to the next", () => {
  const f = file();
  const e = ana();
  const her = people(f, e).find((p) => p.player_id === "Ana");
  assert.deepEqual(her.conflicts, [30, 33, 36, 39, 42, 45]);
  const s = skipTwice(e, her.id, 30);
  assert.deepEqual(pendingTwice(her.conflicts, her.id, s), [33, 36, 39, 42, 45]);
  assert.equal(nextTwice(pendingTwice(her.conflicts, her.id, s), 30), 33);
  assert.equal(nextTwice([], 0), null);
  assert.equal(s.identity, e.identity, "nothing edited");
});

test("«Ninguna es ella» takes both boxes ±0.5 s out of her", () => {
  const f = file();
  const e = ana();
  const id = people(f, e).find((p) => p.player_id === "Ana").id;
  const r = noneIsHer(e, f, id, 36, 15);
  assert.ok(r.boxes > 0);
  const her = people(f, r.edits).find((p) => p.player_id === "Ana");
  assert.ok(!her || !her.frames.includes(36), "no box of hers left at 36");
  assert.ok(r.edits.dropped.some((d) => d.track === 1 && d.frame === 36) && r.edits.dropped.some((d) => d.track === 2 && d.frame === 36));
});
