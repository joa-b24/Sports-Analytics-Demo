import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, commandArgv } from "./commands.ts";

test("a command with no parameters chosen sends only its match and video", () => {
  const r = commandArgv("process", "2026_09_25_a_vs_b", "v1", {});
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["-m", "sportsan.tracking.process", "--match", "2026_09_25_a_vs_b", "--video", "v1"]);
});

test("a boolean flag and a number are sent only when chosen", () => {
  const r = commandArgv("process", "m1", "v2", { benchmark: true, stride: "3" });
  assert.ok(r.ok);
  assert.deepEqual(r.argv.slice(6), ["--benchmark", "--stride", "3"]);
  assert.match(r.shown, /^python -m sportsan\.tracking\.process /);
});

test("values out of range, bad times and bad files are refused", () => {
  assert.equal(commandArgv("process", "m1", "v1", { stride: "0" }).ok, false);
  assert.equal(commandArgv("process", "m1", "v1", { stride: "abc" }).ok, false);
  assert.equal(commandArgv("process", "m1", "v1", { start: "33 minutos" }).ok, false);
  assert.equal(commandArgv("propagate", "m1", "v1", { anchors: "../../secreto.json" }).ok, false);
  assert.equal(commandArgv("propagate", "m1", "v1", { anchors: "otro.json" }).ok, false);
});

test("a required parameter is demanded, and a file is placed inside tracking/ of the match", () => {
  assert.equal(commandArgv("propagate", "m1", "v1", {}).ok, false);
  const r = commandArgv("propagate", "m1", "v1", { anchors: "anchors_m1_v1.json", noDirect: true });
  assert.ok(r.ok);
  assert.deepEqual(r.argv.slice(6), ["--anchors", "matches/m1/tracking/anchors_m1_v1.json", "--no-direct"]);
});

test("library subcommands go right after the module, and build needs a source", () => {
  assert.equal(commandArgv("library-build", "m1", "v1", {}).ok, false);
  const r = commandArgv("library-locate", "m1", "v1", { start: "0:33:20", end: "0:33:35" });
  assert.ok(r.ok);
  assert.deepEqual(r.argv.slice(0, 4), ["-m", "sportsan.tracking.library", "locate", "--match"]);
});

test("a match folder or video that could carry a flag is refused; overnight takes no video", () => {
  assert.equal(commandArgv("process", "m1 --force", "v1", {}).ok, false);
  assert.equal(commandArgv("process", "m1", "v1;rm", {}).ok, false);
  const r = commandArgv("overnight", "m1", "", { plan: true });
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["-m", "sportsan.tracking.overnight", "--match", "m1", "--plan"]);
  assert.equal(commandArgv("nope", "m1", "v1", {}).ok, false);
});

test("every parameter has a distinct id and a flag in the catalog", () => {
  for (const c of COMMANDS) {
    const ids = c.params.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, c.id);
    for (const p of c.params) assert.match(p.flag, /^--[a-z-]+$/);
  }
});

test("pedir prestada la biblioteca de otro video, y probar una biblioteca concreta", () => {
  const r = commandArgv("library-borrow", "m1", "v1", { fromVideo: "v2" });
  assert.ok(r.ok);
  assert.deepEqual(r.argv, ["-m", "sportsan.tracking.library", "borrow", "--match", "m1", "--video", "v1", "--from-video", "v2"]);
  assert.equal(commandArgv("library-borrow", "m1", "v1", {}).ok, false);
  assert.equal(commandArgv("library-borrow", "m1", "v1", { fromVideo: "v2 --force" }).ok, false);
  const c = commandArgv("library-check", "m1", "v1", { library: "library_v1.npz", samples: "8" });
  assert.ok(c.ok);
  assert.deepEqual(c.argv.slice(7), ["--library", "matches/m1/tracking/library_v1.npz", "--samples", "8"]);
  assert.equal(commandArgv("library-check", "m1", "v1", { library: "library_v1.exe" }).ok, false);
});
