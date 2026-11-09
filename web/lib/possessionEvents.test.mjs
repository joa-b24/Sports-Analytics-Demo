import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorPossessionToEvents } from "./possessionEvents.ts";

const sample = (t0, team, kind = "control", extra = {}) => ({ video_id: "v1", part: 0, t0, t1: t0 + 1, followed: true, src: "manual", team, kind, player_interp: false, notes: [], owner: null, contact: true, contest: null, ...extra });
const ev = (t_video, type, team, video_id = "v1") => ({ event_id: `e${t_video}${type}`, match_id: "m", video_id, t_video, period: 1, type, team, player_id: null, x: null, y: null, outcome: null, detail: null, note: null });
const res = (samples) => ({ rows: [], samples, params: {} });

test("a tagged loss takes the ball away from the team that lost it, for 3 seconds", () => {
  const out = anchorPossessionToEvents(res([sample(9, "own"), sample(10, "own"), sample(12, "own"), sample(13, "own"), sample(10, "opp")]), [ev(10, "loss", "own")]);
  assert.equal(out.samples[0].team, "own", "before the loss it is still hers");
  assert.equal(out.samples[1].team, "none");
  assert.equal(out.samples[1].kind, "loose");
  assert.deepEqual(out.samples[1].notes, ["event_loss"]);
  assert.equal(out.samples[2].team, "none", "2 s after");
  assert.equal(out.samples[3].team, "own", "3 s after the window is over");
  assert.equal(out.samples[4].team, "opp", "the other team is not touched by her loss");
});

test("a tagged recovery gives the ball to the team that recovered it, but never a dead ball", () => {
  const out = anchorPossessionToEvents(res([sample(20, "opp"), sample(21, "none", "loose"), sample(21.5, "opp", "dead"), sample(23, "opp")]), [ev(20, "recovery", "own")]);
  assert.equal(out.samples[0].team, "own");
  assert.equal(out.samples[0].kind, "control");
  assert.equal(out.samples[1].team, "own");
  assert.equal(out.samples[2].team, "opp", "dead stays dead");
  assert.equal(out.samples[3].team, "opp", "outside the window");
});

test("events of another video, or without a team, change nothing and the same object comes back when there is nothing to do", () => {
  const input = res([sample(10, "own")]);
  assert.equal(anchorPossessionToEvents(input, [ev(10, "pass", "own")]), input);
  const out = anchorPossessionToEvents(input, [ev(10, "loss", "own", "v2")]);
  assert.equal(out.samples[0].team, "own");
});
