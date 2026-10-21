import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBall, ballCoverage, ballPath, eventBall, hasCorrections, holdBall, joinParts, manualBall, measuredPaths, pitchToPixel, pixelToPitch } from "./parts.ts";
import { editsKey, emptyEdits, setBall, setPerson, setRemoved } from "./tracks.ts";

const LAB = [100, 128, 128];
const at = (track, x, y, inside = true) => [track, 0, 0, 10, 30, 0.9, ...LAB, x, y, inside, "unk", track];
// A part of one second (30 fps, 1 of every 3 frames) starting at `start`. `who(i)` gives the boxes of processed frame i.
// The calibration is a plain scale: 10 pixels per meter on a 105 x 68 venue.
const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1];
const part = (start, who) => ({
  match_id: "m", video_id: "v1", fps: 30, start_frame: start, end_frame: start + 30, stride: 3, image_w: 1050, image_h: 680,
  frames: Array.from({ length: 10 }, (_, i) => ({ frame: start + i * 3, H, boxes: who(i) })),
});
const E = (f) => emptyEdits(editsKey(f));
const SMOOTH = { maxSpeedMs: 9, maxFillS: 2, windowS: 0 };

test("pixels go to the pitch through the calibration of the frame", () => {
  const f = part(0, () => []);
  assert.deepEqual(pixelToPitch(f, H, 525, 340).map((v) => Math.round(v * 10) / 10), [52.5, 34]);
  assert.equal(pixelToPitch(f, null, 525, 340), null);
});

test("paths leave out people off the pitch and discarded identities", () => {
  const f = part(0, () => [at(1, 40, 30), at(2, 60, 30, false), at(3, 70, 30)]);
  const paths = measuredPaths(f, setRemoved(E(f), 3, true));
  assert.deepEqual([...paths.keys()], [1]);
  assert.equal(paths.get(1).length, 10);
});

test("the ball: hand marks win over events, short stretches are joined, long ones stay empty", () => {
  const f = part(0, () => []);
  const edits = setBall(setBall(E(f), 0, 100, 100), 9, 400, 100);
  const marks = manualBall(f, edits);
  assert.deepEqual(marks.map((b) => [b.frame, Math.round(b.x), Math.round(b.y), b.source]), [[0, 10, 10, "manual"], [9, 40, 10, "manual"]]);
  const path = ballPath([...marks, { frame: 9, x: 99, y: 99, source: "event" }, { frame: 300, x: 50, y: 50, source: "event" }], 30, 3);
  assert.deepEqual(path.map((b) => [b.frame, b.source]), [[0, "manual"], [3, "interpolated"], [6, "interpolated"], [9, "manual"], [300, "event"]]);
  assert.ok(Math.abs(path[1].x - 20) < 1e-9);
});

test("events become ball positions, mirrored when the team attacks to the left in this video", () => {
  const f = part(30, () => []);
  const ev = (t, x, y, video_id) => ({ t_video: t, x, y, video_id });
  const events = [ev(1.5, 80, 20), ev(1.2, null, null), ev(5, 10, 10), ev(1.5, 1, 1, "v2")];
  assert.deepEqual(eventBall(f, events, true), [{ frame: 45, x: 80, y: 20, source: "event" }]);
  assert.deepEqual(eventBall(f, events, false), [{ frame: 45, x: 25, y: 48, source: "event" }]);
});

test("two parts in a row: same name is one person, the unnamed are linked where it is clear", () => {
  // A walks along y = 30; B stands at (80, 50); C is only in the first part, far from everybody.
  // In the second part the tracker gave everybody new numbers.
  const p1 = part(0, (i) => [at(1, 40 + i * 0.3, 30), at(2, 80, 50), ...(i < 5 ? [at(3, 10, 10)] : [])]);
  const p2 = part(30, (i) => [at(7, 43 + i * 0.3, 30), at(8, 80, 50)]);
  const e1 = setPerson(E(p1), 1, { player_id: "Ana" });
  const out = joinParts([{ file: p2 }, { file: p1, edits: e1 }], { smooth: SMOOTH });
  assert.deepEqual([out.start_frame, out.end_frame], [0, 60]);
  assert.deepEqual(out.parts.map((p) => [p.corrected, p.linked_to_previous]), [[true, 0], [false, 2]]);
  assert.equal(out.people.length, 3);
  const ana = out.people.find((p) => p.player_id === "Ana");
  assert.deepEqual(ana.sources, [{ part: "0_30", id: 1 }, { part: "30_60", id: 7 }]);
  // She has one position in every frame of both parts.
  assert.ok(out.frames.every((fr) => fr.positions.filter((q) => q.id === ana.id).length === 1));
  assert.equal(out.frames.length, 20);
});

