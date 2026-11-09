import assert from "node:assert/strict";
import { test } from "node:test";
import { answerDoubt, boxRect, doubtBoxes, doubtType, DOUBT_TYPES, jumpBetween, stepFrames } from "./doubts.ts";
import { emptyEdits, identityOf, merge, people, setPerson } from "./tracks.ts";

const box = (track, x, y) => [track, 100, 200, 140, 300, 0.9, 50, 0, 0, x, y, true, "unk"];
// 30 fps, stride 3. Track 1 (Ana) walks to frame 27; from frame 30 track 3 goes on 30 m away (the jump). Track 2 is
// a second box of Ana at frame 15 (two places). Track 4 starts at 60 (a doubtful join candidate).
function file() {
  const frames = [];
  for (let f = 0; f <= 90; f += 3) {
    const boxes = [];
    if (f < 30) boxes.push(box(1, 10 + f * 0.05, 30));
    if (f >= 30 && f < 60) boxes.push(box(3, 40, 30));
    if (f === 15) boxes.push(box(2, 50, 50));
    if (f >= 60) boxes.push(box(4, 42, 30));
    frames.push({ frame: f, H: null, boxes });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 90, stride: 3, image_w: 1920, image_h: 1080, frames, venue: { length_m: 105, width_m: 68 } };
}
const ana = () => {
  const f = file();
  let e = setPerson(emptyEdits("m|v1|0_90"), 1, { player_id: "Ana" });
  e = merge(e, 1, 3);
  e = merge(e, 1, 2);
  return { f, e };
};
const who = (f, e, frame, track) => identityOf(f.frames.find((x) => x.frame === frame).boxes.find((b) => b[0] === track), frame, e);

test("every kind of doubt has a legend; tasks and informative ones", () => {
  for (const k of ["salto", "dos_sitios", "union_dudosa", "hueco_largo", "sin_nombre", "no_jugadora"]) assert.ok(doubtType(k)?.todo, k);
  assert.equal(DOUBT_TYPES.filter((t) => t.task).length, 3);
});

test("Python's boxes are used as they are; without them they are worked out and marked", () => {
  const { f, e } = ana();
  const given = { kind: "salto", frame: 30, track: 3, players: ["Ana"], note: "", boxes: [{ role: "antes", frame: 27, track: 1, player: "Ana", t: 0.9, chain: 5 }, { role: "despues", frame: 30, track: 3, player: "Ana", t: 1, chain: 6 }], jump: { dist_m: 30, dt_s: 0.1, speed_ms: 300, from: [11, 30], to: [40, 30] }, resolution: { options: ["antes_es_ella", "despues_es_ella", "ninguna", "esta_bien"], default: "esta_bien" } };
  const g = doubtBoxes(given, f, e);
  assert.equal(g.derived, false);
  assert.deepEqual(g.boxes.map((b) => b.role), ["before", "after"]);
  const u = doubtBoxes({ kind: "union_dudosa", frame: 60, track: 4, players: ["Ana"], note: "", boxes: [{ role: "a", frame: 57, track: 3 }, { role: "b", frame: 60, track: 4 }, { role: "candidata", frame: 60, track: 9, player: null }] }, f, e);
  assert.deepEqual(u.boxes.map((b) => b.role), ["end", "cand", "candidata"]);
  const jump = doubtBoxes({ ...given, boxes: undefined }, f, e);
  assert.equal(jump.derived, true);
  assert.deepEqual(jump.boxes.map((b) => [b.role, b.frame, b.track]), [["before", 27, 1], ["after", 30, 3]]);
  const two = doubtBoxes({ kind: "dos_sitios", frame: 15, track: 2, players: ["Ana"], note: "" }, f, e);
  assert.deepEqual(two.boxes.map((b) => [b.role, b.track]), [["a", 1], ["b", 2]]);
  const j = jumpBetween(f, jump.boxes[0], jump.boxes[1]);
  assert.ok(j.meters > 25 && j.seconds === 0.1 && j.speed > 250);
  assert.equal(stepFrames(f, 30).length, 21);
  assert.deepEqual(boxRect(f, { frame: 30, track: 3 }), [100, 200, 140, 300]);
});

test("answers: 1 / 2 / none / ok / both / join / no join", () => {
  const { f, e } = ana();
  const jb = [{ role: "before", frame: 27, track: 1 }, { role: "after", frame: 30, track: 3 }];
  // «1 es ella»: the box after the jump is no longer Ana.
  const one = answerDoubt(e, f, jb, "pick", 0).edits;
  assert.equal(who(f, one, 27, 1), who(f, e, 27, 1));
  assert.notEqual(who(f, one, 30, 3), who(f, e, 27, 1));
  // «2 es ella»: the box before is cut out instead.
  const two = answerDoubt(e, f, jb, "pick", 1).edits;
  assert.notEqual(who(f, two, 27, 1), who(f, two, 30, 3));
  assert.equal(who(f, two, 30, 3), who(f, e, 30, 3));
  const none = answerDoubt(e, f, jb, "none").edits;
  assert.equal(people(f, none).filter((p) => p.player_id === "Ana").length <= 1, true);
  assert.equal(answerDoubt(e, f, jb, "ok").edits, e);
  const both = answerDoubt(e, f, [{ role: "a", frame: 15, track: 1 }, { role: "b", frame: 15, track: 2 }], "both").edits;
  assert.deepEqual(both.dropped.at(-1), { track: 2, frame: 15 });
  const ub = [{ role: "end", frame: 57, track: 3 }, { role: "cand", frame: 60, track: 4 }];
  const joined = answerDoubt(e, f, ub, "join").edits;
  assert.equal(who(f, joined, 60, 4), who(f, joined, 57, 3));
  const apart = answerDoubt(joined, f, ub, "nojoin").edits;
  assert.notEqual(who(f, apart, 60, 4), who(f, apart, 57, 3));
});

test("dos_sitios «Ninguna»: neither box stays hers", () => {
  const { f, e } = ana();
  const her = who(f, e, 15, 1);
  const two = [{ role: "a", frame: 15, track: 1 }, { role: "b", frame: 15, track: 2 }];
  const r = answerDoubt(e, f, two, "none");
  assert.equal(r.changed, 2);
  assert.notEqual(who(f, r.edits, 15, 1), her);
  assert.notEqual(who(f, r.edits, 15, 2), her);
});
