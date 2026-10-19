import assert from "node:assert/strict";
import { test } from "node:test";
import { physical, teamBlock } from "./physical.ts";

// 30 fps, one of every 3 frames (0.1 s per sample); the venue is the normalised pitch (1 unit = 1 m).
const fixed = ({ n, people, at }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  venue: { length_m: 105, width_m: 68 }, people, ball: [],
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id) => ({ id, team, player_id, tracks: [id] });

test("distance, top speed and sprints of a player running at a steady speed", () => {
  // 7 m/s (25.2 km/h) for 3 s: 21 m, one sprint.
  const f = fixed({ n: 31, people: [P(1, "own", "Paz")], at: (i) => [{ id: 1, x: 10 + 0.7 * i, y: 30, source: "auto" }] });
  const [r] = physical([{ file: f, ownRight: true }], "own");
  assert.equal(r.name, "Paz");
  assert.equal(r.distance_m, 21);
  assert.ok(Math.abs(r.top_kmh - 25.2) < 0.2);
  assert.equal(r.sprints, 1);
  assert.equal(r.hsr_m, 21);
});

test("gaps, jumps and interpolated positions are not measured", () => {
  const f = fixed({
    n: 20,
    people: [P(1, "own", "Kat")],
    at: (i) => (i === 10 ? [] : [{ id: 1, x: i < 10 ? 10 + 0.1 * i : 60 + 0.1 * i, y: 30, source: i === 5 ? "interpolated" : "auto" }]),
  });
  const [r] = physical([{ file: f, ownRight: true }], "own");
  // The 50 m teleport is dropped; walking at 1 m/s is kept.
  assert.ok(r.distance_m <= 2);
  assert.ok(r.top_kmh < 5);
});

test("the block: line height, length and width from average positions, keeper left out", () => {
  const spots = [[3, 34], [40, 10], [42, 25], [42, 43], [40, 58], [55, 15], [56, 34], [55, 53], [70, 20], [72, 34], [70, 48]];
  const people = spots.map((_, k) => P(k + 1, "own", `J${k + 1}`));
  // 70 s of the same shape.
  const f = fixed({ n: 700, people, at: () => spots.map(([x, y], k) => ({ id: k + 1, x, y, source: "auto" })) });
  const b = teamBlock([{ file: f, ownRight: true }], "own");
  assert.equal(b.players.length, 11);
  assert.equal(b.line_m, 41);
  assert.equal(b.length_m, 30);
  assert.equal(b.width_m, 48);
  // Seen from the other side, the rival's shape mirrors.
  assert.equal(teamBlock([{ file: f, ownRight: true }], "opp").players.length, 0);
});
