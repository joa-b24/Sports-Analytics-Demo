import assert from "node:assert/strict";
import { test } from "node:test";
import { NOBODY, applyQuick, quickModel, sampleFrames } from "./quick.ts";
import { editsKey, emptyEdits, identityOf, people } from "./tracks.ts";

const LAB = [100, 128, 160];
// Two players walk towards each other and cross at frame 30 (x in pixels, 1 px = 1 cm); the tracker swaps them there:
// track 1 is A before and B after, track 2 the other way round. 30 fps, 1 of every 3 frames, 3 s.
const box = (track, x) => [track, x - 20, 400, x + 20, 500, 0.9, ...LAB, null, null, true, "own", track];
const xA = (f) => 100 + f * 10;
const xB = (f) => 700 - f * 10;
const file = {
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 90, stride: 3, image_w: 1920, image_h: 1080,
  frames: Array.from({ length: 30 }, (_, i) => {
    const f = i * 3;
    return { frame: f, H: null, boxes: f < 30 ? [box(1, xA(f)), box(2, xB(f))] : [box(1, xB(f)), box(2, xA(f))] };
  }),
};
const base = emptyEdits(editsKey(file));

test("samples every few seconds, on processed frames", () => {
  assert.deepEqual(sampleFrames(file, 1), [0, 30, 60]);
});

test("two names on one track: cut at the crossing, and each name follows its player", () => {
  const labels = [
    { frame: 0, track: 1, name: "A" }, { frame: 0, track: 2, name: "B" },
    { frame: 60, track: 1, name: "B" }, { frame: 60, track: 2, name: "A" },
  ];
  const m = quickModel(file, base, labels, [0, 60]);
  for (const f of [0, 15, 27]) assert.equal(m.nameOf.get(`${f}:1`), "A");
  for (const f of [33, 60, 87]) assert.equal(m.nameOf.get(`${f}:2`), "A");
  for (const f of [33, 60, 87]) assert.equal(m.nameOf.get(`${f}:1`), "B");
  const cut = m.cuts.get(1)[0];
  assert.ok(cut >= 27 && cut <= 33, `cut at ${cut}`);

  // As edits of the table: two people, each one player all along.
  const edits = applyQuick(file, base, m);
  const named = people(file, edits).filter((p) => p.player_id);
  assert.deepEqual(named.map((p) => p.player_id).sort(), ["A", "B"]);
  const a = named.find((p) => p.player_id === "A").id;
  assert.equal(identityOf(file.frames[2].boxes[0], 6, edits), a);
  assert.equal(identityOf(file.frames[25].boxes[1], 75, edits), a);
});

test("a name not confirmed at a reviewed sample stops before it; nobody stops a name", () => {
  // Only track 1 named at 0; at the sample of frame 60 nobody confirmed it: it keeps the name up to the crossing.
  const m = quickModel(file, base, [{ frame: 0, track: 1, name: "A" }], [0, 60]);
  assert.equal(m.nameOf.get("15:1"), "A");
  assert.equal(m.nameOf.get("60:1"), undefined);
  // Not yet reviewed: the model proposes the name all along.
  assert.equal(quickModel(file, base, [{ frame: 0, track: 1, name: "A" }], [0]).nameOf.get("60:1"), "A");
  const none = quickModel(file, base, [{ frame: 0, track: 1, name: NOBODY }], [0]);
  assert.equal(none.nameOf.get("0:1"), undefined);
});

test("one player at a time: stops after crossing a teammate, not after a quick crossing with a rival", async () => {
  const { nextCheckpoint } = await import("./quick.ts");
  // No swap here: track 1 is A all along, track 2 is B; they cross around frame 30 (feet closer than a box height
  // for about a third of a second).
  const straight = { ...file, frames: file.frames.map((fr) => ({ ...fr, boxes: [box(1, xA(fr.frame)), box(2, xB(fr.frame))] })) };
  const m = quickModel(straight, base, [{ frame: 0, track: 1, name: "A", team: "own" }], []);
  const mate = nextCheckpoint(straight, base, m, "A", () => "own", "own", 0);
  assert.equal(mate.kind, "crossing");
  assert.equal(mate.track, 1);
  assert.ok(mate.frame > 30 && mate.frame < 60, `stop at ${mate.frame}`);
  const rival = nextCheckpoint(straight, base, m, "A", (b) => (b[0] === 2 ? "opp" : "own"), "own", 0);
  assert.equal(rival, null);
});

