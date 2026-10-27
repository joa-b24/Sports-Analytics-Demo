import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NO_PASS_FILTER, emptyPassReview, filterPasses, parsePassReview, passCounts, passItems, passReviewOf, passReviewPath, passReviewStats, passSample, passScene, setPassVerdict,
} from "./playgroundPasses.ts";

const fixed = ({ n = 10, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3, people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });

// Ana (1) -> Bea (2), who loses it to the rival (3): one completed pass and one cut.
const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 60, 30)];
const ball = [
  { frame: 0, x: 20.5, y: 30, source: "manual" },
  { frame: 15, x: 30, y: 30, source: "interpolated" },
  { frame: 30, x: 39.5, y: 30, source: "manual" },
  { frame: 45, x: 59, y: 30, source: "manual" },
];
const parts = [{ file: fixed({ n: 20, people, at, ball }), ownRight: true }];

test("passItems lista el pase completado y el cortado, con nombres y tiempos del video", () => {
  const items = passItems(parts, {});
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.completed, true);
  assert.deepEqual([a.from_name, a.to_name, a.team], ["Ana", "Bea", "own"]);
  assert.equal(a.t_start, 0);
  assert.equal(a.t_end, 1);
  assert.equal(b.completed, false);
  assert.equal(b.to, null);
  assert.equal(b.team, "own");
  assert.deepEqual(passCounts(items), { completed: 1, cut: 1, approx: 0 });
  assert.deepEqual(passCounts(items, "opp"), { completed: 0, cut: 0, approx: 0 });
});

test("solo cuentan los pases dentro de los tramos de juego cerrados", () => {
  const out = passItems(parts, { v1: [{ segment_id: "s", start: 5, end: 10, tipo: "juego" }] });
  assert.equal(out.length, 0);
  const inside = passItems(parts, { v1: [{ segment_id: "s", start: 0, end: 10, tipo: "juego" }] });
  assert.equal(inside.length, 2);
});

test("un tramo cubierto por dos partes cuenta una vez", () => {
  assert.equal(passItems([...parts, { file: { ...parts[0].file, start_frame: 0 }, ownRight: true }], {}).length, 2);
});

test("filtros por equipo, resultado y revisión", () => {
  const items = passItems(parts, {});
  assert.equal(filterPasses(items, NO_PASS_FILTER, new Set()).length, 2);
  assert.equal(filterPasses(items, { ...NO_PASS_FILTER, result: "cut" }, new Set()).length, 1);
  assert.equal(filterPasses(items, { ...NO_PASS_FILTER, team: "opp" }, new Set()).length, 0);
  assert.equal(filterPasses(items, { ...NO_PASS_FILTER, review: "pending" }, new Set([items[0].id])).length, 1);
});

test("veredictos: marcar, cambiar, quitar, estadística sobre lo revisado y archivo", () => {
  const items = passItems(parts, {});
  let f = emptyPassReview("v1");
  f = setPassVerdict(f, items[0], "correct", " bien ", "2026-01-01T00:00:00Z");
  f = setPassVerdict(f, items[1], "incorrect", "", "2026-01-01T00:00:00Z");
  assert.equal(passReviewOf(f, items[0]).note, "bien");
  let s = passReviewStats(f.reviews, items);
  assert.deepEqual([s.reviewed, s.correct, s.incorrect, s.accuracy, s.current], [2, 1, 1, 0.5, 2]);
  f = setPassVerdict(f, items[1], null, "");
  s = passReviewStats(f.reviews, items);
  assert.equal(s.reviewed, 1);
  assert.equal(passReviewStats([], items).accuracy, null);
  // Stored reviews that no longer exist in the list are counted apart.
  assert.equal(passReviewStats(f.reviews, []).current, 0);
  const back = parsePassReview(JSON.stringify(f), "v1");
  assert.equal(back.reviews.length, 1);
  assert.equal(parsePassReview("no es json", "v1").reviews.length, 0);
  assert.equal(parsePassReview(JSON.stringify({ kind: "otra" }), "v1").reviews.length, 0);
  assert.equal(passReviewPath("2026_x", "v2"), "matches/2026_x/passes_review_v2.json");
});

test("muestra: reparte entre estratos, es determinista y salta lo revisado", () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ id: `v1|${i}`, video_id: "v1", t_start: i * 4, t_end: i * 4 + 1, team: i % 5 === 0 ? "opp" : "own", completed: i % 3 !== 0, approx: false });
  const s = passSample(items, 12);
  assert.equal(s.length, 12);
  assert.deepEqual(s, passSample(items, 12));
  assert.ok(s.some((p) => p.team === "opp") && s.some((p) => !p.completed));
  assert.ok(Math.max(...s.map((p) => p.t_start)) > 80);
  const done = new Set(s.map((p) => p.id));
  assert.ok(passSample(items, 12, done).every((p) => !done.has(p.id)));
  assert.equal(passSample(items.slice(0, 3), 30).length, 3);
  assert.deepEqual(passSample([], 30), []);
});

test("escena: jugadoras en el instante del pase, anillo en quien pasa y balón al inicio y al fin", () => {
  const [pass] = passItems(parts, {});
  const r = passScene(parts, pass);
  assert.ok(r);
  assert.equal(r.scene.owner.name, "Ana");
  assert.equal(r.scene.dots.length, 3);
  assert.ok(r.ends.start && r.ends.end);
  assert.equal(passScene([], pass), null);
});
