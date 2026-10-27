import assert from "node:assert/strict";
import { test } from "node:test";
import { consumedAt, loopAction, loopWindow, parseMargin } from "./clipLoop.ts";

const e = { t_start: 100, t_end: 110 };

test("el bucle repite el tramo con margen y no baja de 0", () => {
  assert.deepEqual(loopWindow(e, 2), { start: 98, end: 112 });
  assert.deepEqual(loopWindow({ t_start: 1, t_end: 5 }, 3), { start: 0, end: 8 });
});

test("sin bucle se detiene al final; con bucle reinicia al final de la ventana", () => {
  assert.equal(loopAction(109.9, e, false, 0), "continue");
  assert.equal(loopAction(110, e, false, 0), "stop");
  assert.equal(loopAction(110, e, true, 0), "restart");
  assert.equal(loopAction(111, e, true, 2), "continue");
  assert.equal(loopAction(112, e, true, 2), "restart");
});

test("los márgenes válidos son 0 a 3; las pausas de atrás cuentan como hechas", () => {
  assert.equal(parseMargin("2"), 2);
  assert.equal(parseMargin("9"), 0);
  assert.equal(parseMargin(null), 0);
  assert.deepEqual([...consumedAt([101, 105, 108], 105)], [101]);
  assert.deepEqual([...consumedAt([101, 105], 98)], []);
});
