import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAbsorb,
  clash,
  dropBoxes,
  duplicatesAmong,
  editsKey,
  emptyEdits,
  hexToLab,
  identityOf,
  labToHex,
  merge,
  nearestFrame,
  overlap,
  people,
  removeManual,
  samePlayer,
  setManual,
  setPerson,
  setRemoved,
  setRemovedMany,
  separateTrack,
  split,
  splitPerson,
  suggestAbsorb,
  teamOfColor,
} from "./tracks.ts";

const BLUE = hexToLab("#2a4fb0");
const BLACK = hexToLab("#1a1a1a");
const box = (track, lab, identity = track, inside = true) => [track, 0, 0, 10, 30, 0.9, ...lab, 50, 30, inside, "unk", identity];

// 10 processed frames (stride 3). Track 1 for the first half, track 2 (same player, proposed as identity 1) for the
// second half after a hole; track 5 is another player all along; track 9 is somebody on the bench.
function file() {
  const frames = [];
  for (let i = 0; i < 10; i++) {
    const f = 300 + i * 3;
    const boxes = [box(5, BLACK)];
    if (i < 4) boxes.push(box(1, BLUE));
    if (i >= 7) boxes.push(box(2, BLUE, 1));
    if (i < 2) boxes.push(box(9, BLACK, 9, false));
    frames.push({ frame: f, H: null, boxes });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 300, end_frame: 330, stride: 3, image_w: 1920, image_h: 1080, frames };
}
const E = () => emptyEdits(editsKey(file()));
const byId = (list) => Object.fromEntries(list.map((p) => [p.id, p]));

test("colours convert both ways and decide the team", () => {
  assert.equal(labToHex(hexToLab("#2a4fb0")), "#2a4fb0");
  assert.equal(hexToLab("azul"), null);
  const kits = { own: "#2a4fb0", opp: "#1a1a1a", ref: "#e6e04b" };
  assert.equal(teamOfColor(hexToLab("#3155a8"), kits), "own");
  assert.equal(teamOfColor(hexToLab("#262220"), kits), "opp");
  assert.equal(teamOfColor(hexToLab("#c2185b"), kits), "unk");
  assert.equal(teamOfColor(BLUE, undefined), "unk");
  // The goalkeeper wears another colour and still counts for her team.
  const withKeepers = { ...kits, own_gk: "#f28c28", opp_gk: "#39b54a" };
  assert.equal(teamOfColor(hexToLab("#ef8a2c"), withKeepers), "own");
  assert.equal(teamOfColor(hexToLab("#3cb24d"), withKeepers), "opp");
  // Same shirt in the shade: darker, same hue. Lightness counts half, so it stays with its team.
  assert.equal(teamOfColor(hexToLab("#1d3a85"), kits), "own");
});

test("the file's proposal joins fragments, and the hole between them is reported", () => {
  // 0.4 s without her: below the default of half a second, so the test asks for shorter holes too.
  const ps = byId(people(file(), E(), { own: "#2a4fb0", opp: "#1a1a1a" }, 0.2));
  assert.deepEqual(Object.keys(ps).map(Number).sort((a, b) => a - b), [1, 5, 9]);
  assert.deepEqual(ps[1].tracks, [1, 2]);
  assert.equal(ps[1].team, "own");
  assert.equal(ps[1].teamByHand, false);
  assert.deepEqual(ps[1].gaps, [[309, 321]]); // lost from frame 309 to 321
  assert.deepEqual(ps[5].gaps, []);
  assert.equal(ps[9].onPitchShare, 0);
});

