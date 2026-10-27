import assert from "node:assert/strict";
import { test } from "node:test";
import { ANCHOR_RESERVED_KEYS, PLAYER_KEYS, linksProtection, afterResolve, dropHalfFrames, editsFromLinks, pickInDoubt, stepDoubt, filterByDensity, pendingSuggestions, runAround, setAnchor, sortDoubts, timingSummary } from "./anchors.ts";
import { emptyEdits, identityOf, people, setPerson } from "./tracks.ts";

const fps = 30;
const box = (track, identity) => [track, 0, 0, 10, 20, 0.9, 120, 128, 128, 1, 1, true, "own", identity];
const file = {
  match_id: "m",
  video_id: "v1",
  fps,
  start_frame: 0,
  end_frame: 30,
  stride: 3,
  image_w: 100,
  image_h: 100,
  frames: [0, 3, 6, 9, 30].map((frame) => ({ frame, boxes: [box(1, 1), box(2, 1), box(3, 3)] })),
};

test("density keeps the best suggestion per chain and window", () => {
  const s = [
    { chain: 1, frame: 0, track: 1, score: 0.5, why: "larga" },
    { chain: 1, frame: 600, track: 1, score: 0.9, why: "larga" },
    { chain: 1, frame: 1500, track: 1, score: 0.7, why: "aislada" },
    { chain: 2, frame: 0, track: 2, score: 0.8, why: "larga" },
  ];
  assert.deepEqual(filterByDensity(s, 1, fps).map((x) => [x.chain, x.frame]), [[1, 600], [2, 0]]);
  assert.equal(filterByDensity(s, 3, fps).length, 4);
});

test("an anchor of a chain removes its nearby suggestions", () => {
  const chains = [{ id: 1, team: "own", t0: 0, t1: 60, n: 2, boxes: [[0, 1], [600, 1]] }];
  const s = [
    { chain: 1, frame: 0, track: 1, score: 1, why: "larga" },
    { chain: 1, frame: 3000, track: 1, score: 1, why: "larga" },
  ];
  const left = pendingSuggestions(s, [{ frame: 600, track: 1, player: "Ana" }], [], chains, 2, fps);
  assert.deepEqual(left.map((x) => x.frame), [3000]);
  assert.deepEqual(pendingSuggestions(s, [], ["1:3000"], chains, 2, fps).map((x) => x.frame), [0]);
});

test("setAnchor replaces the name of the same box", () => {
  const a = setAnchor(setAnchor([], { frame: 3, track: 1, player: "Ana" }), { frame: 3, track: 1, player: "Bea" });
  assert.deepEqual(a, [{ frame: 3, track: 1, player: "Bea" }]);
});

test("links become ordinary edits: same name, joined tracks, nothing removed", () => {
  const edits = emptyEdits("k");
  const links = {
    part: "v1_0_30",
    identities: [
      { player: "Ana", chains: [], tracks: [1, 3], t_ranges: [] },
      { player: "Bea", chains: [], tracks: [2], t_ranges: [] },
      { player: "Eva", chains: [], tracks: [3], t_ranges: [] },
    ],
    doubts: [],
    coverage: {},
  };
  const r = editsFromLinks(edits, file, links, new Map());
  assert.deepEqual(r.conflicts, [3]);
  const fr = file.frames[0];
  const ana = identityOf(fr.boxes[0], 0, r.edits);
  const bea = identityOf(fr.boxes[1], 0, r.edits);
  assert.notEqual(ana, bea);
  assert.equal(r.edits.people[String(ana)].player_id, "Ana");
  assert.equal(r.edits.people[String(bea)].player_id, "Bea");
  // Track 3 was claimed by two players: left as it was.
  assert.equal(identityOf(fr.boxes[2], 0, r.edits), 3);
  assert.equal(people(file, r.edits).length, 3);
  // An existing person with that name receives the tracks.
  const again = editsFromLinks(edits, file, { ...links, identities: [links.identities[0]] }, new Map([["Ana", 3]]));
  assert.equal(identityOf(fr.boxes[0], 0, again.edits), 3);
});

