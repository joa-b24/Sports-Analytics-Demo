import assert from "node:assert/strict";
import { test } from "node:test";
import { ballAnomalies, playerAnomalies } from "./anomalies.ts";
import { emptyEdits } from "./tracks.ts";

// Synthetic part: 30 fps, a processed frame every 3, venue of the normalised size (1 unit = 1 m). No real players.
// pos(track, frame) -> [x, y] on the pitch or null (not seen).
const file = (tracks, pos, frames = 30) => ({
  match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: frames * 3, stride: 3, image_w: 1920, image_h: 1080,
  venue: { length_m: 105, width_m: 68 },
  frames: Array.from({ length: frames }, (_, i) => {
    const frame = i * 3;
    return {
      frame,
      H: null,
      boxes: tracks.flatMap((t) => {
        const p = pos(t, frame);
        // [track, x1, y1, x2, y2, conf, L, a, b, x, y, on_pitch, team]
        return p ? [[t, 0, 0, 10, 30, 0.9, 120, 128, 128, p[0], p[1], true, "unk"]] : [];
      }),
    };
  }),
});

test("jugadora con nombre que salta más de lo que se puede correr: sale primero, con su nombre", () => {
  // Track 2 runs normally, then at frame 30 is suddenly 20 m away (her name went to somebody else).
  const f = file([1, 2, 3], (t, frame) => (t === 2 ? [frame < 30 ? 30 + frame * 0.02 : 50 + frame * 0.02, 20] : [10 * t + frame * 0.01, 40]));
  const edits = { ...emptyEdits("k"), people: { 2: { player_id: "Jugadora Dos" } } };
  const a = playerAnomalies(f, edits);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].kind, a[0].person, a[0].name, a[0].frame], ["player", 2, "Jugadora Dos", 30]);
  assert.ok(a[0].meters > 19 && a[0].speed > 190);
});

test("si muchas saltan en el mismo cuadro es la cámara (calibración), no las jugadoras", () => {
  const f = file([1, 2, 3, 4, 5], (t, frame) => [10 * t + (frame === 30 ? 12 : 0), 30]);
  const a = playerAnomalies(f, emptyEdits("k"));
  // Out at 30 and back at 33: two camera jumps, no player ones.
  assert.deepEqual(a.map((x) => [x.kind, x.frame, x.people]), [["camera", 30, 5], ["camera", 33, 5]]);
});

test("correr rápido no es anomalía; un hueco largo tampoco", () => {
  // 8 m/s, and a 3 s hole after which she is 20 m away.
  const f = file([1], (t, frame) => (frame > 30 && frame < 120 ? null : [10 + (frame / 30) * 8, 30]), 60);
  assert.deepEqual(playerAnomalies(f, emptyEdits("k")), []);
});

test("balón: un teletransporte de ida y vuelta es una anomalía; los eventos no cuentan; un pase largo rápido sí es posible", () => {
  const p = (frame, x, source = "manual") => ({ frame, x, y: 30, source });
  const pts = [p(0, 50), p(3, 52), p(6, 90, "auto"), p(9, 88, "auto"), p(12, 55), p(15, 56), p(18, 10, "event")];
  const a = ballAnomalies(pts, { fps: 30, venue: { length_m: 105, width_m: 68 } });
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].kind, a[0].frame, a[0].until], ["ball", 6, 12]);
  assert.ok(a[0].speed > 300);
  // 30 m in 1.2 s (25 m/s): a long pass, fine.
  assert.deepEqual(ballAnomalies([p(0, 20), p(36, 50)], { fps: 30, venue: { length_m: 105, width_m: 68 } }), []);
  // A jump that does not come back is reported without an end.
  const one = ballAnomalies([p(0, 20), p(3, 60), p(6, 61)], { fps: 30, venue: { length_m: 105, width_m: 68 } });
  assert.equal(one.length, 1);
  assert.equal(one[0].until, undefined);
});
