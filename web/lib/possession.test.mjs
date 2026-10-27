import assert from "node:assert/strict";
import { test } from "node:test";
import { ballJumpFrames, autoBallChecked } from "./parts.ts";
import { ballReport, touches } from "./positions.ts";
import { AUTO_WARN_SHARE, parsePossessionCsv, possessionCellsOf, possessionCsv, possessionIntervals, summarizePossession, suspectBoxes, autoWarning } from "./possession.ts";

// A corrected part: 30 fps, one of every 3 frames (0.1 s per step).
const fixed = ({ n = 10, start = 0, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: start, end_frame: start + n * 3, stride: 3,
  people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: start + i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });
const B = (i, x, y, source = "manual") => ({ frame: i * 3, x, y, source });
const parts = (f) => [{ file: f, ownRight: true }];
const NS = { stillS: 1e9 }; // tests that hold a fixed ball on purpose
const seg = (segment_id, start, end, tipo = "juego") => ({ segment_id, start, end, tipo });
const total = (r, team) => r.samples.filter((s) => s.team === team).reduce((a, s) => a + s.t1 - s.t0, 0);

test("diagnóstico: balón fijo, propia con nombre a 5 m, rival a 1.5 m y una caja sin equipo a 0.5 m: sin dueño", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp"), P(3, "unk")];
  const at = () => [q(1, 55, 34), q(2, 51.5, 34), q(3, 50, 34.5)];
  const ball = Array.from({ length: 200 }, (_, i) => B(i, 50, 34));
  const f = fixed({ n: 200, people, at, ball });
  // Before the fix the unk box was skipped and the rival at 1.5 m took the ball.
  assert.deepEqual(touches(f), []);
  const r = possessionIntervals(parts(f), {}, NS);
  assert.equal(total(r, "own"), 0);
  assert.equal(total(r, "opp"), 0);
  assert.ok(r.rows.every((x) => x.team === "none" && x.kind === "unknown" && x.flags.notes.includes("blocked")));
  // Without the unk box the rival has it, and with a duplicate box of the rival (unk 0.4 m from her) too.
  const f2 = fixed({ n: 200, people: people.slice(0, 2), at: () => [q(1, 55, 34), q(2, 51.5, 34)], ball });
  assert.equal(touches(f2).length, 200);
  const f3 = fixed({ n: 200, people, at: () => [q(1, 55, 34), q(2, 51.5, 34), q(3, 51.5, 34.4)], ball });
  assert.equal(touches(f3).length, 200);
  const r3 = possessionIntervals(parts(f3), {}, NS);
  assert.ok(Math.abs(total(r3, "opp") - 20) < 1e-6);
  assert.equal(r3.rows[0].kind, "control");
});

test("racha del balón automático con un salto de 50 m: ni toque ni segundos de posesión", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  // Ana has the ball (auto) except for three positions 50 m away, right on the rival.
  const ball = Array.from({ length: 30 }, (_, i) => (i >= 12 && i < 15 ? B(i, 70, 30, "auto") : B(i, 20.5, 30, "auto")));
  const f = fixed({ n: 30, people, at, ball });
  assert.deepEqual([...ballJumpFrames(f.ball, 30)].sort((a, b) => a - b), [36, 39, 42]);
  assert.ok(!touches(f).some((t) => t.team === "opp"));
  const r = possessionIntervals(parts(f), {});
  assert.equal(total(r, "opp"), 0);
  const jumpSamples = r.samples.filter((s) => s.notes.includes("ball_jump"));
  assert.equal(jumpSamples.length, 3);
  assert.ok(jumpSamples.every((s) => s.team === "none" && s.kind === "unknown"));
  // A run that lasts (more than a second) is kept: it may be the real ball.
  const longRun = Array.from({ length: 30 }, (_, i) => (i >= 15 ? B(i, 70, 30, "auto") : B(i, 20.5, 30, "auto")));
  assert.equal(ballJumpFrames(longRun, 30).size, 0);
});