test("at a boundary, two people who could both be the one seen before are not linked", () => {
  const p1 = part(0, () => [at(1, 40, 30)]);
  const p2 = part(30, () => [at(7, 40.4, 30), at(8, 39.6, 30)]);
  const out = joinParts([{ file: p1 }, { file: p2 }], { smooth: null });
  assert.equal(out.people.length, 3);
  assert.equal(out.smoothing, null);
});

test("names join people across parts that are not in a row; parts that do not belong together are refused", () => {
  const p1 = part(0, () => [at(1, 40, 30)]);
  const p3 = part(600, () => [at(4, 70, 50)]);
  const name = (f, id) => setPerson(E(f), id, { player_id: "ana" });
  const out = joinParts([{ file: p1, edits: name(p1, 1) }, { file: p3, edits: name(p3, 4) }], { smooth: SMOOTH });
  assert.equal(out.people.length, 1);
  assert.throws(() => joinParts([{ file: p1 }, { file: p1 }], { smooth: null }), /traslapan/);
  assert.throws(() => joinParts([{ file: p1 }, { file: { ...p3, video_id: "v2" } }], { smooth: null }), /distintos/);
  assert.equal(hasCorrections(E(p1)), false);
  assert.equal(hasCorrections(name(p1, 1)), true);
});

test("a tagged event is only used as ball where there is no hand mark within 3 s", () => {
  const m = (frame, x) => ({ frame, x, y: 10, source: "manual" });
  const ev = (frame, x) => ({ frame, x, y: 50, source: "event" });
  // Marks at 0 and 60 (2 s apart, joined by a line); an event at 30 would pull the ball 40 m off that line.
  const path = ballPath([m(0, 10), ev(30, 40), m(60, 20), ev(600, 70)], 30, 3);
  const at = (f) => path.find((b) => b.frame === f);
  assert.equal(at(30).source, "interpolated");
  assert.ok(Math.abs(at(30).y - 10) < 1e-9);
  assert.equal(at(600).source, "event");
});

test("ball coverage: marks and the lines between them, out of play left out, and where it is missing", () => {
  // 30 fps, 1 of 3 frames, 10 s. Marks every second for the first 4 s, the ball out from 4 to 6 s, nothing after.
  const marks = [0, 30, 60, 90, 120];
  const r = ballCoverage({ marks, out: [150], from: 0, to: 300, fps: 30, stride: 3, outHalf: 30 });
  assert.deepEqual(r.missing, [[180, 300]]);
  assert.ok(Math.abs(r.share - (1 - 120 / 240)) < 0.02);
  assert.equal(ballCoverage({ marks: [...marks, 180, 210, 240, 270, 300], out: [150], from: 0, to: 300, fps: 30, stride: 3, outHalf: 30 }).missing.length, 0);
});

test("a line drawn by hand joins two marks whatever the time between them, and covers its stretch", () => {
  const m = (frame, x) => ({ frame, x, y: 10, source: "manual" });
  // 6 s between where it leaves and where it lands: too long for the automatic line, joined by hand.
  const pts = [m(0, 10), m(180, 70)];
  assert.equal(ballPath(pts, 30, 3).length, 2);
  const linked = ballPath(pts, 30, 3, 3, [{ from: 0, to: 180 }]);
  assert.equal(linked.length, 61);
  assert.ok(Math.abs(linked.find((b) => b.frame === 90).x - 40) < 1e-9);
  const cov = ballCoverage({ marks: [0, 180], out: [], from: 0, to: 180, fps: 30, stride: 3, outHalf: 15, links: [{ from: 0, to: 180 }] });
  assert.deepEqual(cov.missing, []);
});

