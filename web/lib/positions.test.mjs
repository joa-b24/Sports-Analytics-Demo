import assert from "node:assert/strict";
import { test } from "node:test";
import { autoFixed, ballReport, passStretches, behindBallAtLosses, heatmap, inferOwnAttacksRight, parseFixed, passArrows, passNetwork, passesAndTurnovers, positionsAt, touches, unnamedLeftovers } from "./positions.ts";

// A corrected part: 30 fps, one of every 3 frames. `at(i)` gives the positions of processed frame i.
const fixed = ({ n = 10, people, at, ball = [] }) => ({
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
  people, ball,
  frames: Array.from({ length: n }, (_, i) => ({ frame: i * 3, positions: at(i) })),
});
const P = (id, team, player_id = null) => ({ id, team, player_id, tracks: [id] });
const q = (id, x, y, source = "auto") => ({ id, x, y, source });

test("reads only corrected parts", () => {
  assert.equal(parseFixed('{"kind":"tracks_px","frames":[]}'), null);
  assert.equal(parseFixed("no"), null);
  assert.ok(parseFixed(JSON.stringify(fixed({ people: [], at: () => [] }))));
});

test("the direction of play comes from where each team spends its time", () => {
  const people = [P(1, "own"), P(2, "opp")];
  const left = fixed({ n: 300, people, at: () => [q(1, 30, 30), q(2, 70, 30)] });
  assert.equal(inferOwnAttacksRight(left), true);
  const right = fixed({ n: 300, people, at: () => [q(1, 70, 30), q(2, 30, 30)] });
  assert.equal(inferOwnAttacksRight(right), false);
  assert.equal(inferOwnAttacksRight(fixed({ n: 10, people, at: () => [q(1, 30, 30), q(2, 70, 30)] })), null);
  assert.equal(inferOwnAttacksRight(fixed({ n: 300, people, at: () => [q(1, 50, 30), q(2, 52, 30)] })), null);
});

test("heat map: seconds per cell, team attacking right, interpolated left out", () => {
  const f = fixed({ people: [P(1, "own", "Ana"), P(2, "opp")], at: (i) => [q(1, 100, 60, i < 5 ? "auto" : "interpolated"), q(2, 10, 10)] });
  const h = heatmap([{ file: f, ownRight: true }], "own", null, 2, 2);
  assert.ok(Math.abs(h.total - 0.5) < 1e-9);
  assert.ok(Math.abs(h.seconds[3] - 0.5) < 1e-9);
  const mirrored = heatmap([{ file: f, ownRight: false }], "own", null, 2, 2);
  assert.ok(Math.abs(mirrored.seconds[0] - 0.5) < 1e-9);
  assert.equal(heatmap([{ file: f, ownRight: true }], "own", "Otra", 2, 2).total, 0);
});

test("who has the ball, passes and changes of team", () => {
  // Ana (1) has it, passes to Bea (2), who loses it to an opponent (3).
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 60, 30)];
  const ball = [
    { frame: 0, x: 20.5, y: 30, source: "manual" },
    { frame: 3, x: 30, y: 30, source: "interpolated" }, // in flight: nobody
    { frame: 6, x: 39.5, y: 30, source: "manual" },
    { frame: 9, x: 59, y: 30, source: "manual" },
  ];
  const f = fixed({ people, at, ball });
  assert.deepEqual(touches(f).map((t) => t.id), [1, 2, 3]);
  const r = passesAndTurnovers(f);
  assert.deepEqual(r.passes.map((p) => [p.from, p.to]), [[1, 2]]);
  assert.deepEqual(r.turnovers, [{ frame: 9, from_frame: 6, from: 2, lost: "own" }]);
  const net = passNetwork([{ file: f, ownRight: true }], "own");
  assert.deepEqual(net.edges, [{ a: "Ana", b: "Bea", count: 1 }]);
  assert.equal(net.passes, 1);
  assert.equal(net.unnamed, 0);
  // The same pass as an arrow: from Ana to Bea, 20 units forward (progressive), and mirrored when the team attacks left.
  assert.deepEqual(passArrows([{ file: f, ownRight: true }], "own"), [{ x1: 20, y1: 30, x2: 40, y2: 30, from: "Ana", progressive: true }]);
  assert.deepEqual(passArrows([{ file: f, ownRight: false }], "own")[0].x2, 65);
});

