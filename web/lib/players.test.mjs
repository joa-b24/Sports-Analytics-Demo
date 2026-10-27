import assert from "node:assert/strict";
import { test } from "node:test";
import { METRICS, metricValue, playerRows, shownMetrics } from "./players.ts";

const ev = (id, type, team, player_id, extra = {}) => ({
  event_id: id, match_id: "m", video_id: "v1", t_video: 0, period: 1, type, team, player_id, x: null, y: null, outcome: null, detail: null, note: null, ...extra,
});
const metric = (key) => METRICS.find((m) => m.key === key);

test("events by player: a goal and its shot count once, names are trimmed, events without a player are left out", () => {
  const rows = playerRows({
    events: [
      ev("a", "shot", "own", "Paz", { t_video: 10, outcome: "on_target" }),
      ev("b", "goal", "own", "Paz ", { t_video: 11 }),
      ev("c", "shot", "own", "Kat", { t_video: 50, outcome: "off_target" }),
      ev("d", "recovery", "opp", "R7"),
      ev("e", "duel", "opp", "R7", { outcome: "won" }),
      ev("f", "duel", "opp", "R7", { outcome: "lost" }),
      ev("g", "loss", "own", null),
    ],
    parts: [],
  });
  const paz = rows.find((r) => r.key === "own|Paz");
  assert.equal(paz.shots, 1);
  assert.equal(paz.goals, 1);
  assert.equal(paz.on_target, 1);
  const r7 = rows.find((r) => r.key === "opp|R7");
  assert.equal(r7.recoveries, 1);
  assert.equal(metricValue(r7, metric("duel_pct")), 50);
  assert.equal(rows.length, 3);
});

test("without tracking the tracking figures are null, not 0, and are not offered", () => {
  const [r] = playerRows({ events: [ev("a", "recovery", "own", "Zoe")], parts: [] });
  assert.equal(r.minutes, null);
  assert.equal(r.touches, null);
  assert.equal(metricValue(r, metric("pass_pct")), null);
  // Per 10 minutes needs minutes measured.
  assert.equal(metricValue(r, metric("recoveries"), true), null);
  const keys = shownMetrics([r]).map((m) => m.key);
  assert.deepEqual(keys, ["recoveries"]);
});

test("touches, passes and minutes from a corrected part with the ball followed", () => {
  // 30 fps, a sample every 3 frames. Paz has the ball, passes to Kat (same team), Kat loses it to R7.
  const n = 60;
  const frames = Array.from({ length: n }, (_, i) => ({
    frame: i * 3,
    positions: [
      { id: 1, x: 40, y: 30, source: "auto" },
      { id: 2, x: 60, y: 30, source: "auto" },
      { id: 3, x: 80, y: 30, source: "auto" },
    ],
  }));
  const ball = [
    { frame: 0, x: 40, y: 30, source: "manual" },
    { frame: 30, x: 60, y: 30, source: "manual" },
    { frame: 60, x: 80, y: 30, source: "manual" },
  ];
  const file = {
    kind: "tracks_fixed", match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: n * 3, stride: 3,
    venue: { length_m: 105, width_m: 68 }, ball, frames,
    people: [
      { id: 1, team: "own", player_id: "Paz", tracks: [1] },
      { id: 2, team: "own", player_id: "Kat", tracks: [2] },
      { id: 3, team: "opp", player_id: "R7", tracks: [3] },
    ],
  };
  const rows = playerRows({ events: [], parts: [{ file, ownRight: true }] });
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by["own|Paz"].passes, 1);
  assert.equal(by["own|Paz"].progressive, 1); // 20 m forward
  assert.equal(by["own|Kat"].passes_cut, 1);
  assert.equal(by["opp|R7"].touches, 1);
  assert.ok(by["own|Paz"].minutes > 0);
  assert.equal(metricValue(by["own|Kat"], metric("pass_pct")), 0);
  // Nobody's events were tagged with a name: her event figures are not noted, not zero.
  assert.equal(metricValue(by["opp|R7"], metric("recoveries")), null);
});

// ---------------------------------------------------------------------------------------------- minutes played
const file2 = (video_id, names, frames = 900) => ({
  kind: "tracks_fixed", match_id: "m", video_id, fps: 30, start_frame: 0, end_frame: frames, stride: 3,
  venue: { length_m: 105, width_m: 68 }, ball: [],
  people: names.map(([n, id]) => ({ id, team: "own", player_id: n, tracks: [id] })),
  frames: Array.from({ length: 20 }, (_, k) => ({ frame: k * 3, positions: names.filter(([, , seen = true]) => seen !== false).map(([, id]) => ({ id, x: 50 + 0.1 * k, y: 30, source: "auto" })) })),
});
const seg = (start, end) => [{ segment_id: "s", start, end, tipo: "juego" }];
const sub = (t, out, inn, video_id = "v1") => ev(`s${t}`, "substitution", "own", out, { t_video: t, video_id, player_in: inn });

test("minutes played: clock of the half, substitutions and no-data substitute", () => {
  // Half = 600 s of play (100 to 700) => 10 min. Paz starter all half; Kat starter, out at 400 (5 min); Ita comes in.
  // First clip: only Paz and Kat. A later clip of the same half has everybody.
  const later = { ...file2("v1", [["Paz", 1], ["Kat", 2], ["Ita", 3], ["Mia", 4]]), start_frame: 900, end_frame: 1800 };
  const parts = [{ file: file2("v1", [["Paz", 1], ["Kat", 2], ["Ita", 3, false], ["Mia", 4, false]]), ownRight: true }, { file: later, ownRight: true }];
  const base = { parts, playByVideo: { v1: seg(100, 700) } };
  const m = (events) => Object.fromEntries(playerRows({ events, ...base }).map((r) => [r.id, r.minutes_played]));
  const none = m([]);
  assert.equal(none.Paz, 10);
  assert.equal(none.Kat, 10);
  assert.equal(none.Ita, null); // substitute with no substitution tagged
  const withSub = m([sub(400, "Kat", "Ita")]);
  assert.equal(withSub.Kat, 5);
  assert.equal(withSub.Ita, 5); // enters at 400: 700 - 400 = 300 s
  assert.equal(withSub.Paz, 10);
  assert.equal(withSub.Mia, null);
});

test("minutes played add the halves, which can come in several videos", () => {
  const parts = [
    { file: file2("v1", [["Paz", 1], ["Kat", 2]]), ownRight: true },
    { file: file2("v2", [["Paz", 1]]), ownRight: true },
    { file: file2("v3", [["Paz", 1]]), ownRight: true },
  ];
  const playByVideo = { v1: seg(0, 600), v2: seg(10, 310), v3: seg(0, 300) };
  const rows = playerRows({
    events: [], parts, playByVideo,
    videoPeriods: [{ video_id: "v1", period: 1 }, { video_id: "v2", period: 2 }, { video_id: "v3", period: 2 }],
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r.minutes_played]));
  assert.equal(by.Paz, 20); // 600 + 300 + 300 = 1200 s
  assert.equal(by.Kat, null); // starter in half 1, not in the first clip of half 2 and no entry tagged: no data
});