test("doubts: worst kinds first, resolved apart", () => {
  const d = [
    { kind: "hueco_largo", frame: 1, track: 1, players: [], note: "" },
    { kind: "salto", frame: 9, track: 1, players: [], note: "" },
    { kind: "dos_sitios", frame: 50, track: 2, players: [], note: "" },
    { kind: "salto", frame: 3, track: 1, players: [], note: "" },
  ];
  const r = sortDoubts(d, ["salto:9:1"]);
  assert.deepEqual(r.pending.map((x) => `${x.kind}${x.frame}`), ["dos_sitios50", "salto3", "hueco_largo1"]);
  assert.equal(r.done.length, 1);
});

test("runAround stops at holes and at the window", () => {
  assert.deepEqual(runAround(file, 1, 4, 3, 100), [0, 3, 6, 9]);
  assert.deepEqual(runAround(file, 1, 4, 3, 3), [3, 6]);
  assert.deepEqual(runAround(file, 9, 4, 3, 3), []);
});

test("stopwatch summary caps pauses", () => {
  const s = timingSummary([
    { kind: "ancla", s: 2, at: 0 },
    { kind: "ancla", s: 4, at: 0 },
    { kind: "duda", s: 500, at: 0 },
  ]);
  assert.equal(s.total_s, 66);
  assert.equal(s.per.ancla.median_s, 3);
  assert.ok(Number.isNaN(s.per.saltar.median_s));
});

test("density counts flag levels without more places", async () => {
  const { densityCounts } = await import("./anchors.ts");
  const s = [0, 600, 1200].map((frame) => ({ chain: 1, frame, track: 1, score: 1, why: "larga" }));
  const c = densityCounts(s, 30);
  assert.deepEqual(c.map((x) => x.n), [1, 2, 3, 3, 3]);
  assert.deepEqual(c.map((x) => x.short), [false, false, false, true, true]);
});

test("dudas: Tab avanza y retrocede dando la vuelta; al resolver se abre la que seguía", () => {
  const ds = [1, 2, 3].map((i) => ({ kind: "salto", frame: i * 10, track: i, players: [], note: "" }));
  const key = (d) => `${d.kind}:${d.frame}:${d.track}`;
  assert.equal(stepDoubt(ds, null, 1).track, 1);
  assert.equal(stepDoubt(ds, null, -1).track, 3);
  assert.equal(stepDoubt(ds, key(ds[2]), 1).track, 1);
  assert.equal(stepDoubt(ds, key(ds[0]), -1).track, 3);
  assert.equal(stepDoubt([ds[0]], key(ds[0]), 1), null);
  assert.equal(stepDoubt([], null, 1), null);
  assert.equal(afterResolve(ds, key(ds[1])).track, 3);
  assert.equal(afterResolve(ds, key(ds[2])).track, 1);
  assert.equal(afterResolve([ds[0]], key(ds[0])), null);
});

test("cortar una duda quita ±0.5 s", () => {
  assert.equal(dropHalfFrames(30), 15);
  assert.equal(dropHalfFrames(29.97), 15);
});

test("clic en una caja de la duda: esa es ella y las otras cajas suyas se separan", () => {
  const e = setPerson(setPerson(emptyEdits("k"), 1, { player_id: "Ana" }), 3, { player_id: "Bea" });
  const ids = (ed) => file.frames.find((x) => x.frame === 3).boxes.map((b) => identityOf(b, 3, ed));
  const playerOf = (ed) => (id) => ed.people[String(id)]?.player_id || undefined;
  const all = [{ track: 1, id: 1 }, { track: 2, id: 1 }, { track: 3, id: 3 }];
  // Ana sale en los trozos 1 y 2: clic en el 1.
  const r = pickInDoubt(e, file, 3, { track: 1, id: 1 }, all, playerOf(e), new Map([["Ana", 1], ["Bea", 3]]), ["Ana"]);
  assert.equal(r.player, "Ana");
  assert.equal(r.cut, 1);
  const [a, b, c] = ids(r.edits);
  assert.equal(a, 1);
  assert.notEqual(b, 1);
  assert.equal(c, 3); // Bea no se toca
  // Caja sin nombre: pasa a ser la jugadora de la duda y sus otras cajas se separan.
  const e2 = setPerson(emptyEdits("k"), 1, { player_id: "Ana" });
  const r2 = pickInDoubt(e2, file, 3, { track: 3, id: 3 }, all, playerOf(e2), new Map([["Ana", 1]]), ["Ana"]);
  assert.equal(r2.cut, 2);
  const [a2, b2, c2] = ids(r2.edits);
  assert.notEqual(a2, 1);
  assert.notEqual(b2, 1);
  assert.equal(c2, 1);
});

