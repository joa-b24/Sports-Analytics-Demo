import assert from "node:assert/strict";
import { test } from "node:test";
import { blockShape } from "./blockShape.ts";
import { buildFixed } from "./fixedExport.ts";
import { physical, teamBlock } from "./physical.ts";
import { trackedPasses } from "./passSources.ts";
import { editsKey, emptyEdits, setPerson } from "./tracks.ts";
import { extrapolateEnds, isExtrapolated, isMeasuredSource } from "./smooth.ts";
import { behindBallAtLosses, heatmap, namedPlayers, passesAndTurnovers, positionsAt, touches } from "./positions.ts";
import { possessionIntervals } from "./possession.ts";

// Positions held still before the first and after the last appearance ("extrapolated") are invented: they are drawn,
// and no measure reads them.

const fixed = ({ n = 30, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  venue: { length_m: 105, width_m: 68 }, people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });
const parts = (f) => [{ file: f, ownRight: true }];

test("extrapolateEnds holds the first and last position on the frames outside what was seen", () => {
  const pts = [4, 5, 6].map((i) => ({ frame: i * 3, x: 10 + i, y: 30, source: "auto" }));
  const frames = Array.from({ length: 10 }, (_, i) => i * 3);
  const { points, added } = extrapolateEnds(pts, frames);
  assert.equal(added, 7);
  assert.equal(points.length, 10);
  assert.deepEqual(points.filter((p) => p.source === "extrapolated").map((p) => p.frame), [0, 3, 6, 9, 21, 24, 27]);
  assert.ok(points.slice(0, 4).every((p) => p.x === 14 && p.y === 30));
  assert.ok(points.slice(7).every((p) => p.x === 16));
  assert.deepEqual(points.filter((p) => p.source !== "extrapolated"), pts);
  // Nobody seen at all: nobody is invented.
  assert.equal(extrapolateEnds([], frames).added, 0);
  assert.ok(isExtrapolated("extrapolated") && !isExtrapolated("interpolated"));
  assert.ok(isMeasuredSource("auto") && isMeasuredSource("manual") && !isMeasuredSource("interpolated") && !isMeasuredSource("extrapolated"));
});

// A tracks file of the processing: one box for track 1 only in processed frames 10..19.
const LAB = [100, 128, 128];
const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1];
const rawPart = {
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 90, stride: 3, image_w: 1050, image_h: 680,
  frames: Array.from({ length: 30 }, (_, i) => ({ frame: i * 3, H, boxes: i >= 10 && i < 20 ? [[1, 0, 0, 10, 30, 0.9, ...LAB, 40 + i, 30, true, "unk", 1]] : [] })),
};
test("the export marks the held positions as extrapolated, only when the path is cleaned, and says how many", () => {
  const edits = setPerson(emptyEdits(editsKey(rawPart)), 1, { player_id: "Ana" });
  const smooth = { maxSpeedMs: 9, maxFillS: 2, windowS: 0 };
  const { out, note } = buildFixed(rawPart, edits, { smooth });
  const src = out.frames.map((f) => f.positions.map((p) => p.source)[0]);
  assert.deepEqual(src.slice(0, 10), Array(10).fill("extrapolated"));
  assert.ok(src.slice(10, 20).every((s) => s !== "extrapolated" && s !== undefined));
  assert.deepEqual(src.slice(20), Array(10).fill("extrapolated"));
  assert.equal(out.smoothing.extrapolated, 20);
  assert.match(note, /extrapoladas/);
  // As measured: nothing is held.
  assert.ok(buildFixed(rawPart, edits, { smooth: null }).out.frames.slice(0, 10).every((f) => f.positions.length === 0));
  // Switched off.
  assert.ok(buildFixed(rawPart, edits, { smooth, extrapolate: false }).out.frames.slice(0, 10).every((f) => f.positions.length === 0));
});

test("a loose fragment with no name is not held still across the part (it made the file too big to save)", () => {
  const { out } = buildFixed(rawPart, emptyEdits(editsKey(rawPart)), { smooth: { maxSpeedMs: 9, maxFillS: 2, windowS: 0 } });
  const all = out.frames.flatMap((f) => f.positions);
  assert.ok(all.length > 0 && all.every((p) => p.source !== "extrapolated"));
  assert.equal(out.smoothing.extrapolated, 0);
});

