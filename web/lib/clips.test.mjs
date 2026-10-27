import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { atOutput, clipDrawingsAt, outputOf, pitchToImage, project, resolve, revealCount, timeline } from "./annotations.ts";
import { MAX_HOLE_S, addToEdit, homographyAt, labelFor, normalizeEdit, removeFromEdit, snapshotContext } from "./clips.ts";

// Synthetic data only: no real players or teams.
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const edit = (extra = {}) => normalizeEdit({ edit_id: "e1", match_id: "m1", video_id: "v1", t_start: 100, t_end: 110, ...extra });

test("línea de tiempo con dos pausas: tiempos de salida y de video; las pausas no cuentan como video", () => {
  const e = edit({ freezes: [{ t: 106, duration_s: 4, reveal: [] }, { t: 102, duration_s: 3, reveal: [] }, { t: 120, duration_s: 9, reveal: [] }] });
  const tl = timeline(e);
  // 10 s of video + 3 + 4 of stops; the stop at 120 is outside the clip.
  near(tl.duration, 17);
  assert.deepEqual(tl.spans.map((s) => [s.kind, s.out0, s.out1, s.v0, s.v1]), [
    ["video", 0, 2, 100, 102],
    ["freeze", 2, 5, 102, 102],
    ["video", 5, 9, 102, 106],
    ["freeze", 9, 13, 106, 106],
    ["video", 13, 17, 106, 110],
  ]);
  assert.deepEqual(atOutput(tl, 1), { t_video: 101, freeze: null, elapsed: 0 });
  const inStop = atOutput(tl, 3.5);
  assert.equal(inStop.t_video, 102);
  assert.equal(inStop.freeze.t, 102);
  near(inStop.elapsed, 1.5);
  assert.equal(atOutput(tl, 7).t_video, 104);
  assert.equal(atOutput(tl, 15).t_video, 108);
  near(outputOf(tl, 104), 7);
  near(outputOf(tl, 108), 15);
});

test("en una pausa los dibujos de `reveal` aparecen uno a uno", () => {
  const f = { t: 102, duration_s: 3, reveal: ["a", "b"] };
  assert.deepEqual([0, 0.9, 1.0, 2.0, 2.9, 3].map((s) => revealCount(f, s)), [0, 0, 1, 2, 2, 2]);
  const draw = (id) => ({ id, kind: "text", anchors: [{ kind: "screen", x: 0.5, y: 0.5 }], t_in: 102, t_out: 110, style: { color: "ink" } });
  const e = edit({ annotations: [draw("a"), draw("b"), draw("c")], freezes: [f] });
  const ctx = { positionOf: () => null };
  assert.deepEqual(clipDrawingsAt(e, 102, ctx, { freeze: f, shown: 1 }).map((r) => r.id), ["a", "c"]);
  assert.deepEqual(clipDrawingsAt(e, 103, ctx, null).map((r) => r.id), ["a", "b", "c"]);
});

test("la proyección coincide con el caso común con Python (tests/fixtures/projection_cases.json)", () => {
  const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/projection_cases.json", import.meta.url), "utf8"));
  for (const c of fx.cases) {
    const to = pitchToImage(c.H, c.venue);
    c.points.forEach((p, i) => {
      const q = to(p);
      assert.ok(Math.hypot(q[0] - c.pixels[i][0], q[1] - c.pixels[i][1]) < fx.tolerance_px, `${c.name} ${p}: ${q} vs ${c.pixels[i]}`);
    });
    // The same H with any scale or sign gives the same pixels.
    const q2 = pitchToImage(c.H.map((v) => v * -3.7), c.venue)(c.points[0]);
    assert.ok(Math.hypot(q2[0] - c.pixels[0][0], q2[1] - c.pixels[0][1]) < fx.tolerance_px);
  }
  assert.equal(pitchToImage(null, { length_m: 100, width_m: 65 }), null);
});

