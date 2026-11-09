import { test } from "node:test";
import assert from "node:assert/strict";
import { dirtyPartKeys, backupName, backupsToDelete, dirtyItems, eventsPath, hashText, isConflict, matchBackup, matchItems, partHash, stableJson, statusText } from "./saveAll.ts";

const edits = (key, extra = {}) => ({ key, identity: {}, people: {}, removed: [], splits: [], manual: [], dropped: [], ...extra });
const ev = (id, t, extra = {}) => ({ event_id: id, match_id: "m1", video_id: "v1", t_video: t, period: 1, type: "shot", team: "own", player_id: null, x: 50, y: 30, outcome: null, note: null, ...extra });

test("la huella no depende del orden de las claves y cambia con cualquier corrección", () => {
  assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  const a = edits("f|v1|0_900");
  const b = edits("f|v1|0_900", { removed: [4] });
  assert.equal(partHash(a, [], ""), partHash(edits("f|v1|0_900"), [], ""));
  assert.notEqual(partHash(a, [], ""), partHash(b, [], ""));
  assert.notEqual(hashText("a"), hashText("b"));
});

test("los eventos solo cambian la huella de una parte si dan balón (sentido de ataque conocido) y son de su video", () => {
  const a = edits("f|v1|0_900");
  assert.equal(partHash(a, [ev("e1", 3)], ""), partHash(a, [], ""));
  assert.notEqual(partHash(a, [ev("e1", 3)], "right"), partHash(a, [], "right"));
  assert.equal(partHash(a, [ev("e1", 3, { video_id: "v2" })], "right"), partHash(a, [], "right"));
});

test("qué partes están sin guardar", () => {
  const state = { trackEdits: [edits("f|v1|0_900"), edits("f|v1|900_1800", { removed: [1] }), edits("otro|v1|0_900")], events: [ev("e1", 3)] };
  const items = matchItems(state, { match_id: "m1", folder: "f" }, () => "");
  assert.deepEqual(items.map((i) => i.id), ["part:f|v1|0_900", "part:f|v1|900_1800", "events"]);
  const log = Object.fromEntries(items.map((i) => [i.id, { hash: i.hash, at: 1000 }]));
  assert.equal(dirtyItems(items, log).length, 0);
  state.trackEdits[1] = edits("f|v1|900_1800", { removed: [1, 2] });
  const after = matchItems(state, { match_id: "m1", folder: "f" }, () => "");
  assert.deepEqual(dirtyItems(after, log).map((i) => i.id), ["part:f|v1|900_1800"]);
  assert.match(statusText(after, log).text, /^Sin guardar: 1 cambio en 1 parte$/);
  delete log.events;
  assert.match(statusText(after, log).text, /^Sin guardar: 2 cambios en 1 parte$/);
  assert.equal(matchItems(state, { match_id: "m1" }, () => "").length, 0);
});

test("todo guardado dice la hora del último guardado", () => {
  const items = [{ id: "events", kind: "events", label: "Eventos", hash: "x" }];
  const at = new Date(2026, 9, 25, 14, 7).getTime();
  assert.equal(statusText(items, { events: { hash: "x", at } }).text, "Todo guardado a las 14:07");
});

test("conflicto: archivo de la carpeta más nuevo que el último guardado de este navegador", () => {
  assert.equal(isConflict(null, undefined), false);
  assert.equal(isConflict(5000, undefined), true);
  assert.equal(isConflict(5000, { hash: "h", at: 4000 }), false);
  assert.equal(isConflict(10_000, { hash: "h", at: 4000 }), true);
});

test("rotación de respaldos: quedan los 5 más recientes y nada más se toca", () => {
  const names = ["notas.json", ...[1, 2, 3, 4, 5, 6, 7].map((d) => `respaldo_2026-10-0${d}_1200.json`)];
  assert.deepEqual(backupsToDelete(names), ["respaldo_2026-10-02_1200.json", "respaldo_2026-10-01_1200.json"]);
  assert.deepEqual(backupsToDelete(names.slice(0, 3)), []);
  assert.equal(backupName(new Date(2026, 9, 5, 9, 3)), "respaldo_2026-10-05_0903.json");
});

test("los eventos van a su CSV de la carpeta si ya hay uno", () => {
  assert.equal(eventsPath("f", [], []), "matches/f/events_f.csv");
  assert.equal(eventsPath("f", ["events_viejo.csv"], []), "matches/f/events_viejo.csv");
  assert.equal(eventsPath("f", [], ["events_f.csv"]), "matches/f/events/events_f.csv");
});

test("el respaldo de un partido solo lleva lo suyo", () => {
  const state = {
    matches: [{ match_id: "m1", folder: "f" }, { match_id: "m2" }],
    events: [ev("e1", 1), ev("e2", 2, { match_id: "m2" })],
    plays: [], sessions: [{ x: 1 }], anchors: [], segments: [], venues: [], roster: [{ player_id: "Ana", number: 9 }],
    trackEdits: [edits("f|v1|0_9"), edits("g|v1|0_9")], passes: [], boards: [], edits: [], jerseys: { f: { own: "#000" }, g: {} },
  };
  const b = matchBackup(state, state.matches[0]);
  assert.equal(b.events.length, 1);
  assert.equal(b.trackEdits.length, 1);
  assert.deepEqual(Object.keys(b.jerseys), ["f"]);
  assert.equal(b.sessions.length, 0);
});

test("dirtyPartKeys flags every part with unsaved corrections, not only the one saved last", () => {
  const e1 = { key: "f|v1|0_900", ball: [] };
  const e2 = { key: "f|v1|900_1800", ball: [] };
  const other = { key: "g|v1|0_900", ball: [] };
  const att = () => "";
  const log = {};
  assert.deepEqual([...dirtyPartKeys([e1, e2, other], "f", [], att, log)].sort(), [e1.key, e2.key]);
  log[`part:${e1.key}`] = { hash: partHash(e1, [], ""), at: 1 };
  assert.deepEqual([...dirtyPartKeys([e1, e2], "f", [], att, log)], [e2.key]);
  const e1b = { ...e1, ball: [{ frame: 3 }] };
  assert.deepEqual([...dirtyPartKeys([e1b, e2], "f", [], att, log)].sort(), [e1.key, e2.key]);
});
