import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, clipList, dataLevel, normalizeReport, recentResults, scoreOf } from "./report.ts";
import { laneThirdOf, zoneGrid5x3 } from "./stats.ts";
import { EMPTY_REPORT, EVENT_DETAILS, EVENT_KEYS, EVENT_OUTCOMES, EVENT_TYPES } from "./types.ts";

// Synthetic data only: no real players or teams.
let n = 0;
const ev = (t_video, type, team, extra = {}) => ({
  event_id: `e${n++}`, match_id: "m1", video_id: "v1", t_video, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, detail: null, note: null, ...extra,
});
const match = (extra = {}) => ({
  match_id: "m1", name: "Equipo A vs Equipo B", kind: "own", date: "2026-10-10", focus_team: "Equipo A", other_team: "Equipo B",
  youtube_id: "abcdefghijk", folder: "2026_10_10_equipo_a_vs_equipo_b", report: { ...EMPTY_REPORT }, ...extra,
});
const segs = { v1: [{ segment_id: "s01", start: 0, end: 2700, tipo: "juego" }] };
const input = (extra = {}) => ({ match: match(), events: [], plays: [], segmentsByVideo: segs, parts: [], roster: [], library: [], now: "2026-10-17", ...extra });

const sample = () => [
  ev(100, "loss", "own", { x: 30, y: 10 }),
  ev(108, "shot", "opp", { x: 15, y: 30, outcome: "on_target" }),
  ev(300, "recovery", "own", { x: 70, y: 40 }),
  ev(305, "goal", "own", { x: 95, y: 34, player_id: "Delantera Uno" }),
  ev(400, "cross", "own", { x: 90, y: 5, x_end: 99, y_end: 34, outcome: "shot" }),
  ev(420, "cross", "own", { x: 92, y: 62 }),
  ev(500, "box_entry", "own"),
  ev(505, "shot", "own", { outcome: "off_target" }),
];

test("solo eventos: nivel N1, las secciones de balón y tracking no disponibles y sin cifras de posesión ni pases", () => {
  const r = buildReport(input({ events: sample() }));
  assert.equal(r.cover.level.level, 1);
  assert.match(r.cover.level.label, /N1/);
  assert.equal(r.summary.possession.ok, false);
  assert.match(r.summary.possession.need, /^Requiere el balón seguido/);
  assert.equal(r.key_players.touches.ok, false);
  assert.match(r.key_players.touches.need, /^Requiere nombres/);
  assert.equal(r.patterns.ok, false);
  assert.ok(!r.summary.rows.some((x) => /posesi|pase/i.test(x.label)));
  assert.equal(JSON.stringify(r).match(/"possession_pct"|"passes":/), null);
});

test("nivel: sin umbral; cualquier balón seguido a mano da N2 y dice su cobertura; las marcas de eventos no cuentan", () => {
  const fps = 10;
  const stride = 10;
  const frames = Array.from({ length: 200 }, (_, i) => i * stride); // 0..199 s
  const part = (ball) => ({
    ownRight: true,
    file: { kind: "tracks_fixed", match_id: "m1", video_id: "v1", fps, start_frame: 0, end_frame: 2000, stride, people: [], frames: [], ball },
  });
  const seg = { v1: [{ segment_id: "s01", start: 0, end: 200, tipo: "juego" }] };
  const manual = (k) => frames.slice(0, k).map((f) => ({ frame: f, x: 50, y: 30, source: "manual" }));
  const lv = dataLevel([ev(1, "shot", "own")], seg, [part(manual(150))]);
  assert.equal(lv.level, 2);
  assert.equal(Math.round((lv.ball.share ?? 0) * 100), 75);
  assert.match(lv.label, /N2 · balón seguido en 75 % del tiempo de juego/);
  // 10 % is still N2: there is no minimum, the coverage says how much.
  const little = dataLevel([ev(1, "shot", "own")], seg, [part(manual(20))]);
  assert.equal(little.level, 2);
  assert.match(little.label, /balón seguido en 10 %/);
  const fromEvents = frames.map((f) => ({ frame: f, x: 50, y: 30, source: "event" }));
  assert.equal(dataLevel([ev(1, "shot", "own")], seg, [part(fromEvents)]).level, 1);
  // Without play stretches the share cannot be said: minutes instead, and a hint to mark them.
  const none = dataLevel([ev(1, "shot", "own")], {}, [part(manual(150))]);
  assert.equal(none.level, 2);
  assert.equal(none.ball.share, null);
  assert.match(none.label, /balón seguido en 3 min/);
  assert.match(none.next, /tramos de juego/);
});