test("autoBallChecked: quita la racha con salto y lo que cae en la caja de un árbitro", () => {
  const box = (track, x1, y1, x2, y2, team, lab) => [track, x1, y1, x2, y2, 0.9, ...lab, 0, 0, true, team, track];
  const frames = Array.from({ length: 12 }, (_, i) => ({
    frame: i * 30,
    H: [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1],
    boxes: [box(1, 100, 100, 140, 200, "own", [200, 128, 128]), box(2, 300, 100, 340, 200, "ref", [100, 150, 150])],
  }));
  const file = { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 360, stride: 3, image_w: 1920, image_h: 1080, venue: { length_m: 105, width_m: 68 }, frames };
  const auto = { frames: [{ frame: 0, px: 320, py: 150, p: 0.99 }, { frame: 30, px: 120, py: 150, p: 0.99 }, { frame: 60, px: 300, py: 250, p: 0.99 }], ask: [] };
  const r = autoBallChecked(file, auto, { key: "k", identity: {}, people: {}, removed: [], splits: [], manual: [], dropped: [] });
  assert.deepEqual(r.dropped, [{ frame: 0, reason: "ref_box" }]);
  assert.deepEqual(r.kept.map((p) => p.frame), [30, 60]);
  const noCheck = autoBallChecked(file, auto, { key: "k", identity: {}, people: {}, removed: [], splits: [], manual: [], dropped: [] }, false);
  assert.equal(noCheck.kept.length, 3);
});

test("cortes de segmento unidos: un solo intervalo con joined_cut; si el balón está lejos, se reinicia", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea")];
  const at = () => [q(1, 20, 30), q(2, 80, 30)];
  const segs = { v1: [seg("s01", 0, 3), seg("s02", 5, 8)] };
  // Ana keeps the ball through the cut (video seconds 3-5 skipped).
  const ball = Array.from({ length: 80 }, (_, i) => B(i, 20.5, 30));
  const f = fixed({ n: 80, people, at, ball });
  const r = possessionIntervals(parts(f), segs, NS);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, "control");
  assert.equal(r.rows[0].segment_id, "s01");
  assert.ok(r.rows[0].flags.notes.includes("joined_cut"));
  assert.ok(Math.abs(r.rows[0].t_end - r.rows[0].t_start - 6) > 0 && r.rows[0].t_start === 0);
  assert.ok(Math.abs(total(r, "own") - 6) < 1e-6); // 3 + 3 s of play, not the 2 s skipped
  // After the cut the ball is 60 m away (with Bea): the state restarts, two intervals, and the hold is not carried.
  const far = Array.from({ length: 80 }, (_, i) => (i < 30 ? B(i, 20.5, 30) : B(i, 80.5, 30)));
  const r2 = possessionIntervals(parts(fixed({ n: 80, people, at, ball: far })), segs, NS);
  assert.equal(r2.rows.length, 2);
  assert.ok(r2.rows[1].flags.notes.includes("cut_reset"));
  assert.equal(r2.rows[1].segment_id, "s02");
  // Not joining: also two.
  const r3 = possessionIntervals(parts(f), segs, { joinSegments: false, stillS: 1e9 });
  assert.equal(r3.rows.length, 2);
  // The 5 s hold does not reach across a reset: ball free after Ana's control in s01, new ball elsewhere free in s02.
  const free = Array.from({ length: 80 }, (_, i) => (i < 25 ? B(i, 20.5, 30) : i < 30 ? B(i, 24, 30) : B(i, 60, 10)));
  const r4 = possessionIntervals(parts(fixed({ n: 80, people, at, ball: free })), segs, NS);
  assert.ok(r4.samples.filter((s) => s.t0 >= 5).every((s) => s.team === "none"));
});

