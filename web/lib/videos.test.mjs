import assert from "node:assert/strict";
import { test } from "node:test";
import { VIDEO_GAP_S, matchTimeline, matchVideos, nextVideo, videoOf } from "./videos.ts";

const ev = (id, t_video, video_id) => ({ event_id: id, match_id: "m", t_video, period: 1, type: "shot", team: "own", player_id: null, x: null, y: null, outcome: null, note: null, ...(video_id ? { video_id } : {}) });

test("a match saved before multi-video has one video with its old link", () => {
  assert.deepEqual(matchVideos({ youtube_id: "abc" }), [{ video_id: "v1", youtube_id: "abc", label: "1.er tiempo" }]);
  const two = [{ video_id: "v1", youtube_id: "a", label: "1" }, { video_id: "v2", youtube_id: "b", label: "2" }];
  assert.equal(matchVideos({ youtube_id: "a", videos: two }), two);
  assert.equal(videoOf({}), "v1");
  assert.equal(videoOf({ video_id: "v2" }), "v2");
});

test("the next video gets a free id and a sensible label", () => {
  const one = matchVideos({ youtube_id: "" });
  assert.deepEqual(nextVideo(one), { video_id: "v2", youtube_id: "", label: "2.º tiempo" });
  assert.equal(nextVideo([...one, { video_id: "v2", youtube_id: "", label: "" }]).video_id, "v3");
});

test("one video: the timeline is the video itself", () => {
  const events = [ev("b", 50), ev("a", 10)];
  const segs = { v1: [{ segment_id: "s01", start: 0, end: 100, tipo: "juego" }] };
  const tl = matchTimeline(matchVideos({ youtube_id: "" }), events, segs);
  assert.deepEqual(tl.events.map((e) => [e.event_id, e.t_video]), [["a", 10], ["b", 50]]);
  assert.deepEqual(tl.segments, segs.v1);
  assert.deepEqual(tl.offsets, { v1: 0 });
});

test("two videos: the second starts after the first, with a gap, and nothing is modified in place", () => {
  const videos = [{ video_id: "v1", youtube_id: "", label: "1" }, { video_id: "v2", youtube_id: "", label: "2" }];
  const first = ev("a", 2700); // legacy row: no video_id
  const second = ev("b", 30, "v2");
  const segs = {
    v1: [{ segment_id: "s01", start: 180, end: 2880, tipo: "juego" }],
    v2: [{ segment_id: "s01", start: 20, end: null, tipo: "juego" }],
  };
  const tl = matchTimeline(videos, [second, first], segs);
  const off = 2880 + VIDEO_GAP_S;
  assert.deepEqual(tl.offsets, { v1: 0, v2: off });
  assert.deepEqual(tl.events.map((e) => [e.event_id, e.t_video]), [["a", 2700], ["b", 30 + off]]);
  assert.equal(second.t_video, 30);
  assert.deepEqual(tl.segments.map((s) => [s.segment_id, s.start, s.end]), [["v1·s01", 180, 2880], ["v2·s01", 20 + off, null]]);
});
