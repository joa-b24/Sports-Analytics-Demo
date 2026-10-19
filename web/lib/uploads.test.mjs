import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsFromCsv, formatBytes, innerKind, matchFromYaml, parseMatchYaml, planZip, trackingInner, uploadTarget, videoInner, zipTopFolder } from "./uploads.ts";

test("innerKind accepts the files of a match folder and nothing else", () => {
  assert.equal(innerKind("video/v1.mp4"), "video");
  assert.equal(innerKind("video/v2.MOV"), "video");
  assert.equal(innerKind("tracking/tracks_fixed_v1_0_900.json"), "tracking");
  assert.equal(innerKind("tracking/library_v1.npz"), "tracking");
  assert.equal(innerKind("tracking/calib_v1_6294_8092.json"), "tracking");
  assert.equal(innerKind("match.yaml"), "match");
  assert.equal(innerKind("segments.csv"), "match");
  assert.equal(innerKind("edits/edit_abc.json"), "edits");
  assert.equal(innerKind("report_partido.json"), "report");
  assert.equal(innerKind("video/../../x.mp4"), null);
  assert.equal(innerKind("tracking/evil.exe"), null);
  assert.equal(innerKind("events/events.csv"), null);
  assert.equal(innerKind("video/v1.mp4.part"), null);
  assert.equal(innerKind("tracking//tracks_a.json"), null);
});

test("uploadTarget needs matches/<folder>/<accepted path>", () => {
  assert.deepEqual(uploadTarget("matches/2026_10_01_a_vs_b/video/v1.mp4"), { folder: "2026_10_01_a_vs_b", inner: "video/v1.mp4", kind: "video" });
  assert.equal(uploadTarget("matches/../config/video/v1.mp4"), null);
  assert.equal(uploadTarget("matches/.hidden/match.yaml"), null);
  assert.equal(uploadTarget("config/roster.json"), null);
  assert.equal(uploadTarget("matches/x/README.md"), null);
});

test("videoInner and trackingInner place chosen files", () => {
  assert.equal(videoInner("v2", "Partido 2do tiempo.MP4"), "video/v2.mp4");
  assert.equal(videoInner("v1", "clip.avi"), null);
  assert.equal(videoInner("../v1", "a.mp4"), null);
  assert.equal(trackingInner("tracks_v1_0_900.json"), "tracking/tracks_v1_0_900.json");
  assert.equal(trackingInner("foto.png"), null);
});

test("zipTopFolder strips the folder zipped as a whole", () => {
  assert.equal(zipTopFolder(["partido/match.yaml", "partido/video/v1.mp4", "partido/"]), "partido/");
  assert.equal(zipTopFolder(["matches/p/match.yaml", "matches/p/tracking/tracks_a.json"]), "matches/p/");
  assert.equal(zipTopFolder(["match.yaml", "video/v1.mp4"]), null);
  assert.equal(zipTopFolder(["video/v1.mp4", "video/v2.mp4"]), null);
  assert.equal(zipTopFolder(["a/match.yaml", "b/match.yaml"]), null);
  assert.equal(zipTopFolder(["p\\match.yaml", "p\\video\\v1.mp4", "__MACOSX/p/._match.yaml"]), "p/");
});

test("planZip maps entries and explains the ones it skips", () => {
  const plan = planZip([
    { name: "p/", size: 0 },
    { name: "p/match.yaml", size: 300 },
    { name: "p/video/v1.mp4", size: 5e9 },
    { name: "p/tracking/tracks_v1_0_9.json", size: 10 },
    { name: "p/notas.txt", size: 4 },
    { name: "p/.DS_Store", size: 4 },
  ]);
  assert.equal(plan.top, "p/");
  assert.deepEqual(
    plan.entries.map((e) => [e.inner, e.kind]),
    [
      ["match.yaml", "match"],
      ["video/v1.mp4", "video"],
      ["tracking/tracks_v1_0_9.json", "tracking"],
      [null, null],
    ],
  );
  assert.ok(plan.entries[3].reason);
  const slip = planZip([{ name: "../../etc/passwd", size: 1 }]);
  assert.equal(slip.entries[0].inner, null);
});