test("cada sección pide su fuente: con balón, la posesión ya no dice «requiere»", () => {
  const ball = Array.from({ length: 30 }, (_, i) => ({ frame: i * 10, x: 50, y: 30, source: "manual" }));
  const parts = [{ ownRight: true, file: { kind: "tracks_fixed", match_id: "m1", video_id: "v1", fps: 10, start_frame: 0, end_frame: 300, stride: 10, people: [], frames: [], ball } }];
  const r = buildReport(input({ events: sample(), parts }));
  assert.equal(r.cover.level.sources.ball, true);
  assert.equal(r.summary.possession.ok, true);
  assert.ok(r.summary.ball);
  // No players in the part: no network and no touches by player.
  assert.equal(r.summary.network, null);
  assert.equal(r.key_players.touches.ok, false);
  assert.match(r.key_players.touches.need, /^Requiere nombres/);
});

test("con balón y nombres: posesión que suma la cobertura, red de pases y toques por jugadora (anonimizables)", () => {
  // 10 s of play; Ana passes to Bea every second, Bea to Ana; 30 fps, stride 3.
  const people = [{ id: 1, team: "own", player_id: "Ana Uno", tracks: [1] }, { id: 2, team: "own", player_id: "Bea Dos", tracks: [2] }];
  const frames = Array.from({ length: 100 }, (_, i) => ({ frame: i * 3, positions: [{ id: 1, x: 40, y: 20, source: "auto" }, { id: 2, x: 60, y: 40, source: "auto" }] }));
  const ball = Array.from({ length: 100 }, (_, i) => (Math.floor(i / 10) % 2 === 0 ? { frame: i * 3, x: 40.3, y: 20, source: "manual" } : { frame: i * 3, x: 60.3, y: 40, source: "manual" }));
  const parts = [{ ownRight: true, file: { kind: "tracks_fixed", match_id: "m1", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, people, frames, ball } }];
  const seg = { v1: [{ segment_id: "s01", start: 0, end: 10, tipo: "juego" }] };
  const r = buildReport(input({ events: sample(), parts, segmentsByVideo: seg }));
  const b = r.summary.ball;
  assert.equal(b.followed_s, 10);
  assert.equal(b.share, 1);
  assert.equal(b.possession.own + b.possession.opp + b.possession.unassigned, b.followed_s);
  assert.equal(b.passes.own.completed, 9);
  assert.equal(r.cover.level.level, 4);
  assert.equal(r.summary.network.passes, 9);
  assert.deepEqual(r.summary.network.edges, [{ a: "Ana Uno", b: "Bea Dos", count: 9 }]);
  assert.deepEqual(r.key_players.rows.map((x) => [x.player, x.touches]), [["Ana Uno", 50], ["Bea Dos", 50]]);
  assert.equal(r.key_players.rows[0].per10, 3000); // 50 touches in 10 s of ball followed
  assert.equal(r.key_players.print, false);
  const anon = JSON.stringify(buildReport(input({ events: sample(), parts, segmentsByVideo: seg, anonymize: true })));
  assert.ok(!anon.includes("Ana Uno") && !anon.includes("Bea Dos"));
});

test("partido de rival: lados y textos con focus_team y other_team, nunca «nosotras»", () => {
  const m = match({ kind: "rival", focus_team: "Rival Uno", other_team: "Rival Dos", report: { ...EMPTY_REPORT, plan: "Presionar su salida" } });
  const r = buildReport(input({ match: m, events: sample() }));
  assert.equal(r.cover.focus_team, "Rival Uno");
  assert.equal(r.cover.other_team, "Rival Dos");
  assert.equal(r.cover.title, "Informe de rival (análisis previo)");
  assert.equal(r.texts.closing.key, "plan");
  assert.equal(r.texts.closing.text, "Presionar su salida");
  assert.doesNotMatch(JSON.stringify(r), /nosotr|nuestr/i);
  // Our own match: conclusions instead of the plan.
  assert.equal(buildReport(input({ events: sample() })).texts.closing.key, "conclusiones");
});