test("merge makes two identities one person and keeps what was set on either", () => {
  let e = setPerson(E(), 5, { player_id: "7" });
  e = setPerson(e, 1, { team: "own" });
  e = merge(e, 1, 5);
  const ps = people(file(), e);
  assert.deepEqual(ps.map((p) => p.id).sort((a, b) => a - b), [1, 9]);
  assert.equal(byId(ps)[1].player_id, "7");
  assert.equal(byId(ps)[1].team, "own");
  assert.deepEqual(byId(ps)[1].tracks, [1, 2, 5]);
  // Merging 1 into 9 afterwards carries everything that was already part of 1.
  assert.deepEqual(people(file(), merge(e, 9, 1)).map((p) => p.id), [9]);
  assert.equal(merge(e, 1, 1), e);
});

test("split sends a track to a new person from a frame on", () => {
  const f = file();
  const { edits, identity } = split(E(), 5, 315, f);
  assert.ok(identity > 9);
  assert.equal(identityOf(f.frames[0].boxes[0], 300, edits), 5);
  assert.equal(identityOf(f.frames[5].boxes[0], 315, edits), identity);
  const ps = byId(people(f, edits));
  assert.deepEqual([ps[5].first, ps[5].last], [300, 312]);
  assert.deepEqual([ps[identity].first, ps[identity].last], [315, 327]);
  // The new piece can then be merged into whoever it really is.
  const fixed = byId(people(f, merge(edits, 1, identity)));
  assert.equal(fixed[identity], undefined);
  assert.deepEqual(fixed[1].tracks, [1, 2, 5]);
});

test("a hand-marked position fills a hole", () => {
  const f = file();
  let e = setManual(E(), 1, 312, 800, 600);
  e = setManual(e, 1, 315, 810, 600);
  e = setManual(e, 1, 318, 820, 600);
  e = setManual(e, 1, 315, 812, 601); // marking again replaces
  assert.equal(e.manual.length, 3);
  assert.deepEqual(byId(people(f, e, undefined, 0.2))[1].gaps, []);
  assert.deepEqual(byId(people(f, removeManual(e, 1, 315), undefined, 0.2))[1].gaps, [[312, 318]]);
  // With the default, a hole that short is not worth a warning.
  assert.deepEqual(byId(people(f, removeManual(e, 1, 315)))[1].gaps, []);
});

test("discarded identities disappear from the list and can come back", () => {
  const f = file();
  const e = setRemoved(E(), 9, true);
  assert.deepEqual(people(f, e).map((p) => p.id), [1, 5]);
  assert.deepEqual(people(f, setRemoved(e, 9, false)).map((p) => p.id).sort((a, b) => a - b), [1, 5, 9]);
});

test("team by hand overrides the colour and can be cleared", () => {
  const f = file();
  const kits = { own: "#2a4fb0", opp: "#1a1a1a" };
  let e = setPerson(E(), 5, { team: "ref" });
  assert.equal(byId(people(f, e, kits))[5].team, "ref");
  assert.equal(byId(people(f, e, kits))[5].teamByHand, true);
  e = setPerson(e, 5, { team: null });
  assert.equal(byId(people(f, e, kits))[5].team, "opp");
});

test("a reviewed person stays marked until somebody else is joined into her", () => {
  const f = file();
  let e = setPerson(E(), 1, { done: true });
  assert.equal(byId(people(f, e))[1].done, true);
  assert.equal(byId(people(f, e))[5].done, false);
  // Joining another piece into her reopens the review.
  assert.equal(byId(people(f, merge(e, 1, 5)))[1].done, false);
  e = setPerson(e, 1, { done: false });
  assert.equal(byId(people(f, e))[1].done, false);
  assert.deepEqual(e.people["1"], {});
});

