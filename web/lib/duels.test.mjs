import assert from "node:assert/strict";
import { test } from "node:test";
import { completeDuels, duelOwner } from "./duels.ts";

// A part of 30 fps, one frame every 3: two of ours with names, one of ours without, one rival.
const part = {
  ownRight: true,
  file: {
    kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, ball: [],
    people: [
      { id: 1, team: "own", player_id: "Paz", tracks: [1] },
      { id: 2, team: "own", player_id: "Ana", tracks: [2] },
      { id: 3, team: "own", player_id: null, tracks: [3] },
      { id: 4, team: "opp", player_id: null, tracks: [4] },
    ],
    frames: [0, 3, 6, 9, 12].map((frame) => ({
      frame,
      positions: [
        { id: 1, x: 50, y: 30, source: "manual" },
        { id: 2, x: 60, y: 30, source: "manual" },
        { id: 3, x: 51, y: 31, source: "auto" }, // closer than Paz, but nobody knows who she is
        { id: 4, x: 50.5, y: 30, source: "auto" }, // the rival: never credited
      ],
    })),
  },
};
const duel = (id, t, extra = {}) => ({ event_id: id, match_id: "m", video_id: "v1", t_video: t, period: 1, type: "duel", team: "own", player_id: null, x: null, y: null, outcome: "won", detail: "ground", note: null, ...extra });

test("the player of a duel is the named one of our team nearest to its spot", () => {
  assert.equal(duelOwner([part], duel("a", 0.2, { x: 59, y: 30 }))?.player_id, "Ana");
  assert.equal(duelOwner([part], duel("b", 0.2, { x: 49, y: 30 }))?.player_id, "Paz", "the unnamed one and the rival do not count");
});

test("nobody is credited when nobody named is close or the tracking does not cover the moment", () => {
  assert.equal(duelOwner([part], duel("a", 0.2, { x: 5, y: 5 })), null);
  assert.equal(duelOwner([part], duel("b", 50, { x: 50, y: 30 })), null);
  assert.equal(duelOwner([], duel("c", 0.2, { x: 50, y: 30 })), null);
});

test("completeDuels only touches the duels without a player, and sets our team", () => {
  const events = [duel("a", 0.2, { x: 59, y: 30, team: "unk" }), duel("b", 0.2, { x: 49, y: 30, player_id: "Lola" }), duel("c", 50, { x: 50, y: 30 }), { ...duel("d", 0.2), type: "loss" }];
  const r = completeDuels(events, [part]);
  assert.equal(r.pending, 2, "a and c have no player");
  assert.deepEqual(r.patches, [{ event_id: "a", patch: { player_id: "Ana", team: "own" } }]);
});