const YAML = `match_id: partido_2026_09_25
kind: own                       # own = partido nuestro
date: "2026-09-25"
own_team_name: "Tec CCM"
other_team_name: "Anáhuac"   # jornada 1
analysis_stride: 3

venue:
  name: "Estadio"
  pitch_length_m: 102

videos:
  - video_id: v1
    period: 1
    youtube_id: "_-utAbJNqhI"
    file: video/v1.mp4
    jersey_colors: {own: "#5c5a72"}
  - video_id: v2
    period: 2
    label: "2.do tiempo (parte 1)"
    youtube_id: "REEMPLAZAR"
  # - video_id: v9
`;

test("parseMatchYaml reads the fields the app uses and drops placeholders", () => {
  const y = parseMatchYaml(YAML);
  assert.equal(y.match_id, "partido_2026_09_25");
  assert.equal(y.kind, "own");
  assert.equal(y.date, "2026-09-25");
  assert.equal(y.own_team_name, "Tec CCM");
  assert.equal(y.other_team_name, "Anáhuac");
  assert.deepEqual(y.videos, [
    { video_id: "v1", youtube_id: "_-utAbJNqhI", period: 1 },
    { video_id: "v2", period: 2, label: "2.do tiempo (parte 1)" },
  ]);
  assert.deepEqual(parseMatchYaml("kind: rival\nown_team_name: UP\n").videos, []);
});

test("matchFromYaml creates a match or only fills what an existing one lacks", () => {
  const y = parseMatchYaml(YAML);
  const m = matchFromYaml(y, "carpeta", undefined, "m_1");
  assert.equal(m.match_id, "m_1");
  assert.equal(m.folder, "carpeta");
  assert.equal(m.kind, "own");
  assert.equal(m.focus_team, "Tec CCM");
  assert.equal(m.other_team, "Anáhuac");
  assert.equal(m.youtube_id, "_-utAbJNqhI");
  assert.equal(m.videos.length, 2);
  assert.equal(m.videos[1].youtube_id, "");

  const existing = { ...m, match_id: "m_0", focus_team: "Nosotras", date: "2026-09-26", youtube_id: "", videos: [{ video_id: "v1", youtube_id: "", label: "Primer tiempo" }] };
  const up = matchFromYaml(y, "otra", existing, "m_2");
  assert.equal(up.match_id, "m_0");
  assert.equal(up.folder, "carpeta");
  assert.equal(up.focus_team, "Nosotras");
  assert.equal(up.date, "2026-09-26");
  assert.deepEqual(up.videos.map((v) => [v.video_id, v.youtube_id, v.label]), [
    ["v1", "_-utAbJNqhI", "Primer tiempo"],
    ["v2", "", "2.do tiempo (parte 1)"],
  ]);
  assert.equal(matchFromYaml(parseMatchYaml("kind: raro\n"), "f", undefined, "x").kind, "own");
});

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(3.2 * 1024 ** 3), "3.2 GB");
});

test("eventsFromCsv keeps valid rows, skips the rest and never fills gaps", () => {
  let n = 0;
  const out = eventsFromCsv(
    [
      { t_video: "12,5", type: "shot", team: "own", x: "90", y: "30", period: "2", video_id: "v2" },
      { t_video: "", type: "shot" },
      { t_video: "3", type: "inventado" },
      { t_video: "-1", type: "shot" },
      { t_video: "40", type: "recovery", team: "nadie", x: "200", y: "" },
    ],
    "m1",
    () => `e${n++}`,
  );
  assert.equal(out.skipped, 3);
  assert.equal(out.offPitch, 1);
  assert.equal(out.events.length, 2);
  assert.deepEqual([out.events[0].t_video, out.events[0].period, out.events[0].video_id, out.events[0].x], [12.5, 2, "v2", 90]);
  assert.deepEqual([out.events[1].team, out.events[1].x, out.events[1].y, out.events[1].video_id], ["unk", null, null, "v1"]);
});
