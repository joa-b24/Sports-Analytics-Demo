// Evalúa las sugerencias de web/lib/autoEvents.ts contra los eventos etiquetados a mano (L3, 2026-11-05).
//
//   node scripts/eval_auto_events.mjs [--match <id>]... [--tol 2] [--detail] [--json salida.json]
//
// Por defecto usa partidos terminados (nunca 2026_10_10_tec_ccm_vs_up). Lee solo archivos; no escribe en matches/.
// Qué se compara: para cada parte `tracks_fixed_<video>_<ini>_<fin>.json` se corre autoEvents (la misma entrada que arma
// Correction.tsx) y cada evento de cada opción se empareja uno a uno con un evento a mano del mismo tipo y equipo cuyo
// t_video difiera menos que la tolerancia.
//  - "primera opción": solo cuenta la primera opción de cada sugerencia (la que la mesa propone antes).
//  - "alguna opción": cuenta cualquiera (la analista puede elegir otra opción al aceptar).
// Aproximaciones (el archivo de la parte no guarda qué cuadros revisó la analista en el navegador):
//  - reviewed = toda la parte; out = los rangos "out" de ball_states si los hay.
//  - ownRight se infiere por video comparando la x de los eventos propios con la del balón marcado (contrato: own ataca a x=105).
// El recall solo cuenta eventos a mano dentro de una parte con balón; la precisión es contra todo lo etiquetado, y una
// sugerencia sin etiqueta puede ser un evento real que la analista no etiquetó (la precisión es una cota baja).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoEvents, AUTO } from "../web/lib/autoEvents.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const matches = args.flatMap((a, i) => (a === "--match" ? [args[i + 1]] : []));
if (matches.length === 0) matches.push("2026_09_25_tec_ccm_vs_anahuac");
const TOL = Number(opt("--tol", "2"));
const DETAIL = args.includes("--detail");
// --set clave=valor (repetible): cambia un umbral de AUTO solo durante esta corrida, para barridos.
for (let i = 0; i < args.length; i++) if (args[i] === "--set") { const [k, v] = args[i + 1].split("="); if (!(k in AUTO)) throw new Error(`AUTO.${k} no existe`); AUTO[k] = Number(v); }
const QUIET = args.includes("--quiet");
const jsonOut = opt("--json", null);
if (matches.some((m) => m.includes("2026_10_10_tec_ccm_vs_up"))) throw new Error("Ese partido lo está marcando la analista.");

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const TYPES = ["throw_in", "goal_kick", "corner", "goal", "final_third_entry", "box_entry", "cross", "loss", "recovery", "duel", "foul", "free_kick", "penalty", "offside"];

// own ataca hacia x=105 en las coordenadas de eventos; el archivo está "como se filmó".
function inferOwnRight(parts, events) {
  let right = 0, left = 0;
  for (const e of events) {
    if (e.team !== "own" || e.x === "" || !["final_third_entry", "box_entry", "corner", "goal", "shot", "cross"].includes(e.type)) continue;
    const ex = Number(e.x);
    for (const f of parts) {
      const fr = e.t_video * f.fps;
      if (fr < f.start_frame || fr > f.end_frame) continue;
      let best = null;
      for (const b of f.ball) if (b.source === "manual" && (!best || Math.abs(b.frame - fr) < Math.abs(best.frame - fr))) best = b;
      if (!best || Math.abs(best.frame - fr) > 1.5 * f.fps) continue;
      if (Math.abs(ex - best.x) < Math.abs(ex - (105 - best.x))) right++; else left++;
    }
  }
  return { ownRight: right >= left, right, left };
}

function stats() { return Object.fromEntries(TYPES.map((t) => [t, { sug: 0, tp: 0, gt: 0, gtHit: 0, dts: [] }])); }
const modes = { first: stats(), any: stats() };
const detail = [];
const byRule = {}; // regla/confianza -> { sug, ok } (primera opción)