test("relleno: protege verificadas y con nombre; sin protección aplica todo", () => {
  const prot = linksProtection([
    { id: 1, player_id: "Ana", done: true, tracks: [1, 2] },
    { id: 3, player_id: "", done: false, tracks: [3] },
    { id: 4, player_id: "Bea", done: false, tracks: [4] },
  ]);
  assert.deepEqual(prot.list, [{ name: "Ana", done: true }, { name: "Bea", done: false }]);
  assert.deepEqual([...prot.tracks].sort(), [1, 2, 4]);
  const e = setPerson(emptyEdits("k"), 1, { player_id: "Ana" });
  // Python dice que el trozo 3 es Ana y el 2 es Carla.
  const links = { part: "p", identities: [{ player: "Ana", chains: [], tracks: [3], t_ranges: [] }, { player: "Carla", chains: [], tracks: [2], t_ranges: [] }], doubts: [], coverage: {} };
  const safe = editsFromLinks(e, file, links, new Map([["Ana", 1]]), prot);
  assert.equal(safe.skipped, 2); // Ana verificada no gana el 3; el 2 de Ana no pasa a Carla
  assert.equal(identityOf(file.frames[1].boxes[1], 3, safe.edits), 1);
  assert.equal(identityOf(file.frames[1].boxes[2], 3, safe.edits), 3);
  const all = editsFromLinks(e, file, links, new Map([["Ana", 1]]));
  assert.equal(all.skipped, 0);
  assert.equal(identityOf(file.frames[1].boxes[2], 3, all.edits), 1);
  assert.notEqual(identityOf(file.frames[1].boxes[1], 3, all.edits), 1);
});

test("teclas de jugadora: 1-0 y QWERTY sin las reservadas", () => {
  assert.deepEqual(PLAYER_KEYS.slice(0, 12), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "q", "w"]);
  for (const k of ANCHOR_RESERVED_KEYS) assert.ok(!PLAYER_KEYS.includes(k));
  assert.equal(new Set(PLAYER_KEYS).size, PLAYER_KEYS.length);
});

test("doubts: informative ones never pending, missing task counts as task", () => {
  const d = [
    { kind: "hueco_largo", frame: 1, track: 1, players: [], note: "", task: false },
    { kind: "sin_nombre", frame: 2, track: 1, players: [], note: "", task: false },
    { kind: "salto", frame: 3, track: 1, players: [], note: "", task: true },
    { kind: "dos_sitios", frame: 4, track: 2, players: [], note: "" },
  ];
  const r = sortDoubts(d);
  assert.deepEqual(r.pending.map((x) => x.kind), ["dos_sitios", "salto"]);
  assert.equal(r.info.length, 2);
  assert.equal(stepDoubt(r.pending, null, 1).kind, "dos_sitios");
  assert.equal(sortDoubts(d, ["salto:3:1", "dos_sitios:4:2"]).pending.length, 0);
});

test("drops of the links leave out the double boxes of a player, except for protected people", () => {
  // Ana has tracks 1 and 2, both in every frame: a double box in each of the 5 frames.
  const links = {
    part: "v1_0_30",
    identities: [{ player: "Ana", chains: [], tracks: [1, 2], t_ranges: [] }],
    doubts: [],
    coverage: {},
    drops: [0, 3, 6, 9, 30].map((frame) => ({ frame, track: 2, player: "Ana", reason: "ruta" })),
  };
  const ana = (e) => people(file, e).find((p) => e.people[String(p.id)]?.player_id === "Ana");
  const without = editsFromLinks(emptyEdits("k"), file, { ...links, drops: undefined }, new Map());
  assert.equal(ana(without.edits).conflicts.length, 5);
  assert.equal(without.dropped, 0);
  const r = editsFromLinks(emptyEdits("k"), file, links, new Map());
  assert.equal(r.dropped, 5);
  assert.equal(ana(r.edits).conflicts.length, 0);
  assert.deepEqual(ana(r.edits).frames, [0, 3, 6, 9, 30]);
  // Applying the same file again adds nothing.
  assert.equal(editsFromLinks(r.edits, file, links, new Map()).dropped, 0);
  // A protected (verified) Ana keeps her boxes.
  const e = setPerson(emptyEdits("k"), 1, { player_id: "Ana", done: true });
  const prot = linksProtection(people(file, e).map((p) => ({ id: p.id, player_id: e.people[String(p.id)]?.player_id ?? "", done: e.people[String(p.id)]?.done === true, tracks: p.tracks })));
  assert.equal(editsFromLinks(e, file, links, new Map([["Ana", 1]]), prot).dropped, 0);
});