test("two boxes of one person in the same frame are reported, and the wrong track can be taken out", () => {
  const f = file();
  // Tracks 1 and 5 share frames 300..309. Nothing wrong while they are two people...
  const ps = byId(people(f, E()));
  assert.deepEqual(ps[1].conflicts, []);
  assert.deepEqual(overlap(ps[1], ps[5]), [300, 303, 306, 309, 321, 324, 327]);
  assert.deepEqual(overlap(ps[1], ps[9]), [300, 303]);

  // ...but joined, the person is in two places at once in those frames.
  const joined = merge(E(), 1, 5);
  const one = byId(people(f, joined))[1];
  assert.deepEqual(one.conflicts, [300, 303, 306, 309, 321, 324, 327]);

  // Taking track 5 out leaves her clean, and track 5 is a person again (with a new number).
  const { edits, identity } = separateTrack(joined, 5, f);
  const fixed = byId(people(f, edits));
  assert.deepEqual(fixed[1].conflicts, []);
  assert.deepEqual(fixed[1].tracks, [1, 2]);
  assert.deepEqual(fixed[identity].tracks, [5]);
  assert.equal(fixed[identity].frames.length, 10);
  // The new number is free: it collides with nobody, not even after more merges.
  assert.ok(!Object.keys(byId(people(f, E()))).map(Number).includes(identity));
});

test("a person can be split inside a hole: what comes after is somebody else", () => {
  const f = file();
  // Person 1 = track 1 (frames 300-309) + track 2 (321-327), joined by the program across a hole.
  // Standing in the hole (frame 315, where she has no box), the later piece is sent away.
  const r = splitPerson(E(), 1, 315, f);
  assert.ok(r);
  const ps = byId(people(f, r.edits));
  assert.deepEqual(ps[1].tracks, [1]);
  assert.deepEqual([ps[1].first, ps[1].last], [300, 309]);
  assert.deepEqual(ps[r.identity].tracks, [2]);
  assert.deepEqual([ps[r.identity].first, ps[r.identity].last], [321, 327]);
  assert.deepEqual(ps[1].gaps, []);

  // The piece can then be joined to whoever it really is.
  assert.deepEqual(byId(people(f, merge(r.edits, 9, r.identity)))[9].tracks, [2, 9]);
});

test("splitting a person in the middle of a track cuts that track and carries the later ones", () => {
  const f = file();
  const r = splitPerson(E(), 1, 306, f);
  const ps = byId(people(f, r.edits));
  assert.deepEqual([ps[1].first, ps[1].last], [300, 303]);
  // From 306 on: the rest of track 1 and all of track 2.
  assert.deepEqual(ps[r.identity].tracks, [1, 2]);
  assert.deepEqual([ps[r.identity].first, ps[r.identity].last], [306, 327]);
  // Hand marks after the cut go with the new person.
  const withMark = setManual(E(), 1, 315, 10, 10);
  const r2 = splitPerson(withMark, 1, 312, f);
  assert.deepEqual(r2.edits.manual, [{ identity: r2.identity, frame: 315, px: 10, py: 10 }]);
});

test("there is nothing to split before her first frame or after her last", () => {
  const f = file();
  assert.equal(splitPerson(E(), 1, 300, f), null); // nothing before
  assert.equal(splitPerson(E(), 1, 330, f), null); // nothing after
  assert.equal(splitPerson(E(), 5, 315, f) !== null, true);
});

test("fragments that are a second box on somebody are told apart from lone ones, and go in one step", () => {
  const f = file();
  const at = (frame, track, x, y) => f.frames.find((fr) => fr.frame === frame).boxes.push([track, 0, 0, 10, 30, 0.9, ...BLUE, x, y, true, "unk", track]);
  // Everybody in the fixture stands at (50, 30).
  at(300, 71, 50.4, 30.2); // one frame, glued to the others: a duplicate
  at(306, 72, 80, 10); // one frame, alone on the far side: not a duplicate
  at(309, 73, 50.3, 30); // next to somebody here...
  at(312, 73, 20, 60); // ...but alone here: not a duplicate either
  const short = new Set([71, 72, 73]);
  assert.deepEqual(duplicatesAmong(f, E(), short), [71]);
  // People who are not in the list are never returned, however close they stand to each other.
  assert.deepEqual(duplicatesAmong(f, E(), new Set()), []);

  const cleaned = setRemovedMany(setRemoved(E(), 9, true), [71, 72]);
  assert.deepEqual(cleaned.removed, [9, 71, 72]);
  assert.ok(!people(f, cleaned).some((p) => [71, 72].includes(p.id)));
});

