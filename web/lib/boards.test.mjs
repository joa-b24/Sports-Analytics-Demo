import assert from "node:assert/strict";
import { test } from "node:test";
import { keyframePositions, resolve } from "./annotations.ts";
import {
  BOARD_TAIL_S,
  SHEET,
  addStep,
  boardDuration,
  boardFromPlay,
  boardsOf,
  filterBoards,
  framingBox,
  newBoard,
  normalizeBoard,
  removeStep,
  sheetLayout,
  sheetPages,
  spanOfSteps,
  startPositions,
  stepsOf,
  toggleToken,
} from "./boards.ts";
import { PITCH } from "./types.ts";

// Synthetic data only: no real players or teams.
const play = (extra = {}) => ({
  play_id: "p1", match_id: "m1", video_id: "v1", title: "Jugada 10:00", t_start: 600, t_end: 607, note: "Salida por fuera",
  keyframes: [
    { t: 603, pos: { o1: [30, 20], ball: [31, 20] } },
    { t: 600, pos: { o1: [10, 10], r2: [70, 40], ball: [11, 10] } },
  ],
  ...extra,
});

test("pasar un Play al pizarrón conserva sus posiciones, con el tiempo contado desde el inicio de la jugada", () => {
  const p = play();
  const b = boardFromPlay(p, "b1");
  assert.equal(b.match_id, "m1");
  assert.equal(b.play_id, "p1");
  assert.equal(b.notes, "Salida por fuera");
  assert.deepEqual(b.keyframes.map((k) => k.t), [0, 3]);
  assert.deepEqual(b.keyframes[0].pos, { o1: [10, 10], r2: [70, 40], ball: [11, 10] });
  assert.deepEqual(b.keyframes[1].pos, { o1: [30, 20], ball: [31, 20] });
  // The play is left as it was (positions copied, not shared).
  b.keyframes[0].pos.o1[0] = 99;
  assert.equal(p.keyframes[1].pos.o1[0], 10);
  assert.equal(p.keyframes[0].t, 603);
});

test("pasar un Play con posiciones medidas: un paso cada 2 s y el final, solo con quienes estaban en cuadro", () => {
  const seen = [];
  const measured = (t) => {
    seen.push(t);
    if (t > 606) return null; // past the part
    return {
      players: [
        { id: 4, team: "own", x: t - 590, y: 20, label: "7" },
        { id: 8, team: "opp", x: 80, y: 30 },
        { id: 9, team: "ref", x: 50, y: 30 },
        ...(t >= 604 ? [{ id: 12, team: "own", x: 60, y: 60 }] : []),
      ],
      ball: t === 602 ? null : [t - 589, 20],
    };
  };
  const b = boardFromPlay(play(), "b2", measured);
  assert.deepEqual(seen, [600, 602, 604, 606, 607]);
  // 607 has no measurement: no step there.
  assert.deepEqual(b.keyframes.map((k) => k.t), [0, 2, 4, 6]);
  assert.deepEqual(b.keyframes[0].pos, { m4: [10, 20], m8: [80, 30], ball: [11, 20] });
  assert.equal(b.keyframes[1].pos.ball, undefined);
  assert.deepEqual(b.keyframes[2].pos.m12, [60, 60]);
  assert.deepEqual(b.tokens, [
    { id: "m4", team: "own", label: "7" },
    { id: "m8", team: "opp", label: "" },
    { id: "m12", team: "own", label: "" },
    { id: "ball", team: "ball", label: "" },
  ]);
  // Without any measurement in the play, its hand keyframes are used.
  assert.deepEqual(boardFromPlay(play(), "b3", () => null).keyframes.map((k) => k.t), [0, 3]);
});

test("filtros por categoría y a favor o en contra", () => {
  const list = [
    newBoard("b1", "corner", "for", "Córner corto"),
    newBoard("b2", "corner", "against", "Córner rival"),
    newBoard("b3", "throw_in", "for", "Banda larga"),
    newBoard("b4", "corner", "for", "Córner al primer palo"),
  ];
  assert.deepEqual(filterBoards(list, { category: "corner" }).map((b) => b.board_id), ["b4", "b1", "b2"]);
  assert.deepEqual(filterBoards(list, { category: "corner", side: "for" }).map((b) => b.board_id), ["b4", "b1"]);
  assert.deepEqual(filterBoards(list, { category: "all", side: "against" }).map((b) => b.board_id), ["b2"]);
  assert.equal(filterBoards(list, {}).length, 4);
});

test("un State de antes del pizarrón abre sin errores y un tablero incompleto se completa", () => {
  const old = { matches: [], events: [], plays: [play()], sessions: [] };
  assert.deepEqual(boardsOf(old), []);
  const b = normalizeBoard({ board_id: "b1", title: "ABP", keyframes: [{ t: 2, pos: {} }, { t: 0, pos: {} }] });
  assert.equal(b.category, "other");
  assert.equal(b.side, "for");
  assert.equal(b.tokens.length, 23);
  assert.deepEqual(b.annotations, []);
  assert.deepEqual(b.keyframes.map((k) => k.t), [0, 2]);
  assert.equal(normalizeBoard({ board_id: "b2", category: "penalti" }).category, "other");
});

