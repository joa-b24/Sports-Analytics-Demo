import assert from "node:assert/strict";
import { test } from "node:test";
import { autoEvents, pending, reviewedStretches } from "./autoEvents.ts";

// Synthetic parts only: 30 fps, one of every 3 frames, pitch of 105 x 68 m (normalised = real).
// `steps`: one entry per processed frame, { ball: [x, y] | null, players: [[id, x, y], ...] }.
const part = (steps, people) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: steps.length * 3, stride: 3, venue: null,
  people: people.map(([id, team, player_id = null]) => ({ id, team, player_id, tracks: [id] })),
  ball: steps.flatMap((s, i) => (s.ball ? [{ frame: i * 3, x: s.ball[0], y: s.ball[1], source: "manual" }] : [])),
  frames: steps.map((s, i) => ({ frame: i * 3, positions: (s.players ?? []).map(([id, x, y]) => ({ id, x, y, source: "auto" })) })),
});
const PEOPLE = [[1, "own", "Ana"], [2, "opp"], [3, "own", "Bea"]];
const all = (steps) => [[0, steps.length * 3]];
// n processed frames with the ball still at p, held by player `who` next to it.
const hold = (n, p, who) => Array.from({ length: n }, () => ({ ball: p, players: who ? [[who, p[0] + 0.5, p[1]]] : [] }));
// n processed frames without ball (not seen).
const none = (n) => Array.from({ length: n }, () => ({ ball: null, players: [] }));
const run = (steps, extra = {}) => autoEvents({ file: part(steps, PEOPLE), ownRight: true, reviewed: all(steps), out: [], ...extra });
const firstEvent = (s) => s.options[0].events[0];

test("balón marcado fuera de la banda: saque de banda del equipo que no lo tocó", () => {
  const steps = [...hold(10, [50, 60], 1), { ball: [50, 66], players: [] }, { ball: [50, 69.5], players: [] }, ...none(10), ...hold(5, [52, 68], 2)];
  const s = run(steps).filter((x) => x.rule === "out_touchline");
  assert.equal(s.length, 1);
  assert.deepEqual([firstEvent(s[0]).type, firstEvent(s[0]).team, firstEvent(s[0]).y], ["throw_in", "opp", 68]);
  assert.equal(s[0].confidence, "high");
});

test("línea de fondo: el lugar donde reaparece decide (área chica, esquina, centro)", () => {
  const before = [...hold(10, [98, 40], 1), { ball: [104, 40], players: [] }];
  const outFrames = () => [(before.length + 2) * 3];
  const kick = [...before, ...none(30), ...hold(5, [101, 34], 2)];
  let s = run(kick, { out: outFrames(kick) }).find((x) => x.rule === "out_goal_line");
  assert.deepEqual([firstEvent(s).type, firstEvent(s).team, s.confidence], ["goal_kick", "opp", "high"]);

  const corner = [...before, ...none(30), ...hold(5, [104.5, 67.5], 3)];
  s = run(corner, { out: outFrames(corner) }).find((x) => x.rule === "out_goal_line");
  assert.deepEqual([firstEvent(s).type, firstEvent(s).team, firstEvent(s).x, firstEvent(s).y], ["corner", "own", 105, 68]);

  const goal = [...before, ...none(30), ...hold(5, [52.5, 34], 2)];
  s = run(goal, { out: outFrames(goal) }).find((x) => x.rule === "out_goal_line");
  assert.deepEqual([firstEvent(s).type, firstEvent(s).team, firstEvent(s).player_id], ["goal", "own", "Ana"]);
});

test("en otro lugar decide el último toque y se pregunta (confianza media)", () => {
  const steps = [...hold(10, [99, 20], 2), { ball: [104, 20], players: [] }, ...none(30), ...hold(5, [95, 25], 1)];
  const s = run(steps, { out: [36] }).find((x) => x.rule === "out_goal_line");
  assert.equal(firstEvent(s).type, "corner");
  assert.equal(s.confidence, "medium");
  assert.deepEqual(s.options.map((o) => o.events[0].type), ["corner", "goal_kick", "goal"]);
});