test("two people who clash only where one player was detected twice can be unified", () => {
  const f = file();
  const put = (frame, track, x, y, conf = 0.9) => f.frames.find((fr) => fr.frame === frame).boxes.push([track, 0, 0, 10, 30, conf, ...BLUE, x, y, true, "unk", track]);
  // Track 1 is at (50, 30) in frames 300-309. A short piece of the same player overlaps its last two frames,
  // half a metre away (the detector gave two boxes), and goes on alone afterwards.
  put(306, 40, 50.5, 30.2, 0.5);
  put(309, 40, 50.4, 30.1, 0.95);
  put(312, 40, 51, 30);
  put(315, 40, 52, 30);
  assert.equal(samePlayer(f.frames[2].boxes.at(-1), f.frames[2].boxes.find((b) => b[0] === 1)), true);

  // Track 5 shares the fixture's position, so use a person that is elsewhere: move track 9 away.
  const c = clash(f, E(), 1, 40);
  assert.deepEqual(c.same, [306, 309]);
  assert.deepEqual(c.apart, []);
  // In each frame the less confident box goes: the piece's in 306, track 1's in 309.
  assert.deepEqual(c.drop, [{ track: 40, frame: 306 }, { track: 1, frame: 309 }]);

  // Unify: leave those boxes out, then join. She is one person, with one box per frame and no warning left.
  const joined = merge(dropBoxes(E(), c.drop), 1, 40);
  const one = byId(people(f, joined))[1];
  assert.deepEqual(one.conflicts, []);
  assert.deepEqual(one.tracks, [1, 2, 40]);
  assert.ok(one.frames.includes(312) && one.frames.includes(315));
  // Dropping the same boxes again changes nothing.
  assert.equal(dropBoxes(joined, c.drop), joined);
});

test("people who are apart in the frames they share are told as two", () => {
  const f = file();
  f.frames[0].boxes.push([60, 0, 0, 10, 30, 0.9, ...BLUE, 80, 10, true, "unk", 60]); // far side of the pitch
  f.frames[1].boxes.push([60, 0, 0, 10, 30, 0.9, ...BLUE, 50.3, 30, true, "unk", 60]); // here, on top of track 1
  const c = clash(f, E(), 1, 60);
  assert.deepEqual(c.apart, [300]);
  assert.deepEqual(c.same, [303]);
});

test("the two boxes of one person in a frame are a clash with herself", () => {
  const f = file();
  f.frames[0].boxes.push([70, 0, 0, 10, 30, 0.4, ...BLUE, 50.2, 30.1, true, "unk", 1]); // proposed as person 1 too
  const before = byId(people(f, E()))[1];
  assert.deepEqual(before.conflicts, [300]);
  const c = clash(f, E(), 1, 1);
  assert.deepEqual([c.same, c.apart, c.drop], [[300], [], [{ track: 70, frame: 300 }]]);
  assert.deepEqual(byId(people(f, dropBoxes(E(), c.drop)))[1].conflicts, []);
});

test("without positions, closeness is judged in the image", () => {
  const a = [1, 100, 200, 130, 280, 0.9, ...BLUE, null, null, false, "unk", 1];
  const twin = [2, 104, 205, 132, 283, 0.6, ...BLUE, null, null, false, "unk", 2];
  const other = [3, 400, 200, 430, 280, 0.9, ...BLUE, null, null, false, "unk", 3];
  assert.equal(samePlayer(a, twin), true);
  assert.equal(samePlayer(a, other), false);
});