test("an interpolated ball is never a touch, even right next to a player (it went over her)", () => {
  // Ana (1) passes to Bea (2); the straight line between the two marks passes over an opponent (3).
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 30, 30.5)];
  const ball = [
    { frame: 0, x: 20.5, y: 30, source: "manual" },
    { frame: 3, x: 30, y: 30, source: "interpolated" },
    { frame: 6, x: 39.5, y: 30, source: "manual" },
  ];
  const f = fixed({ people, at, ball });
  assert.deepEqual(touches(f).map((t) => t.id), [1, 2]);
  const r = passesAndTurnovers(f);
  assert.deepEqual(r.passes.map((p) => [p.from, p.to]), [[1, 2]]);
  assert.equal(r.turnovers.length, 0);
});

test("a ball between two rivals at the same distance belongs to nobody", () => {
  const f = fixed({ people: [P(1, "own"), P(3, "opp")], at: () => [q(1, 20, 30), q(3, 21, 30)], ball: [{ frame: 0, x: 20.5, y: 30, source: "manual" }] });
  assert.equal(touches(f).length, 0);
});

test("players behind the ball when it is lost: tagged losses and changes read from the ball", () => {
  // Own players at x 10, 30 and 80; the ball lost at x 50 (event) => 2 behind of 3 seen.
  const people = [P(1, "own"), P(2, "own"), P(4, "own"), P(3, "opp")];
  const at = () => [q(1, 10, 30), q(2, 30, 30), q(4, 80, 30), q(3, 85, 30)];
  const f = fixed({ n: 100, people, at });
  const ev = { event_id: "e", match_id: "m", video_id: "v1", t_video: 1, period: 1, type: "loss", team: "own", player_id: null, x: 50, y: 30, outcome: null, note: null };
  const r = behindBallAtLosses([{ file: f, ownRight: true }], [ev]);
  assert.deepEqual(r.map((b) => [b.behind, b.seen, b.source]), [[2, 3, "event"]]);
  // Mirrored video: the same players are now 95, 75 and 25 from the left; seen attacking right they are as before.
  const m = fixed({ n: 100, people, at: () => [q(1, 95, 38), q(2, 75, 38), q(4, 25, 38), q(3, 20, 38)] });
  assert.deepEqual(behindBallAtLosses([{ file: m, ownRight: false }], [ev]).map((b) => b.behind), [2]);
  // A change of team read from the followed ball, with no tagged loss.
  const g = fixed({ n: 10, people, at, ball: [{ frame: 0, x: 80.5, y: 30, source: "manual" }, { frame: 3, x: 84.5, y: 30, source: "manual" }] });
  assert.deepEqual(behindBallAtLosses([{ file: g, ownRight: true }], []).map((b) => [b.behind, b.source]), [[3, "ball"]]);
});

test("positions of a moment are joined between processed frames", () => {
  const f = fixed({ people: [P(1, "own", "Ana")], at: (i) => [q(1, 10 + i, 30)], ball: [{ frame: 0, x: 5, y: 5, source: "manual" }, { frame: 3, x: 8, y: 5, source: "manual" }] });
  const s = positionsAt({ file: f, ownRight: true }, 2 / 30);
  assert.ok(Math.abs(s.players[0].x - (10 + 2 / 3)) < 1e-9);
  assert.equal(s.players[0].label, "Ana");
  assert.ok(Math.abs(s.ball[0] - 7) < 1e-9);
  assert.equal(positionsAt({ file: f, ownRight: true }, 5), null);
});

test("the ball distance is measured in real meters of the venue", () => {
  // On a 52.5 x 34 m venue one unit of the drawing is half a metre: 3 units away is 1.5 m, close enough to have it.
  const f = fixed({ people: [P(1, "own")], at: () => [q(1, 20, 30)], ball: [{ frame: 0, x: 23, y: 30, source: "manual" }] });
  assert.equal(touches(f).length, 0);
  assert.equal(touches({ ...f, venue: { length_m: 52.5, width_m: 34 } }).length, 1);
});