test("con nosotras atacando a la izquierda en el video, el resultado sale igual (coordenadas del contrato)", () => {
  const mirror = (steps) => steps.map((st) => ({ ball: st.ball && [105 - st.ball[0], 68 - st.ball[1]], players: st.players.map(([id, x, y]) => [id, 105 - x, 68 - y]) }));
  const steps = mirror([...hold(10, [98, 40], 1), { ball: [104, 40], players: [] }, ...none(30), ...hold(5, [101, 34], 2)]);
  const s = autoEvents({ file: part(steps, PEOPLE), ownRight: false, reviewed: all(steps), out: [36] }).find((x) => x.rule === "out_goal_line");
  assert.deepEqual([firstEvent(s).type, firstEvent(s).team], ["goal_kick", "opp"]);
  assert.ok(firstEvent(s).x > 95);
});

test("balón que se deja de ver dentro de la cancha y vuelve al mismo sitio: falta, fuera de lugar o pausa", () => {
  const steps = [...hold(10, [40, 30], 1), ...none(40), ...hold(5, [41, 30], 2)];
  const s = run(steps).find((x) => x.rule === "stoppage");
  assert.deepEqual(s.options.map((o) => o.events.map((e) => `${e.type}:${e.team}`)), [["foul:own", "free_kick:opp"], ["offside:own", "free_kick:opp"], []]);
});

test("vuelve en el punto penal: penal", () => {
  const steps = [...hold(10, [92, 34], 1), ...none(40), ...hold(5, [94, 34], 1)];
  const s = run(steps).find((x) => x.rule === "stoppage");
  assert.equal(firstEvent(s).type, "penalty");
  assert.equal(firstEvent(s).team, "own");
});

test("un hueco corto sin «No se ve» no es una salida (el balón solo se marcó cada tanto)", () => {
  const steps = [...hold(10, [100, 40], 1), ...none(20), ...hold(5, [101, 34], 2)];
  assert.equal(run(steps).filter((x) => x.rule === "out_goal_line").length, 0);
});

test("entrada al último tercio: una sola mientras la conserva", () => {
  const carry = Array.from({ length: 30 }, (_, i) => {
    const x = 60 + i;
    return { ball: [x, 30], players: [[1, x + 0.5, 30]] };
  });
  const s = run(carry).filter((x) => x.rule === "final_third_entry");
  assert.equal(s.length, 1);
  assert.deepEqual([firstEvent(s[0]).team, firstEvent(s[0]).player_id], ["own", "Ana"]);
});

test("si el rival la toca justo después no hay entrada", () => {
  const steps = [...hold(5, [65, 30], 1), { ball: [72, 30], players: [] }, ...hold(5, [74, 30], 2)];
  assert.equal(run(steps).filter((x) => x.rule === "final_third_entry" && firstEvent(x).team === "own").length, 0);
});

test("centro: desde la banda del último tercio hasta el área, más al centro", () => {
  const flight = Array.from({ length: 8 }, (_, i) => ({ ball: [85 + i * 1.5, 5 + i * 3.6], players: [] }));
  const steps = [...hold(5, [85, 5], 1), ...flight, ...hold(5, [97, 34], 3)];
  const s = run(steps).filter((x) => x.rule === "cross");
  assert.equal(s.length, 1);
  const e = firstEvent(s[0]);
  assert.deepEqual([e.team, e.player_id], ["own", "Ana"]);
  assert.ok(e.y_end > 25 && e.x_end > 88);
});

test("cambio de equipo con el balón en juego: pérdida y recuperación", () => {
  const steps = [...hold(5, [50, 30], 1), { ball: [55, 30], players: [] }, ...hold(5, [58, 30], 2)];
  const s = run(steps).find((x) => x.rule === "turnover");
  assert.deepEqual(s.options[0].events.map((e) => `${e.type}:${e.team}`), ["loss:own", "recovery:opp"]);
});

test("fuera de lo revisado no se sugiere nada", () => {
  const steps = [...hold(5, [50, 30], 1), { ball: [55, 30], players: [] }, ...hold(5, [58, 30], 2)];
  assert.equal(run(steps, { reviewed: [] }).length, 0);
});

