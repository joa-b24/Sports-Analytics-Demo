import assert from "node:assert/strict";
import { test } from "node:test";
import { possessionIntervals, POSSESSION_DEFAULTS } from "./possession.ts";
import {
  NO_FILTER, ballEnds, clampFrac, dragDivider, fmtTd, formatFracs, loopSeek, loopWindow, parseFracs, parseMinDur, clampParam, effectText, emptyReview, filterRows, medianLab, parseReview, PARAM_FIELDS, reviewSample, reviewStats, rowId, sceneAt, setVerdict,
} from "./playgroundPossession.ts";

const fixed = ({ n = 10, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3, people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });
const B = (i, x, y, source = "manual") => ({ frame: i * 3, x, y, source });

const row = (o) => ({ video_id: "v1", segment_id: "s", t_start: 0, t_end: 2, team: "own", first_player: null, last_player: null, kind: "control",
  flags: { ball_interp: false, player_interp: false, ball_source: "manual", ball_s: {}, notes: [] }, ...o });

test("filterRows combina equipo, tipo, fuente y bandera de interpolado", () => {
  const rows = [row({}), row({ team: "opp", t_start: 3 }), row({ kind: "unknown", t_start: 5, flags: { ...row({}).flags, ball_interp: true, ball_source: "interp" } })];
  assert.equal(filterRows(rows, NO_FILTER).length, 3);
  assert.equal(filterRows(rows, { ...NO_FILTER, team: "opp" }).length, 1);
  assert.equal(filterRows(rows, { ...NO_FILTER, interp: "yes" }).length, 1);
  assert.equal(filterRows(rows, { ...NO_FILTER, interp: "no", source: "manual" }).length, 2);
  assert.equal(filterRows(rows, { ...NO_FILTER, kind: "unknown", source: "interp" }).length, 1);
});

test("reviewSample reparte entre grupos, salta cortos y revisados, y es determinista", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row({ t_start: i * 3, t_end: i * 3 + 2, team: i % 4 === 0 ? "opp" : "own" }));
  rows.push(row({ t_start: 500, t_end: 500.2, team: "none", kind: "dead" }));
  rows.push(row({ t_start: 600, t_end: 602, team: "none", kind: "dead" }));
  const s = reviewSample(rows, 12);
  assert.equal(s.length, 12);
  assert.deepEqual(s, reviewSample(rows, 12));
  assert.ok(s.some((r) => r.team === "opp") && s.some((r) => r.team === "own") && s.some((r) => r.kind === "dead"));
  assert.ok(!s.some((r) => r.t_start === 500));
  // Spread through the match, not the first ones.
  assert.ok(Math.max(...s.filter((r) => r.team === "own").map((r) => r.t_start)) > 60);
  const done = new Set(s.map(rowId));
  assert.ok(reviewSample(rows, 12, done).every((r) => !done.has(rowId(r))));
  assert.equal(reviewSample(rows, 500).length, 41);
});

test("veredictos: marcar, cambiar, quitar, guardar y leer; acierto sobre lo revisado", () => {
  const a = row({});
  const b = row({ t_start: 10, t_end: 12, team: "opp" });
  let f = emptyReview("v1");
  f = setVerdict(f, a, "correct", "", POSSESSION_DEFAULTS, "t");
  f = setVerdict(f, b, "incorrect", " dueña mal ", POSSESSION_DEFAULTS, "t");
  const st = reviewStats(f.reviews, [a]);
  assert.deepEqual([st.reviewed, st.correct, st.incorrect, st.accuracy, st.current], [2, 1, 1, 0.5, 1]);
  assert.equal(f.reviews[1].note, "dueña mal");
  f = setVerdict(f, a, "incorrect", "", POSSESSION_DEFAULTS, "t");
  assert.equal(f.reviews.length, 2);
  assert.equal(reviewStats(f.reviews, []).accuracy, 0);
  const back = parseReview(JSON.stringify(f), "v1");
  assert.deepEqual(back.reviews, f.reviews);
  assert.equal(setVerdict(f, a, null, "", POSSESSION_DEFAULTS).reviews.length, 1);
  assert.equal(reviewStats([], []).accuracy, null);
  assert.equal(parseReview("{roto", "v1").reviews.length, 0);
  assert.equal(parseReview(null, "v1").reviews.length, 0);
});

test("clampParam respeta los límites y conserva el valor ante basura", () => {
  const f = PARAM_FIELDS.find((x) => x.key === "controlS");
  assert.equal(clampParam(f, 0.3, 0.5), 0.3);
  assert.equal(clampParam(f, 99, 0.5), f.max);
  assert.equal(clampParam(f, NaN, 0.5), 0.5);
});

test("sceneAt: la dueña que asigna la tabla sale en la escena, con su distancia al balón", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 50.5, 34), q(2, 80, 30)];
  const ball = Array.from({ length: 30 }, (_, i) => B(i, 50, 34));
  const parts = [{ file: fixed({ n: 30, people, at, ball }), ownRight: true }];
  const r = possessionIntervals(parts, {});
  const own = r.rows.find((x) => x.team === "own");
  const sc = sceneAt(r, parts, own);
  assert.ok(sc);
  assert.equal(sc.owner.id, 1);
  assert.equal(sc.owner.role, "holder");
  assert.equal(sc.owner.name, "Ana");
  assert.ok(Math.abs(sc.owner.distance - 0.5) < 1e-6);
  assert.equal(sc.dots.length, 2);
  assert.deepEqual(sc.ball, [50, 34]);
  // Outside every part: nothing to draw.
  assert.equal(sceneAt(r, parts, row({ video_id: "v9" })), null);
});