// ---- fill by stretches (links with `segments`)
const longFile = {
  ...file,
  end_frame: 30,
  frames: [0, 3, 6, 9, 12, 15, 18, 21].map((frame) => ({ frame, boxes: [box(1, 1), box(2, 2)] })),
};
const segLinks = (identities, extra = {}) => ({ part: "v1_0_30", identities, doubts: [], coverage: {}, ...extra });
const idAt = (e, track, frame) => {
  const b = longFile.frames.find((f) => f.frame === frame).boxes.find((x) => x[0] === track);
  return identityOf(b, frame, e);
};
const nameAt = (e, track, frame) => e.people[String(idAt(e, track, frame))]?.player_id;

test("a track claimed by two players is cut in two stretches, not skipped", () => {
  const links = segLinks([
    { player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 0, 9]] },
    { player: "Bea", chains: [], tracks: [1], t_ranges: [], segments: [[1, 12, 21]] },
  ]);
  const r = editsFromLinks(emptyEdits("k"), longFile, links, new Map());
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.stretches, 2);
  assert.equal(r.cutTracks, 1);
  assert.equal(nameAt(r.edits, 1, 0), "Ana");
  assert.equal(nameAt(r.edits, 1, 9), "Ana");
  assert.equal(nameAt(r.edits, 1, 12), "Bea");
  assert.equal(nameAt(r.edits, 1, 21), "Bea");
  assert.equal(r.stretchSeconds.Ana, (4 * 3) / fps);
  // The other track is untouched.
  assert.equal(idAt(r.edits, 2, 0), 2);
});

test("adjacent stretches: the new one rules from its first frame; a gap goes back to the track's own identity", () => {
  const links = segLinks([
    { player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 0, 6], [1, 15, 18]] },
    { player: "Bea", chains: [], tracks: [1], t_ranges: [], segments: [[1, 9, 12]] },
  ]);
  const r = editsFromLinks(emptyEdits("k"), longFile, links, new Map());
  assert.deepEqual([0, 3, 6, 9, 12, 15, 18, 21].map((f) => nameAt(r.edits, 1, f) ?? "-"), ["Ana", "Ana", "Ana", "Bea", "Bea", "Ana", "Ana", "-"]);
  assert.equal(idAt(r.edits, 1, 21), 1);
});

test("overlapping stretches of different players are left as they were", () => {
  const links = segLinks([
    { player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 0, 12]] },
    { player: "Bea", chains: [], tracks: [1], t_ranges: [], segments: [[1, 9, 21]] },
  ]);
  const r = editsFromLinks(emptyEdits("k"), longFile, links, new Map());
  assert.deepEqual(r.conflicts, [1]);
  assert.equal(r.stretches, 0);
  assert.equal(idAt(r.edits, 1, 0), 1);
});

test("without segments nothing changes (same result as by track)", () => {
  const links = segLinks([{ player: "Ana", chains: [], tracks: [1], t_ranges: [] }]);
  const r = editsFromLinks(emptyEdits("k"), longFile, links, new Map());
  assert.equal(r.stretches, 0);
  assert.deepEqual(r.edits.splits, []);
  assert.equal(r.edits.linkSplits, undefined);
  assert.equal(nameAt(r.edits, 1, 21), "Ana");
});

test("the fill is one new edits object: the one before stays as it was (one undo)", () => {
  const before = emptyEdits("k");
  const snapshot = JSON.stringify(before);
  const r = editsFromLinks(before, longFile, segLinks([{ player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 3, 9]] }]), new Map());
  assert.equal(JSON.stringify(before), snapshot);
  assert.notEqual(r.edits, before);
  assert.equal(r.edits.linkSplits.length, 2);
});

