// Run with: node --test "lib/*.test.mjs"   (Node 24 strips the TypeScript types on import)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtHms, marksFromCsvRows, parseHms, segmentAt, segmentsCsv, segmentsFromMarks, skipTarget, totalSeconds } from "./segments.ts";

const mark = (t_video, tipo) => ({ mark_id: `m${t_video}`, match_id: "m", t_video, tipo });

test("marks become consecutive segments, in time order", () => {
  const segs = segmentsFromMarks([mark(190, "juego"), mark(0, "pausa"), mark(2700, "fin")]);
  assert.deepEqual(segs, [
    { segment_id: "s01", start: 0, end: 190, tipo: "pausa" },
    { segment_id: "s02", start: 190, end: 2700, tipo: "juego" },
  ]);
});

test("the last stretch stays open without a closing mark and is left out of the CSV", () => {
  const segs = segmentsFromMarks([mark(0, "pausa"), mark(190, "juego")]);
  assert.equal(segs[1].end, null);
  assert.equal(segmentsCsv(["v1"], { v1: segs }), "segment_id,video_id,start,end,tipo\ns01,v1,00:00:00,00:03:10,pausa\n");
});

test("a 'fin' mark leaves an unlabelled gap", () => {
  const segs = segmentsFromMarks([mark(10, "juego"), mark(20, "fin"), mark(50, "juego"), mark(60, "fin")]);
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[10, 20], [50, 60]]);
  assert.equal(segmentAt(segs, 30), null);
  assert.equal(segmentAt(segs, 55)?.segment_id, "s02");
  assert.equal(totalSeconds(segs, "juego"), 20);
});

test("times round-trip through HH:MM:SS, with decimals only when needed", () => {
  assert.equal(fmtHms(254), "00:04:14");
  assert.equal(fmtHms(3725.5), "01:02:05.5");
  assert.equal(parseHms("01:02:05.5"), 3725.5);
  assert.equal(parseHms("4:14"), 254);
  assert.equal(parseHms("abc"), null);
});

test("a segments.csv becomes marks and back to the same rows", () => {
  const rows = [
    { segment_id: "s01", start: "00:04:14", end: "00:07:09", tipo: "juego" },
    { segment_id: "s04", start: "00:07:09", end: "00:07:44", tipo: "pausa" },
    { segment_id: "s05", start: "00:08:00", end: "00:12:15", tipo: "juego" },
    { segment_id: "bad", start: "00:20:00", end: "00:19:00", tipo: "juego" },
  ];
  // A file without the video_id column (the format before matches had several videos) belongs to v1.
  const marks = marksFromCsvRows(rows).map((m, i) => ({ ...m, mark_id: String(i), match_id: "m" }));
  assert.ok(marks.every((m) => m.video_id === "v1"));
  const csv = segmentsCsv(["v1"], { v1: segmentsFromMarks(marks) });
  assert.equal(csv, "segment_id,video_id,start,end,tipo\ns01,v1,00:04:14,00:07:09,juego\ns02,v1,00:07:09,00:07:44,pausa\ns03,v1,00:08:00,00:12:15,juego\n");
});

test("one file holds every video of the match, with ids that never repeat", () => {
  const byVideo = {
    v1: segmentsFromMarks([mark(0, "pausa"), mark(180, "juego"), mark(2880, "fin")]),
    v2: segmentsFromMarks([mark(20, "juego"), mark(2720, "fin")]),
  };
  const csv = segmentsCsv(["v1", "v2"], byVideo);
  assert.equal(csv, "segment_id,video_id,start,end,tipo\ns01,v1,00:00:00,00:03:00,pausa\ns02,v1,00:03:00,00:48:00,juego\ns03,v2,00:00:20,00:45:20,juego\n");

  // And it reads back into the marks of each video, without mixing their times.
  const rows = csv.trim().split("\n").slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [["segment_id", "video_id", "start", "end", "tipo"][i], v])));
  const marks = marksFromCsvRows(rows);
  assert.deepEqual(marks.filter((m) => m.video_id === "v2"), [
    { video_id: "v2", t_video: 20, tipo: "juego" },
    { video_id: "v2", t_video: 2720, tipo: "fin" },
  ]);
  assert.deepEqual(marks.filter((m) => m.video_id === "v1").map((m) => [m.t_video, m.tipo]), [[0, "pausa"], [180, "juego"], [2880, "fin"]]);
});

test("while tagging, pauses and unmarked stretches are skipped to the next play", () => {
  const seg = (start, end, tipo) => ({ segment_id: "", start, end, tipo });
  const segs = [seg(214, 457, "juego"), seg(457, 485, "pausa"), seg(485, 532, "no_medible"), seg(532, 560, "pausa")];
  assert.equal(skipTarget(segs, 10), 214); // before kick-off
  assert.equal(skipTarget(segs, 300), null); // in play
  assert.equal(skipTarget(segs, 460), 485); // pause -> next stretch, also when it is hard to see
  assert.equal(skipTarget(segs, 500), null);
  assert.equal(skipTarget(segs, 540), null); // last pause: nothing playable ahead
  assert.equal(skipTarget([], 10), null); // nothing marked: nothing is skipped
});
