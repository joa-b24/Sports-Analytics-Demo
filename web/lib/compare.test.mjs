import assert from "node:assert/strict";
import { test } from "node:test";
import { autoResolve, comparisonMarkdown, countEdits, jumpExcursionDrops, startReview, switchVersion, versionEdits, versionMetrics } from "./compare.ts";
import { dropBoxes, emptyEdits, merge, setPerson, setRemoved, split } from "./tracks.ts";

const box = (track, x, y) => [track, 0, 0, 10, 30, 0.9, 50, 0, 0, x, y, true, "unk"];
// 30 processed frames at 30 fps, stride 3. Track 1 walks along y = 30; between frames 30 and 36 (0.2 s) its box is
// 20 m away (somebody else) and comes back. Track 2 stands still.
function file() {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    const f = i * 3;
    const x = 10 + i * 0.1;
    const out = f >= 30 && f < 36;
    frames.push({ frame: f, H: null, boxes: [box(1, out ? x + 20 : x, 30), box(2, 60, 40)] });
  }
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 87, stride: 3, image_w: 1920, image_h: 1080, frames, venue: { length_m: 105, width_m: 68 } };
}
const KEY = "m|v1|0_87";
const named = () => setPerson(setPerson(emptyEdits(KEY), 1, { player_id: "Ana" }), 2, { player_id: "Bea" });

test("a review keeps each version's edits apart and restores them exactly", () => {
  const base = named();
  let r = startReview(KEY, base);
  assert.equal(r.active, "A");
  const a1 = setPerson(base, 2, { player_id: "Carla" });
  // To B: A is saved, B starts from the base (not from A's edits).
  let s = switchVersion(r, a1, "B");
  r = s.review;
  assert.equal(r.active, "B");
  assert.equal(s.edits.people["2"].player_id, "Bea");
  assert.equal(r.A.edits.people["2"].player_id, "Carla");
  const b1 = setRemoved(s.edits, 2, true);
  // Back to A: exactly A's edits; B saved.
  s = switchVersion(r, b1, "A");
  r = s.review;
  assert.deepEqual(s.edits, a1);
  assert.deepEqual(r.B.edits.removed, [2]);
  assert.deepEqual(versionEdits(r, "B", s.edits).removed, [2]);
  assert.deepEqual(versionEdits(r, "A", s.edits), s.edits);
  // The saved copy is not the live object: changing the live one does not touch it.
  s.edits.people["2"].player_id = "X";
  assert.equal(r.A.edits?.people["2"]?.player_id ?? "Carla", "Carla");
  // Switching to the version already open changes nothing.
  assert.equal(switchVersion(r, a1, "A").review, r);
});

test("countEdits counts merges, splits, drops, removals and renames, and who they touch", () => {
  const f = file();
  const from = named();
  let to = merge(from, 1, 2);
  to = split(to, 1, 45, f).edits;
  to = dropBoxes(to, [
    { track: 1, frame: 30 },
    { track: 1, frame: 33 },
    { track: 2, frame: 60 },
  ]);
  to = setRemoved(to, 7, true);
  to = setPerson(to, 1, { player_id: "Ana María" });
  const c = countEdits(from, to);
  assert.equal(c.merge, 1);
  assert.equal(c.split, 1);
  assert.equal(c.drop, 2, "two tracks: one action each");
  assert.equal(c.remove, 1);
  assert.ok(c.rename >= 1);
  assert.equal(c.total, c.merge + c.split + c.drop + c.remove + c.rename);
  assert.ok(c.byPlayer.Ana >= 2);
  assert.ok(c.byPlayer.Bea >= 1);
  assert.deepEqual(countEdits(to, to).total, 0);
});

test("A: only out-and-back jumps of at most 0.8 s are dropped automatically", () => {
  const f = file();
  const e = named();
  const drops = jumpExcursionDrops(f, e);
  assert.deepEqual(
    drops.map((d) => d.frame),
    [30, 33],
  );
  assert.ok(drops.every((d) => d.track === 1 && d.player === "Ana" && d.reason === "salto"));
  assert.equal(jumpExcursionDrops(f, e, 0.1).length, 0);
  const links = { part: "v1_0_87", identities: [], doubts: [{ kind: "salto", frame: 30, track: 1, players: ["Ana"], note: "" }] };
  const r = autoResolve(e, f, links, "A");
  assert.equal(r.edits.dropped.length, 2);
  assert.deepEqual(r.doubts, ["salto:30:1"]);
  assert.deepEqual(r.byReason.salto, { boxes: 2, doubts: 1 });
  assert.ok(r.edits.anchorDoubts.includes("salto:30:1"));
});

