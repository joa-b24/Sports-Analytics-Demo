import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEvents, ruleVersion, paramsFor, EVENT_DEFAULTS, DETECTED_TYPES } from "./eventDetect.ts";

// A synthetic part: 30 fps, a sample every 0.1 s. `ball(t)` -> [x, y] | [x, y, "interpolated"] | null; `who(t)` -> [id, x, y][].
const part = ({ T = 30, t0 = 0, ball, who = () => [], people }) => {
  const n = Math.round(T / 0.1);
  const frames = [];
  const balls = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + i * 0.1;
    const frame = Math.round(t * 30);
    frames.push({ frame, positions: who(t).map(([id, x, y]) => ({ id, x, y, source: "auto" })) });
    const b = ball(t);
    if (b) balls.push({ frame, x: b[0], y: b[1], source: b[2] ?? "manual" });
  }
  return {
    file: { kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: Math.round(t0 * 30), end_frame: Math.round((t0 + T) * 30), stride: 3, people, ball: balls, frames },
    ownRight: true,
  };
};
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const seg = (segment_id, start, end, tipo = "juego") => ({ segment_id, start, end, tipo });
const SEG = { v1: [seg("s1", 0, 30)] };
const row = (o) => ({ video_id: "v1", segment_id: "s1", t_start: 0, t_end: 1, team: "own", first_player: null, last_player: null, kind: "control", flags: { ball_interp: false, player_interp: false, ball_source: "manual", ball_s: {}, notes: [] }, ...o });
const of = (ev, type) => ev.filter((e) => e.type === type);
// 5 + 5 players spread far from every ball point of the tests, standing still.
const still = () => [1, 2, 3, 4, 5].flatMap((k) => [[100 + k, 20 + k * 3, 60], [200 + k, 30 + k * 3, 5]]);
const stillPeople = [1, 2, 3, 4, 5].flatMap((k) => [P(100 + k, "own"), P(200 + k, "opp")]);
// Ball that comes rolling to (x, y), rests until `until`, and leaves for (x2, y2) in one second.
const restBall = (x, y, from, until, x2, y2, before = [x - 8, y]) => (t) => {
  if (t < from) return [before[0] + ((x - before[0]) * t) / from, before[1] + ((y - before[1]) * t) / from];
  if (t <= until) return [x, y];
  const k = Math.min(1, (t - until) / 1);
  return [x + (x2 - x) * k, y + (y2 - y) * k];
};

test("saque de banda: balón detenido en la línea que se reanuda, en la reanudación y con el equipo de quien saca", () => {
  const people = [P(1, "own", "Ana"), ...stillPeople];
  const ball = restBall(40, 0.5, 5, 9, 40, 12);
  const who = () => [[1, 40.5, 1.5], ...still()];
  const ev = detectEvents([part({ ball, who, people })], SEG, []);
  const t = of(ev, "throw_in");
  assert.equal(t.length, 1);
  assert.equal(t[0].team, "own");
  assert.equal(t[0].player, "Ana");
  assert.ok(Math.abs(t[0].t_video - 9) < 0.15, `t=${t[0].t_video}`);
  assert.deepEqual([t[0].x, t[0].y], [40, 0.5]);
  assert.equal(t[0].rule, "restart.throw_in");
  assert.equal(of(ev, "foul").length, 0);
});

test("córner: balón detenido en la esquina; el equipo es el que ataca esa portería; x_end con el primer toque de otra", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), ...stillPeople];
  const ball = (t) => (t < 6 ? [104.4, 0.4] : t < 7 ? [104.4 - 20 * (t - 6), 0.4 + 14 * (t - 6)] : [84.4, 14.4 + 10 * (t - 7)]);
  const who = (t) => [[1, 104.5, 1.2], [2, 84.4, t < 7.5 ? 14.4 : 24.4], ...still()];
  const ev = detectEvents([part({ ball, who, people })], SEG, []);
  const c = of(ev, "corner");
  assert.equal(c.length, 1);
  assert.equal(c[0].team, "own");
  assert.ok(c[0].x > 104 && c[0].y < 1);
  assert.ok(c[0].x_end !== null && c[0].x_end < 90);
  // El mismo balón en la esquina contraria (x = 0) es del rival.
  const ev2 = detectEvents([part({ ball: (t) => (t < 6 ? [0.6, 67.5] : [0.6 + 20 * (t - 6), 67.5 - 10 * (t - 6)]), who: () => still(), people: stillPeople })], SEG, []);
  assert.equal(of(ev2, "corner")[0].team, "opp");
});