test("short pieces are offered to the person they complete or repeat", () => {
  // One second at 30 fps, every 3 frames. A (track 1) walks along y = 30 and is lost in frames 12-18.
  // B (track 2) stands far away all along.
  const at = (track, x, y, conf = 0.9, lab = BLUE) => [track, 0, 0, 10, 30, conf, ...lab, x, y, true, "unk", track];
  const frames = [];
  for (let i = 0; i <= 10; i++) {
    const boxes = [at(2, 80, 10)];
    if (i < 4 || i > 6) boxes.push(at(1, 40 + i * 0.5, 30));
    frames.push({ frame: i * 3, H: null, boxes });
  }
  const f = { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 33, stride: 3, image_w: 1920, image_h: 1080, frames };
  const add = (frame, box) => f.frames.find((fr) => fr.frame === frame).boxes.push(box);
  add(12, at(30, 42.1, 30.2)); // in A's hole, where she would be
  add(15, at(30, 42.4, 30.1));
  add(3, at(31, 40.7, 30.3, 0.4)); // on top of A where she has a box: a repeat
  add(15, at(32, 60, 50)); // alone, nowhere near anyone
  add(18, at(33, 43.2, 30, 0.9, BLACK)); // in the hole too, but in the rival's shirt
  const kits = { own: "#2a4fb0", opp: "#1a1a1a" };
  const e = emptyEdits("k");
  const ppl = people(f, e, kits);
  const short = new Set([30, 31, 32, 33]);
  const got = suggestAbsorb(f, e, ppl, short);
  assert.deepEqual(got.map((a) => [a.from, a.into, a.adds]), [[31, 1, 0], [30, 1, 2]]);

  const done = applyAbsorb(f, e, got);
  assert.deepEqual([done.joined, done.frames], [2, 2]);
  const a = byId(people(f, done.edits, kits))[1];
  assert.equal(a.frames.length, 10);
  assert.deepEqual(a.conflicts, []);
  assert.deepEqual(done.edits.dropped, [{ track: 31, frame: 3 }]);
});

test("a piece that fits two people equally, or is too far in time, is left alone", () => {
  const at = (track, x, y) => [track, 0, 0, 10, 30, 0.9, ...BLUE, x, y, true, "unk", track];
  const frames = [];
  for (let i = 0; i <= 40; i++) frames.push({ frame: i * 3, H: null, boxes: i < 4 ? [at(1, 40, 30), at(2, 41.5, 30)] : [] });
  const f = { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 123, stride: 3, image_w: 1920, image_h: 1080, frames };
  f.frames[5].boxes.push(at(30, 40.7, 30)); // just after both are lost, between the two
  f.frames[40].boxes.push(at(31, 40, 30)); // 3.6 s after anyone was seen
  const e = emptyEdits("k");
  assert.deepEqual(suggestAbsorb(f, e, people(f, e), new Set([30, 31])), []);
});

test("two pieces cannot fill the same frame of one person in different places", () => {
  const at = (track, x, y) => [track, 0, 0, 10, 30, 0.9, ...BLUE, x, y, true, "unk", track];
  const frames = [];
  for (let i = 0; i <= 6; i++) frames.push({ frame: i * 3, H: null, boxes: i === 3 ? [at(30, 40.2, 30), at(31, 42.5, 30)] : [at(1, 40, 30)] });
  const f = { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 21, stride: 3, image_w: 1920, image_h: 1080, frames };
  const e = emptyEdits("k");
  const got = suggestAbsorb(f, e, people(f, e), new Set([30, 31]));
  assert.equal(got.length, 2);
  const done = applyAbsorb(f, e, got);
  assert.equal(done.joined, 1); // the closer one; the other stays a person of its own
  assert.deepEqual(byId(people(f, done.edits))[1].conflicts, []);
  assert.ok(people(f, done.edits).some((p) => p.id === 31));
});

test("nearest processed frame", () => {
  const f = file();
  assert.equal(nearestFrame(f, 300), 300);
  assert.equal(nearestFrame(f, 304), 303);
  assert.equal(nearestFrame(f, 305), 306);
  assert.equal(nearestFrame(f, 10), 300);
  assert.equal(nearestFrame(f, 999), 327);
});