test("identity after edits: hand splits inside a stretch are replaced, outside kept; protection skips the stretch", () => {
  let e = emptyEdits("k");
  e = { ...e, splits: [{ track: 1, frame: 6, identity: 50 }, { track: 1, frame: 18, identity: 60 }] };
  const links = segLinks([{ player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 3, 12]] }]);
  const r = editsFromLinks(e, longFile, links, new Map());
  assert.equal(nameAt(r.edits, 1, 9), "Ana");
  // Back after the stretch to what the hand split said there (it was 50 from frame 6 on).
  assert.equal(idAt(r.edits, 1, 15), 50);
  assert.equal(idAt(r.edits, 1, 18), 60);
  const p = editsFromLinks(e, longFile, links, new Map(), { ids: new Set(), tracks: new Set([1]) });
  assert.equal(p.stretches, 0);
  assert.equal(p.skipped, 1);
  assert.deepEqual(p.edits.splits, e.splits);
});

test("stale «dos_sitios» doubts: only when the named player has one box left", async () => {
  const { staleTwoPlaces } = await import("./doubts.ts");
  const links = segLinks([
    { player: "Ana", chains: [], tracks: [1], t_ranges: [], segments: [[1, 0, 9]] },
    { player: "Ana", chains: [], tracks: [2], t_ranges: [], segments: [[2, 12, 21]] },
  ]);
  const doubts = [
    { kind: "dos_sitios", frame: 6, track: 1, players: ["Ana"], note: "" },
    { kind: "dos_sitios", frame: 6, track: 2, players: ["Zoe"], note: "" },
  ];
  // Before the fill nobody has the name: kept.
  assert.deepEqual(staleTwoPlaces(doubts, longFile, emptyEdits("k")), []);
  const r = editsFromLinks(emptyEdits("k"), longFile, links, new Map());
  // Ana has track 1 at frame 6 and track 2 only from 12: one box, so no longer in two places.
  assert.deepEqual(staleTwoPlaces(doubts, longFile, r.edits), ["dos_sitios:6:1"]);
  // If track 2 also covered frame 6 she would still be in two places.
  const both = editsFromLinks(emptyEdits("k"), longFile, segLinks([
    { player: "Ana", chains: [], tracks: [1, 2], t_ranges: [], segments: [[1, 0, 9], [2, 0, 9]] },
  ]), new Map());
  assert.deepEqual(staleTwoPlaces(doubts, longFile, both.edits), []);
});

// ---------------------------------------------------------------- A-2 and A-3 (2026-10-25)

const mk = (tracks, frames, pos = () => [10, 10]) => ({
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, image_w: 1920, image_h: 1080, venue: { length_m: 105, width_m: 68 },
  frames: frames.map((frame) => ({
    frame, H: null,
    boxes: tracks.filter((t) => pos(t, frame)).map((t) => [t, 0, 0, 10, 30, 0.9, 120, 128, 128, pos(t, frame)[0], pos(t, frame)[1], true, "own"]),
  })),
});
const seq = (a, b) => Array.from({ length: Math.floor((b - a) / 3) + 1 }, (_, i) => a + i * 3);

test("tramos: ordered by p, hidden once answered; without the field nothing changes", async () => {
  const { pendingTramos, tramoKey } = await import("./anchors.ts");
  assert.deepEqual(pendingTramos(null), []);
  assert.deepEqual(pendingTramos({}), []);
  const s = [
    { kind: "union_dudosa", person: "Ana", track: 5, frame_ini: 30, frame_fin: 60, p: 0.85, cost: 0.5 },
    { kind: "union_dudosa", person: "Bea", track: 6, frame_ini: 10, frame_fin: 20, p: 0.95, cost: 0.9 },
    { kind: "otra", person: "Eva", track: 7, frame_ini: 1, frame_fin: 2, p: 1, cost: 0 },
  ];
  assert.deepEqual(pendingTramos({ suggestions: s }).map((x) => x.track), [6, 5]);
  assert.deepEqual(pendingTramos({ suggestions: s }, [tramoKey(s[1])]).map((x) => x.track), [5]);
});