test("últimos resultados: une app y manuales, ordena por fecha, se queda con 5 y calcula V/E/D", () => {
  const lib = [
    { match: match({ match_id: "a1", date: "2026-10-01", focus_team: "Equipo A", other_team: "Equipo C" }), events: [ev(1, "goal", "own", { match_id: "a1" })] },
    // The analysed team as other_team: its goals are the "opp" ones.
    { match: match({ match_id: "a2", date: "2026-10-08", focus_team: "Equipo D", other_team: "équipo  a" }), events: [ev(1, "goal", "own", { match_id: "a2" }), ev(2, "goal", "own", { match_id: "a2" }), ev(3, "goal", "opp", { match_id: "a2" })] },
    // No events: no result.
    { match: match({ match_id: "a3", date: "2026-10-12", focus_team: "Equipo A", other_team: "Equipo E" }), events: [] },
    // Another team: left out.
    { match: match({ match_id: "a4", date: "2026-10-13", focus_team: "Equipo F", other_team: "Equipo G" }), events: [ev(1, "shot", "own", { match_id: "a4" })] },
  ];
  const manual = [
    { date: "2026-09-01", opponent: "Equipo H", home: true, goals_for: 2, goals_against: 2, competition: "Liga" },
    { date: "2026-09-10", opponent: "Equipo I", home: false, goals_for: 0, goals_against: 1, competition: "Liga" },
    { date: "2026-09-20", opponent: "Equipo J", home: true, goals_for: 3, goals_against: 0, competition: "Copa" },
    { date: "2026-08-01", opponent: "Equipo K", home: true, goals_for: 1, goals_against: 0, competition: "Amistoso" },
    // Same date and opponent as the app match a1: the app one is kept.
    { date: "2026-10-01", opponent: "equipo c", home: true, goals_for: 5, goals_against: 0, competition: "Liga" },
  ];
  const r = recentResults("Equipo A", lib, manual);
  assert.deepEqual(r.rows.map((x) => x.date), ["2026-10-08", "2026-10-01", "2026-09-20", "2026-09-10", "2026-09-01"]);
  assert.deepEqual(r.rows.map((x) => x.result), ["D", "V", "V", "D", "E"]);
  assert.deepEqual([r.rows[0].goals_for, r.rows[0].goals_against, r.rows[0].opponent], [1, 2, "Equipo D"]);
  assert.equal(r.rows[1].source, "app");
  assert.equal(r.total, 6);
  assert.equal(r.no_events, 1);
});

test("marcador derivado de los goles etiquetados; un autogol etiquetado al equipo que lo recibe cuenta para ese equipo", () => {
  assert.deepEqual(scoreOf([ev(1, "goal", "own"), ev(2, "goal", "opp"), ev(3, "goal", "own"), ev(4, "shot", "opp")]), { own: 2, opp: 1 });
  // Assumption (lib/report.ts): an own goal is tagged as a goal of the team that benefits. Tagged with the team that
  // put it into its own net, nothing corrects it: it stays a goal of that team, whatever the note says.
  assert.deepEqual(scoreOf([ev(1, "goal", "own", { note: "autogol" })]), { own: 1, opp: 0 });
  assert.equal(scoreOf([]), null);
  assert.deepEqual(buildReport(input({ events: sample() })).cover.score, { own: 1, opp: 0 });
});

test("centros: uno sin destino cuenta en el resumen pero no en el mapa, y sale como «sin destino marcado»", () => {
  const r = buildReport(input({ events: sample() }));
  assert.equal(r.summary.rows.find((x) => x.key === "crosses").own, 2);
  assert.equal(r.maps.crosses.length, 1);
  assert.deepEqual([r.maps.crosses[0].x_end, r.maps.crosses[0].y_end], [99, 34]);
  assert.equal(r.maps.crosses_no_end.own, 1);
  assert.equal(r.maps.crosses_no_pos.own, 0);
});

test("cuadrícula 5×3: un evento en el borde cae en un solo carril y el contrario se orienta al revés", () => {
  const w = 68 / 5;
  // Right on the border between lanes 0 and 1: lane 1 only.
  assert.deepEqual(laneThirdOf({ x: 10, y: w, team: "own" }), { lane: 1, third: 0 });
  const g = zoneGrid5x3([{ x: 10, y: w, team: "own" }]);
  assert.equal(g.grid.flat().reduce((a, b) => a + b, 0), 1);
  // Edges of the pitch stay inside the grid.
  assert.deepEqual(laneThirdOf({ x: 105, y: 68, team: "own" }), { lane: 4, third: 2 });
  // The other team attacks towards x = 0: a loss at x = 100, low y, is in its own third and on its right wing.
  assert.deepEqual(laneThirdOf({ x: 100, y: 2, team: "opp" }), { lane: 4, third: 0 });
  assert.equal(laneThirdOf({ x: null, y: 3, team: "own" }), null);
  const r = buildReport(input({ events: [ev(1, "loss", "opp", { x: 100, y: 2 }), ev(2, "loss", "opp")] }));
  assert.equal(r.maps.zones.loss.opp.grid[4][0], 1);
  assert.equal(r.maps.zones.loss.opp.missing, 1);
});