test("an uncorrected part gives positions by team, box by box, without referees or people off the pitch", () => {
  const own = [100, 128, 160];
  const opp = [30, 128, 128];
  const ref = [90, 100, 180];
  const box = (track, lab, x, inside, team, ident) => [track, 0, 0, 10, 30, 0.9, ...lab, x, 30, inside, team, ident];
  const t = {
    match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 6, stride: 3, image_w: 100, image_h: 100,
    venue: { length_m: 102, width_m: 66 },
    // The shirt colour of each team is measured from the file itself: twelve frames of the three kits, then identity 7
    // wears the other shirt (a different person for the team-level analysis).
    frames: [
      ...Array.from({ length: 12 }, (_, i) => ({
        frame: i * 3,
        boxes: [box(1, own, 10, true, "own", 7), box(2, opp, 20, true, "opp", 8), box(3, ref, 30, true, "ref", 9), box(4, own, 40, false, "own", 10)],
      })),
      { frame: 36, boxes: [box(1, opp, 11, true, "opp", 7), box(2, opp, 21, true, "opp", 8)] },
    ],
  };
  const f = autoFixed(t);
  assert.equal(f.auto, true);
  assert.deepEqual(f.frames[0].positions.length, 2);
  const teams = new Map(f.people.map((p) => [p.id, p.team]));
  assert.deepEqual(f.frames[12].positions.map((q) => teams.get(q.id)), ["opp", "opp"]);
  assert.notEqual(f.frames[0].positions[0].id, f.frames[12].positions[0].id);
  assert.deepEqual(f.venue, { length_m: 102, width_m: 66 });
});


// ---------------------------------------------------------------------------------------------- phase 2: ball report

const M = (frame, x, y, source = "manual") => ({ frame, x, y, source });
const seg = (start, end, tipo = "juego") => ({ segment_id: `s${start}`, start, end, tipo });
const ev = (t_video, type, team) => ({ event_id: `e${t_video}${type}`, match_id: "m", video_id: "v1", t_video, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, note: null });

test("A → A → B del mismo equipo es 1 pase; B → rival, 1 cambio; tras un hueco mayor que PASS_MAX_S, nada", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(2, 40, 30), q(3, 60, 30)];
  const ball = [M(0, 20, 30), M(30, 20, 30), M(60, 40, 30), M(90, 60, 30), M(300, 20, 30)];
  const r = passesAndTurnovers(fixed({ n: 120, people, at, ball }));
  assert.deepEqual(r.passes.map((p) => [p.from, p.to, p.from_frame]), [[1, 2, 30]]);
  assert.deepEqual(r.turnovers.map((t) => [t.from, t.lost]), [[2, "own"]]);
});

test("una jugadora en posición interpolada no toca el balón", () => {
  const f = fixed({ people: [P(1, "own", "Ana")], at: () => [q(1, 20, 30, "interpolated")], ball: [M(0, 20, 30)] });
  assert.equal(touches(f).length, 0);
});

test("posesión: solo en tramos de juego con el balón seguido, y suma justo el tiempo medido", () => {
  // 20 s of video; ball marked near Ana for the first 15 s; a pause from 5 s to 10 s.
  const ball = Array.from({ length: 150 }, (_, i) => M(i * 3, 20.5, 30));
  const f = fixed({ n: 200, people: [P(1, "own", "Ana"), P(3, "opp")], at: () => [q(1, 20, 30), q(3, 80, 30)], ball });
  const r = ballReport([{ file: f, ownRight: true }], { v1: [seg(0, 5), seg(5, 10, "pausa"), seg(10, 20)] }, []);
  assert.equal(r.followed_s, 10);
  assert.deepEqual(r.possession, { own: 10, opp: 0, unassigned: 0 });
  // Without play stretches all the followed ball counts.
  assert.equal(ballReport([{ file: f, ownRight: true }], {}, []).followed_s, 15);
});

test("posesión: un balón disputado o sin toques por más de PASS_MAX_S queda sin asignar", () => {
  // Ana has it 0-1 s; then 1-2 s Ana and a rival equally near (contested); then 2-9 s the ball is far from everyone.
  const ball = Array.from({ length: 90 }, (_, i) => (i < 10 ? M(i * 3, 20.5, 30) : i < 20 ? M(i * 3, 21, 30) : M(i * 3, 50, 10)));
  const f = fixed({ n: 90, people: [P(1, "own", "Ana"), P(3, "opp")], at: () => [q(1, 20, 30), q(3, 22, 30)], ball });
  const r = ballReport([{ file: f, ownRight: true }], {}, []);
  assert.equal(r.followed_s, 9);
  assert.equal(r.possession.own, 1);
  assert.equal(r.possession.opp, 0);
  assert.equal(r.possession.unassigned, 8);
});