test("distance, speed, sprints and block: extrapolated positions count for nothing", () => {
  const at = (i) => {
    if (i < 10) return [q(1, 10, 30, "extrapolated")];
    if (i < 20) return [q(1, 10 + 0.7 * (i - 10), 30)];
    return [q(1, 16.3, 30, "extrapolated")];
  };
  const f = fixed({ people: [P(1, "own", "Ana")], at });
  const [r] = physical(parts(f), "own");
  // Only the 10 measured samples (9 steps of 0.7 m); no distance from the held ones.
  assert.ok(Math.abs(r.distance_m - 6.3) <= 0.5);
  assert.ok(r.seconds <= 1.1);
  // Treated as measured, the same part would show more time seen and more rows of distance/speed.
  const asAuto = fixed({ people: [P(1, "own", "Ana")], at: (i) => at(i).map((p) => ({ ...p, source: "auto" })) });
  const [r2] = physical(parts(asAuto), "own");
  assert.ok(r2.seconds > r.seconds + 1);
  // Block: ten players held still the whole part do not make a block.
  const spots = Array.from({ length: 11 }, (_, k) => [3 + k * 8, 20 + (k % 3) * 10]);
  const ppl = spots.map((_, k) => P(k + 1, "own", `J${k + 1}`));
  const g = fixed({ n: 700, people: ppl, at: () => spots.map(([x, y], k) => q(k + 1, x, y, "extrapolated")) });
  assert.equal(teamBlock(parts(g), "own").players.length, 0);
});

test("heat maps and players behind the ball: extrapolated positions are not counted", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea")];
  const f = fixed({ people, at: () => [q(1, 20, 30), q(2, 60, 30, "extrapolated")] });
  const h = heatmap(parts(f), "own");
  assert.ok(Math.abs(h.total - 3) < 1e-9); // only Ana: 30 samples of 0.1 s
  assert.equal(heatmap(parts(f), "own", "Bea").total, 0);
  assert.deepEqual(namedPlayers(parts(f), "own").map((p) => p.name), ["Ana"]);
  const ev = { event_id: "e", match_id: "m", video_id: "v1", t_video: 1, period: 1, type: "loss", team: "own", player_id: null, x: 50, y: 30, outcome: null, note: null };
  const g = fixed({ n: 100, people: [P(1, "own"), P(2, "own"), P(3, "own")], at: () => [q(1, 10, 30), q(2, 30, 30), q(3, 20, 30, "extrapolated")] });
  assert.deepEqual(behindBallAtLosses(parts(g), [ev]).map((b) => [b.behind, b.seen]), [[2, 2]]);
});

test("touches, passes and possession: an extrapolated player is never a touch nor a blocker", () => {
  // The ball sits next to Bea held still (extrapolated); Ana, measured, is 1.2 m away: Bea is no candidate, so Ana has it.
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea")];
  const ball = Array.from({ length: 30 }, (_, i) => ({ frame: i * 3, x: 50, y: 30, source: "manual" }));
  const f = fixed({ people, at: () => [q(1, 51.2, 30), q(2, 50.2, 30, "extrapolated")], ball });
  assert.deepEqual([...new Set(touches(f).map((t) => t.id))], [1]);
  // Nobody measured near: no touch even though an extrapolated player is on the ball.
  const g = fixed({ people, at: () => [q(1, 80, 30), q(2, 50.2, 30, "extrapolated")], ball });
  assert.equal(touches(g).length, 0);
  assert.equal(passesAndTurnovers(g).passes.length, 0);
  const r = possessionIntervals(parts(g), {}, { stillS: 1e9 });
  assert.ok(r.samples.every((s) => s.team === "none"));
  // A nameless held box right on the ball does not make the frame "blocked": the measured player keeps the touch.
  const blocker = fixed({ people: [P(1, "own", "Ana"), P(3, "unk")], at: () => [q(1, 51, 30), q(3, 50.1, 30, "extrapolated")], ball });
  assert.equal(touches(blocker).length, 30);
  const rb = possessionIntervals(parts(blocker), {}, { stillS: 1e9 });
  assert.ok(rb.samples.some((s) => s.team === "own"));
  assert.ok(!rb.samples.some((s) => s.notes.includes("blocked")));
  // Passes of the tracking: a held player is not a receiver.
  const ballA = Array.from({ length: 30 }, (_, i) => ({ frame: i * 3, x: i < 15 ? 20.5 : 60.5, y: 30, source: "manual" }));
  const pass = fixed({ people, at: () => [q(1, 20, 30), q(2, 60, 30, "extrapolated")], ball: ballA });
  assert.equal(trackedPasses(parts(pass), "own").completed, 0);
});

test("block shape by stretches: extrapolated positions are not counted", () => {
  const spots = Array.from({ length: 10 }, (_, k) => [10 + k * 8, 10 + (k % 4) * 15]);
  const people = spots.map((_, k) => P(k + 1, "own", `J${k + 1}`));
  const f = fixed({ n: 3000, people, at: () => spots.map(([x, y], k) => q(k + 1, x, y, "extrapolated")) });
  const b = blockShape(parts(f), {}, ["v1"], 5);
  assert.equal(b.frames.own, 0);
});

test("positionsAt leaves held people out unless the caller draws them (flagged)", () => {
  const f = fixed({ people: [P(1, "own"), P(2, "own")], at: () => [q(1, 20, 30), q(2, 60, 30, "extrapolated")] });
  assert.deepEqual(positionsAt(parts(f)[0], 1).players.map((d) => d.id), [1]);
  const drawn = positionsAt(parts(f)[0], 1, { withExtrapolated: true }).players;
  assert.deepEqual(drawn.map((d) => [d.id, d.extrapolated ?? false]), [[1, false], [2, true]]);
});