test("transiciones: pérdida → tiro del contrario y recuperación → tiro propio, con su momento y enlace", () => {
  const r = buildReport(input({ events: sample() }));
  const t = r.transitions.own;
  assert.equal(t.losses.length, 1);
  assert.equal(t.losses[0].seconds, 8);
  assert.equal(t.losses[0].zone, "Banda izquierda · Campo propio");
  assert.equal(t.losses[0].moment.minute, 2);
  assert.match(t.losses[0].moment.youtube, /abcdefghijk&t=97s/);
  assert.equal(t.recoveries.length, 1);
  assert.equal(t.recoveries[0].goal, true);
  assert.deepEqual(t.loss_to_shot, { k: 1, n: 1 });
});

test("un Report guardado antes de los campos nuevos abre sin errores", () => {
  const old = { resumen: "Texto", fortalezas: "", debilidades: "", balon_parado: "", jugadoras_clave: "", plan: "Plan" };
  const r = normalizeReport(old);
  assert.equal(r.resumen, "Texto");
  assert.equal(r.conclusiones, "");
  assert.equal(r.jornada, "");
  assert.deepEqual(r.results_manual, []);
  assert.deepEqual(normalizeReport(undefined), { ...EMPTY_REPORT });
  const built = buildReport(input({ match: match({ kind: "rival", report: old }), events: sample() }));
  assert.equal(built.texts.closing.text, "Plan");
  assert.deepEqual(built.results.rows.length, 0);
});