test("a part is complete with 10 players checked in the table and the ball gone through; the quick review alone is not", async () => {
  const { partStatus } = await import("./quick.ts");
  const checked = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { player_id: `P${i}`, done: true }]));
  const ball = { every: 1, seen: Array.from({ length: 11 }, (_, i) => i * 30) };
  const part = { start_frame: 0, end_frame: 300, fps: 30 };
  const ten = Array.from({ length: 10 }, (_, i) => `P${i}`);
  assert.equal(partStatus({ people: checked(10), ballReview: ball }, part).complete, true);
  assert.equal(partStatus({ people: checked(9), ballReview: ball }, part).complete, false);
  assert.equal(partStatus({ people: checked(10), ballReview: { every: 1, seen: [0, 30, 60] } }, part).complete, false);
  const onlyQuick = partStatus({ quick: { labels: [], seen: [], done: ten }, ballReview: ball }, part);
  assert.deepEqual([onlyQuick.quick, onlyQuick.players, onlyQuick.complete], [10, 0, false]);
  assert.equal(partStatus({}, part).players, 0);
});

test("leftovers of a complete part: unnamed of ours, short rivals, referees and no team; never the named", async () => {
  const { leftovers } = await import("./quick.ts");
  const P = (id, team, n, player_id = "") => ({ id, team, player_id, frames: Array.from({ length: n }, (_, i) => i * 3) });
  // 30 fps, 1 of 3 frames: 10 frames = 1 s.
  const ppl = [P(1, "own", 50, "Ana"), P(2, "own", 50), P(3, "opp", 5), P(4, "opp", 50), P(5, "ref", 50), P(6, "unk", 50), P(7, "unk", 50, "Bea")];
  assert.deepEqual(leftovers(ppl, 30, 3), [2, 3, 5, 6]);
});

test("only named people count as checked", async () => {
  const { partStatus } = await import("./quick.ts");
  const people = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), { player_id: `P${i}`, done: true }]));
  people["99"] = { done: true }; // without a name: does not count
  assert.equal(partStatus({ people }, { start_frame: 0, end_frame: 300, fps: 30 }).players, 11);
});

test("adding the review to the table: checked players are left as they are, the rest gets its names", async () => {
  const { applyQuickOnto, quickModel } = await import("./quick.ts");
  const { setPerson, people } = await import("./tracks.ts");
  // The straight file: track 1 is A, track 2 is B all along.
  const straight = { ...file, frames: file.frames.map((fr) => ({ ...fr, boxes: [box(1, xA(fr.frame)), box(2, xB(fr.frame))] })) };
  const labels = [
    { frame: 0, track: 1, name: "A", team: "own" },
    { frame: 0, track: 2, name: "B", team: "own" },
  ];
  const m = quickModel(straight, base, labels, []);
  // In the table, A was already checked by hand (identity 1, with her name), with a correction the review knows
  // nothing of: her last frames were cut off.
  let table = setPerson(base, 1, { player_id: "A", done: true });
  table = { ...table, splits: [{ track: 1, frame: 81, identity: 50 }] };
  const r = applyQuickOnto(straight, table, base, m, new Set([1]));
  const named = people(straight, r.edits).filter((p) => p.player_id);
  assert.deepEqual(named.map((p) => p.player_id).sort(), ["A", "B"]);
  const a = named.find((p) => p.player_id === "A");
  assert.equal(a.done, true);
  assert.equal(a.last, 78); // her correction stays
  assert.equal(named.find((p) => p.player_id === "B").frames.length, 30);
});