for (const id of matches) {
  const dir = path.join(root, "matches", id);
  const csv = fs.readdirSync(dir).find((f) => /^events_.*\.csv$/.test(f));
  const events = parseCsv(fs.readFileSync(path.join(dir, csv), "utf8")).map((e) => ({ ...e, t_video: Number(e.t_video), video_id: e.video_id || "v1" }));
  const tdir = path.join(dir, "tracking");
  const files = fs.readdirSync(tdir).filter((f) => /^tracks_fixed_.*\.json$/.test(f)).sort();
  const byVideo = new Map();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8"));
    if (j.parts) continue; // unión de varias partes: ya están por separado
    if (!byVideo.has(j.video_id)) byVideo.set(j.video_id, []);
    byVideo.get(j.video_id).push(j);
  }
  for (const [video, parts] of byVideo) {
    const gtAll = events.filter((e) => e.video_id === video && TYPES.includes(e.type));
    const { ownRight, right, left } = inferOwnRight(parts, gtAll);
    console.error(`${id} ${video}: ${parts.length} partes, ownRight=${ownRight} (votos ${right}/${left})`);
    // Sugerencias de todas las partes (con la unión de partes que se solapan, se descartan duplicados por tipo/equipo/tiempo).
    const sugs = [];
    for (const f of parts) {
      const out = (f.ball_states ?? []).filter((s) => s.state === "out" || s.state === "hidden").flatMap((s) => [s.from ?? s.start, s.to ?? s.end]).filter((x) => x != null);
      void out;
      const res = autoEvents({ file: f, ownRight, reviewed: [[f.start_frame, f.end_frame]], out: [], links: [] });
      for (const s of res) sugs.push({ s, fps: f.fps });
    }
    // Cobertura para el recall: cuadros con balón en alguna parte.
    const covered = (t) => parts.some((f) => t * f.fps >= f.start_frame && t * f.fps <= f.end_frame && f.ball.length > 0);
    for (const mode of ["first", "any"]) {
      const st = modes[mode];
      const pool = sugs.flatMap(({ s, fps }) => s.options.slice(0, mode === "first" ? 1 : undefined).flatMap((o, oi) => o.events.map((e) => ({ e, t: e.frame / fps, rule: s.rule, conf: s.confidence, oi, sid: s.id }))));
      const gt = gtAll.filter((e) => covered(e.t_video));
      // Emparejamiento uno a uno, voraz por menor diferencia.
      const pairs = [];
      for (let i = 0; i < pool.length; i++) for (let j = 0; j < gt.length; j++) {
        const dt = pool[i].t - gt[j].t_video;
        if (pool[i].e.type === gt[j].type && pool[i].e.team === gt[j].team && Math.abs(dt) <= TOL) pairs.push({ i, j, dt });
      }
      pairs.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt));
      const usedI = new Set(), usedJ = new Set();
      for (const p of pairs) {
        if (usedI.has(p.i) || usedJ.has(p.j)) continue;
        usedI.add(p.i); usedJ.add(p.j);
        st[pool[p.i].e.type].tp++; st[pool[p.i].e.type].gtHit++; st[pool[p.i].e.type].dts.push(p.dt);
      }
      for (const x of pool) st[x.e.type].sug++;
      if (mode === "first") pool.forEach((x, i) => { const k = `${x.rule}/${x.conf}`; (byRule[k] ??= { sug: 0, ok: 0 }).sug++; if (usedI.has(i)) byRule[k].ok++; });
      for (const g of gt) st[g.type].gt++;
      if (DETAIL && mode === "first") {
        for (let i = 0; i < pool.length; i++) if (!usedI.has(i)) detail.push(`FP ${id} ${video} ${pool[i].t.toFixed(1)}s ${pool[i].e.type}/${pool[i].e.team} (${pool[i].rule})`);
        gt.forEach((g, j) => { if (!usedJ.has(j)) detail.push(`FN ${id} ${video} ${g.t_video.toFixed(1)}s ${g.type}/${g.team}`); });
      }
    }
  }
}

if (QUIET) {
  // Una línea: tipo=ok/sugeridas/a mano (primera opción), para comparar barridos.
  console.log(TYPES.filter((t) => modes.first[t].sug || modes.first[t].gt).map((t) => `${t}=${modes.first[t].tp}/${modes.first[t].sug}/${modes.first[t].gt}`).join(" "));
  process.exit(0);
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "  - ");
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : "-");
const result = {};
for (const mode of ["first", "any"]) {
  console.log(`\n== ${mode === "first" ? "Primera opción" : "Alguna opción"} (tolerancia ${TOL} s) ==`);
  console.log("tipo               sug   ok  precisión | a mano  halladas  recall | dt mediano");
  const tot = { sug: 0, tp: 0, gt: 0 };
  result[mode] = {};
  for (const t of TYPES) {
    const r = modes[mode][t];
    if (!r.sug && !r.gt) continue;
    tot.sug += r.sug; tot.tp += r.tp; tot.gt += r.gt;
    result[mode][t] = { suggested: r.sug, correct: r.tp, precision: r.sug ? r.tp / r.sug : null, labelled: r.gt, recall: r.gt ? r.gtHit / r.gt : null, median_dt: r.dts.length ? Number(median(r.dts)) : null };
    console.log(`${t.padEnd(18)} ${String(r.sug).padStart(4)} ${String(r.tp).padStart(4)}  ${pct(r.tp, r.sug).padStart(8)} | ${String(r.gt).padStart(6)} ${String(r.gtHit).padStart(9)}  ${pct(r.gtHit, r.gt).padStart(6)} | ${median(r.dts)}`);
  }
  console.log(`${"TOTAL".padEnd(18)} ${String(tot.sug).padStart(4)} ${String(tot.tp).padStart(4)}  ${pct(tot.tp, tot.sug).padStart(8)} | ${String(tot.gt).padStart(6)} ${String(tot.tp).padStart(9)}  ${pct(tot.tp, tot.gt).padStart(6)} |`);
}
console.log("\nPor regla y confianza (primera opción):");
for (const [k, v] of Object.entries(byRule).sort()) console.log(`  ${k.padEnd(28)} ${String(v.sug).padStart(4)} sugeridas, ${String(v.ok).padStart(3)} ok (${pct(v.ok, v.sug)})`);
if (DETAIL) console.log("\n" + detail.sort().join("\n"));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ matches, tolerance_s: TOL, result }, null, 1));
