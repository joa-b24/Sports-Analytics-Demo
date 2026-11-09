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