test("pasos: un dibujo dura de su paso hasta el siguiente; borrar un paso quita los dibujos que empiezan en él", () => {
  let b = newBoard("b1", "corner", "for", "Córner");
  b = addStep(addStep(b));
  assert.deepEqual(b.keyframes.map((k) => k.t), [0, 2, 4]);
  assert.equal(boardDuration(b), 4 + BOARD_TAIL_S);
  const arrow = { id: "a1", kind: "arrow", anchors: [{ kind: "player", identity: "o7" }, { kind: "pitch", x: 100, y: 34 }], style: { color: "accent" }, ...spanOfSteps(b, 1, 1) };
  const zone = { id: "a2", kind: "zone", anchors: [{ kind: "pitch", x: 99, y: 25 }, { kind: "pitch", x: 105, y: 25 }, { kind: "pitch", x: 105, y: 43 }], style: { color: "warn" }, ...spanOfSteps(b, 0, 2) };
  b = { ...b, annotations: [arrow, zone] };
  assert.deepEqual(stepsOf(b, arrow), [1]);
  assert.deepEqual(stepsOf(b, zone), [0, 1, 2]);
  // During the move from step 1 to step 2 the arrow is still there.
  assert.ok(resolve(arrow, 3.5, keyframePositions(b.keyframes)));
  assert.equal(resolve(arrow, 4, keyframePositions(b.keyframes)), null);
  const less = removeStep(b, 1);
  assert.deepEqual(less.keyframes.map((k) => k.t), [0, 4]);
  assert.deepEqual(less.annotations.map((a) => a.id), ["a2"]);
});

test("quitar una ficha la saca de todos los pasos y borra sus dibujos; volver a ponerla la deja en su sitio de salida", () => {
  let b = addStep(newBoard("b1", "corner", "for", "Córner"));
  b = { ...b, annotations: [{ id: "h", kind: "highlight", anchors: [{ kind: "player", identity: "o7" }], t_in: 0, t_out: 3, style: { color: "accent" } }] };
  const off = toggleToken(b, "o7");
  assert.ok(off.keyframes.every((k) => !k.pos.o7));
  assert.equal(off.annotations.length, 0);
  const on = toggleToken(off, "o7");
  assert.ok(on.keyframes.every((k) => k.pos.o7[0] === startPositions("corner", "for").o7[0]));
});

test("córner en contra: el mismo córner reflejado, con el otro equipo atacando hacia la izquierda", () => {
  const f = startPositions("corner", "for");
  const a = startPositions("corner", "against");
  assert.deepEqual(a.r5, [PITCH.length - f.o5[0], PITCH.width - f.o5[1]]);
  assert.deepEqual(a.o1, [PITCH.length - f.r1[0], PITCH.width - f.r1[1]]);
  assert.ok(f.ball[0] > 100 && a.ball[0] < 5);
  assert.equal(Object.keys(f).length, 23);
});

test("láminas: de 2 a 4 pasos por página", () => {
  assert.deepEqual(sheetPages([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(sheetPages([1, 2, 3, 4, 5], 4), [[1, 2, 3, 4], [5]]);
  assert.deepEqual(sheetPages([], 3), []);
});

test("láminas: cada página cabe en A4 y carta; córner y tiro libre se encuadran en su mitad", () => {
  for (const framing of ["full", "right"]) {
    const [, , vw, vh] = framingBox(framing);
    for (const n of [2, 3, 4]) {
      const { cols, itemPct } = sheetLayout(n, framing);
      const colW = (SHEET.w - SHEET.gap * (cols - 1)) / cols;
      const w = (colW * itemPct) / 100;
      const rows = Math.ceil(n / cols);
      assert.ok(cols * w + SHEET.gap * (cols - 1) <= SHEET.w + 1e-9, `${framing} ${n}: ancho`);
      assert.ok(SHEET.header + rows * (w * (vh / vw) + SHEET.caption) + SHEET.gap * (rows - 1) <= SHEET.h + 1e-9, `${framing} ${n}: alto`);
    }
  }
  // Two whole pitches go one under the other; two halves side by side.
  assert.equal(sheetLayout(2, "full").cols, 1);
  assert.equal(sheetLayout(2, "right").cols, 2);
  assert.equal(newBoard("b", "corner", "for", "C").framing, "right");
  assert.equal(newBoard("b", "free_kick", "against", "F").framing, "left");
  assert.equal(newBoard("b", "throw_in", "for", "B").framing, "full");
  assert.equal(normalizeBoard({ board_id: "x" }).framing, "full");
});
