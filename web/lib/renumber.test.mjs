import assert from "node:assert/strict";
import { test } from "node:test";
import { mapToken, renumberPlan, renumberPrefKey, renumberState, validMap } from "./renumber.ts";

test("el plan pone los videos, en el orden del partido, como v1..vn", () => {
  assert.deepEqual(renumberPlan([{ video_id: "v2" }, { video_id: "v1" }]), { v2: "v1", v1: "v2" });
  assert.equal(renumberPlan([{ video_id: "v1" }, { video_id: "v2" }]), null);
  assert.deepEqual(renumberPlan([{ video_id: "v1" }, { video_id: "v3" }]), { v3: "v2" });
});

test("un mapa válido: ids vN, sin repetir destino y sin pisar un video que no se mueve", () => {
  assert.equal(validMap({ v1: "v2", v2: "v1" }, ["v1", "v2"]), true);
  assert.equal(validMap({ v1: "v2" }, ["v1", "v2"]), false);
  assert.equal(validMap({ v3: "v2" }, ["v1", "v3"]), true);
  assert.equal(validMap({ v1: "x" }, ["v1"]), false);
  assert.equal(validMap({ v1: "v3", v2: "v3" }, ["v1", "v2"]), false);
});

test("nombres y claves con el id como palabra cambian todos a la vez", () => {
  const m = { v1: "v2", v2: "v1" };
  assert.equal(mapToken("tracks_v1_0_9.json", m), "tracks_v2_0_9.json");
  assert.equal(mapToken("carpeta|v2|0_9", m), "carpeta|v1|0_9");
  assert.equal(mapToken("tec_vs_up", m), "tec_vs_up");
  assert.equal(renumberPrefKey("attack:m1:v1", ["m1", "carpeta"], m), "attack:m1:v2");
  assert.equal(renumberPrefKey("attack:otro:v1", ["m1", "carpeta"], m), "attack:otro:v1");
  assert.equal(renumberPrefKey("skipPauses", ["m1"], m), "skipPauses");
});

const base = () => ({
  matches: [
    { match_id: "m1", folder: "carpeta", youtube_id: "AAA", videos: [{ video_id: "v1", youtube_id: "AAA", label: "segundo", period: 2 }, { video_id: "v2", youtube_id: "BBB", label: "primero", period: 1 }] },
    { match_id: "m2", folder: "otra", youtube_id: "ZZZ", videos: [{ video_id: "v1", youtube_id: "ZZZ", label: "x" }] },
  ],
  events: [{ event_id: "e1", match_id: "m1" }, { event_id: "e2", match_id: "m1", video_id: "v2" }, { event_id: "e3", match_id: "m2" }],
  plays: [{ play_id: "p1", match_id: "m1", video_id: "v1" }],
  segments: [{ mark_id: "s1", match_id: "m1", video_id: "v2" }],
  anchors: [{ anchor_id: "a1", match_id: "m1", video_id: "v1" }],
  passes: [],
  edits: [{ edit_id: "c1", match_id: "m1", video_id: "v2" }],
  trackEdits: [{ key: "carpeta|v1|0_90", identity: {}, anchorDoubts: ["links_v1_0_90.json"] }, { key: "otra|v1|0_90", identity: {} }],
  reviews: [],
});

test("el estado de un partido cambia de id sin tocar los demás, y cada dato sigue con su video", () => {
  const out = renumberState(base(), "m1", "carpeta", { v1: "v2", v2: "v1" });
  const m1 = out.matches[0];
  assert.deepEqual(m1.videos.map((v) => [v.video_id, v.youtube_id]), [["v1", "BBB"], ["v2", "AAA"]]);
  assert.equal(m1.youtube_id, "BBB");
  // A row with no video_id was v1: now it says v2. The other match is the same object.
  assert.deepEqual(out.events.map((e) => e.video_id), ["v2", "v1", undefined]);
  assert.equal(out.matches[1], base().matches[1] ? out.matches[1] : null);
  assert.equal(out.matches[1].videos[0].video_id, "v1");
  assert.equal(out.plays[0].video_id, "v2");
  assert.equal(out.segments[0].video_id, "v1");
  assert.equal(out.anchors[0].video_id, "v2");
  assert.equal(out.edits[0].video_id, "v1");
  assert.equal(out.trackEdits[0].key, "carpeta|v2|0_90");
  assert.deepEqual(out.trackEdits[0].anchorDoubts, ["links_v2_0_90.json"]);
  assert.equal(out.trackEdits[1].key, "otra|v1|0_90");
  // A swap done twice is the original again.
  const back = renumberState(out, "m1", "carpeta", { v1: "v2", v2: "v1" });
  assert.deepEqual(back.events.map((e) => e.video_id), ["v1", "v2", undefined].map((x, i) => (i === 0 ? "v1" : x)));
  assert.equal(back.trackEdits[0].key, "carpeta|v1|0_90");
});
