// The doubt cards of the anchors mode: which boxes a doubt is about (exact frame and track), what the jump measures,
// and what each answer does to the edits. Python writes `boxes` (and `jump`, `resolution`) into every doubt; files
// written before that get the boxes worked out here from the tracks (marked `derived`, shown as such).
// Pure functions: no storage, no React.
import type { Doubt } from "./anchors.ts";
import { dropBoxes, identityOf, merge, separateRun, type DetBox, type TracksFile } from "./tracks.ts";
import { PITCH, type TrackEdits } from "./types.ts";

// Contract of the new fields of a doubt (sportsan.tracking.anchors fill):
//   boxes: [{frame, track, player, role, t, chain}]  role: antes | despues (salto), a | b (dos_sitios), a | b | candidata
//   jump: {dist_m, dt_s, speed_ms, from, to}        resolution: {options, default}  (absent in older links)
export type BoxRole = "before" | "after" | "a" | "b" | "end" | "cand" | string;
export interface DoubtBox {
  role: BoxRole;
  frame: number;
  track: number;
  player?: string | null;
  t?: number;
  chain?: number | null;
}
// As written by Python (fill): meters, seconds, m/s and the two places on the pitch (105 x 68).
export interface DoubtJump {
  dist_m: number;
  dt_s: number;
  speed_ms: number;
  from?: [number, number];
  to?: [number, number];
}
export interface DoubtResolution {
  options: string[];
  default: string;
}
export type RichDoubt = Doubt & { boxes?: DoubtBox[]; jump?: DoubtJump; resolution?: DoubtResolution; t0?: number; t1?: number };
// Python's roles -> the card's: salto antes/despues, dos_sitios a/b, union_dudosa a (end of the previous chain, may be
// missing) / b (start of the doubtful one) / candidates.
const ROLE: Record<string, Record<string, BoxRole>> = {
  salto: { antes: "before", despues: "after" },
  union_dudosa: { a: "end", b: "cand" },
};
export function normalizeBoxes(kind: string, boxes: DoubtBox[]): DoubtBox[] {
  const m = ROLE[kind] ?? {};
  const out = boxes.map((b) => ({ ...b, role: m[b.role] ?? b.role }));
  // A join without the end of the previous chain: the doubtful start goes second, as in the card.
  if (kind === "union_dudosa" && !out.some((b) => b.role === "end")) return out;
  return out;
}
// Python's default answer, in the card's words.
export const RESOLUTION_NAMES: Record<string, string> = {
  antes_es_ella: "1 es ella",
  despues_es_ella: "2 es ella",
  a_es_ella: "A es ella",
  b_es_ella: "B es ella",
  ninguna: "ninguna",
  esta_bien: "está bien",
  las_dos: "las dos",
  unir: "unir",
  no_unir: "no unir",
  otra: "otra",
};

// The anchor of a box that is not a player (a referee, a coach, a ball boy). Python leaves it out of every identity.
export const NOT_PLAYER = "__no__";

// The kinds of doubt and what to do in each (the legend «Tipos de duda» and the line inside each card).
export const DOUBT_TYPES: { kind: string; name: string; task: boolean; what: string; todo: string }[] = [
  { kind: "salto", name: "Salto", task: true, what: "Entre dos cuadros seguidos la jugadora se movería más rápido de lo posible.", todo: "Mira ANTES y DESPUÉS: elige cuál caja es ella (1 o 2), «ninguna», o «es real» si de verdad corrió." },
  { kind: "dos_sitios", name: "En dos sitios", task: true, what: "La misma jugadora tiene dos cajas en el mismo cuadro.", todo: "Elige cuál caja es ella (A o B); «las dos» si es la misma persona detectada dos veces; «ninguna» si no es ella." },
  { kind: "union_dudosa", name: "Unión dudosa", task: true, what: "Python unió el final de un trozo con otro que empieza después, con poca seguridad.", todo: "Compara el fin del trozo con la candidata: «unir», «no unir» u «otra» (es otra jugadora)." },
  { kind: "hueco_largo", name: "Hueco largo", task: false, what: "La jugadora no se ve durante un rato (fuera de cuadro o tapada).", todo: "Informativa: no hay que hacer nada; el hueco se rellena al exportar." },
  { kind: "sin_nombre", name: "Sin nombre", task: false, what: "Un trozo largo que nadie nombró.", todo: "Informativa: se puede nombrar en la mesa si importa." },
  { kind: "no_jugadora", name: "No jugadora", task: false, what: "Un trozo anclado como «No es jugadora» (árbitra, banca, cuerpo técnico).", todo: "Informativa: queda fuera de las jugadoras." },
];
export const doubtType = (kind: string) => DOUBT_TYPES.find((t) => t.kind === kind);

type Hit = { frame: number; box: DetBox };
function boxAt(file: TracksFile, frame: number, track: number): DetBox | undefined {
  return file.frames.find((f) => f.frame === frame)?.boxes.find((b) => b[0] === track);
}
const nameOf = (edits: TrackEdits, id: number) => edits.people[String(id)]?.player_id ?? "";