test("sceneAt marca la caja bloqueante cuando nadie se lleva el balón", () => {
  const people = [P(1, "own", "Ana"), P(3, "unk")];
  const at = () => [q(1, 55, 34), q(3, 50, 34.5)];
  const ball = Array.from({ length: 30 }, (_, i) => B(i, 50, 34));
  const parts = [{ file: fixed({ n: 30, people, at, ball }), ownRight: true }];
  const r = possessionIntervals(parts, {});
  const sc = sceneAt(r, parts, r.rows[0]);
  assert.equal(sc.owner.role, "blocker");
  assert.equal(sc.owner.id, 3);
});

test("effectText y medianLab", () => {
  const t = effectText({ own: { own: 2.1, opp: -2.1, none: 0 } });
  assert.equal(t.length, 1);
  assert.match(t[0], /Si fuera nuestra/);
  assert.match(t[0], /\+2[.,]1 s/);
  assert.deepEqual(medianLab([[10, 20, 30], null, [30, 40, 50], [20, 30, 40]]), [20, 30, 40]);
  assert.equal(medianLab([null]), null);
});

test("filtro por duración: mayor a X s, combinable con los demás y sin filtro con vacío", () => {
  const rows = [row({ t_start: 0, t_end: 2 }), row({ t_start: 10, t_end: 15, team: "opp" }), row({ t_start: 20, t_end: 26 })];
  assert.equal(filterRows(rows, { ...NO_FILTER, minDur: 3 }).length, 2);
  assert.equal(filterRows(rows, { ...NO_FILTER, minDur: 5 }).length, 1, "estrictamente mayor");
  assert.equal(filterRows(rows, { ...NO_FILTER, minDur: 3, team: "own" }).length, 1);
  assert.equal(filterRows(rows, NO_FILTER).length, 3);
  assert.equal(parseMinDur(""), null);
  assert.equal(parseMinDur("abc"), null);
  assert.equal(parseMinDur("-2"), null);
  assert.equal(parseMinDur("2,5"), 2.5);
});

test("bucle: ventana con márgenes, bordes del video y salto al inicio", () => {
  assert.deepEqual(loopWindow(10, 14, 1, 100), { start: 9, end: 15 });
  assert.deepEqual(loopWindow(0.4, 3, 1, 100), { start: 0, end: 4 }, "no antes de 0");
  assert.deepEqual(loopWindow(98, 99.5, 2, 100), { start: 96, end: 100 }, "no después del final");
  assert.deepEqual(loopWindow(10, 12, 1, 0), { start: 9, end: 13 }, "duración desconocida");
  assert.deepEqual(loopWindow(10, 12, 99), { start: 5, end: 17 }, "margen acotado a 5 s");
  assert.equal(loopWindow(100, 100, 0, 100), null);
  const w = { start: 9, end: 15 };
  assert.equal(loopSeek(12, w), null);
  assert.equal(loopSeek(14.97, w), 9);
  assert.equal(loopSeek(16, w), 9);
});

test("tamaño de los paneles: se guarda como texto, vuelve al original si está dañado y no deja un panel aplastado", () => {
  const v = [0.4, 0.35, 0.25];
  assert.deepEqual(parseFracs(formatFracs(v), 3, [1 / 3, 1 / 3, 1 / 3]), v);
  assert.deepEqual(parseFracs("", 3, [0.2, 0.3, 0.5]), [0.2, 0.3, 0.5]);
  assert.deepEqual(parseFracs("0.5,0.5", 3, [0.2, 0.3, 0.5]), [0.2, 0.3, 0.5]);
  assert.deepEqual(parseFracs("0.01,0.5,0.49", 3, [0.2, 0.3, 0.5]), [0.2, 0.3, 0.5]);
  const d = dragDivider(v, 0, 0.1);
  assert.ok(Math.abs(d[0] - 0.5) < 1e-9 && Math.abs(d[1] - 0.25) < 1e-9 && d[2] === 0.25);
  assert.ok(Math.abs(dragDivider(v, 1, 5)[1] + dragDivider(v, 1, 5)[2] - 0.6) < 1e-9);
  assert.ok(dragDivider(v, 0, -5)[0] >= 0.12 - 1e-9);
  assert.equal(clampFrac(0.01), 0.12);
});

test("balón al inicio y al final del intervalo, y hora con décima", () => {
  const f = fixed({ n: 20, people: [P(1, "own")], at: (i) => [q(1, i, 5)], ball: Array.from({ length: 20 }, (_, i) => B(i, i * 2, 10)) });
  const parts = [{ file: f, ownRight: true }];
  const e = ballEnds(parts, row({ t_start: 0.2, t_end: 1.5 }));
  assert.ok(e.start && e.end);
  assert.ok(e.end[0] > e.start[0]);
  assert.deepEqual(ballEnds(parts, row({ video_id: "otro" })), { start: null, end: null });
  assert.equal(fmtTd(3723.46), "1:02:03.5");
  assert.equal(fmtTd(59.96), "0:01:00.0");
});
