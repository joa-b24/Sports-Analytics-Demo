import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_FILTER, filterPlays, matchPlays, playTraits, typesPresent } from "./matchPlays.ts";

const videos = [
  { video_id: "v1", youtube_id: "a", label: "1.er tiempo" },
  { video_id: "v2", youtube_id: "b", label: "2.º tiempo" },
];
const play = (id, t0, video_id, extra = {}) => ({ play_id: id, match_id: "m", ...(video_id ? { video_id } : {}), title: id, t_start: t0, t_end: t0 + 10, note: "", keyframes: [], ...extra });
const ev = (id, t, type, team, video_id) => ({ event_id: id, match_id: "m", ...(video_id ? { video_id } : {}), t_video: t, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, note: null });

const plays = [play("c", 30, "v2"), play("a", 500), play("b", 20, "v1", { abp: true }), play("d", 5, "v2")];
const events = [ev("e1", 22, "shot", "own", "v1"), ev("e2", 8, "loss", "opp", "v2"), ev("e3", 505, "key_pass", "own")];

test("todas las jugadas de todos los videos, por tiempo del partido; sin video_id es v1", () => {
  const list = matchPlays({ videos }, videos, plays, events, new Set(["a"]));
  assert.deepEqual(list.map((m) => m.play.play_id), ["b", "a", "d", "c"]);
  assert.deepEqual(list.map((m) => m.video_id), ["v1", "v1", "v2", "v2"]);
  assert.ok(list[2].t_match > list[1].t_match + 100, "el 2.º tiempo va después, con su hueco");
  assert.equal(list[1].edited, true);
});

test("tipo y equipo salen de los eventos dentro del tramo; sin eventos, nulos", () => {
  assert.deepEqual(playTraits(plays[2], events), { type: "shot", team: "own" });
  assert.deepEqual(playTraits(plays[0], events), { type: null, team: null });
  assert.deepEqual(playTraits(plays[3], events), { type: "loss", team: "opp" });
});

test("filtros por video, tipo, ABP, con dibujos y equipo", () => {
  const list = matchPlays({ videos }, videos, plays, events, new Set(["a"]));
  assert.equal(filterPlays(list, NO_FILTER).length, 4);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, video: "v2" }).map((m) => m.play.play_id), ["d", "c"]);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, kind: "abp" }).map((m) => m.play.play_id), ["b"]);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, kind: "edited" }).map((m) => m.play.play_id), ["a"]);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, kind: "loss" }).map((m) => m.play.play_id), ["d"]);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, team: "opp" }).map((m) => m.play.play_id), ["d"]);
  assert.deepEqual(filterPlays(list, { ...NO_FILTER, team: "none" }).map((m) => m.play.play_id), ["c"]);
  assert.deepEqual(typesPresent(list).sort(), ["key_pass", "loss", "shot"]);
});

test("una jugada de un video que ya no existe se lee como del primero", () => {
  const list = matchPlays({ videos }, videos, [play("z", 3, "v9")], [], new Set());
  assert.equal(list[0].video_id, "v1");
});