test("sin H en ese cuadro, los dibujos en metros se ocultan y el texto en pantalla se queda", () => {
  const ctx = { positionOf: () => [50, 30] };
  const img = { w: 1920, h: 1080 };
  const ring = resolve({ id: "h", kind: "highlight", anchors: [{ kind: "player", identity: 4 }], t_in: 0, t_out: 9, style: { color: "accent" } }, 1, ctx);
  const text = resolve({ id: "t", kind: "text", anchors: [{ kind: "screen", x: 0.25, y: 0.1 }], t_in: 0, t_out: 9, style: { color: "ink", label: "Presión" } }, 1, ctx);
  assert.equal(project(ring, null, img), null);
  assert.deepEqual(project(text, null, img).text, { at: [480, 108], value: "Presión" });
  // With H: the ring at the feet is a closed ellipse around the projected point.
  const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/projection_cases.json", import.meta.url), "utf8")).cases[0];
  const p = project(ring, pitchToImage(fx.H, fx.venue), img);
  assert.ok(p.closed && p.paths[0].length === 32);
});

// Identity 7 seen every 3 frames (30 fps, 0.1 s) from frame 3000 to 3300, missing 0.5 s around 3060 and 2 s around 3150.
const snap = () => {
  const rows = [];
  for (let f = 3000; f <= 3300; f += 3) {
    const lost05 = f > 3051 && f < 3069; // last seen 3051, back at 3069: 0.6 s apart, 0.5 s missing
    const lost2 = f > 3120 && f < 3183; // 2.1 s apart, 2 s missing
    if (!lost05 && !lost2) rows.push([f, f / 100, 20, "auto"]);
  }
  return {
    fps: 30,
    stride: 3,
    tracks: { 7: rows, 8: [[3000, 10, 10, "auto"], [3003, 11, 10, "interpolated"], [3006, 12, 10, "auto"]] },
    people: [{ id: 7, team: "own", player_id: "Jugadora Siete", number: 7 }, { id: 8, team: "own", player_id: "Jugadora Ocho", number: null }],
  };
};

test("resaltar a una jugadora que desaparece 0.5 s la sigue (interpola) y 2 s la oculta", () => {
  const ctx = snapshotContext(snap());
  const ring = (t) => resolve({ id: "h", kind: "highlight", anchors: [{ kind: "player", identity: 7 }], t_in: 0, t_out: 999, style: { color: "accent" } }, t, ctx);
  // Inside the 0.5 s hole: on the line between 3051 and 3069.
  const r = ring(3060 / 30);
  assert.ok(r);
  near(r.points[0][0], 30.6, 1e-6);
  // Inside the 2 s hole: hidden.
  assert.equal(ring(3150 / 30), null);
  assert.ok(MAX_HOLE_S === 1);
  // A position filled by the smoothing is not a measurement: the 0.1 s step around it is bridged from the measured ones.
  assert.deepEqual(snapshotContext(snap()).positionOf(8, 3003 / 30), [11, 10]);
  // Past the last position, only within one step.
  assert.ok(ctx.positionOf(7, 3302 / 30));
  assert.equal(ctx.positionOf(7, 3320 / 30), null);
});

test("label_mode number: ningún nombre en lo que se dibuja", () => {
  const s = snap();
  const ctx = snapshotContext(s);
  const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/projection_cases.json", import.meta.url), "utf8")).cases[0];
  const to = pitchToImage(fx.H, fx.venue);
  const anns = [7, 8].map((id) => ({ id: `h${id}`, kind: "highlight", anchors: [{ kind: "player", identity: id }], t_in: 0, t_out: 999, style: { color: "accent" } }));
  const drawn = (mode) =>
    JSON.stringify(anns.map((a) => project(resolve(a, 3000 / 30, ctx), to, { w: 1920, h: 1080 }, (id) => labelFor(id, mode, s))));
  const numbers = drawn("number");
  assert.ok(!numbers.includes("Jugadora"));
  assert.ok(numbers.includes('"value":"7"'));
  assert.ok(drawn("name").includes("Jugadora Siete"));
  assert.ok(!drawn("none").includes('"value"'));
  assert.equal(labelFor(8, "number", s), null);
  assert.equal(labelFor(8, "name", s), "Jugadora Ocho");
});