test("un balón interpolado lleva la bandera; solo interpolado no es control medido", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  const mixed = Array.from({ length: 20 }, (_, i) => B(i, 20.5, 30, i < 10 ? "manual" : "interpolated"));
  const r = possessionIntervals(parts(fixed({ n: 20, people, at, ball: mixed })), {});
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, "control");
  assert.equal(r.rows[0].flags.ball_interp, true);
  assert.equal(r.rows[0].flags.ball_source, "mixed");
  assert.ok(Math.abs(r.rows[0].flags.ball_s.interp - 1) < 1e-9 && Math.abs(r.rows[0].flags.ball_s.manual - 1) < 1e-9);
  // Only interpolated: the team is credited but kind is unknown (no measured touch behind it).
  const onlyInterp = Array.from({ length: 20 }, (_, i) => B(i, 20.5, 30, "interpolated"));
  const r2 = possessionIntervals(parts(fixed({ n: 20, people, at, ball: onlyInterp })), {});
  // PG-6: no measured contact, no credit: no team, out of the percentage.
  assert.equal(r2.rows[0].team, "none");
  assert.equal(r2.rows[0].kind, "unknown");
  assert.ok(r2.rows[0].flags.notes.includes("no_measured_touch"));
  assert.equal(r2.rows[0].flags.ball_source, "interp");
  // A player at an interpolated position holds it, with her flag.
  const r3 = possessionIntervals(parts(fixed({ n: 20, people, at: () => [q(1, 20, 30, "interpolated"), q(2, 70, 30)], ball: mixed.map((b) => ({ ...b, source: "manual" })) })), {});
  // PG-6: a box that was never measured is not a measured contact: no credit.
  assert.equal(r3.rows[0].team, "none");
  assert.equal(r3.rows[0].kind, "unknown");
  assert.ok(r3.rows[0].flags.notes.includes("no_measured_touch"));
  // Interpolated for the first second, measured afterwards: the control is credited and keeps the flag for those samples.
  const r3b = possessionIntervals(parts(fixed({ n: 20, people, at: (i) => [q(1, 20, 30, i < 10 ? "interpolated" : "auto"), q(2, 70, 30)], ball: mixed.map((b) => ({ ...b, source: "manual" })) })), {});
  assert.equal(r3b.rows[0].team, "own");
  assert.equal(r3b.rows[0].flags.player_interp, true);
  const s = summarizePossession(r3b.samples, false);
  assert.ok(Math.abs(s.assigned_player_interp_s - 1) < 1e-9);
  assert.ok(Math.abs(s.measured.own - 1) < 1e-9);
});

test("un toque corto no es control; el balón rápido que pasa tampoco", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  // 0.2 s near Ana (2 samples; the default control time is 0.3 s), then away.
  const ball = Array.from({ length: 30 }, (_, i) => (i >= 10 && i < 12 ? B(i, 20.5, 30) : B(i, 20.5 + (i < 10 ? -(10 - i) * 4 : (i - 11) * 4), 30)));
  const r = possessionIntervals(parts(fixed({ n: 30, people, at, ball })), {});
  assert.equal(total(r, "own"), 0);
  assert.ok(r.samples.some((s) => s.notes.includes("short_touch")));
  // Shorter windows can be calibrated.
  const r2 = possessionIntervals(parts(fixed({ n: 30, people, at, ball })), {}, { controlS: 0.1, maxCtrlSpeedMs: 100 });
  assert.ok(total(r2, "own") > 0);
});

test("posesión: se mantiene 5 s tras el último control y luego queda suelta; el rival la cambia", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  // Ana 1 s, then the ball drifts away slowly for 9 s, then the rival 1 s.
  const ball = Array.from({ length: 110 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 100 ? B(i, 24 + (i - 10) * 0.3, 30 + ((i % 2) * 8 - 4)) : B(i, 70.5, 30)));
  const r = possessionIntervals(parts(fixed({ n: 110, people, at, ball })), {});
  const own = total(r, "own");
  // PG-6: the 9 s of drift end in a control of the rival, so nobody had them (flight_lost): only Ana's 1 s.
  assert.ok(own > 0.9 && own < 1.2, String(own));
  assert.ok(total(r, "opp") > 0.9);
  assert.ok(r.rows.some((x) => x.kind === "loose" && x.team === "none"));
  // Without the rival's control, the team keeps it holdS after her last measured touch (3 s; 5 s if asked).
  const noEnd = ball.map((b, i) => (i < 100 ? b : B(i, 40, 55)));
  assert.ok(Math.abs(total(possessionIntervals(parts(fixed({ n: 110, people, at, ball: noEnd })), {}), "own") - 4) < 0.15);
  assert.ok(total(possessionIntervals(parts(fixed({ n: 110, people, at, ball: noEnd })), {}, { holdS: 5 }), "own") > 5.9);
});

