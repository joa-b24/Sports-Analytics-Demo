#!/usr/bin/env node
// Reconstruye el TrackEdits de una parte desde lo que «Guardar» dejó en disco (labels_*.json + tracks_fixed_*.json +
// tracks_*.json crudo), por si el navegador perdió las ediciones.
//
//   node scripts/recover_edits_from_fixed.mjs [--match <carpeta>] [--part v1_3339_15666] [--merge <respaldo.json>]
//
// Sin --merge escribe matches/<carpeta>/recuperacion/edits_recuperadas_<parte>.json (NO es un respaldo completo: la
//   app lo rechaza a propósito para que nunca borre nada; sirve de entrada para --merge y para revisar).
// Con --merge <respaldo exportado desde la app> escribe, junto a la recuperación, un respaldo completo
//   (<parte>_respaldo_con_recuperacion.json) con ese respaldo y el TrackEdits de la parte sustituido. El respaldo
//   original no se toca. Solo se CREAN archivos nuevos; ninguno existente se modifica.
//
// Fuente principal: labels_*.json guarda `edits` completo (buildLabels hace `...edits`) salvo los nombres de las
// personas, que se sacan de tracks_fixed_*.json (people[].player_id). Todo se verifica rehaciendo buildFixed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const lib = (f) => import(pathToFileURL(path.join(root, "web", "lib", f)).href);
const { buildFixed, DEFAULT_SMOOTH } = await lib("fixedExport.ts");
const { pixelToPitch, manualBall, autoBall } = await lib("parts.ts");
const { partStatus } = await lib("quick.ts");
const { editsKey, emptyEdits } = await lib("tracks.ts");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const MATCH = arg("match", "2026_10_10_tec_ccm_vs_up");
const PART = arg("part", "v1_3339_15666");
const MERGE = arg("merge", null);
const dir = path.join(root, "matches", MATCH, "tracking");
const outDir = path.join(root, "matches", MATCH, arg("out", "recuperacion"));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const exists = (p) => fs.existsSync(p);

const rawPath = path.join(dir, `tracks_${PART}.json`);
const fixedPath = path.join(dir, `tracks_fixed_${PART}.json`);
const labelsPath = path.join(dir, `labels_${PART}.json`);
const autoPath = path.join(dir, `ball_auto_${PART}.json`);
for (const p of [rawPath, fixedPath, labelsPath]) if (!exists(p)) throw new Error(`falta ${p}`);
const raw = readJson(rawPath);
const fixed = readJson(fixedPath);
const labels = readJson(labelsPath);
const auto = exists(autoPath) ? readJson(autoPath) : null;
const ballAuto = auto && auto.kind === "ball_auto" && Array.isArray(auto.frames) ? { frames: auto.frames, ask: auto.ask ?? [] } : null;
const key = editsKey(raw);
if (labels.edits.key !== key) throw new Error(`la clave de labels (${labels.edits.key}) no es la del crudo (${key})`);

// ---------------------------------------------------------------- reconstruction
const lost = []; // [what, why]
const notes = [];
const edits = JSON.parse(JSON.stringify(labels.edits));

// People: labels dropped the names (stored `named` instead of `player_id`); tracks_fixed has them.
const fixedName = new Map(fixed.people.filter((p) => p.player_id).map((p) => [String(p.id), p.player_id]));
const fixedTeam = new Map(fixed.people.map((p) => [String(p.id), p.team]));
let namesBack = 0;
const unnamedAgain = [];
for (const [id, meta] of Object.entries(edits.people)) {
  const wasNamed = meta.named === true;
  delete meta.named;
  if (wasNamed) {
    const n = fixedName.get(id);
    if (n) {
      meta.player_id = n;
      namesBack++;
    } else unnamedAgain.push(id);
  }
}
// A name in tracks_fixed whose identity has no entry in labels' people (cannot happen when both come from one save).
for (const [id, n] of fixedName) {
  if (!edits.people[id]) {
    edits.people[id] = { player_id: n };
    namesBack++;
    notes.push(`identidad ${id} (${n}): nombre en tracks_fixed sin entrada en labels; se añadió sólo el nombre (sin equipo ni done)`);
  } else if (!edits.people[id].player_id) {
    edits.people[id].player_id = n;
    namesBack++;
    notes.push(`identidad ${id} (${n}): labels no la marcaba como nombrada; se tomó el nombre de tracks_fixed`);
  }
}
if (unnamedAgain.length) lost.push([`nombre de ${unnamedAgain.length} persona(s) marcadas como nombradas (identidades ${unnamedAgain.join(", ")})`, "no aparecen en tracks_fixed.people: o estaban descartadas (removed) o sin cajas; el nombre sólo vive en el navegador"]);