test("pendientes: sin las rechazadas ni las ya etiquetadas", () => {
  const steps = [...hold(5, [50, 30], 1), { ball: [55, 30], players: [] }, ...hold(5, [58, 30], 2)];
  const s = run(steps);
  const t = s.find((x) => x.rule === "turnover");
  const loss = t.options[0].events[0];
  assert.equal(pending(s, [{ type: "loss", team: "own", t_video: loss.frame / 30 - 1.5, video_id: "v1" }], "v1", 30, []).some((x) => x.id === t.id), false);
  assert.equal(pending(s, [], "v1", 30, [t.id]).some((x) => x.id === t.id), false);
  assert.equal(pending(s, [], "v1", 30, []).some((x) => x.id === t.id), true);
});

test("tramos revisados: cada muestra cubre medio intervalo a cada lado y se unen", () => {
  assert.deepEqual(reviewedStretches([60, 0, 30, 300], 1, 30), [[-15, 75], [285, 315]]);
});

test("mientras el balón espera el saque, los huecos entre marcas no son salidas nuevas", () => {
  const steps = [...hold(10, [98, 40], 1), { ball: [104, 40], players: [] }, ...none(30), ...hold(3, [101, 34], null), ...none(40), ...hold(3, [101.5, 34], null), ...none(40), ...hold(5, [101, 34], 2)];
  const s = run(steps, { out: [36] }).filter((x) => x.rule === "out_goal_line" || x.rule === "stoppage");
  assert.equal(s.length, 1);
  assert.equal(firstEvent(s[0]).type, "goal_kick");
});

test("el balón que van a buscar detrás de la línea no sale dos veces por pisar la línea", () => {
  const behind = [[108, 40], [110, 45], [105.5, 50], [109, 48]].map((p) => ({ ball: p, players: [] }));
  const steps = [...hold(10, [98, 40], 1), { ball: [104, 40], players: [] }, ...behind, ...hold(5, [101, 34], 2)];
  const s = run(steps).filter((x) => x.rule === "out_goal_line");
  assert.equal(s.length, 1);
  assert.equal(firstEvent(s[0]).type, "goal_kick");
});

test("tras ir a buscarlo detrás de la línea, el córner se cobra sobre la esquina", () => {
  const behind = [[108, 60], [106, 66]].map((p) => ({ ball: p, players: [] }));
  const steps = [...hold(10, [99, 50], 2), { ball: [104, 55], players: [] }, ...behind, ...hold(5, [105.3, 68.3], 1), { ball: [100, 60], players: [] }, ...hold(5, [95, 40], 3)];
  const s = run(steps).filter((x) => x.rule === "out_goal_line");
  assert.equal(s.length, 1);
  assert.deepEqual([firstEvent(s[0]).type, firstEvent(s[0]).team], ["corner", "own"]);
});

test("un hueco que no se revisó entero no es una salida", () => {
  const steps = [...hold(10, [102, 40], 1), ...none(60), ...hold(5, [80, 34], 2)];
  const reviewed = [[0, 33], [210, 250]];
  assert.equal(run(steps, { reviewed }).filter((x) => x.rule === "out_goal_line").length, 0);
  assert.equal(run(steps).filter((x) => x.rule === "out_goal_line").length, 1);
});

test("el balón que va y viene en menos de 2 s es un duelo, ganado por quien se lo queda", () => {
  const steps = [...hold(5, [50, 30], 1), ...hold(3, [51, 30], 2), ...hold(3, [51.5, 30], 1), ...hold(10, [55, 30], 1)];
  const s = run(steps);
  assert.equal(s.filter((x) => x.rule === "turnover").length, 0);
  const d = s.find((x) => x.rule === "duel");
  assert.deepEqual(d.options[0].events.map((e) => `${e.type}:${e.team}:${e.outcome}`), ["duel:own:won"]);
  const lost = run([...hold(5, [50, 30], 1), ...hold(3, [51, 30], 2), ...hold(3, [51.5, 30], 1), ...hold(10, [55, 30], 2)]).find((x) => x.rule === "duel");
  assert.deepEqual(lost.options[0].events.map((e) => `${e.type}:${e.team}`), ["duel:own", "loss:own", "recovery:opp"]);
  assert.equal(lost.options[0].events[0].outcome, "lost");
});