// The boxes of a doubt: Python's when the doubt has them; otherwise worked out from the tracks.
export function doubtBoxes(d: RichDoubt, file: TracksFile, edits: TrackEdits): { boxes: DoubtBox[]; derived: boolean } {
  if (d.boxes?.length) return { boxes: normalizeBoxes(d.kind, d.boxes), derived: false };
  const player = d.players[0];
  const fps = file.fps;
  const isHer = (h: Hit) => !!player && nameOf(edits, identityOf(h.box, h.frame, edits)) === player;
  const boxes: DoubtBox[] = [];
  if (d.kind === "dos_sitios") {
    const fr = file.frames.find((f) => f.frame === d.frame);
    const hers = (fr?.boxes ?? []).filter((b) => isHer({ frame: d.frame, box: b }));
    const list = hers.some((b) => b[0] === d.track) ? hers : [...hers, ...(fr?.boxes ?? []).filter((b) => b[0] === d.track)];
    list.slice(0, 2).forEach((b, i) => boxes.push({ role: i ? "b" : "a", frame: d.frame, track: b[0], player }));
  } else if (d.kind === "salto" || d.kind === "union_dudosa") {
    // Her last box before the doubt (another track for a join; any for a jump), at most 2 s before.
    let prev: Hit | null = null;
    for (const fr of file.frames) {
      if (fr.frame >= d.frame) break;
      if (d.frame - fr.frame > 2 * fps) continue;
      for (const b of fr.boxes) {
        const h = { frame: fr.frame, box: b };
        if (d.kind === "union_dudosa" && b[0] === d.track) continue;
        if (isHer(h) || (!player && b[0] === d.track)) prev = h;
      }
    }
    const first = d.kind === "salto" ? "before" : "end";
    if (prev) boxes.push({ role: first, frame: prev.frame, track: prev.box[0], player });
    if (boxAt(file, d.frame, d.track)) boxes.push({ role: d.kind === "salto" ? "after" : "cand", frame: d.frame, track: d.track });
  } else if (boxAt(file, d.frame, d.track)) boxes.push({ role: "a", frame: d.frame, track: d.track });
  return { boxes, derived: true };
}

// Meters of the venue between two boxes, the seconds and the speed (null when a position is missing).
export function jumpBetween(file: TracksFile, a: DoubtBox, b: DoubtBox): { meters: number; seconds: number; speed: number; from: [number, number]; to: [number, number] } | null {
  const ba = boxAt(file, a.frame, a.track);
  const bb = boxAt(file, b.frame, b.track);
  if (!ba || !bb || ba[9] == null || ba[10] == null || bb[9] == null || bb[10] == null) return null;
  const sx = (file.venue?.length_m ?? PITCH.length) / PITCH.length;
  const sy = (file.venue?.width_m ?? PITCH.width) / PITCH.width;
  const meters = Math.hypot((bb[9] - ba[9]) * sx, (bb[10] - ba[10]) * sy);
  const seconds = Math.abs(b.frame - a.frame) / file.fps;
  return { meters, seconds, speed: seconds > 0 ? meters / seconds : Number.NaN, from: [ba[9], ba[10]], to: [bb[9], bb[10]] };
}

// The frames of the time steps of a card: every processed frame within ±1 s of the doubt.
export function stepFrames(file: TracksFile, frame: number, spanS = 1): number[] {
  const span = spanS * file.fps;
  return file.frames.filter((f) => Math.abs(f.frame - frame) <= span).map((f) => f.frame);
}

// Pixel rectangle of a box (for the mini views), or null.
export function boxRect(file: TracksFile, b: Pick<DoubtBox, "frame" | "track">): [number, number, number, number] | null {
  const x = boxAt(file, b.frame, b.track);
  return x ? [x[1], x[2], x[3], x[4]] : null;
}

export type Answer = "pick" | "none" | "ok" | "both" | "join" | "nojoin";

// What an answer does. `pick`: box `index` is her, every other box of the doubt is cut out of her (its run becomes a
// person of its own). `none`: every box is cut out. `ok` / `both`: nothing changes, except that «both» (one player
// detected twice) leaves out the second box. `join`: the candidate becomes the same person as the end of the chain.
// `nojoin`: the candidate is cut out.
export function answerDoubt(edits: TrackEdits, file: TracksFile, boxes: DoubtBox[], answer: Answer, index = 0): { edits: TrackEdits; changed: number } {
  let next = edits;
  let changed = 0;
  const cut = (b: DoubtBox) => {
    const r = separateRun(next, file, b.track, b.frame);
    if (r) {
      next = r.edits;
      changed++;
    }
  };
  const idOf = (b: DoubtBox) => {
    const x = boxAt(file, b.frame, b.track);
    return x ? identityOf(x, b.frame, next) : null;
  };
  if (answer === "pick") {
    const her = boxes[index];
    const herId = her ? idOf(her) : null;
    for (const [i, b] of boxes.entries()) if (i !== index && (herId === null || idOf(b) === herId || boxes.length === 2)) cut(b);
  } else if (answer === "none") boxes.forEach(cut);
  else if (answer === "both" && boxes[1]) {
    next = dropBoxes(next, [{ track: boxes[1].track, frame: boxes[1].frame }]);
    changed = 1;
  } else if (answer === "join") {
    const end = boxes.find((b) => b.role === "end") ?? boxes[0];
    const cand = boxes.find((b) => b.role === "cand") ?? boxes[1];
    const a = end ? idOf(end) : null;
    const c = cand ? idOf(cand) : null;
    if (a !== null && c !== null && a !== c) {
      next = merge(next, a, c);
      changed = 1;
    }
  } else if (answer === "nojoin") {
    const cand = boxes.find((b) => b.role === "cand") ?? boxes[1];
    if (cand) cut(cand);
  }
  return { edits: next, changed };
}
