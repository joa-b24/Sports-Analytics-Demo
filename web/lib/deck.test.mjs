import assert from "node:assert/strict";
import { test } from "node:test";
import { addSlide, editSlide, moveSlide, removeSlide, slidesOf } from "./deck.ts";

const sl = (id) => ({ id, title: id, note: "", image: "data:image/png;base64,x", at: 1 });

test("slides are added in order, per match, and the order can be changed", () => {
  let d = addSlide(undefined, "m1", sl("a"));
  d = addSlide(d, "m1", sl("b"));
  d = addSlide(d, "m2", sl("z"));
  d = addSlide(d, "m1", sl("c"));
  assert.deepEqual(slidesOf(d, "m1").map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(slidesOf(d, "m2").map((s) => s.id), ["z"]);
  d = moveSlide(d, "m1", "c", -1);
  assert.deepEqual(slidesOf(d, "m1").map((s) => s.id), ["a", "c", "b"]);
  assert.deepEqual(slidesOf(moveSlide(d, "m1", "a", -1), "m1").map((s) => s.id), ["a", "c", "b"], "the first one cannot go up");
  assert.deepEqual(slidesOf(moveSlide(d, "m1", "b", 1), "m1").map((s) => s.id), ["a", "c", "b"], "the last one cannot go down");
});

test("editing changes only title and note; removing the last slide drops the deck", () => {
  let d = addSlide(undefined, "m1", sl("a"));
  d = editSlide(d, "m1", "a", { title: "Tiros", note: "Mirar el carril izquierdo" });
  assert.equal(slidesOf(d, "m1")[0].title, "Tiros");
  assert.equal(slidesOf(d, "m1")[0].image, "data:image/png;base64,x");
  d = removeSlide(d, "m1", "a");
  assert.deepEqual(d, []);
});

import { blankSlide, clipSlide, dropItem, upsertItem } from "./deck.ts";

test("blank and clip slides carry no chart; pieces are added, changed and dropped by id", () => {
  assert.equal(blankSlide("b").image, undefined);
  assert.equal(clipSlide("c", "e1", "Córner").clip, "e1");
  let items = upsertItem(undefined, { id: "i1", kind: "text", x: 0.1, y: 0.2, text: "Hola", color: "ink" });
  items = upsertItem(items, { id: "i2", kind: "arrow", x: 0, y: 0, x2: 1, y2: 1, color: "warn" });
  items = upsertItem(items, { id: "i1", kind: "text", x: 0.5, y: 0.2, text: "Hola", color: "ink" });
  assert.equal(items.length, 2);
  assert.equal(items[0].x, 0.5);
  assert.deepEqual(dropItem(items, "i1").map((x) => x.id), ["i2"]);
});

import { upsertChartSlide } from "./deck.ts";

test("adding the same panel twice refreshes its slide instead of repeating it", () => {
  let d = upsertChartSlide(undefined, "m1", { id: "a", title: "Mapa", note: "", image: "one", source: "mapa-de-tiros", at: 1 });
  d = editSlide(d, "m1", "a", { note: "mirar el carril" });
  d = upsertChartSlide(d, "m1", { id: "b", title: "Mapa", note: "", image: "two", source: "mapa-de-tiros", at: 2 });
  d = upsertChartSlide(d, "m1", { id: "c", title: "Otro", note: "", image: "x", source: "otro", at: 3 });
  const list = slidesOf(d, "m1");
  assert.equal(list.length, 2);
  assert.equal(list[0].image, "two");
  assert.equal(list[0].note, "mirar el carril");
});

import { boardSlide } from "./deck.ts";
test("una diapositiva de animación apunta a un pizarrón o a una jugada", () => {
  const a = boardSlide("s1", { board: "b1" }, "ABP");
  assert.equal(a.kind, "board");
  assert.equal(a.board, "b1");
  const b = boardSlide("s2", { play: "p1" }, "Jugada");
  assert.equal(b.play, "p1");
  assert.equal(b.board, undefined);
});
