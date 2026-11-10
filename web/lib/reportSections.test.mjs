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

import { layoutOf as layoutOfX, withExtra, withoutExtra } from "./reportSections.ts";

test("a chart added to the report is a section at the end; the same panel refreshes it; it can be removed", () => {
  let r = withExtra({}, { id: "e1", title: "Mapa de tiros", image: "one", source: "mapa-de-tiros" });
  assert.equal(r.sections.at(-1), "x:e1");
  assert.ok(layoutOfX(r.sections, r.extras).includes("x:e1"));
  r = withExtra(r, { id: "e2", title: "Mapa de tiros", image: "two", source: "mapa-de-tiros" });
  assert.equal(r.extras.length, 1);
  assert.equal(r.extras[0].image, "two");
  assert.equal(r.sections.filter((s) => s === "x:e1").length, 1);
  r = withoutExtra(r, "e1");
  assert.equal(r.extras.length, 0);
  assert.ok(!r.sections.includes("x:e1"));
  assert.ok(!layoutOfX(["x:gone"], []).includes("x:gone"), "an extra that does not exist is dropped");
});