test("tramos: accepting gives the stretch to her in one edit; it keeps the rest of the track; overlap is refused", async () => {
  const { acceptTramo } = await import("./anchors.ts");
  // Track 1 is Ana (0..30); track 2 runs 33..90 and is free. Track 3 (also Ana) overlaps 60..90.
  const f = mk([1, 2, 3], seq(0, 90), (t, fr) => (t === 1 ? (fr <= 30 ? [10, 10] : null) : t === 2 ? (fr >= 33 ? [11, 10] : null) : fr >= 60 ? [30, 30] : null));
  let e = emptyEdits("k");
  e = { ...e, identity: { 1: 1, 3: 1 }, people: { 1: { player_id: "Ana" } } };
  const s = { kind: "union_dudosa", person: "Ana", track: 2, frame_ini: 33, frame_fin: 57, p: 0.9, cost: 0.4 };
  const r = acceptTramo(e, f, s, new Map([["Ana", 1]]));
  assert.equal(r.status, "ok");
  const idAt = (ed, frame) => identityOf(f.frames.find((x) => x.frame === frame).boxes.find((b) => b[0] === 2), frame, ed);
  assert.equal(idAt(r.edits, 33), 1);
  assert.equal(idAt(r.edits, 57), 1);
  // After the stretch the track is what it was (its own identity, 2).
  assert.equal(idAt(r.edits, 60), 2);
  // Whole stretch over Ana's other box: refused, nothing changes.
  const o = acceptTramo(e, f, { ...s, frame_fin: 90 }, new Map([["Ana", 1]]));
  assert.equal(o.status, "overlap");
  assert.equal(o.edits, e);
  // Already hers: nothing to do.
  assert.equal(acceptTramo(r.edits, f, s, new Map([["Ana", 1]])).status, "same");
  // A name the table lacks: a new person with that name.
  const n = acceptTramo(emptyEdits("k"), f, s, new Map());
  assert.equal(n.status, "ok");
  assert.equal(Object.values(n.edits.people).filter((p) => p.player_id === "Ana").length, 1);
});

test("cadena impura: se avisa si se solapa con otra ya anclada a la misma jugadora; partir y descartar", async () => {
  const { chainLookup, chainIndex, chainOverlaps, overlapStretches, resolveOverlap } = await import("./anchors.ts");
  const chains = [
    { id: "A", team: "own", t0: 0, t1: 3, n: 31, boxes: seq(0, 90).map((fr) => [fr, 1]) },
    { id: "B", team: "own", t0: 1.5, t1: 5, n: 20, boxes: seq(45, 150).map((fr) => [fr, 2]) },
    { id: "C", team: "own", t0: 6, t1: 7, n: 5, boxes: seq(180, 210).map((fr) => [fr, 3]) },
  ];
  const lookup = chainLookup(chains);
  const index = chainIndex(chains);
  const anchors = [{ frame: 30, track: 1, player: "Ana" }, { frame: 190, track: 3, player: "Bea" }];
  const cand = { frame: 120, track: 2, player: "Ana" };
  const ov = chainOverlaps(lookup, index, anchors, cand);
  assert.deepEqual(ov.map((o) => [o.chain, o.other, o.from, o.to]), [["B", "A", 45, 90]]);
  // Another player, the same chain, or a chain that does not overlap: no warning.
  assert.deepEqual(chainOverlaps(lookup, index, anchors, { ...cand, player: "Bea" }), []);
  assert.deepEqual(chainOverlaps(lookup, index, anchors, { frame: 30, track: 1, player: "Ana" }), []);
  assert.deepEqual(chainOverlaps(lookup, index, [{ frame: 190, track: 3, player: "Ana" }], cand), []);
  assert.deepEqual(chainOverlaps(lookup, index, anchors, { frame: 120, track: 2, player: "__no__" }), []);
  assert.deepEqual(overlapStretches(chains[1], 45, 90), [{ track: 2, a: 45, b: 90 }]);
  // Resolving: the overlap of chain B leaves its person (partir) or is left out (descartar).
  const f = mk([1, 2], seq(0, 150));
  const part = resolveOverlap(emptyEdits("k"), f, chains[1], 45, 90, "partir");
  const idOf = (ed, frame) => identityOf(f.frames.find((x) => x.frame === frame).boxes.find((b) => b[0] === 2), frame, ed);
  assert.equal(part.boxes, 1);
  assert.notEqual(idOf(part.edits, 60), 2);
  assert.equal(idOf(part.edits, 120), 2);
  const drop = resolveOverlap(emptyEdits("k"), f, chains[1], 45, 90, "descartar");
  assert.equal(drop.boxes, 16);
  assert.equal(drop.edits.dropped.length, 16);
});
