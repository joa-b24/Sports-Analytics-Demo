import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MAX_COST, autoLabel, judgeTramos, planAutoAccept, revertAuto } from "./autoAccept.ts";
import { tramoKey } from "./anchors.ts";
import { emptyEdits, identityOf, people } from "./tracks.ts";

const OWN = [120, 128, 128];
const OPP = [200, 128, 180];
const seq = (a, b) => Array.from({ length: Math.floor((b - a) / 3) + 1 }, (_, i) => a + i * 3);
// tracks: { id: { frames: [a, b], pos: [x, y], lab?, team? } }; track 90 is a rival (gives the file a reference colour).
function mkFile(tracks) {
  const frames = seq(0, 120).map((frame) => ({
    frame,
    H: null,
    boxes: Object.entries(tracks)
      .filter(([, t]) => frame >= t.frames[0] && frame <= t.frames[1])
      .map(([id, t]) => [Number(id), 0, 0, 10, 30, 0.9, ...(t.lab ?? OWN), t.pos[0], t.pos[1], true, t.team ?? "own"]),
  }));
  return { match_id: "m", video_id: "v1", fps: 30, start_frame: 0, end_frame: 120, stride: 3, image_w: 1920, image_h: 1080, venue: { length_m: 105, width_m: 68 }, frames };
}
const base = () => ({ 1: { frames: [0, 30], pos: [10, 10] }, 2: { frames: [33, 60], pos: [11, 10] }, 90: { frames: [0, 120], pos: [80, 30], lab: OPP, team: "opp" } });
const sug = { kind: "union_dudosa", person: "Ana", track: 2, frame_ini: 33, frame_fin: 60, p: 0.99, cost: 0.3 };
// Ana is track 1 (identity 1, named).
function ctx(tracks = base(), over = {}) {
  const file = mkFile(tracks);
  let edits = { ...emptyEdits("k"), identity: { 1: 1 }, people: { 1: { player_id: "Ana" } } };
  if (over.edits) edits = over.edits(edits);
  const ppl = people(file, edits);
  const named = new Map(ppl.filter((p) => p.player_id).map((p) => [p.player_id, p.id]));
  return { file, edits, ppl, named, doubts: over.doubts ?? [] };
}
const reasons = (c, s = sug, p = 0.98) => judgeTramos(c, [s], p)[0].reasons;
const idAt = (c, edits, track, frame) => identityOf(c.file.frames.find((f) => f.frame === frame).boxes.find((b) => b[0] === track), frame, edits);

test("una unión trivial es segura y se acepta como UNA edición marcada", () => {
  const c = ctx();
  assert.deepEqual(reasons(c), []);
  const plan = planAutoAccept(c, [sug], 0.98);
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.edits === c.edits, false);
  assert.equal(idAt(c, plan.edits, 2, 45), 1);
  assert.deepEqual(plan.edits.anchorDoubts, [tramoKey(sug)]);
  assert.deepEqual(plan.edits.autoAccepted, [{ key: tramoKey(sug), person: "Ana", track: 2, frame_ini: 33, frame_fin: 60, p: 0.99, cost: 0.3, prev: 2 }]);
  // El original no se tocó (un solo Ctrl+Z vuelve a él).
  assert.equal(c.edits.autoAccepted, undefined);
  assert.equal(autoLabel(1), "Aceptar la 1 segura");
  assert.equal(autoLabel(12), "Aceptar las 12 seguras");
});

test("probabilidad y costo: por debajo del umbral no es segura", () => {
  const c = ctx();
  assert.deepEqual(reasons(c, { ...sug, p: 0.97 }), ["p"]);
  assert.deepEqual(reasons(c, { ...sug, p: 0.97 }, 0.9), []);
  assert.deepEqual(reasons(c, { ...sug, cost: AUTO_MAX_COST + 0.1 }), ["costo"]);
  assert.deepEqual(reasons(c, { ...sug, p: 0.5, cost: 0.9 }), ["p", "costo"]);
  const plan = planAutoAccept(c, [{ ...sug, p: 0.9 }], 0.98);
  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.edits, c.edits);
  assert.deepEqual(plan.unsafe, { p: 1 });
});

test("choques: solape con otra caja suya, salto imposible, otro equipo y duda pendiente", () => {
  // Ana ya tiene otra caja (track 3) en esos cuadros.
  const ov = ctx({ ...base(), 3: { frames: [40, 60], pos: [30, 30] } }, { edits: (e) => ({ ...e, identity: { ...e.identity, 3: 1 } }) });
  assert.ok(reasons(ov).includes("solape"));
  // El trozo está a 50 m de donde ella estaba medio segundo antes.
  const far = ctx({ ...base(), 2: { frames: [33, 60], pos: [60, 50] } });
  assert.ok(reasons(far).includes("salto"));
  // Una caja con el color del rival.
  const opp = ctx({ ...base(), 2: { frames: [33, 60], pos: [11, 10], lab: OPP, team: "opp" } });
  assert.ok(reasons(opp).includes("equipo"));
  // Una duda pendiente «en dos sitios» en ese trozo.
  const dd = ctx(base(), { doubts: [{ kind: "dos_sitios", frame: 45, track: 2, players: ["Ana"], note: "" }] });
  assert.ok(reasons(dd).includes("duda"));
  // Una informativa no cuenta; una duda lejos en el tiempo tampoco.
  assert.deepEqual(reasons(ctx(base(), { doubts: [{ kind: "hueco_largo", frame: 45, track: 2, players: [], note: "", task: false }] })), []);
  assert.deepEqual(reasons(ctx(base(), { doubts: [{ kind: "salto", frame: 110, track: 2, players: [], note: "" }] })), []);
});

