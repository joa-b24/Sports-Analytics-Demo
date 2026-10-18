import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_FILTER, activeAt, cleanEnd, retype, duplicatesOf, eventsFor, knownPlayers, missingEnd, missingReview } from "./tagging.ts";

const ev = (id, t, type = "shot", team = "own", extra = {}) => ({
  event_id: id, match_id: "m", video_id: "v1", t_video: t, period: 1, type, team, player_id: null, x: null, y: null,
  outcome: null, detail: null, note: null, ...extra,
});

test("the same type and team within 3 s is a possible duplicate", () => {
  const list = [ev("a", 10), ev("b", 12.5), ev("c", 12.5, "shot", "opp"), ev("d", 12.5, "corner"), ev("e", 14), ev("f", 12, "shot", "own", { video_id: "v2" })];
  assert.deepEqual(duplicatesOf(list, list[0]).map((e) => e.event_id), ["b"]);
  assert.deepEqual(duplicatesOf(list, list[1]).map((e) => e.event_id), ["a", "e"]);
});

test("an event is active from its time for two seconds", () => {
  const list = [ev("a", 10), ev("b", 11.5), ev("c", 20)];
  assert.deepEqual(activeAt(list, 11.9).map((e) => e.event_id), ["a", "b"]);
  assert.deepEqual(activeAt(list, 9.9), []);
  assert.deepEqual(activeAt(list, 12).map((e) => e.event_id), ["b"]);
});

test("what each pass still needs", () => {
  assert.deepEqual(missingReview(ev("a", 1)), ["posición", "resultado"]);
  assert.deepEqual(missingReview(ev("a", 1, "foul", "own", { x: 50, y: 30 })), []);
  assert.deepEqual(missingReview(ev("a", 1, "shot", "own", { x: 90, y: 30, outcome: "blocked" })), []);
  assert.equal(missingEnd(ev("a", 1, "shot")), true);
  assert.equal(missingEnd(ev("a", 1, "penalty", "own", { goal_y: 1, goal_z: 0.5 })), false);
  assert.equal(missingEnd(ev("a", 1, "cross", "own", { x_end: 98, y_end: 30 })), false);
  assert.equal(missingEnd(ev("a", 1, "foul")), null);
});

test("each pass works on its events, filtered and in time order", () => {
  const list = [
    ev("a", 30, "cross", "own", { player_id: "Ana" }),
    ev("b", 10, "shot", "opp", { goal_y: 2, goal_z: 1 }),
    ev("c", 20, "foul", "own", { x: 50, y: 30 }),
    ev("d", 5, "corner", "own"),
  ];
  assert.deepEqual(eventsFor(1, list, NO_FILTER).map((e) => e.event_id), ["d", "b", "c", "a"]);
  assert.deepEqual(eventsFor(3, list, NO_FILTER).map((e) => e.event_id), ["d", "b", "a"]);
  assert.deepEqual(eventsFor(3, list, { ...NO_FILTER, onlyMissing: true }).map((e) => e.event_id), ["d", "a"]);
  assert.deepEqual(eventsFor(2, list, { ...NO_FILTER, onlyMissing: true }).map((e) => e.event_id), ["d", "b", "a"]);
  assert.deepEqual(eventsFor(2, list, { ...NO_FILTER, team: "own", types: ["cross", "foul"] }).map((e) => e.event_id), ["c", "a"]);
  assert.deepEqual(eventsFor(2, list, { ...NO_FILTER, player: "an" }).map((e) => e.event_id), ["a"]);
  assert.deepEqual(knownPlayers([...list, ev("e", 1, "loss", "own", { player_id: "Bea" }), ev("f", 2, "loss", "own", { player_id: "Bea" })]), ["Bea", "Ana"]);
});

test("a new type keeps the end position only when it takes the same kind", () => {
  assert.deepEqual(retype({ type: "shot" }, "penalty"), { type: "penalty", outcome: null, detail: null });
  assert.deepEqual(retype({ type: "shot" }, "foul"), { type: "foul", outcome: null, detail: null, x_end: null, y_end: null, goal_y: null, goal_z: null });
  assert.equal(retype({ type: "cross" }, "shot").goal_y, null);
  assert.deepEqual(cleanEnd("shot", { x_end: 90, y_end: 30, goal_y: 2, goal_z: null }), { x_end: null, y_end: null, goal_y: null, goal_z: null });
  assert.deepEqual(cleanEnd("corner", { x_end: 94, y_end: 34, goal_y: 2, goal_z: 1 }), { x_end: 94, y_end: 34, goal_y: null, goal_z: null });
});

test("pasada 3: un tiro bloqueado no pide dirección a puerta, ni un tiro libre que no fue tiro", () => {
  assert.equal(missingEnd(ev("a", 1, "shot", "own", { outcome: "blocked" })), null);
  assert.equal(missingEnd(ev("a", 1, "shot", "own", { outcome: "off_target" })), true);
  assert.equal(missingEnd(ev("a", 1, "free_kick", "own", { outcome: "cleared" })), null);
  assert.equal(missingEnd(ev("a", 1, "free_kick", "own", { outcome: "shot" })), true);
  assert.equal(missingEnd(ev("a", 1, "free_kick")), true);
  const evs = [ev("b", 1, "shot", "own", { outcome: "blocked" }), ev("c", 2, "shot", "own"), ev("d", 3, "foul")];
  assert.deepEqual(eventsFor(3, evs, NO_FILTER).map((e) => e.event_id), ["c"]);
});