test("H de un cuadro: la suya, mezcla de las vecinas cercanas o la más cercana; nada si están lejos", () => {
  const A = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const B = [3, 0, 0, 0, 3, 0, 0, 0, 3]; // same H, other scale
  const hs = [[0, A], [10, B], [100, null], [200, A]];
  assert.deepEqual(homographyAt(hs, 0, 20), A);
  const mid = homographyAt(hs, 5, 20);
  near(mid[0] / mid[8], 1);
  near(mid[1], 0);
  // 100 has no calibration: 10 and 200 are too far apart to blend, and 150 is too far from both.
  assert.equal(homographyAt(hs, 150, 20), null);
  assert.deepEqual(homographyAt(hs, 205, 20), A);
});

test("dibujar sobre una pausa lo añade a su lista de aparición; borrarlo lo quita", () => {
  let e = edit({ freezes: [{ t: 104, duration_s: 3, reveal: [] }] });
  const a = { id: "a1", kind: "text", anchors: [{ kind: "screen", x: 0.5, y: 0.5 }], t_in: 104.02, t_out: 108, style: { color: "ink" } };
  e = addToEdit(e, a, 104.02);
  assert.equal(e.annotations[0].t_in, 104);
  assert.deepEqual(e.freezes[0].reveal, ["a1"]);
  e = addToEdit(e, { ...a, id: "a2", t_in: 106 }, 106);
  assert.deepEqual(e.freezes[0].reveal, ["a1"]);
  e = removeFromEdit(e, "a1");
  assert.deepEqual(e.freezes[0].reveal, []);
  assert.deepEqual(e.annotations.map((x) => x.id), ["a2"]);
  assert.equal(normalizeEdit({ edit_id: "x" }).label_mode, "number");
});

test("los dibujos completos (círculo, flecha curva, zona y línea con jugadoras, texto) coinciden con el render de Python", () => {
  const fx = JSON.parse(readFileSync(new URL("../../tests/fixtures/projection_cases.json", import.meta.url), "utf8"));
  const d = fx.drawings;
  const cam = fx.cases.find((c) => c.name === d.case);
  const to = pitchToImage(cam.H, cam.venue);
  const ctx = { positionOf: (id) => d.positions[String(id)] ?? null };
  const close = (a, b, what) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < fx.tolerance_px, `${what}: ${a} vs ${b}`);
  for (const { annotation, expected } of d.items) {
    const p = project(resolve(annotation, d.t, ctx), to, cam.image, (id) => d.labels[String(id)] ?? null);
    assert.equal(p.closed, expected.closed, annotation.id);
    assert.equal(p.paths.length, expected.paths.length, annotation.id);
    p.paths.forEach((path, i) => {
      assert.equal(path.length, expected.paths[i].length, `${annotation.id} puntos`);
      path.forEach((q, j) => close(q, expected.paths[i][j], `${annotation.id} ${j}`));
    });
    assert.equal(!!p.head, !!expected.head);
    p.head?.forEach((q, j) => close(q, expected.head[j], `${annotation.id} punta`));
    assert.equal(p.text?.value ?? null, expected.text?.[1] ?? null, annotation.id);
    if (p.text) close(p.text.at, expected.text[0], `${annotation.id} texto`);
  }
});

test("un clip con resalte «caja» se abre con óvalo y conserva el resto", async () => {
  const { migrateEdit } = await import("./clips.ts");
  const a = (id, shape) => ({ id, kind: "highlight", anchors: [{ kind: "player", identity: 1 }], t_in: 100, t_out: 104, style: { color: "warn", label: "x", dashed: true, ...(shape ? { shape } : {}) } });
  const e = edit({ annotations: [a("a1", "box"), a("a2", "arrow"), a("a3")], highlight_shape: "box", title: "Mi clip" });
  assert.equal(e.annotations[0].style.shape, "oval");
  assert.equal(e.annotations[0].style.label, "x");
  assert.equal(e.annotations[0].style.dashed, true);
  assert.equal(e.annotations[1].style.shape, "arrow");
  assert.equal(e.annotations[2].style.shape, undefined);
  assert.equal(e.highlight_shape, "oval");
  assert.equal(e.title, "Mi clip");
  const again = migrateEdit(e);
  assert.equal(again, e, "sin nada que migrar devuelve el mismo objeto");
});