test("resumen por fuente y aviso cuando domina el balón automático", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  const ball = Array.from({ length: 40 }, (_, i) => (i < 30 ? B(i, 20.5, 30, "auto") : B(i, 70.5, 30, "manual")));
  const r = possessionIntervals(parts(fixed({ n: 40, people, at, ball })), {});
  const s = summarizePossession(r.samples);
  assert.ok(Math.abs(s.by_source.auto.own - 3) < 1e-9 && Math.abs(s.by_source.manual.opp - 1) < 1e-9);
  assert.ok(s.auto_share > AUTO_WARN_SHARE && s.auto_dominant);
  assert.match(autoWarning(s), /tracker/);
  assert.equal(s.pct_own, 0.75);
  const cells = possessionCellsOf(r.samples);
  assert.equal(cells.size * 0.5, 4);
});

test("el informe lee la posesión del motor: suma el tiempo seguido", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  const ball = Array.from({ length: 40 }, (_, i) => (i < 30 ? B(i, 20.5, 30) : B(i, 70.5, 30)));
  const f = fixed({ n: 40, people, at, ball });
  const r = possessionIntervals(parts(f), {});
  const rep = ballReport(parts(f), {}, [], possessionCellsOf(r.samples));
  assert.equal(rep.followed_s, 4);
  assert.deepEqual(rep.possession, { own: 3, opp: 1, unassigned: 0 });
});

test("CSV de la tabla: ida y vuelta", () => {
  const people = [P(1, "own", "Ana, la 9"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 70, 30)];
  const ball = Array.from({ length: 20 }, (_, i) => B(i, 20.5, 30, i < 10 ? "manual" : "interpolated"));
  const r = possessionIntervals(parts(fixed({ n: 20, people, at, ball })), {});
  const text = possessionCsv(r.rows, "v1");
  assert.match(text.split("\n")[0], /^video_id,segment_id,t_start,t_end,team,first_player,last_player,kind,flags$/);
  const back = parsePossessionCsv(text);
  assert.equal(back.length, r.rows.length);
  assert.equal(back[0].first_player, "Ana, la 9");
  assert.equal(back[0].flags.ball_interp, true);
  assert.equal(back[0].kind, "control");
  assert.deepEqual(parsePossessionCsv("nada"), []);
});

test("cajas sospechosas: rival con camiseta como la nuestra y caja sin equipo junto al balón, con su efecto", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp"), P(3, "unk"), P(4, "opp")];
  // Rival 2 holds the ball for 3 s, then the ball sits next to an unk box for 2 s.
  const at = (i) => [q(1, 40, 10), q(2, 50, 34), i < 30 ? q(3, 90, 60) : q(3, 70, 34.5), q(4, 85, 5)];
  const ball = Array.from({ length: 50 }, (_, i) => (i < 30 ? B(i, 50.5, 34) : B(i, 70, 34)));
  const f = fixed({ n: 50, people, at, ball });
  const lab = { 1: [220, 128, 128], 2: [215, 130, 128], 3: [128, 128, 128], 4: [40, 128, 128] };
  const res = suspectBoxes(parts(f), {}, {
    teamLab: { own: [220, 128, 128], opp: [40, 128, 128] },
    labOf: (_v, _p, id) => lab[id] ?? null,
  });
  const r2 = res.find((s) => s.person_id === 2);
  assert.equal(r2.reason, "opp_like_own");
  assert.equal(r2.team, "opp");
  assert.ok(Math.abs(r2.influence_s - 3) < 1e-6);
  assert.equal(r2.t, 0);
  // Taken as ours, 3 s move from the rival to us.
  assert.equal(r2.effect_if.own.opp, -3);
  assert.equal(r2.effect_if.own.own, 3);
  const r3 = res.find((s) => s.person_id === 3);
  assert.equal(r3.reason, "unk_near_ball");
  assert.ok(r3.influence_s >= 2);
  assert.ok("own" in r3.effect_if && "opp" in r3.effect_if && "none" in r3.effect_if);
  // Without colour data the colour reason is not checked, and the result says it by being absent.
  const noColor = suspectBoxes(parts(f), {}, {});
  assert.ok(!noColor.some((s) => s.reason === "opp_like_own"));
});

