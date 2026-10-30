import test from "node:test";
import assert from "node:assert/strict";
import { parseHms, fmtHms } from "./segments.ts";

test("min:s and h:mm:ss are read as seconds; the test range goes to the command as HH:MM:SS", () => {
  assert.equal(parseHms("19:30"), 1170);
  assert.equal(parseHms("1:19:30"), 4770);
  assert.equal(parseHms("abc"), null);
  assert.equal(fmtHms(1170), "00:19:30");
  assert.equal(fmtHms(1170 + 45), "00:20:15");
});
