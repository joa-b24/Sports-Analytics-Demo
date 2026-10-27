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
  // El cuadro anterior al salto, para poder quitar ese en vez del salto (Alt + Q).
  assert.ok(a[0].before < 30 && a[0].before >= 27);
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

test("pierde los pies: se va y vuelve en poco tiempo, una sola anomalía con dónde vuelve", () => {
  // Track 2 walks along y = 20; in frames 30-36 her box loses the feet and she shows 8 m off, then is back.
  const f = file([1, 2], (t, frame) => (t === 2 ? [30 + frame * 0.02, frame >= 30 && frame <= 36 ? 28 : 20] : [10, 40]));
  const a = playerAnomalies(f, emptyEdits("k"));
  assert.deepEqual(a.map((x) => [x.kind, x.person, x.frame, x.until]), [["player", 2, 30, 39]]);
});

test("una marca a mano de los pies reemplaza a su caja: con los cuadros corregidos ya no hay salto", () => {
  // H = identity: a pixel is a point of the pitch (scaled to the normalised 105 x 68, here the same).
  const H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const f = file([2], (t, frame) => [30, frame === 30 ? 28 : 20]);
  for (const fr of f.frames) fr.H = H;
  assert.equal(playerAnomalies(f, emptyEdits("k")).length, 1);
  const edits = { ...emptyEdits("k"), manual: [{ identity: 2, frame: 30, px: 30, py: 20 }] };
  assert.deepEqual(playerAnomalies(f, edits), []);
});

// ---------------------------------------------------------------- quitar saltos (Q, Alt + Q, hasta aquí), 2026-10-25

test("Q: un cuadro suelto fuera de sitio se quita y el aviso desaparece", async () => {
  const { quitJump, tryJumpFix, jumpCount } = await import("./jumpFix.ts");
  // Track 1 walks along x; at frame 30 one box lands 20 m away and the next one is back on her path.
  const f = file([1], (t, frame) => [10 + frame * 0.05 + (frame === 30 ? 20 : 0), 30]);
  const e = emptyEdits("k");
  assert.equal(jumpCount(f, e), 1);
  const a = playerAnomalies(f, e)[0];
  const r = quitJump(f, e, a);
  assert.equal(r.fix?.side, "next");
  assert.equal(r.fix?.status, "ok");
  assert.equal(r.fix?.removed, 1);
  assert.equal(r.fix?.needsConfirm, false);
  assert.equal(jumpCount(f, r.fix.edits), 0);
  // The input is not touched.
  assert.equal((e.dropped ?? []).length, 0);
  assert.equal(tryJumpFix(f, e, a, "next").edits.dropped.length, 1);
});

test("Q: si quitar el siguiente no deja de saltar, se revierte; un salto que se queda no lo resuelve ningún cuadro", async () => {
  const { quitJump, trimAtJump, jumpCount } = await import("./jumpFix.ts");
  // Track 1 until 27, then track 2 elsewhere for good: a wrong long stretch.
  const f = file([1, 2], (t, frame) => (t === 1 ? (frame <= 27 ? [10 + frame * 0.05, 30] : null) : frame >= 30 ? [60 + frame * 0.05, 10] : null));
  const e = { ...emptyEdits("k"), identity: { 2: 1 } };
  const a = playerAnomalies(f, e)[0];
  assert.equal(a.person, 1);
  const r = quitJump(f, e, a);
  assert.equal(r.fix, null);
  assert.deepEqual([r.next, r.prev], ["persists", "persists"]);
  // «Quitar hasta aquí»: her run on the track after the jump goes (2 to the end), one action; the warning is gone.
  const t = trimAtJump(f, e, a, "after");
  assert.equal(t.track, 2);
  assert.equal(t.from, 30);
  assert.equal(t.to, 87);
  assert.equal(jumpCount(f, t.edits), 0);
  // Before: her run on track 1 (0 to 27).
  const b = trimAtJump(f, e, a, "before");
  assert.deepEqual([b.track, b.from, b.to, b.removed], [1, 0, 27, 10]);
  assert.equal(jumpCount(f, b.edits), 0);
});

test("Alt + Q: el cuadro previo, con confirmación si el salto es entre dos trozos; no si dejaría un hueco que no se rellena", async () => {
  const { tryJumpFix, jumpCount } = await import("./jumpFix.ts");
  // Track 1 is her up to 24, where its last box is 2.9 m ahead (not a jump on its own); track 2 goes on 4 m behind that box.
  const pos = (t, frame) => (t === 1 ? (frame <= 21 ? [10, 30] : frame === 24 ? [12.9, 30] : null) : frame >= 27 ? [8.9, 30] : null);
  const f = file([1, 2], pos);
  const e = { ...emptyEdits("k"), identity: { 2: 1 } };
  const a = playerAnomalies(f, e)[0];
  assert.equal(a.before, 24);
  // The box after: the next one is still 4 m from the previous: the warning stays.
  assert.equal(tryJumpFix(f, e, a, "next").status, "persists");
  const p = tryJumpFix(f, e, a, "prev");
  assert.equal(p.status, "ok");
  assert.equal(p.needsConfirm, true);
  assert.deepEqual(p.tracks, [1, 2]);
  assert.equal(jumpCount(f, p.edits), 0);
  // A hole the export cannot fill: 12.5 m/s between the neighbours after taking the box out.
  const g = file([1], (t, frame) => (frame <= 27 ? [10, 30] : frame === 30 ? [14, 30] : [12.5, 30]));
  const ga = playerAnomalies(g, emptyEdits("k"))[0];
  assert.equal(ga.frame, 30);
  const h = tryJumpFix(g, emptyEdits("k"), ga, "next");
  assert.equal(h.status, "hole");
  assert.equal(h.removed, 0);
});