test("saque de meta: reposo en el área chica tras salir; con el balón vivo en reposo (portera) no sale", () => {
  const people = [P(1, "own", "Portera"), ...stillPeople];
  const outThen = (t) => (t < 3 ? [-3, 34, "manual"] : t < 7 ? [5, 34] : [5 + 20 * (t - 7), 34]);
  const ev = detectEvents([part({ ball: outThen, who: () => [[1, 4, 34], ...still()], people })], SEG, []);
  const g = of(ev, "goal_kick");
  assert.equal(g.length, 1);
  assert.equal(g[0].team, "own");
  const live = (t) => (t < 3 ? [20 - (t * 15) / 3, 34] : t < 7 ? [5, 34] : [5 + 20 * (t - 7), 34]);
  assert.equal(of(detectEvents([part({ ball: live, who: () => [[1, 4, 34], ...still()], people })], SEG, []), "goal_kick").length, 0);
});

test("saque de centro no es evento", () => {
  const ball = restBall(52.5, 34, 4, 8, 60, 34);
  const ev = detectEvents([part({ ball, who: () => still(), people: stillPeople })], SEG, []);
  assert.equal(ev.length, 0);
});

test("penal: reposo en el punto penal con nadie cerca salvo quien patea; marca también la falta del rival", () => {
  const people = [P(1, "own", "Ana"), ...stillPeople];
  const ball = restBall(94, 34, 4, 9, 104, 34, [80, 34]);
  const who = () => [[1, 93, 34], ...still()];
  const ev = detectEvents([part({ ball, who, people })], SEG, []);
  assert.equal(of(ev, "penalty").length, 1);
  assert.equal(of(ev, "penalty")[0].team, "own");
  const f = of(ev, "foul");
  assert.equal(f.length, 1);
  assert.equal(f[0].team, "opp");
  assert.ok(Math.abs(f[0].t_video - 4) < 0.25);
});

test("pausa con balón quieto: foul al inicio de la pausa y free_kick en la reanudación; jugadoras corriendo: nada", () => {
  const people = [P(1, "opp", "Rita"), ...stillPeople];
  const ball = restBall(60, 30, 4, 10, 70, 30);
  const ev = detectEvents([part({ ball, who: () => [[1, 61, 30], ...still()], people })], SEG, []);
  const fk = of(ev, "free_kick");
  const fl = of(ev, "foul");
  assert.equal(fk.length, 1);
  assert.equal(fk[0].team, "opp");
  assert.ok(Math.abs(fk[0].t_video - 10) < 0.15);
  assert.equal(fl.length, 1);
  assert.equal(fl[0].team, "own");
  assert.ok(Math.abs(fl[0].t_video - 4) < 0.25, `foul en ${fl[0].t_video}`);
  // Contraprueba: todos corren a 4 m/s.
  const run = (t) => [[1, 61, 30], ...still().map(([id, x, y]) => [id, x + 4 * t, y])];
  const ev2 = detectEvents([part({ ball, who: run, people })], SEG, []);
  assert.equal(of(ev2, "free_kick").length + of(ev2, "foul").length, 0);
  // Sin jugadoras seguidas: no se sabe si es pausa, no se inventa.
  const ev3 = detectEvents([part({ ball, who: () => [[1, 61, 30]], people })], SEG, []);
  assert.equal(of(ev3, "free_kick").length, 0);
});

test("balón no medido y luego quieto: el hueco se trata como balón detenido (reposo) con bandera ball_gap", () => {
  const people = [P(1, "opp", "Rita"), ...stillPeople];
  const base = restBall(60, 30, 4, 10, 70, 30);
  // Del 5 al 9 el balón no se ve (interpolado): vuelve en el mismo sitio.
  const ball = (t) => (t > 5 && t < 9 ? [60, 30, "interpolated"] : base(t));
  const ev = detectEvents([part({ ball, who: () => [[1, 61, 30], ...still()], people })], SEG, []);
  assert.equal(of(ev, "free_kick").length, 1);
});

test("pérdida: cualquier cambio de posesión, en el último toque del equipo que la pierde", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp", "Rita"), ...stillPeople];
  const ball = (t) => (t < 4 ? [50 + t, 34] : t < 5 ? [54 + 3 * (t - 4), 34] : [57 + 0.2 * (t - 5), 34]);
  // Ana toca hasta t = 4.0; Rita recibe desde t = 5.2.
  const who = (t) => [[1, t < 4.05 ? 50 + t + 0.3 : 56, t < 4.05 ? 34 : 45], [2, t < 5 ? 66 : 57.2, t < 5 ? 40 : 34.3], ...still()];
  const rows = [row({ t_start: 0, t_end: 4.2 }), row({ t_start: 5.2, t_end: 9, team: "opp" })];
  const ev = detectEvents([part({ ball, who, people })], SEG, rows);
  const l = of(ev, "loss");
  assert.equal(l.length, 1);
  assert.equal(l[0].team, "own");
  assert.equal(l[0].player, "Ana");
  assert.ok(Math.abs(l[0].t_video - 4) < 0.15, `t=${l[0].t_video}`);
  // El mismo equipo dos veces seguidas: ninguna.
  assert.equal(of(detectEvents([part({ ball, who, people })], SEG, [row({ t_start: 0, t_end: 4 }), row({ t_start: 5, t_end: 9 })]), "loss").length, 0);
  // Cambio de posesión a más de 5 s sin reanudación que lo explique: ninguna.
  assert.equal(of(detectEvents([part({ ball, who, people })], SEG, [row({ t_start: 0, t_end: 4.2 }), row({ t_start: 12, t_end: 15, team: "opp" })]), "loss").length, 0);
});

