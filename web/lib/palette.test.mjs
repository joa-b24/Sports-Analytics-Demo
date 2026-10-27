import assert from "node:assert/strict";
import { test } from "node:test";
import { PALETTE_SLOTS, colorValue, parsePalette, serializePalette, withOverride } from "./palette.ts";

test("un nombre del color da su token; sin override no hay colores literales", () => {
  assert.equal(colorValue("warn"), "var(--color-warn)");
  assert.ok(PALETTE_SLOTS.every((s) => s.css.startsWith("var(") || s.css.startsWith("color-mix(")));
  assert.equal(colorValue("no_existe"), colorValue("accent"));
  assert.equal(colorValue(undefined), colorValue("accent"));
});

test("el override gana, un hex libre se respeta y restablecer vuelve al token", () => {
  let o = withOverride({}, "danger", "#FF0000");
  assert.equal(colorValue("danger", o), "#ff0000");
  assert.equal(colorValue("#123abc", o), "#123abc");
  o = withOverride(o, "danger", null);
  assert.equal(colorValue("danger", o), "var(--color-danger)");
});

test("parsePalette descarta lo inválido y viaja por texto", () => {
  const o = parsePalette(JSON.stringify({ ok: "#00ff00", warn: "rojo", zzz: "#000000" }));
  assert.deepEqual(o, { ok: "#00ff00" });
  assert.deepEqual(parsePalette(serializePalette(o)), o);
  assert.deepEqual(parsePalette("{no json"), {});
  assert.deepEqual(parsePalette(null), {});
});