test("no quita nada a una jugadora con otro nombre ni a una verificada", () => {
  const bea = ctx(base(), { edits: (e) => ({ ...e, identity: { ...e.identity, 2: 2 }, people: { ...e.people, 2: { player_id: "Bea" } } }) });
  assert.ok(reasons(bea).includes("dueña"));
  const done = ctx(base(), { edits: (e) => ({ ...e, identity: { ...e.identity, 2: 2 }, people: { ...e.people, 2: { done: true } } }) });
  assert.ok(reasons(done).includes("verificada"));
  const gone = ctx(base(), { edits: (e) => ({ ...e, removed: [2] }) });
  assert.ok(reasons(gone).includes("dueña"));
  // Ya era suya: nada que aceptar.
  const mine = ctx(base(), { edits: (e) => ({ ...e, identity: { ...e.identity, 2: 1 } }) });
  assert.deepEqual(reasons(mine), ["ya_suya"]);
  // Un tramo sin cajas.
  assert.deepEqual(reasons(ctx(), { ...sug, track: 77 }), ["sin_cajas"]);
});

test("el lote: dos seguras de una jugadora que chocan entre sí, solo entra una; y las excluidas no se toman", () => {
  const tracks = { ...base(), 4: { frames: [33, 60], pos: [12, 11] } };
  const c = ctx(tracks);
  const other = { ...sug, track: 4, p: 0.985 };
  const plan = planAutoAccept(c, [sug, other], 0.98);
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.refused, 1);
  assert.equal(plan.accepted[0].track, 2);
  // Excluida (la analista la quitó antes): no se vuelve a tomar.
  const skip = planAutoAccept(c, [sug], 0.98, new Set([tramoKey(sug)]));
  assert.equal(skip.accepted.length, 0);
  assert.equal(skip.judged, 0);
});

test("una jugadora sin nombre en la mesa se crea una vez para varias uniones", () => {
  const tracks = { 2: { frames: [0, 15], pos: [10, 10] }, 5: { frames: [30, 45], pos: [11, 10] }, 90: { frames: [0, 120], pos: [80, 30], lab: OPP, team: "opp" } };
  const c = ctx(tracks, { edits: () => emptyEdits("k") });
  const a = { kind: "union_dudosa", person: "Cata", track: 2, frame_ini: 0, frame_fin: 15, p: 0.99, cost: 0.2 };
  const b = { ...a, track: 5, frame_ini: 30, frame_fin: 45 };
  const plan = planAutoAccept(c, [a, b], 0.98);
  assert.equal(plan.accepted.length, 2);
  assert.equal(Object.values(plan.edits.people).filter((p) => p.player_id === "Cata").length, 1);
  assert.equal(idAt(c, plan.edits, 2, 6), idAt(c, plan.edits, 5, 36));
});

test("quitar una a una: vuelve a como estaba, queda pendiente y se deja lo cambiado a mano", () => {
  const tracks = { ...base(), 4: { frames: [63, 90], pos: [12, 11] } };
  const c = ctx(tracks);
  const s2 = { ...sug, track: 4, frame_ini: 63, frame_fin: 90 };
  const plan = planAutoAccept(c, [sug, s2], 0.98);
  assert.equal(plan.accepted.length, 2);
  const named = new Map([["Ana", 1]]);
  const one = revertAuto(plan.edits, c.file, [plan.accepted[0]], named);
  assert.equal(one.reverted, 1);
  assert.equal(idAt(c, one.edits, 2, 45), 2);
  assert.equal(idAt(c, one.edits, 4, 75), 1);
  assert.deepEqual(one.edits.anchorDoubts, [tramoKey(s2)]);
  assert.deepEqual(one.edits.autoAccepted.map((r) => r.track), [4]);
  // Todas: la lista desaparece del todo.
  const all = revertAuto(plan.edits, c.file, plan.accepted, named);
  assert.equal(all.reverted, 2);
  assert.equal(all.edits.autoAccepted, undefined);
  assert.deepEqual(all.edits.anchorDoubts, []);
  assert.equal(idAt(c, all.edits, 4, 75), 4);
  // Si ya no es suyo (cambiado a mano), solo se quita el registro.
  const hand = { ...plan.edits, identity: { ...plan.edits.identity }, splits: plan.edits.splits.map((x) => (x.track === 2 && x.frame === 33 ? { ...x, identity: 9 } : x)) };
  const moved = revertAuto(hand, c.file, [plan.accepted[0]], named);
  assert.equal(moved.changed, 1);
  assert.equal(moved.reverted, 0);
  assert.deepEqual(moved.edits.autoAccepted.map((r) => r.track), [4]);
});