test("B: the drops of its links, by reason; metrics separate auto from by-hand work", () => {
  const f = file();
  const e = named();
  const links = {
    part: "v1_0_87",
    identities: [],
    doubts: [
      { kind: "dos_sitios", frame: 60, track: 2, players: ["Bea"], note: "" },
      { kind: "union_dudosa", frame: 9, track: 1, players: ["Ana"], note: "" },
      { kind: "hueco_largo", frame: 9, track: 1, players: ["Ana"], note: "", task: false },
    ],
    drops: [
      { frame: 60, track: 2, player: "Bea", reason: "ruta" },
      { frame: 63, track: 2, player: "Bea", reason: "exclusion" },
      { frame: 999, track: 2, player: "Bea", reason: "ambas" },
    ],
  };
  const r = autoResolve(e, f, links, "B");
  assert.equal(r.edits.dropped.length, 2, "a box not in the file is skipped");
  assert.deepEqual(r.byReason, { ruta: { boxes: 1, doubts: 1 }, exclusion: { boxes: 1, doubts: 0 } });
  const v = { auto: { doubts: r.doubts, byReason: r.byReason }, checkpoint: r.edits, loaded: "links_x_exp.json" };
  let after = { ...r.edits, anchorDoubts: [...r.edits.anchorDoubts, "union_dudosa:9:1"] };
  after = setPerson(after, 2, { player_id: "Bea R" });
  const m = versionMetrics(f, after, links, v, "B", [{ s: 5 }, { s: 120 }]);
  assert.equal(m.pending_total, 0);
  assert.equal(m.resolved_by_hand, 1);
  assert.equal(m.auto_doubts, 1);
  assert.deepEqual(m.auto_boxes, { ruta: 1, exclusion: 1 });
  assert.equal(m.manual.rename, 1);
  assert.equal(m.seconds, 65, "a pause over 60 s counts as 60");
  const md = comparisonMarkdown("m", "v1_0_87", [m]);
  assert.match(md, /Tareas pendientes \| 0/);
});

test("an automatic resolution undone stops counting", () => {
  const f = file();
  const e = named();
  const links = { part: "p", identities: [], doubts: [{ kind: "salto", frame: 30, track: 1, players: ["Ana"], note: "" }] };
  const r = autoResolve(e, f, links, "A");
  const v = { auto: { doubts: r.doubts, byReason: r.byReason }, checkpoint: r.edits };
  assert.equal(versionMetrics(f, r.edits, links, v, "A", []).auto_doubts, 1);
  const undone = versionMetrics(f, e, links, v, "A", []);
  assert.equal(undone.auto_doubts, 0);
  assert.deepEqual(undone.auto_boxes, {});
  assert.equal(undone.manual, null);
});

test("resetPart restores the snapshot and forgets the part's stopwatch and comparison only", async () => {
  const { resetPart } = await import("./compare.ts");
  const base = named();
  const r = startReview(KEY, base);
  const live = { ...setRemoved(base, 2, true), anchorDoubts: ["salto:1:1"] };
  const other = emptyEdits("m|v1|100_200");
  const st = { trackEdits: [live, other], reviews: [r, { ...r, key: "m|v1|100_200" }] };
  const out = resetPart(st, KEY, "v1_0_87", "f", [{ part: "v1_0_87" }, { part: "v1_100_200" }]);
  assert.deepEqual(out.state.trackEdits.find((e) => e.key === KEY), base);
  assert.equal(out.state.trackEdits.find((e) => e.key === other.key), other);
  assert.deepEqual(out.state.reviews.map((x) => x.key), ["m|v1|100_200"]);
  assert.deepEqual(out.timing, [{ part: "v1_100_200" }]);
  assert.deepEqual(out.summary, { review: true, doubts: 1, timing: 1 });
  assert.ok(out.prefKeys.includes("anchors:skipped:f:v1_0_87"));
  // Without a comparison: edits kept, only the resolved doubts go.
  const out2 = resetPart({ trackEdits: [live] }, KEY, "v1_0_87", "f", []);
  assert.equal(out2.state.trackEdits[0].anchorDoubts, undefined);
  assert.deepEqual(out2.state.trackEdits[0].removed, [2]);
});