// ---------------------------------------------------------------- verification
const jc = (() => {
  const t = fs.readFileSync(path.join(root, "matches", MATCH, "match.yaml"), "utf8");
  const m = /^\s*jersey_colors:\s*\{([^}]*)\}/m.exec(t);
  if (!m) return {};
  const o = {};
  for (const kv of m[1].split(",")) {
    const [k, v] = kv.split(":").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    if (k && v) o[k] = v;
  }
  return o;
})();
const run = (e, extra = {}) => buildFixed(raw, e, { colors: jc, smooth: DEFAULT_SMOOTH, events: [], attackRight: null, ballAuto, ...extra });
const rebuilt = run(edits);
const diffs = [];
const same = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  diffs.push({ label, ok, disk: ok ? undefined : summary(a), rebuilt: ok ? undefined : summary(b) });
  return ok;
};
const summary = (v) => (Array.isArray(v) ? `${v.length} elementos` : JSON.stringify(v)?.slice(0, 120));
const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
same("personas (id, equipo, nombre, tracks)", fixed.people, rebuilt.out.people);
same("balón (todas las posiciones)", fixed.ball, rebuilt.out.ball);
same("estados del balón (no se ve / fuera)", fixed.ball_states, rebuilt.out.ball_states);
same("cortes de cámara", fixed.camera_cuts, rebuilt.out.camera_cuts);
same("suavizado (totales)", fixed.smoothing, rebuilt.out.smoothing);
const flat = (o) => o.frames.map((f) => `${f.frame}:` + f.positions.map((p) => `${p.id},${p.x},${p.y},${p.source}`).join(";"));
const fa = flat(fixed);
const fb = flat(rebuilt.out);
const rowsEqual = fa.length === fb.length && fa.every((s, i) => s === fb[i]);
const nPos = (o) => o.frames.reduce((n, f) => n + f.positions.length, 0);
diffs.push({ label: `posiciones por cuadro (${nPos(fixed)} en disco, ${nPos(rebuilt.out)} reconstruidas)`, ok: rowsEqual, disk: rowsEqual ? undefined : `${fa.filter((s, i) => s !== fb[i]).length} cuadros distintos` });

// Cross-check the ball marks in pixels against the manual ball positions of tracks_fixed (inverse of the projection):
// pixelToPitch(px,py) with the frame's homography must give the position written in tracks_fixed.
const Hof = new Map(raw.frames.map((f) => [f.frame, f.H]));
const fixedManual = new Map(fixed.ball.filter((b) => b.source === "manual" && !b.air).map((b) => [b.frame, b]));
let maxD = 0;
let checked = 0;
let noMatch = 0;
for (const m of edits.ball ?? []) {
  if (m.air) continue;
  const b = fixedManual.get(m.frame);
  const p = pixelToPitch(raw, Hof.get(m.frame), m.px, m.py);
  if (!b || !p) {
    noMatch++;
    continue;
  }
  maxD = Math.max(maxD, Math.hypot(b.x - p[0], b.y - p[1]));
  checked++;
}
const markFrames = new Set((edits.ball ?? []).filter((m) => !m.air).map((m) => m.frame));
const extraInFixed = [...fixedManual.keys()].filter((f) => !markFrames.has(f));
diffs.push({ label: `marcas de balón en píxeles vs posiciones manuales de tracks_fixed (${checked} comparadas, desvío máximo ${maxD.toFixed(3)} m, ${noMatch} sin pareja, ${extraInFixed.length} manuales de disco sin marca)`, ok: maxD < 0.02 && noMatch === 0 && extraInFixed.length === 0 });

// aerial / air flags from tracks_fixed vs the edits
const fixedAerial = fixed.ball.filter((b) => b.aerial).length;
const fixedAir = fixed.ball.filter((b) => b.air).length;
const editsAerial = (edits.ball ?? []).filter((m) => m.aerial || m.air).length;
diffs.push({ label: `marcas aéreas: ${editsAerial} en las ediciones, ${fixedAerial} (aerial) y ${fixedAir} (air) en tracks_fixed`, ok: fixedAerial === rebuilt.out.ball.filter((b) => b.aerial).length });

// partStatus
const span = { start_frame: raw.start_frame, end_frame: raw.end_frame, fps: raw.fps, stride: raw.stride };
const extraOf = (out) => out.ball.filter((b) => b.source === "event" || b.source === "auto").map((b) => b.frame);
const statusRecovered = partStatus(edits, span, extraOf(rebuilt.out));
const statusEmpty = partStatus(emptyEdits(key), span, []);
const statusSavedHash = partStatus(edits, span, extraOf(fixed));
const nIdentitiesNamed = Object.values(edits.people).filter((p) => p.player_id).length;

