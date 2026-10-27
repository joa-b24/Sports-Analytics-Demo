import assert from "node:assert/strict";
import { test } from "node:test";
import { blockShape } from "./blockShape.ts";
import { momentHref, momentOfEvent, momentStart } from "./moments.ts";
import { trackedNet, trackedPasses } from "./passSources.ts";
import { behindSummary } from "./positions.ts";

const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });
const M = (frame, x, y, source = "manual") => ({ frame, x, y, source });
const fixed = ({ n = 40, people, at, ball = [], video_id = "v1" }) => ({
  kind: "tracks_fixed", match_id: "m", video_id, fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  people, ball, venue: { length_m: 105, width_m: 68 },
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});

test("pases del tracking por jugadora: hechos, recibidos y cortados; solo con nombres", () => {
  // Ana -> Bea (1 s), Bea loses it to an opponent (3).
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 60, 30)];
  const f = fixed({ n: 60, people, at, ball: [M(0, 20.5, 30), M(30, 40.5, 30), M(60, 60.5, 30)] });
  const t = trackedPasses([{ file: f, ownRight: true }], "own");
  assert.equal(t.completed, 1);
  assert.equal(t.cut, 1);
  assert.equal(t.approx, 0);
  const by = Object.fromEntries(t.players.map((p) => [p.player_id, p]));
  assert.deepEqual([by.Ana.attempted, by.Ana.completed, by.Ana.received], [1, 1, 0]);
  assert.deepEqual([by.Bea.attempted, by.Bea.completed, by.Bea.received], [1, 0, 1]);
  assert.deepEqual(by.Ana.partners, [{ player_id: "Bea", count: 1 }]);
  const n = trackedNet([{ file: f, ownRight: true }], "own");
  assert.deepEqual(n.edges, [{ a: "Ana", b: "Bea", count: 1 }]);
  assert.equal(n.nodes[0].placed, "tracking");
});

test("rival sin nombres: la cifra de equipo existe, aproximada, y no hay jugadoras", () => {
  const people = [P(1, "opp"), P(2, "opp"), P(3, "own", "Ana")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 90, 30)];
  const f = fixed({ people, at, ball: [M(0, 20.5, 30), M(30, 40.5, 30)] });
  const t = trackedPasses([{ file: f, ownRight: true }], "opp");
  assert.deepEqual([t.completed, t.approx, t.players.length], [1, 1, 0]);
  assert.equal(trackedNet([{ file: f, ownRight: true }], "opp").unnamed, 1);
});

test("un cambio de fragmento a menos de 0.5 s no es pase", () => {
  const people = [P(1, "opp"), P(2, "opp")];
  const f = fixed({ people, at: () => [q(1, 20, 30), q(2, 40, 30)], ball: [M(0, 20.5, 30), M(9, 40.5, 30)] });
  assert.equal(trackedPasses([{ file: f, ownRight: true }], "opp").completed, 0);
});

test("forma del bloque: altura desde su portería, ancho y largo; sin portera sola; el rival defiende el lado contrario", () => {
  // Own: keeper at x=3 (alone behind), 7 field players. Opp: 8 players, deepest at x=70 (35 m from its goal at 105).
  const own = [3, 30, 32, 34, 36, 50, 55, 60];
  const opp = [70, 72, 74, 76, 80, 85, 90, 95];
  const people = [...own.map((_, i) => P(i + 1, "own")), ...opp.map((_, i) => P(i + 20, "opp"))];
  const at = () => [...own.map((x, i) => q(i + 1, x, 10 + 6 * i)), ...opp.map((x, i) => q(i + 20, x, 12 + 5 * i))];
  const f = fixed({ n: 100, people, at });
  const out = blockShape([{ file: f, ownRight: true }], { v1: [{ segment_id: "s", start: 0, end: 10, tipo: "juego" }] }, ["v1"], 5);
  assert.equal(out.clock, "play");
  assert.equal(out.bins.length, 1);
  const o = out.bins[0].own;
  // keeper dropped (gap 27 m): field players 30..60; line = mean(30,32,34,36) = 33; length 60 - 30.
  assert.ok(Math.abs(o.line_height - 33) < 1e-9);
  assert.ok(Math.abs(o.length - 30) < 1e-9);
  assert.ok(Math.abs(o.width - 36) < 1e-9); // y 16..52 after the keeper (y 10) is gone
  const r = out.bins[0].opp;
  // depth = 105 - x: 35, 33, 31, 29, 25, 20, 15, 10 -> sorted 10..35; no keeper gap -> line = mean(10,15,20,25) = 17.5
  assert.ok(Math.abs(r.line_height - 17.5) < 1e-9);
  assert.equal(out.valid.own, 100);
});

test("forma del bloque: pocos jugadores en cuadro no cuentan y el tramo queda sin valor (no se inventa)", () => {
  const people = [1, 2, 3].map((i) => P(i, "own"));
  const f = fixed({ n: 100, people, at: () => [q(1, 30, 10), q(2, 40, 20), q(3, 50, 30)] });
  const out = blockShape([{ file: f, ownRight: true }], {}, ["v1"], 5);
  assert.equal(out.clock, "video");
  assert.equal(out.bins[0].own.line_height, null);
  assert.equal(out.bins[0].own.valid_share, 0);
  assert.equal(out.valid.own, 0);
});

test("jugadoras detrás del balón: columnas por número y cuántas pérdidas con 4 o más detrás", () => {
  const row = (behind, t) => ({ t, video_id: "v1", behind, seen: 8, source: "event" });
  const s = behindSummary([row(2, 1), row(2, 5), row(5, 9)]);
  assert.equal(s.n, 3);
  assert.equal(s.covered, 1);
  assert.deepEqual(s.columns.map((c) => c.items.length), [0, 0, 2, 0, 0, 1]);
  assert.ok(Math.abs(s.mean - 3) < 1e-9);
  assert.equal(behindSummary([]), null);
});

test("momentos: el tiempo es el del video del evento, no el del eje unido", () => {
  const joined = { event_id: "e1", video_id: "v2", t_video: 5000, type: "goal" };
  const own = new Map([["e1", { event_id: "e1", video_id: "v2", t_video: 312, type: "goal" }]]);
  assert.deepEqual(momentOfEvent(joined, own, "Gol"), { video_id: "v2", t: 312, label: "Gol" });
  // Without the list, rows saved before several videos existed are the first video.
  assert.deepEqual(momentOfEvent({ event_id: "e2", t_video: 40 }, null, "x"), { video_id: "v1", t: 40, label: "x" });
  assert.equal(momentStart(2), 0);
  assert.equal(momentHref("m 1", { video_id: "v2", t: 312 }), "/partido?id=m%201&video=v2&t=309");
});
