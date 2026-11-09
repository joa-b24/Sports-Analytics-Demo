import assert from "node:assert/strict";
import { test } from "node:test";
import { ballMetrics, playMetrics, possessionMetrics } from "./playMetrics.ts";

// Synthetic data only. 30 fps, one processed frame every 3 (0.1 s); the venue is the normalised pitch (1 unit = 1 m).
const P = (id, team, player_id) => ({ id, team, player_id, tracks: [id] });
const part = ({ n, people, at, ball = [], extra = {} }) => ({
  file: {
    kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
    venue: { length_m: 105, width_m: 68 }, people, ball, frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })), ...extra,
  },
  ownRight: true,
});
const mark = (i, x, y, source = "manual") => ({ frame: i * 3, x, y, source });

test("el balón: distancia y velocidad solo entre marcas medidas; sin marcas es NaN, no cero", () => {
  // 10 m/s for 2 s with a mark every 0.5 s (manual).
  const o = part({ n: 31, people: [], at: () => [], ball: [0, 1, 2, 3, 4].map((k) => ({ frame: k * 15, x: 10 + k * 2.5, y: 30, source: "manual" })) });
  // marks every 0.5 s (frames 0, 15, 30, 45, 60) moving 2.5 m each: 10 m in 2 s
  const b = ballMetrics([o], 0, 2);
  assert.ok(Math.abs(b.distance_m - 10) < 1e-6);
  assert.ok(Math.abs(b.mean_ms - 5) < 1e-6);
  assert.ok(b.coverage > 0.99);
  const none = ballMetrics([part({ n: 31, people: [], at: () => [], ball: [mark(0, 1, 1, "interpolated"), mark(10, 5, 5, "event")] })], 0, 2);
  assert.ok(Number.isNaN(none.distance_m));
  assert.ok(Number.isNaN(none.mean_ms));
  assert.equal(none.coverage, 0);
});

test("un salto imposible del balón no suma distancia", () => {
  const o = part({ n: 31, people: [], at: () => [], ball: [mark(0, 10, 30), mark(5, 90, 30), mark(10, 91, 30)] });
  const b = ballMetrics([o], 0, 1);
  assert.ok(b.distance_m < 5);
});

test("la posesión reparte el tiempo por toques y deja lo no medido aparte", () => {
  // Own player 1 stands at (20,30) and the ball sits on her for 1 s; then nothing is measured for the rest of 3 s.
  const o = part({
    n: 31,
    people: [P(1, "own", "Ana"), P(2, "opp", null)],
    at: () => [{ id: 1, x: 20, y: 30, source: "auto" }, { id: 2, x: 60, y: 10, source: "auto" }],
    ball: [0, 3, 6, 9, 12].map((i) => mark(i, 20.3, 30, "manual")),
  });
  const p = possessionMetrics([o], 0, 3);
  assert.ok(p.own_s > 1 && p.own_s <= 1.6, `own_s ${p.own_s}`);
  assert.equal(p.opp_s, 0);
  assert.ok(p.unmeasured_s > 1, "lo que no tiene balón medido se dice");
  assert.ok(p.coverage < 0.8);
});

test("playMetrics: sin parte de tracking todo es NaN y se dice; con parte, por delante/detrás y forma", () => {
  const none = playMetrics({ parts: [], videoId: "v1", t0: 0, t1: 3 });
  assert.equal(none.tracked, false);
  assert.ok(Number.isNaN(none.ball.distance_m));
  assert.ok(Number.isNaN(none.passes.own));
  assert.equal(none.shape.start.own, null);

  const people = [P(1, "own", "Ana"), ...Array.from({ length: 9 }, (_, k) => P(2 + k, "own", null)), P(20, "opp", null)];
  const at = (i) => [
    { id: 1, x: 10 + 0.5 * i, y: 30, source: "auto" },
    ...Array.from({ length: 9 }, (_, k) => ({ id: 2 + k, x: 20 + k * 5, y: 10 + k * 5, source: "auto" })),
    { id: 20, x: 80, y: 30, source: "auto" },
    { id: 21, x: 5, y: 5, source: "extrapolated" },
  ];
  const o = part({ n: 31, people: [...people, P(21, "own", null)], at, ball: [0, 30].map((i) => mark(i, 40, 30)) });
  const m = playMetrics({ parts: [o], videoId: "v1", t0: 0, t1: 3, players: ["Ana", "Zoe"] });
  assert.equal(m.tracked, true);
  // At the start, the ball is at x = 40: Ana (10) and the players at x 20, 25, 30, 35 are behind it; 45..60 ahead (x = 40 is level).
  assert.equal(m.ball_side.start.own.behind, 5);
  assert.equal(m.ball_side.start.own.ahead, 4, "el que está a la altura del balón no cuenta ni delante ni detrás");
  assert.equal(m.ball_side.start.own.seen, 10, "el extrapolado no cuenta");
  assert.ok(m.shape.start.own && m.shape.start.own.width_m > 30);
  assert.equal(m.shape.start.opp, null, "una sola rival en cuadro: sin forma");
  assert.deepEqual(m.players.map((p) => p.name), ["Ana"]);
  assert.deepEqual(m.players_missing, ["Zoe"]);
  assert.ok(m.players[0].distance_m > 10);
});