// ---------------------------------------------------------------- what was not recovered (explicit)
lost.push(["tracks_fixed y labels son SALIDA de las ediciones: lo que se hizo después de las 08:13 del 2026-11-06 (si algo) no está", "es el último «Guardar»; la app no guarda nada más en disco"]);
lost.push(["ediciones de las otras 8 partes del partido (v1_15933_32688, v2_*, v3_*)", "este script sólo trabaja la parte indicada; cada parte tiene sus propios labels_*.json y se puede repetir con --part"]);
lost.push(["eventos etiquetados, jugadas, anclas, tramos, sedes, plantilla (roster), rivales nombrados, jerseys, pizarrón y clips del navegador", "no son TrackEdits: no se escriben en tracks_fixed ni labels. Con --merge se conservan los del respaldo que exportes"]);
lost.push(["preferencias por navegador (sentido de ataque attack:<carpeta>:<video>, registro «saved:», velocidad, etc.)", "viven fuera del respaldo; el sentido de ataque se vuelve a elegir en la app"]);
lost.push(["estado A/B de comparación de rellenos (PartReview: base, checkpoint, verified)", "no se guarda en disco; sólo importa a «Empezar de cero», no a las ediciones"]);
if ((edits.quick?.seen ?? []).length === 0) notes.push("quick.seen venía vacío ya en labels (no es una pérdida: la revisión rápida se hizo con quick.done / quick.labels)");
if (!edits.ballReview?.seen?.length) lost.push(["ballReview.seen", "vacío en labels"]);

// ---------------------------------------------------------------- output
fs.mkdirSync(outDir, { recursive: true });
const outName = `edits_recuperadas_${PART}.json`;
const out = {
  _recuperacion: {
    generado: new Date().toISOString(),
    parte: key,
    fuente: { labels: path.basename(labelsPath), labels_exportado_en: labels.exported_at, tracks_fixed: path.basename(fixedPath), crudo: path.basename(rawPath) },
    aviso: "NO es un respaldo completo: no trae partidos ni eventos, por eso «Restaurar un respaldo» lo rechaza (no puede borrar nada). Usa --merge con un respaldo exportado desde la app.",
    no_recuperado: lost.map(([que, motivo]) => ({ que, motivo })),
    notas: notes,
  },
  trackEdits: [edits],
};
const write = (name, obj) => {
  const p = path.join(outDir, name);
  if (exists(p)) throw new Error(`${p} ya existe; no se sobrescribe. Bórralo tú o cambia de nombre.`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};
const written = [];
if (exists(path.join(outDir, outName)) && MERGE) notes.push(`${outName} ya existía de una corrida anterior; se deja como está`);
else written.push(write(outName, out));
if (MERGE) {
  const base = readJson(MERGE);
  if (!base || !Array.isArray(base.matches) || !Array.isArray(base.events)) throw new Error("--merge: ese archivo no parece un respaldo de la app");
  const list = Array.isArray(base.trackEdits) ? base.trackEdits : [];
  const prev = list.find((t) => t.key === key);
  const merged = { ...base, trackEdits: [...list.filter((t) => t.key !== key), edits] };
  notes.push(prev ? `el respaldo traía esta parte con ${(prev.ball ?? []).length} marcas de balón y ${Object.keys(prev.people ?? {}).length} personas; se REEMPLAZÓ por la recuperada (${(edits.ball ?? []).length} marcas, ${Object.keys(edits.people).length} personas)` : "el respaldo no traía esta parte; se añadió");
  written.push(write(`${PART}_respaldo_con_recuperacion.json`, merged));
}

// ---------------------------------------------------------------- console report
const pct = (x) => `${Math.round(100 * x)} %`;
console.log(`Parte ${key}`);
console.log(`Ediciones: identity ${Object.keys(edits.identity).length}, splits ${edits.splits.length}, removed ${edits.removed.length}, manual ${edits.manual.length}, dropped ${(edits.dropped ?? []).length}, ball ${(edits.ball ?? []).length}, ballStates ${(edits.ballStates ?? []).length}, ballLinks ${(edits.ballLinks ?? []).length}, ballReview.seen ${(edits.ballReview?.seen ?? []).length}, quick.labels ${(edits.quick?.labels ?? []).length}, quick.done ${(edits.quick?.done ?? []).length}`);
console.log(`Personas con ficha ${Object.keys(edits.people).length}, con nombre ${nIdentitiesNamed} (nombres devueltos ${namesBack}); marcadas «done» ${Object.values(edits.people).filter((p) => p.done).length}`);
console.log("Verificación contra el disco:");
for (const d of diffs) console.log(`  ${d.ok ? "OK  " : "DIF "} ${d.label}${d.ok ? "" : `  [disco: ${d.disk}; reconstruido: ${d.rebuilt}]`}`);
console.log(`partStatus recuperado: verificadas ${statusRecovered.players}, revisión rápida ${statusRecovered.quick}, balón ${pct(statusRecovered.ball)}, completa ${statusRecovered.complete}`);
console.log(`partStatus con balón de tracks_fixed: balón ${pct(statusSavedHash.ball)}; sin ediciones: balón ${pct(statusEmpty.ball)}`);
console.log("No recuperado:");
for (const [q, m] of lost) console.log(`  - ${q}: ${m}`);
for (const n of notes) console.log(`Nota: ${n}`);
console.log("Escrito:");
for (const w of written) console.log(`  ${w}`);
process.exitCode = diffs.every((d) => d.ok) ? 0 : 2;