test("pérdida por balón fuera: el rival saca de banda y la pérdida es de quien lo mandó fuera", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp", "Rita"), ...stillPeople];
  const ball = (t) => (t < 3 ? [50 + t, 34 - 10 * t] : t < 5 ? [53, 34 - 10 * 3 + 0 * t] : t < 11 ? [53, 5] : [53, 5 + 12 * (t - 11)]);
  void ball;
  // Sale por la banda y se detiene en (53, 0.4); saca la rival.
  const b = (t) => (t < 3 ? [50 + t, 20 - (19.6 * t) / 3] : t < 9 ? [53, 0.4] : [53, 0.4 + 12 * (t - 9)]);
  const who = (t) => [[1, t < 3 ? 50 + t - 0.5 : 60, t < 3 ? 20 : 30], [2, 53.5, 1.5], ...still()];
  const rows = [row({ t_start: 0, t_end: 3.2 }), row({ t_start: 10.5, t_end: 14, team: "opp" })];
  const ev = detectEvents([part({ ball: b, who, people })], SEG, rows);
  assert.equal(of(ev, "throw_in")[0].team, "opp");
  const l = of(ev, "loss");
  assert.equal(l.length, 1);
  assert.equal(l[0].detail, "sale");
  assert.equal(l[0].team, "own");
});

test("entrada al último tercio y al área: con posesión vigente y sin perderla; no se repite y el rival que toca antes la anula", () => {
  const people = [P(1, "own", "Ana"), ...stillPeople];
  const ball = (t) => [50 + 2.5 * t, 34];
  const who = (t) => [[1, 50 + 2.5 * t - 0.3, 34], ...still()];
  const rows = [row({ t_start: 0, t_end: 30 })];
  const ev = detectEvents([part({ ball, who, people, T: 16 })], { v1: [seg("s1", 0, 16)] }, rows);
  const th = of(ev, "final_third_entry");
  const bx = of(ev, "box_entry");
  assert.equal(th.length, 1);
  assert.ok(Math.abs(th[0].x - 70) < 3, `x=${th[0].x}`);
  assert.equal(bx.length, 1);
  assert.ok(Math.abs(bx[0].x - 88.5) < 3);
  assert.equal(th[0].team, "own");
  // El rival toma el balón a los 2 s del cruce del tercio: no hay entrada al tercio.
  const rows2 = [row({ t_start: 0, t_end: 8.5 }), row({ t_start: 10, t_end: 16, team: "opp" })];
  assert.equal(of(detectEvents([part({ ball, who, people, T: 16 })], { v1: [seg("s1", 0, 16)] }, rows2), "final_third_entry").length, 0);
  // Sin posesión asignada: nada.
  assert.equal(of(detectEvents([part({ ball, who, people, T: 16 })], { v1: [seg("s1", 0, 16)] }, []), "final_third_entry").length, 0);
});

test("la entrada del rival se mide hacia su portería (x = 0)", () => {
  const people = [P(2, "opp", "Rita"), ...stillPeople];
  const ball = (t) => [55 - 2.5 * t, 34];
  const ev = detectEvents([part({ ball, who: (t) => [[2, 55 - 2.5 * t + 0.3, 34], ...still()], people, T: 14 })], { v1: [seg("s1", 0, 14)] }, [row({ t_start: 0, t_end: 20, team: "opp" })]);
  const th = of(ev, "final_third_entry");
  assert.equal(th.length, 1);
  assert.equal(th[0].team, "opp");
  assert.ok(Math.abs(th[0].x - 35) < 3);
});