test("anonymize no deja ningún nombre de jugadora en el JSON", () => {
  const roster = [{ player_id: "Portera Dos", number: 1 }, { player_id: "Delantera Uno", number: 9 }];
  const events = [...sample(), ev(600, "shot", "own", { x: 90, y: 30, player_id: "Media Tres" }), ev(610, "loss", "opp", { player_id: "7" })];
  const m = match({ report: { ...EMPTY_REPORT, jugadoras_clave: "Delantera Uno llega por dentro; media tres cubre." } });
  const plays = [{ play_id: "p1", match_id: "m1", video_id: "v1", title: "Gol de Delantera Uno", t_start: 300, t_end: 310, note: "", keyframes: [] }];
  const r = buildReport(input({ match: m, events, roster, plays, anonymize: true }));
  const json = JSON.stringify(r);
  for (const name of ["Portera Dos", "Delantera Uno", "Media Tres", "media tres"]) assert.ok(!json.includes(name), name);
  assert.equal(r.anonymized, true);
  assert.equal(r.maps.shots.find((s) => s.goal).player, "#9");
  assert.match(r.texts.jugadoras_clave, /^#9 llega por dentro; J\d cubre\.$/);
  assert.equal(r.plays[0].title, "Gol de #9");
  // Links are not touched.
  assert.match(r.plays[0].moment.youtube, /abcdefghijk/);
});

test("duel: en el catálogo con tecla libre, resultado y detalle", () => {
  assert.ok(EVENT_TYPES.includes("duel"));
  assert.equal(EVENT_KEYS.duel, "d");
  const keys = Object.values(EVENT_KEYS);
  assert.equal(new Set(keys).size, keys.length);
  // Letters taken by other shortcuts of the tagging tab.
  for (const k of ["a", "s", "j"]) assert.ok(!keys.includes(k));
  assert.deepEqual(Object.keys(EVENT_OUTCOMES.duel), ["won", "lost"]);
  assert.deepEqual(Object.keys(EVENT_DETAILS.duel), ["aerial", "ground"]);
  const r = buildReport(input({ events: [ev(1, "duel", "own", { x: 50, y: 20, outcome: "won", detail: "aerial" }), ev(2, "duel", "opp", { outcome: "won" })] }));
  assert.equal(r.maps.duels.points.length, 1);
  assert.equal(r.maps.duels.no_pos, 1);
  assert.deepEqual(r.maps.duels.won, { own: 1, opp: 1 });
  // A match without duels has no map.
  assert.equal(buildReport(input({ events: sample() })).maps.duels, null);
});

test("cobertura: dos archivos que cubren el mismo tramo (unido y suelto) cuentan una vez", () => {
  const fps = 10;
  const stride = 10;
  const ball = Array.from({ length: 120 }, (_, i) => ({ frame: i * stride, x: 50, y: 30, source: "manual" })); // 0..119 s
  const people = [{ id: 1, team: "own", player_id: null, tracks: [1] }];
  const frames = [{ frame: 0, positions: [{ id: 1, x: 10, y: 10, source: "auto" }] }];
  const file = (start, end) => ({ kind: "tracks_fixed", match_id: "m1", video_id: "v1", fps, start_frame: start, end_frame: end, stride, people, frames, ball: ball.filter((b) => b.frame >= start && b.frame < end) });
  const seg = { v1: [{ segment_id: "s01", start: 0, end: 200, tipo: "juego" }] };
  const joined = { ownRight: true, file: file(0, 1200) };
  const pieces = [file(0, 600), file(600, 1200)].map((f) => ({ ownRight: true, file: f }));
  const lv = dataLevel([ev(1, "shot", "own")], seg, [joined, ...pieces]);
  assert.equal(lv.ball.seconds, 120);
  assert.equal(lv.tracking.seconds, 120);
  assert.equal(lv.level, 3);
  // An open last stretch counts neither in the play time nor in the coverage.
  const open = dataLevel([ev(1, "shot", "own")], { v1: [...seg.v1, { segment_id: "s02", start: 300, end: null, tipo: "juego" }] }, [joined]);
  assert.equal(open.play_s, 200);
});

test("un resultado escrito a mano sin goles no cuenta como empate", () => {
  const r = normalizeReport({ results_manual: [{ date: "2026-09-01", opponent: "Equipo H", home: true, competition: "" }] });
  assert.ok(Number.isNaN(r.results_manual[0].goals_for));
  assert.equal(recentResults("Equipo A", [], r.results_manual).rows.length, 0);
});

test("«ver» abre el clip editado si existe y, si no, el tramo sin editar; la lista de clips lleva su edit_id", () => {
  const plays = [{ play_id: "p1", match_id: "m1", video_id: "v1", title: "Salida", t_start: 600, t_end: 612, note: "", keyframes: [] }];
  const edit = (id, t_start, t_end, extra = {}) => ({ edit_id: id, match_id: "m1", video_id: "v1", t_start, t_end, title: id, freezes: [], annotations: [], label_mode: "number", ...extra });
  const plain = buildReport(input({ events: sample(), plays }));
  const loss = plain.transitions.own.losses[0];
  assert.equal(loss.moment.edit, null);
  assert.match(loss.moment.app, /video=v1&t=97/);
  // An edit between the loss (100) and the shot (108) belongs to the transition, even if it starts after the loss.
  const r = buildReport(input({ events: sample(), plays, edits: [edit("c_tr", 104, 112), edit("c_play", 590, 615, { play_id: "p1" }), edit("c_otro", 600, 610, { match_id: "m2" })] }));
  const row = r.transitions.own.losses[0];
  assert.equal(row.moment.edit.edit_id, "c_tr");
  assert.equal(row.moment.edit.app, "/partido?id=m1&edit=c_tr");
  assert.equal(r.transitions.own.recoveries[0].moment.edit, null);
  assert.equal(r.plays[0].moment.edit.edit_id, "c_play");
  const list = clipList(r);
  assert.equal(list.kind, "clips");
  const tr = list.clips.find((c) => c.clip_id === `tr_${row.id}`);
  assert.deepEqual([tr.kind, tr.video_id, tr.t_start, tr.t_end, tr.edit_id], ["transition", "v1", 97, 110, "c_tr"]);
  const pl = list.clips.find((c) => c.clip_id === "play_p1");
  assert.deepEqual([pl.t_start, pl.t_end, pl.edit_id], [600, 612, "c_play"]);
  assert.equal(list.clips.filter((c) => c.edit_id === null).length, list.clips.length - 2);
});

test("sin nombres: los identificadores de clips y ediciones no se tocan", () => {
  const edits = [{ edit_id: "c_ana_x", match_id: "m1", video_id: "v1", t_start: 104, t_end: 112, title: "c", freezes: [], annotations: [], label_mode: "number" }];
  const r = buildReport(input({ events: sample().map((e) => ({ ...e, player_id: e.player_id ?? "ana" })), edits, roster: [{ player_id: "ana", number: 5 }], anonymize: true }));
  assert.equal(r.transitions.own.losses[0].moment.edit.edit_id, "c_ana_x");
  assert.equal(clipList(r).clips.find((c) => c.kind === "transition" && c.edit_id).edit_id, "c_ana_x");
});