// ---------------------------------------------------------------------------------------------- PG-6
test("PG-6 regla 1: un hueco lento del balón es una pausa (dead, restart_gap); uno rápido es un vuelo", () => {
  const people = [P(1, "own", "Ana")];
  const at = () => [q(1, 20, 30)];
  // Ana 1 s (hand marks), 8 s with no ball seen (interpolated, 1.2 m/s in a straight line), then a mark far from her.
  const slow = Array.from({ length: 100 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 90 ? B(i, 20.5 + (i - 10) * 0.12, 30, "interpolated") : B(i, 30.5, 30)));
  const r = possessionIntervals(parts(fixed({ n: 100, people, at, ball: slow })), {});
  const gap = r.samples.filter((s) => s.t0 >= 1 && s.t1 <= 9);
  assert.ok(gap.length > 70 && gap.every((s) => s.kind === "dead" && s.team === "none" && s.notes.includes("restart_gap")));
  assert.ok(total(r, "own") < 1.2);
  // The same hole crossed at 10 m/s is a flight: no restart.
  const fast = Array.from({ length: 100 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 90 ? B(i, 20.5 + (i - 10) * 1.0, 30, "interpolated") : B(i, 100.5, 30)));
  const r2 = possessionIntervals(parts(fixed({ n: 100, people, at, ball: fast })), {});
  assert.ok(!r2.samples.some((s) => s.notes.includes("restart_gap")));
  // A hole of 2 s or less is never a restart, however slow.
  const short = Array.from({ length: 40 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 26 ? B(i, 20.5, 30, "interpolated") : B(i, 20.6, 30)));
  assert.ok(!possessionIntervals(parts(fixed({ n: 40, people, at, ball: short })), {}).samples.some((s) => s.notes.includes("restart_gap")));
  // The thresholds are parameters.
  const r3 = possessionIntervals(parts(fixed({ n: 100, people, at, ball: slow })), {}, { restFlightMinMs: 0.5 });
  assert.ok(!r3.samples.some((s) => s.notes.includes("restart_gap")));
});

test("PG-6 regla 2: el vuelo se acredita al equipo del siguiente control medido si es el mismo; si no, queda suelto", () => {
  const ball = Array.from({ length: 80 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 70 ? B(i, 20.5 + (i - 10) * 1.0, 30, "interpolated") : B(i, 80.5, 30)));
  // To a teammate: the 6 s of flight (longer than holdS, no cap) are hers.
  const own = possessionIntervals(parts(fixed({ n: 80, people: [P(1, "own", "Ana"), P(2, "own", "Bea")], at: () => [q(1, 20, 30), q(2, 80, 30)], ball })), {});
  assert.ok(Math.abs(total(own, "own") - 8) < 1e-6, String(total(own, "own")));
  assert.ok(own.samples.some((s) => s.notes.includes("flight_confirmed")));
  assert.ok(own.rows.every((x) => x.team === "own" && x.kind === "control"));
  // To a rival: nobody had the flight (loose), the change happens at the rival's control.
  const lost = possessionIntervals(parts(fixed({ n: 80, people: [P(1, "own", "Ana"), P(2, "opp")], at: () => [q(1, 20, 30), q(2, 80, 30)], ball })), {});
  const fl = lost.samples.filter((s) => s.t0 >= 2 && s.t1 <= 6);
  assert.ok(fl.every((s) => s.team === "none" && s.kind === "loose" && s.notes.includes("flight_lost")));
  // Her control (1 s of marks plus the interpolated steps still within 2 m of her) and the rival's, nothing in between.
  assert.ok(total(lost, "own") >= 1 && total(lost, "own") < 1.5, String(total(lost, "own")));
  assert.ok(total(lost, "opp") >= 1 && total(lost, "opp") < 1.5, String(total(lost, "opp")));
});