test("centro: del carril exterior al central; del interior también, con otro detalle; paralelo a la banda o dentro del área no", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), ...stillPeople];
  const cross = (y0, x0, y1, x1) => (t) => (t < 2 ? [x0, y0] : t < 3.5 ? [x0 + ((x1 - x0) * (t - 2)) / 1.5, y0 + ((y1 - y0) * (t - 2)) / 1.5] : [x1, y1]);
  const run = (y0, x0, y1, x1) => {
    const ball = cross(y0, x0, y1, x1);
    return detectEvents([part({ ball, who: (t) => [[1, x0 - 0.5, y0], [2, x1, t < 3.4 ? y1 + 1.5 : y1 + 0.5], ...still()], people, T: 8 })], { v1: [seg("s1", 0, 8)] }, []);
  };
  const ext = of(run(4, 85, 33, 95), "cross");
  assert.equal(ext.length, 1);
  assert.equal(ext[0].detail, "exterior");
  assert.ok(ext[0].x_end > 90 && Math.abs(ext[0].y_end - 34) <= 7);
  const inter = of(run(20, 80, 33, 95), "cross");
  assert.equal(inter.length, 1);
  assert.equal(inter[0].detail, "interior");
  assert.equal(of(run(4, 85, 4, 95), "cross").length, 0);
  assert.equal(of(run(20, 92, 33, 100), "cross").length, 0);
  // Una conducción de la misma jugadora hacia el centro no es centro.
  const drib = detectEvents([part({ ball: (t) => [85 + t, 4 + 4 * t], who: (t) => [[1, 85 + t - 0.5, 4 + 4 * t], ...still()], people, T: 8 })], { v1: [seg("s1", 0, 8)] }, []);
  assert.equal(of(drib, "cross").length, 0);
});

test("unión de segmentos: el córner por cobrar al inicio del segmento siguiente se reconoce y no genera pérdida ni cambio de posesión", () => {
  const people = [P(1, "own", "Ana"), P(2, "opp", "Rita"), ...stillPeople];
  // Primer tramo (0-10): el balón sale por la línea de fondo tras un tiro. Segundo (20-40): córner por cobrar.
  const ball = (t) => (t < 10 ? [90 + t * 1.4, 34 - t * 0.5] : t < 20 ? null : t < 25 ? [104.4, 0.4] : [104.4 - 10 * (t - 25), 0.4 + 10 * (t - 25)]);
  const who = (t) => [[1, t < 10 ? 90 + t * 1.4 - 0.4 : 104, t < 10 ? 34 - t * 0.5 : 1.5], ...still()];
  const rows = [row({ t_start: 0, t_end: 9 }), row({ t_start: 27, t_end: 33, team: "opp" })];
  const ev = detectEvents([part({ ball, who, people, T: 40 })], { v1: [seg("s1", 0, 10), seg("s2", 10, 10.5, "pausa"), seg("s3", 20, 40)] }, rows);
  const c = of(ev, "corner");
  assert.equal(c.length, 1);
  assert.ok(c[0].flags.includes("from_cut"));
  assert.equal(c[0].confidence, "medium");
  assert.equal(of(ev, "loss").length, 0);
  assert.equal(of(ev, "foul").length, 0);
});

test("tiro libre al inicio de un segmento: la falta se marca al final del anterior", () => {
  const people = [P(1, "opp", "Rita"), ...stillPeople];
  const ball = (t) => (t < 10 ? [50 + t, 30] : t < 20 ? null : t < 26 ? [60, 30] : [60 + 10 * (t - 26), 30]);
  const ev = detectEvents([part({ ball, who: () => [[1, 61, 30], ...still()], people, T: 40 })], { v1: [seg("s1", 0, 10), seg("s2", 10, 20, "pausa"), seg("s3", 20, 40)] }, []);
  const fk = of(ev, "free_kick");
  const fl = of(ev, "foul");
  assert.equal(fk.length, 1);
  assert.ok(fk[0].flags.includes("from_cut"));
  assert.equal(fl.length, 1);
  assert.equal(fl[0].team, "own");
  assert.ok(fl[0].t_video > 9 && fl[0].t_video <= 10);
  assert.ok(fl[0].flags.includes("cut_stop"));
});

test("versión de la regla: cambia solo si cambia un parámetro que afecta a ese tipo", () => {
  const d = EVENT_DEFAULTS;
  assert.equal(ruleVersion("cross", d), ruleVersion("cross", paramsFor({ cornerM: d.cornerM })));
  assert.notEqual(ruleVersion("cross", d), ruleVersion("cross", paramsFor({ crossLateralM: 12 })));
  assert.equal(ruleVersion("box_entry", d), ruleVersion("box_entry", paramsFor({ crossLateralM: 12 })));
  assert.notEqual(ruleVersion("corner", d), ruleVersion("throw_in", d));
  assert.equal(DETECTED_TYPES.length, 10);
  const ev = detectEvents([part({ ball: restBall(40, 0.5, 5, 9, 40, 12), who: () => still(), people: stillPeople })], SEG, [], { lineBandM: 1.5 });
  assert.equal(of(ev, "throw_in")[0].rule_version, ruleVersion("throw_in", d));
});