test("ball coverage: «out» samples next to marks leave no slivers", () => {
  // Samples every 0.5 s (15 frames): out at 0 and 15, marks from 30 on; nothing should be missing.
  const marks = [30, 45, 60, 75, 90];
  const r = ballCoverage({ marks, out: [0, 15], from: 0, to: 97, fps: 30, stride: 3, outHalf: 7.5 });
  assert.deepEqual(r.missing, []);
  assert.equal(r.share, 1);
});

// A camera looking straight down that moves 100 px to the right between frame 0 and frame 3 (synthetic).
const pannedFile = () => ({
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 300, stride: 3, image_w: 1920, image_h: 1080,
  venue: { length_m: 105, width_m: 68 },
  frames: [0, 3, 6, 150].map((frame) => ({ frame, H: [0.1, 0, frame === 0 ? 0 : -10, 0, 0.1, 0, 0, 0, 1], boxes: [] })),
});

test("clic en la cancha: pitchToPixel es la inversa de pixelToPitch", () => {
  const f = pannedFile();
  const H = f.frames[1].H;
  const px = pitchToPixel(f, H, 52.5, 34);
  assert.ok(Math.abs(px[0] - 625) < 1e-6 && Math.abs(px[1] - 340) < 1e-6);
  const back = pixelToPitch(f, H, px[0], px[1]);
  assert.ok(Math.abs(back[0] - 52.5) < 1e-9 && Math.abs(back[1] - 34) < 1e-9);
  assert.equal(pitchToPixel(f, null, 52.5, 34), null);
});

test("mantener el balón: la marca nueva cae en el mismo punto de la cancha aunque la cámara se mueva, unida a la anterior", () => {
  const f = pannedFile();
  let e = setBall(emptyEdits("k"), 0, 500, 300);
  const held = holdBall(f, e, 150);
  const mark = held.ball.find((b) => b.frame === 150);
  // Frame 0 has no offset, frame 150 is shifted 10 m: the same spot is 100 px further right.
  assert.deepEqual([mark.px, mark.py], [600, 300]);
  assert.deepEqual(held.ballLinks, [{ from: 0, to: 150 }]);
  // 5 s apart, longer than BALL_FILL_S: the link keeps the ball still the whole time.
  const path = ballPath(manualBall(f, held), 30, 3, 3, held.ballLinks);
  const mid = path.find((p) => p.frame === 75);
  assert.ok(mid && Math.abs(mid.x - 50) < 1e-9 && Math.abs(mid.y - 30) < 1e-9);
  assert.equal(holdBall(f, emptyEdits("k"), 150), null);
});

test("balón del tracker: entra donde no hay marca tuya ni lo quitaste, y una marca tuya gana", () => {
  const f = pannedFile();
  const auto = { frames: [{ frame: 0, px: 100, py: 100, p: 0.99 }, { frame: 3, px: 200, py: 100, p: 0.98 }, { frame: 6, px: 300, py: 100, p: 0.97 }], ask: [150] };
  let e = setBall(emptyEdits("k"), 3, 250, 120);
  e = { ...e, ballRejected: [6] };
  const pts = autoBall(f, auto, e);
  assert.deepEqual(pts.map((p) => [p.frame, p.source]), [[0, "auto"]]);
  const path = ballPath([...autoBall(f, auto, e), ...manualBall(f, e)], 30, 3);
  assert.deepEqual(path.map((p) => p.source), ["auto", "manual"]);
  // An event near the tracker's ball is left out, as near a hand mark.
  const ev = [{ frame: 6, x: 1, y: 1, source: "event" }];
  assert.ok(!ballPath([...pts, ...ev], 30, 3).some((p) => p.source === "event"));
  assert.deepEqual(autoBall(f, null, e), []);
});

test("lo que ve la cámara: el borde de la imagen llevado a la cancha, sin lo que queda sobre el horizonte", async () => {
  const { viewPolygon } = await import("./parts.ts");
  // Cámara que mira toda la cancha de frente: imagen de 1000 x 500 que va de x 0 a 105 y de y 0 a 68.
  const H = [105 / 1000, 0, 0, 0, 68 / 500, 0, 0, 0, 1];
  const f = { image_w: 1000, image_h: 500, venue: null };
  const poly = viewPolygon(f, H, 4);
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 105, 0, 68]);
  assert.equal(viewPolygon(f, null), null);
});