test("PG-6 regla 2: sin control posterior, la posesión se sostiene holdS tras el último toque medido y solo sobre balón medido", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 20, 30), q(2, 90, 5)];
  const measured = Array.from({ length: 100 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : B(i, 24 + (i - 10) * 0.3, 30 + ((i % 2) * 8 - 4))));
  const a = possessionIntervals(parts(fixed({ n: 100, people, at, ball: measured })), {});
  assert.ok(Math.abs(total(a, "own") - 4) < 0.15, String(total(a, "own")));
  // Interpolated ball after the control: nothing to hold on to.
  const interp = measured.map((b, i) => (i < 10 ? b : { ...b, source: "interpolated" }));
  const b = possessionIntervals(parts(fixed({ n: 100, people, at, ball: interp })), {});
  assert.ok(Math.abs(total(b, "own") - 1) < 0.15, String(total(b, "own")));
});

test("PG-6 regla 3: dos cajas de equipos distintos casi igual de cerca son disputa y entran a la cola de dudas con su efecto", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp"), P(3, "opp")];
  // Ana holds the ball alone for 2 s; then a rival stands about as near (ball between them) for 2 s; then Ana alone again.
  const at = (i) => [q(1, 20, 30), i >= 20 && i < 40 ? q(2, 20, 31.2) : q(2, 70, 30), q(3, 90, 5)];
  const ball = Array.from({ length: 60 }, (_, i) => B(i, 20, i >= 20 && i < 40 ? 30.55 : 30.3));
  const r = possessionIntervals(parts(fixed({ n: 60, people, at, ball })), {}, NS);
  const c = r.samples.filter((s) => s.kind === "contested");
  assert.equal(c.length, 20);
  assert.ok(c.every((s) => s.contest && s.contest.margin < 0.5 && s.contest.a.team !== s.contest.b.team));
  const res = suspectBoxes(parts(fixed({ n: 60, people, at, ball })), {}, { params: NS });
  const d = res.find((x) => x.reason === "contested_pair");
  assert.ok(d, "no doubt in the queue");
  assert.ok(Math.abs(d.influence_s - 2) < 1e-6 && d.t === 2);
  assert.ok(d.box && d.other && d.box.team !== d.other.team && d.margin_m < 0.5);
  assert.ok("own" in d.effect_if && "opp" in d.effect_if);
});

test("PG-6: resumen con cobertura (tiempo vivo con dueño respaldado por un contacto medido)", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 80, 30), q(3, 60, 10)];
  const ball = Array.from({ length: 100 }, (_, i) => (i < 10 ? B(i, 20.5, 30) : i < 70 ? B(i, 20.5 + (i - 10) * 1.0, 30, "interpolated") : i < 80 ? B(i, 80.5, 30) : B(i, 60, 40, "interpolated")));
  const r = possessionIntervals(parts(fixed({ n: 100, people, at, ball })), {});
  const s = summarizePossession(r.samples);
  assert.ok(s.coverage > 0.7 && s.coverage <= 1);
  assert.ok(s.contact_s > 0 && s.contact_s < s.alive_s && s.contact_coverage < s.coverage);
  assert.equal(s.pct_own, 1);
});

