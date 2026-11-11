import assert from "node:assert/strict";
import { test } from "node:test";
import { rateAll, ratingAdjustments } from "./rating.ts";

const row = (id, o = {}) => ({
  key: `own|${id}`, team: "own", id, tagged: true, events: 10, goals: 0, shots: 0, on_target: 0, key_passes: 0, crosses: 0, box_entries: 0,
  recoveries: 0, losses: 0, duels_won: 0, duels_lost: 0, fouls: 0, minutes: 90, minutes_played: 90, fill_time_pct: 0, fill_dist_pct: 0,
  touches: 50, passes: 40, passes_cut: 10, progressive: 5, distance_m: 9000, per_min_m: 100, top_kmh: 27, hsr_m: 400, sprints: 10, ...o,
});
const ev = (id, t, type, team, extra = {}) => ({ event_id: id, match_id: "m", video_id: "v1", t_video: t, period: 1, type, team, player_id: null, ...extra });

test("la nota es 5 con el promedio del grupo y sube con mejores cifras; muestra de dónde sale", () => {
  const rows = [
    row("A", { passes: 45, passes_cut: 5, progressive: 9, recoveries: 8, key_passes: 3, box_entries: 4, duels_won: 7, duels_lost: 2, losses: 3, hsr_m: 600 }),
    row("B", { passes: 30, passes_cut: 20, progressive: 2, recoveries: 2, key_passes: 0, box_entries: 0, duels_won: 2, duels_lost: 6, losses: 12, hsr_m: 200 }),
    row("C", {}),
    row("D", {}),
  ];
  const r = rateAll(rows, []);
  const a = r.get("own|A");
  const b = r.get("own|B");
  assert.ok(a.score > 5 && b.score < 5, `${a.score} ${b.score}`);
  assert.ok(a.components.length >= 4);
  assert.ok(Math.abs(a.components.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9);
  assert.equal(a.adjust, 0);
});

test("sin minutos suficientes o con pocas métricas no hay nota, y dice por qué", () => {
  const rows = [row("A", { minutes_played: 10, minutes: 10 }), row("B"), row("C"), row("D")];
  const a = rateAll(rows, []).get("own|A");
  assert.equal(a.score, null);
  assert.match(a.reason, /min/);
  const few = [row("A", { tagged: false, progressive: null, passes: null, passes_cut: null, hsr_m: null }), row("B"), row("C"), row("D")];
  assert.equal(rateAll(few, []).get("own|A").score, null);
});

test("descuentos: pérdida + falta que acaban en el mismo gol son una cadena con tope; la roja y lo bueno también cuentan", () => {
  const kere = row("Kere");
  const events = [
    ev("l1", 100, "loss", "own", { player_id: "Kere" }),
    ev("f1", 108, "foul", "own", { player_id: "Kere" }),
    ev("g1", 112, "goal", "opp"),
    ev("r1", 300, "recovery", "own", { player_id: "Kere" }),
    ev("s1", 306, "shot", "own"),
    ev("rd", 500, "foul", "own", { player_id: "Kere", detail: "red" }),
  ];
  const adj = ratingAdjustments(kere, events);
  const chain = adj.filter((a) => a.event_id === "l1" || a.event_id === "f1");
  assert.equal(chain.length, 2);
  assert.ok(chain.reduce((s, a) => s + a.delta, 0) >= -1.5 - 1e-9);
  assert.ok(adj.some((a) => a.delta === 0.2));
  assert.ok(adj.some((a) => a.delta === -1.5 && /roja/.test(a.label)));
  // Otro video no cuenta.
  assert.equal(ratingAdjustments(kere, [ev("l", 100, "loss", "own", { player_id: "Kere" }), ev("g", 105, "goal", "opp", { video_id: "v2" })]).length, 0);
});

test("la nota total queda entre 0 y 10 y los descuentos del partido tienen tope de -3", () => {
  const rows = [row("A"), row("B"), row("C"), row("D")];
  const events = Array.from({ length: 8 }, (_, i) => [ev(`l${i}`, i * 100, "loss", "own", { player_id: "A" }), ev(`g${i}`, i * 100 + 5, "goal", "opp")]).flat();
  const a = rateAll(rows, events).get("own|A");
  assert.ok(a.adjust >= -3 && a.score >= 0);
  assert.equal(a.adjust, -3);
});

test("suman los goles, tiros a puerta, córners, faltas a favor, pase clave a tiro, falta provocada y la pérdida que ella recupera", () => {
  const lelo = row("Lelo");
  const events = [
    ev("g1", 100, "goal", "own", { player_id: "Lelo" }),
    ev("s1", 98, "shot", "own", { player_id: "Lelo", outcome: "on_target" }), // el tiro del gol: no cuenta aparte
    ev("s2", 300, "shot", "own", { player_id: "Lelo", outcome: "on_target" }),
    ev("c1", 400, "corner", "own", { player_id: "Lelo", outcome: "shot" }),
    ev("f1", 500, "free_kick", "own", { player_id: "Lelo" }),
    ev("k1", 600, "key_pass", "own", { player_id: "Lelo" }),
    ev("s3", 604, "shot", "own", { player_id: "Ana" }),
    ev("fp", 700, "foul", "opp", { player_id: "Lelo" }),
    ev("l1", 800, "loss", "own", { player_id: "Lelo" }),
    ev("r1", 804, "recovery", "own", { player_id: "Lelo" }),
  ];
  const adj = ratingAdjustments(lelo, events);
  const total = (label) => adj.filter((a) => a.label === label).reduce((s, a) => s + a.delta, 0);
  assert.equal(total("Gol"), 0.7);
  assert.equal(total("Tiro a puerta"), 0.25); // solo el de fuera del gol
  assert.equal(total("Córner que acaba en remate"), 0.4);
  assert.equal(total("Falta a favor"), 0.1);
  assert.equal(total("Pase clave que acaba en tiro"), 0.3);
  assert.equal(total("Falta provocada"), 0.3);
  assert.equal(total("Pérdida que ella misma recupera"), 0.3);
});

test("la media del grupo ya no es 5: una jugadora normal saca 6", () => {
  const rows = [row("A"), row("B"), row("C"), row("D")];
  assert.equal(rateAll(rows, []).get("own|A").score, 6);
});

test("la secuencia de Kere: pérdida, falta con amarilla, tiro libre del rival 44 s después y gol: una cadena, con tope", () => {
  const kere = row("Kere");
  const events = [
    ev("l", 2215.6, "loss", "own", { player_id: "Kere" }),
    ev("f", 2222.5, "foul", "own", { player_id: "Kere", detail: "yellow" }),
    ev("fk", 2266.47, "free_kick", "opp", { outcome: "shot" }),
    ev("g", 2268.6, "goal", "opp"),
  ];
  const adj = ratingAdjustments(kere, events);
  assert.equal(adj.length, 2);
  assert.ok(adj.every((a) => a.delta < 0));
  assert.ok(Math.abs(adj.reduce((s, a) => s + a.delta, 0) + 1.5) < 0.02, JSON.stringify(adj));
  // Sin la pérdida, solo la falta: −1.0 (gol del tiro libre).
  const soloFalta = ratingAdjustments(kere, events.slice(1));
  assert.deepEqual(soloFalta.map((a) => a.delta), [-1]);
  // Si el tiro libre llega mucho después (más de 90 s), ya no es consecuencia de la falta.
  assert.equal(ratingAdjustments(kere, [events[1], ev("fk", 2400, "free_kick", "opp"), ev("g", 2402, "goal", "opp")]).length, 0);
});

test("un gol sin nombre con el tiro de Zoe es de Zoe: suma el gol, no el tiro a puerta", () => {
  const events = [ev("s", 1443.4, "shot", "own", { player_id: "Zoe", outcome: "on_target" }), ev("g", 1446.5, "goal", "own")];
  const adj = ratingAdjustments(row("Zoe"), events);
  assert.deepEqual(adj.map((a) => [a.label, a.delta]), [["Gol", 0.7]]);
});
