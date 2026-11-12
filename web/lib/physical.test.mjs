import assert from "node:assert/strict";
import { test } from "node:test";
import { physical, playerSprints, teamBlock } from "./physical.ts";

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
  assert.ok(r.hsr_m >= 17 && r.hsr_m <= 21); // the first and last steps lack a full window
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

const run = (people, at, n = 60) => physical([{ file: fixed({ n, people, at }), ownRight: true }], "own");

test("an isolated jump does not inflate the top speed of the windows around it", () => {
  // Walking at 2 m/s (7.2 km/h); at sample 30 the track jumps 3 m (30 m/s = 108 km/h for that step).
  const [r] = run([P(1, "own", "Zoe")], (i) => [{ id: 1, x: 10 + 0.2 * i + (i >= 30 ? 3 : 0), y: 30, source: "auto" }]);
  assert.ok(r.top_kmh <= 8, `top ${r.top_kmh}`);
  // The jump step adds no distance.
  assert.ok(r.distance_m <= 12);
});

test("a window above the physiological ceiling is not a speed", () => {
  // 10 m/s = 36 km/h held steadily: every step is under MAX_KMH-ish edge, but above the plausible 33 km/h.
  const [r] = run([P(1, "own", "Ceci")], (i) => [{ id: 1, x: 5 + 0.95 * i, y: 30, source: "auto" }]);
  assert.equal(r.top_kmh, null);
  assert.equal(r.sprints, 0);
});

test("a short gap does not cut a sprint run, a long one does", () => {
  // 7 m/s (25 km/h) for 4 s with 0.3 s with no positions at sample 20-22 (frames missing).
  const at = (i) => (i >= 20 && i <= 22 ? [] : [{ id: 1, x: 5 + 0.7 * i, y: 30, source: "auto" }]);
  const [r] = run([P(1, "own", "Quiroz")], at, 40);
  assert.equal(r.sprints, 1);
  // A 1.5 s hole splits it in two runs (2.5 s and 3 s).
  const at2 = (i) => (i >= 25 && i < 40 ? [] : [{ id: 1, x: 5 + 0.7 * i, y: 30, source: "auto" }]);
  const [r2] = run([P(1, "own", "Quiroz")], at2, 70);
  assert.equal(r2.sprints, 2);
});

test("filled positions count and the row says how much comes from them, long fills included", () => {
  // 3 m/s; samples 10-39 (3 s) are filled; the rest measured.
  const at = (i) => [{ id: 1, x: 5 + 0.3 * i, y: 30, source: i >= 10 && i < 40 ? "interpolated" : "auto" }];
  const [r] = run([P(1, "own", "Regi")], at, 60);
  assert.ok(Math.abs(r.distance_m - 18) <= 1, `dist ${r.distance_m}`);
  assert.ok(r.fill_time_pct > 45 && r.fill_time_pct < 55, `fill time ${r.fill_time_pct}`);
  assert.ok(r.fill_dist_pct > 45 && r.fill_dist_pct < 55);
  const [m] = run([P(1, "own", "Paz")], (i) => [{ id: 1, x: 5 + 0.3 * i, y: 30, source: "auto" }], 60);
  assert.equal(m.fill_time_pct, 0);
});

test("una excursión a otra jugadora y de regreso en un segundo no suma metros; el zig-zag y el temblor tampoco", () => {
  // Camina a 1.5 m/s; en las muestras 25-34 (1 s) la caja salta 8 m al lado y vuelve.
  const base = (i) => 10 + 0.15 * i;
  const [clean] = run([P(1, "own", "Ana")], (i) => [{ id: 1, x: base(i), y: 30, source: "auto" }], 60);
  const [jumpy] = run([P(2, "own", "Ana")], (i) => [{ id: 2, x: base(i), y: i >= 25 && i < 35 ? 38 : 30, source: "auto" }], 60);
  assert.ok(Math.abs(jumpy.distance_m - clean.distance_m) <= 2, `limpio ${clean.distance_m} con salto ${jumpy.distance_m}`);
  // Zig-zag de ±0.4 m en cada muestra sobre la misma marcha: la distancia no se dispara.
  const [zig] = run([P(3, "own", "Ana")], (i) => [{ id: 3, x: base(i), y: 30 + (i % 2 ? 0.4 : -0.4), source: "auto" }], 60);
  assert.ok(zig.distance_m <= clean.distance_m * 1.15, `zig-zag ${zig.distance_m} contra ${clean.distance_m}`);
  // Parada con temblor de 0.2 m: no recorre nada.
  const [still] = run([P(4, "own", "Ana")], (i) => [{ id: 4, x: 50 + (i % 2 ? 0.1 : -0.1), y: 30 + (i % 3 ? 0.1 : -0.1), source: "auto" }], 60);
  assert.ok(still.distance_m <= 1, `quieta ${still.distance_m}`);
  assert.ok(still.top_kmh < 3);
});

import { accelerationCoherent, HSR_KMH, SPRINT_KMH, SPRINT_MIN_S, ACCEL_MAX_MS2 } from "./physical.ts";
test("aceleración coherente: un sprint que llega por una rampa humana vale; un salto de velocidad no", () => {
  // De 10 a 24 km/h en 1 s con muestras cada 0.1 s: ~1.2 m/s², normal.
  const ramp = Array.from({ length: 11 }, (_, i) => ({ t: i * 0.1, kmh: 10 + 1.4 * i }));
  assert.equal(accelerationCoherent(ramp), true);
  // De 8 a 26 km/h en 0.1 s: 50 m/s², nadie acelera así: error del track.
  assert.equal(accelerationCoherent([{ t: 0, kmh: 8 }, { t: 0.1, kmh: 26 }, { t: 0.2, kmh: 26 }]), false);
  // Dos velocidades separadas por un hueco no se comparan.
  assert.equal(accelerationCoherent([{ t: 0, kmh: 8 }, { t: 2, kmh: 26 }]), true);
  assert.equal(ACCEL_MAX_MS2, 8);
});
test("umbrales: HSR por encima de 18 km/h; sprint a partir de 22 km/h durante al menos 1 s", () => {
  assert.equal(HSR_KMH, 18);
  assert.equal(SPRINT_KMH, 22);
  assert.equal(SPRINT_MIN_S, 1);
});

test("playerSprints lists the sprint of one player with its video and speed, and no one else's", () => {
  const f = fixed({
    n: 31,
    people: [P(1, "own", "Paz"), P(2, "own", "Kat")],
    at: (i) => [{ id: 1, x: 10 + 0.7 * i, y: 30, source: "auto" }, { id: 2, x: 10 + 0.1 * i, y: 40, source: "auto" }],
  });
  const paz = playerSprints([{ file: f, ownRight: true }], "own", "Paz");
  assert.equal(paz.length, 1);
  assert.equal(paz[0].video_id, "v1");
  assert.equal(paz[0].valid, true);
  assert.ok(Math.abs(paz[0].peak_kmh - 25.2) < 0.3);
  assert.ok(paz[0].t_end - paz[0].t_start >= 1);
  assert.deepEqual(playerSprints([{ file: f, ownRight: true }], "own", "Kat"), []);
});
