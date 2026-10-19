import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SECTIONS, layoutOf, moveSection, toggleSection } from "./reportSections.ts";

test("the default layout starts with General and leaves the locked library out", () => {
  assert.equal(DEFAULT_SECTIONS[0], "general");
  assert.ok(!DEFAULT_SECTIONS.includes("patterns"));
  assert.deepEqual(layoutOf(undefined), DEFAULT_SECTIONS);
});

test("an analyst's layout keeps its order, drops unknown, repeated and locked ids", () => {
  assert.deepEqual(layoutOf(["shots", "nope", "general", "shots", "patterns"]), ["shots", "general"]);
});

test("move and toggle", () => {
  assert.deepEqual(moveSection(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveSection(["a", "b"], "a", -1), ["a", "b"]);
  assert.deepEqual(toggleSection(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleSection(["b"], "a"), ["b", "a"]);
});