test("PG-6: regresión con la revisión de la analista (possession_review_v1.json), si hay datos locales", async (t) => {
  const fs = await import("node:fs");
  const dir = new URL("../../matches/2026_09_25_tec_ccm_vs_anahuac/", import.meta.url);
  const review = new URL("possession_review_v1.json", dir);
  const files = fs.existsSync(new URL("tracking/", dir)) ? fs.readdirSync(new URL("tracking/", dir)).filter((n) => n.startsWith("tracks_fixed_v1_") && n.endsWith(".json")) : [];
  if (!fs.existsSync(review) || files.length === 0) return t.skip("sin possession_review_v1.json o tracks_fixed_v1_*.json: la regresión necesita los datos del partido");
  const { parseFixed, inferOwnAttacksRight } = await import("./positions.ts");
  const { parseHms } = await import("./segments.ts");
  const fx = files.sort().map((n) => parseFixed(fs.readFileSync(new URL(`tracking/${n}`, dir), "utf8")));
  const yaml = fs.readFileSync(new URL("match.yaml", dir), "utf8");
  const len = Number(yaml.match(/pitch_length_m:\s*([0-9.]+)/)?.[1]);
  const wid = Number(yaml.match(/pitch_width_m:\s*([0-9.]+)/)?.[1]);
  const own = inferOwnAttacksRight(fx) ?? true;
  const ps = fx.map((f) => ({ file: f.venue ? f : { ...f, venue: { length_m: len, width_m: wid } }, ownRight: own }));
  const lines = fs.readFileSync(new URL("segments.csv", dir), "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  const segs = { v1: [] };
  for (const l of lines.slice(1)) {
    const v = l.split(",");
    const row = Object.fromEntries(head.map((h, i) => [h, v[i]]));
    if (row.video_id === "v1" && (row.tipo === "juego" || row.tipo === "pausa")) segs.v1.push({ segment_id: row.segment_id, start: parseHms(row.start), end: parseHms(row.end), tipo: row.tipo });
  }
  const r = possessionIntervals(ps, segs, { controlS: 0.3 });
  const rev = JSON.parse(fs.readFileSync(review, "utf8")).reviews;
  const inside = (x) => r.samples.filter((s) => s.t0 >= x.t_start - 1e-6 && s.t1 <= x.t_end + 1e-6);
  const credited = (x, team) => {
    const ins = inside(x);
    const dur = ins.reduce((a, s) => a + s.t1 - s.t0, 0) || 1;
    return ins.filter((s) => s.team === team && s.kind === "control").reduce((a, s) => a + s.t1 - s.t0, 0) / dur;
  };
  const shares = rev.filter((x) => x.verdict === "incorrect" && x.team === "opp").map((x) => credited(x, "opp"));
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  // Documented limit: a rival touch measured inside the interval is still credited, and pauses with a measured ball at
  // rest next to a player are not detected yet, so this is a ceiling (they were ~100 % credited before), not zero.
  assert.ok(mean < 0.4, `mean credited share ${mean.toFixed(2)}`);
  // The ones the analyst confirmed (1 s or more) keep their team and kind (loose may come out as none in either).
  for (const x of rev.filter((y) => y.verdict === "correct" && y.t_end - y.t_start >= 1)) {
    const ins = inside(x);
    const dur = ins.reduce((a, s) => a + s.t1 - s.t0, 0) || 1;
    const same = ins.filter((s) => s.team === x.team && (s.kind === x.kind || x.kind === "loose")).reduce((a, s) => a + s.t1 - s.t0, 0) / dur;
    assert.ok(same >= 0.6, `confirmed interval ${x.t_start.toFixed(1)} ${x.team}/${x.kind} kept only ${same.toFixed(2)}`);
  }
});

test("PG-6: balón quieto a mano 8 s con una jugadora a 1 m es dead, sin equipo y sin crédito; con balón en juego sí hay control", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp")];
  const at = () => [q(1, 50, 35), q(2, 90, 5)];
  const still = Array.from({ length: 80 }, (_, i) => B(i, 50 + (i % 2) * 0.3, 34));
  const r = possessionIntervals(parts(fixed({ n: 80, people, at, ball: still })), {});
  assert.ok(r.samples.every((s) => s.kind === "dead" && s.team === "none"));
  assert.equal(total(r, "own"), 0);
  assert.equal(summarizePossession(r.samples).contact_s, 0);
  // Held with «quieto»: a mark, a straight line at rest (interpolated) and a mark at the same spot: same result.
  const held = Array.from({ length: 80 }, (_, i) => (i === 0 || i === 79 ? B(i, 50, 34) : B(i, 50, 34, "interpolated")));
  const r2 = possessionIntervals(parts(fixed({ n: 80, people, at, ball: held })), {});
  assert.ok(r2.samples.every((s) => s.kind === "dead" && s.team === "none"));
  // A 2 s stop is not a restart.
  const brief = Array.from({ length: 30 }, (_, i) => B(i, 50, 34));
  assert.ok(possessionIntervals(parts(fixed({ n: 30, people, at, ball: brief })), {}).samples.some((s) => s.team === "own"));
});
