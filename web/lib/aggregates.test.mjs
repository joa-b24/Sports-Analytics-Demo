import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregatesFingerprint, buildAggregates, parseAggregates } from "./aggregates.ts";
import { makeTrackingView } from "./trackingView.ts";

// 30 fps, one of every 3 frames; a named player of each team walks for 12 s.
const people = [
  { id: 1, team: "own", player_id: "Ana", tracks: [1] },
  { id: 2, team: "opp", player_id: "R7", tracks: [2] },
];
const file = {
  kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 360, stride: 3, venue: { length_m: 105, width_m: 68 }, people, ball: [], camera_cuts: [],
  frames: Array.from({ length: 120 }, (_, i) => ({ frame: i * 3, positions: [{ id: 1, x: 20 + 0.1 * i, y: 30, source: "auto" }, { id: 2, x: 80 - 0.1 * i, y: 40, source: "auto" }] })),
};
const parts = [{ file, ownRight: true }];

test("los agregados guardados dan lo mismo que calcular desde las posiciones", async () => {
  const fingerprint = aggregatesFingerprint({ files: [{ name: "tracks_fixed_v1_0_360.json", size: 10 }], segmentsByVideo: {}, attack: { v1: "right" }, events: [] });
  const agg = await buildAggregates({ match: { match_id: "m", name: "M", videos: [{ video_id: "v1" }] }, parts, videoIds: ["v1"], events: [], segmentsByVideo: {}, fingerprint });
  // Through the file: text and back.
  const back = parseAggregates(JSON.stringify(agg));
  assert.ok(back);
  const live = makeTrackingView({ parts, agg: null, segmentsByVideo: {}, videoIds: ["v1"] });
  const saved = makeTrackingView({ parts: [], agg: back, segmentsByVideo: {}, videoIds: ["v1"] });
  assert.equal(saved.source, "agg");
  assert.deepEqual(saved.has, live.has);
  assert.deepEqual(saved.physical("own"), live.physical("own"));
  assert.deepEqual(saved.block("own"), live.block("own"));
  const a = live.heat("own", "Ana");
  const b = saved.heat("own", "Ana");
  assert.equal(b.nx, a.nx);
  assert.ok(b.seconds.every((v, i) => Math.abs(v - a.seconds[i]) <= 0.006));
  assert.deepEqual(saved.passes("own"), live.passes("own"));
  assert.equal(saved.heat("own", "Nadie"), null);
  assert.deepEqual(saved.report().ingredients, JSON.parse(JSON.stringify(agg.report.ingredients)));
  assert.deepEqual(saved.shape(5), JSON.parse(JSON.stringify(live.shape(5))));
});

test("la huella cambia con los archivos de tracking, los tramos de juego y los cambios; no con otros eventos", () => {
  const base = { files: [{ name: "a.json", size: 1 }], segmentsByVideo: {}, attack: { v1: "right" }, events: [] };
  const fp = aggregatesFingerprint(base);
  assert.equal(aggregatesFingerprint({ ...base }), fp);
  assert.notEqual(aggregatesFingerprint({ ...base, files: [{ name: "a.json", size: 2 }] }), fp);
  assert.notEqual(aggregatesFingerprint({ ...base, attack: { v1: "left" } }), fp);
  const goal = { event_id: "g", type: "goal", team: "own", t_video: 5, video_id: "v1" };
  assert.equal(aggregatesFingerprint({ ...base, events: [goal] }), fp);
  const sub = { event_id: "s", type: "substitution", team: "own", player_id: "Ana", player_in: "Bea", t_video: 500, video_id: "v1" };
  assert.notEqual(aggregatesFingerprint({ ...base, events: [sub] }), fp);
});

test("parseAggregates rechaza lo que no es nuestro o es de otra versión", () => {
  assert.equal(parseAggregates(null), null);
  assert.equal(parseAggregates("no es json"), null);
  assert.equal(parseAggregates(JSON.stringify({ version: 99 })), null);
});