test("un cambio de equipo con una pérdida etiquetada a menos de 2 s queda confirmado; si no, inferido", () => {
  const people = [P(1, "own", "Ana"), P(3, "opp")];
  const at = () => [q(1, 20, 30), q(3, 60, 30)];
  const ball = [M(0, 20, 30), M(30, 60, 30), M(240, 20, 30), M(270, 60, 30)];
  const f = fixed({ n: 100, people, at, ball });
  // Changes at 1 s and 9 s; a loss tagged at 2.5 s confirms the first one; a loss at 20 s matches nothing.
  const r = ballReport([{ file: f, ownRight: true }], {}, [ev(2.5, "loss", "own"), ev(20, "loss", "own")]);
  assert.deepEqual(r.changes.map((c) => [c.t, c.confirmed]), [[1, true], [9, false]]);
  assert.equal(r.passes.own.cut, 2);
});

test("trozos sin nombre: en un equipo con nombres no tocan el balón (lo toca la jugadora de al lado); en un rival sin nombres sí", () => {
  // Ana and a second box of hers 0.3 m away, without a name; the second box is nearer to the ball.
  const own = fixed({
    people: [P(1, "own", "Ana"), P(2, "own"), P(7, "own", "Bea"), P(8, "own", "Cris")],
    at: () => [q(1, 20, 30), q(2, 20.3, 30), q(7, 40, 30), q(8, 50, 30)],
    ball: [M(0, 20.4, 30)],
  });
  assert.deepEqual(unnamedLeftovers(own).map((l) => l.id), [2]);
  assert.deepEqual(touches(own).map((t) => t.id), [1]);
  // A rival with one named player out of four: its unnamed players are just unnamed.
  const at = () => [q(3, 60, 30), q(4, 70, 30), q(5, 80, 30), q(6, 90, 30)];
  const opp = fixed({ people: [P(3, "opp", "GK"), P(4, "opp"), P(5, "opp"), P(6, "opp")], at, ball: [M(0, 70.2, 30)] });
  assert.equal(unnamedLeftovers(opp).length, 0);
  assert.deepEqual(touches(opp).map((t) => t.id), [4]);
});

test("pases por tercio y carril de origen, con el equipo atacando a la derecha", () => {
  const people = [P(1, "own", "Ana"), P(2, "own", "Bea")];
  // Ana in the middle third, left wing (low y); the part is played with own attacking left, so it is mirrored.
  const at = () => [q(1, 105 - 50, 68 - 5), q(2, 105 - 60, 68 - 5)];
  const ball = [M(0, 105 - 50, 68 - 5), M(15, 105 - 60, 68 - 5)];
  const r = ballReport([{ file: fixed({ people, at, ball }), ownRight: false }], {}, []);
  assert.equal(r.passes.own.completed, 1);
  assert.deepEqual(r.passes.own.completed_by_third, [0, 1, 0]);
  assert.deepEqual(r.passes.own.completed_by_lane, [1, 0, 0, 0, 0]);
  assert.deepEqual(r.players.map((p) => [p.player, p.touches]), [["Ana", 1], ["Bea", 1]]);
});

test("pases por tramo: completo con el equipo analizado y el balón seguidos; sin tracking, nada", () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({
    frame: i * 3,
    // Own team seen in the first 90 processed frames, the other team never.
    positions: i < 90 ? [1, 2, 3, 4, 5].map((id) => ({ id, x: 50, y: 30, source: "auto" })) : [],
  }));
  const file = {
    kind: "tracks_fixed", match_id: "m1", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3,
    people: [1, 2, 3, 4, 5].map((id) => ({ id, team: "own", player_id: null, tracks: [] })),
    ball: frames.slice(0, 80).map((f) => ({ frame: f.frame, x: 50, y: 30, source: "manual" })),
    frames,
  };
  const segs = { v1: [{ segment_id: "s01", start: 0, end: 10, tipo: "juego" }, { segment_id: "s02", start: 10, end: 20, tipo: "juego" }] };
  const rows = passStretches([{ file, ownRight: true }], segs);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].done);
  assert.ok(Math.abs(rows[0].own - 0.9) < 1e-9 && Math.abs(rows[0].ball - 0.8) < 1e-9 && rows[0].opp === 0);
  // The second stretch has no tracking at all.
  assert.equal(rows[1].done, false);
  assert.equal(rows[1].own, 0);
});
