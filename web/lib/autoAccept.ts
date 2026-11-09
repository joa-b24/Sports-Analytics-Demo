import { acceptTramo, tramoKey, type Doubt, type TramoSuggestion } from "./anchors.ts";
import { RUN_MS, SLACK_M } from "./suggestions.ts";
import { assignStretch, boxTeamOf, droppedSet, fileTeamRefs, identityOf, isDropped, type DetBox, type Person, type TracksFile } from "./tracks.ts";
import { PITCH, type AutoAccepted, type TrackEdits } from "./types.ts";

// «Aceptar las seguras» of the anchors mode: of the joins Python suggests (links_<part>_exp_tramos.json `suggestions`:
// person, track, stretch, p, cost) the ones that are TRIVIAL are accepted together, as ONE edit (Ctrl + Z undoes the batch),
// marked in TrackEdits.autoAccepted so they can be reviewed and taken out one by one. Pure functions.
//
// A suggestion is safe only if ALL of this holds (everything is read from fields the suggestion or the table already has;
// nothing is made up):
//   p       the probability the file carries is at least the match's threshold (Detalles técnicos, default 0.98);
//   costo   its cost is at most AUTO_MAX_COST (half of what Python lets through, 1.0): the file has no other «cost» of effort;
//   sin_cajas / varias / ya_suya   the stretch has boxes, they all belong to ONE identity (so it can go back) that is not already hers;
//   dueña / verificada   that identity has no other name and is not verified (nothing taken from named or verified people);
//   equipo  no box of the stretch has the colour of another team (the person is expected to be of her own team, our roster);
//   solape  she has no other box in those frames;
//   salto   she could have run from her nearby boxes (before and after) to the stretch (same speed rule as the table);
//   duda    no pending «en dos sitios» / «salto» / «unión dudosa» of the fill touches that track, or that player, there.
// Missing data is never filled in: a stretch whose position is missing next to a box of hers cannot be checked, so it is
// not safe.
export const AUTO_MAX_COST = 0.5;
// Window around the stretch where a pending doubt makes it unsafe (s).
export const AUTO_DOUBT_WINDOW_S = 1;
export const AUTO_DOUBT_KINDS = ["dos_sitios", "salto", "union_dudosa"];

export type AutoReason = "p" | "costo" | "sin_cajas" | "varias" | "ya_suya" | "dueña" | "verificada" | "equipo" | "solape" | "salto" | "duda";
export const AUTO_REASON_NAMES: Record<AutoReason, string> = {
  p: "probabilidad baja",
  costo: "costo alto",
  sin_cajas: "sin cajas en el tramo",
  varias: "el trozo es de varias personas",
  ya_suya: "ya era suyo",
  dueña: "es de otra jugadora",
  verificada: "es de una jugadora verificada",
  equipo: "caja de otro equipo",
  solape: "se solapa con otra caja suya",
  salto: "salto imposible",
  duda: "hay una duda pendiente",
};

export interface AutoContext {
  file: TracksFile;
  edits: TrackEdits;
  // People of the table (Person of lib/tracks.ts) and the identity of each name that has one.
  ppl: Person[];
  named: Map<string, number>;
  // The doubts of the fill still pending (sortDoubts(...).pending).
  doubts: Doubt[];
}
export interface AutoVerdict {
  s: TramoSuggestion;
  safe: boolean;
  reasons: AutoReason[];
  // The identity the stretch has now (when it has one).
  prev: number | null;
}

type Pt = { frame: number; track: number; x: number; y: number };

// Index of the first frame entry with frame >= f (frames come sorted).
function lowerBound(frames: { frame: number }[], f: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].frame < f) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function lowerBoundPts(pts: Pt[], f: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].frame < f) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function judgeTramos(ctx: AutoContext, list: TramoSuggestion[], minP: number): AutoVerdict[] {
  const { file, edits, ppl, named, doubts } = ctx;
  const sx = (file.venue?.length_m ?? PITCH.length) / PITCH.length;
  const sy = (file.venue?.width_m ?? PITCH.width) / PITCH.width;
  const fps = file.fps;
  const byId = new Map(ppl.map((p) => [p.id, p]));
  const drop = droppedSet(edits);
  const removed = new Set(edits.removed);
  const refs = fileTeamRefs(file);
  const pos = (b: DetBox): [number, number] | null => (b[9] == null || b[10] == null ? null : [b[9] * sx, b[10] * sy]);

  // Where each person who matters is, frame by frame (one pass over the file, only for them).
  const wanted = new Set<number>();
  for (const s of list) {
    const id = named.get(s.person);
    if (id !== undefined) wanted.add(id);
  }
  const at = new Map<number, Pt[]>();
  if (wanted.size) {
    for (const fr of file.frames) {
      for (const b of fr.boxes) {
        if (isDropped(drop, b, fr.frame)) continue;
        const id = identityOf(b, fr.frame, edits);
        if (!wanted.has(id)) continue;
        const p = pos(b);
        const row: Pt = { frame: fr.frame, track: b[0], x: p ? p[0] : Number.NaN, y: p ? p[1] : Number.NaN };
        const l = at.get(id);
        if (l) l.push(row);
        else at.set(id, [row]);
      }
    }
  }
  const win = AUTO_DOUBT_WINDOW_S * fps;
  const pending = doubts.filter((d) => AUTO_DOUBT_KINDS.includes(d.kind));

  return list.map((s): AutoVerdict => {
    const reasons: AutoReason[] = [];
    if (!(s.p >= minP)) reasons.push("p");
    if (!(s.cost <= AUTO_MAX_COST)) reasons.push("costo");
    // The boxes of the stretch.
    const piece: { frame: number; box: DetBox }[] = [];
    for (let i = lowerBound(file.frames, s.frame_ini); i < file.frames.length && file.frames[i].frame <= s.frame_fin; i++) {
      const fr = file.frames[i];
      const box = fr.boxes.find((b) => b[0] === s.track);
      if (box && !isDropped(drop, box, fr.frame)) piece.push({ frame: fr.frame, box });
    }
    if (!piece.length) return { s, safe: false, reasons: [...reasons, "sin_cajas"], prev: null };
    const pid = named.get(s.person);
    // Who has the stretch now.
    const owners = new Set(piece.map((x) => identityOf(x.box, x.frame, edits)));
    let prev: number | null = null;
    if (owners.size > 1) reasons.push("varias");
    else {
      prev = [...owners][0];
      if (prev === pid) reasons.push("ya_suya");
      else {
        const o = byId.get(prev);
        if (removed.has(prev) || (o && o.player_id && o.player_id !== s.person)) reasons.push("dueña");
        else if (o?.done) reasons.push("verificada");
      }
    }
    // Colour of the boxes against the team expected for her (hers, if the table knows it; else ours: the roster).
    const known = pid !== undefined ? byId.get(pid)?.team : undefined;
    const expected = known && known !== "unk" ? known : "own";
    if (piece.some((x) => {
      const t = boxTeamOf(x.box, refs);
      return t !== "unk" && t !== expected;
    }))
      reasons.push("equipo");
    // Her own boxes: overlap and jumps.
    if (pid !== undefined) {
      const pts = at.get(pid) ?? [];
      const i0 = lowerBoundPts(pts, s.frame_ini);
      let overlap = false;
      for (let i = i0; i < pts.length && pts[i].frame <= s.frame_fin; i++) if (pts[i].track !== s.track) overlap = true;
      if (overlap) reasons.push("solape");
      const before = i0 > 0 ? pts[i0 - 1] : null;
      let j = i0;
      while (j < pts.length && pts[j].frame <= s.frame_fin) j++;
      const after = j < pts.length ? pts[j] : null;
      const first = pos(piece[0].box);
      const last = pos(piece[piece.length - 1].box);
      const can = (a: Pt, b: [number, number] | null, frames: number) => {
        if (!b || Number.isNaN(a.x)) return false;
        return Math.hypot(a.x - b[0], a.y - b[1]) <= SLACK_M + (RUN_MS * Math.max(0, frames)) / fps;
      };
      if (before && !can(before, first, piece[0].frame - before.frame)) reasons.push("salto");
      else if (after && !can(after, last, after.frame - piece[piece.length - 1].frame)) reasons.push("salto");
    }
    // Pending doubts of the fill around it.
    if (
      pending.some((d) => d.frame >= s.frame_ini - win && d.frame <= s.frame_fin + win && (d.track === s.track || (d.kind === "dos_sitios" && d.players.includes(s.person))))
    )
      reasons.push("duda");
    return { s, safe: reasons.length === 0, reasons, prev };
  });
}

export interface AutoPlan {
  // The suggestions that would be accepted, in order, and what they leave in the edits.
  accepted: AutoAccepted[];
  edits: TrackEdits;
  // Safe by the judge but refused when applied (e.g. two safe ones that overlap each other).
  refused: number;
  // How many pending suggestions were judged, and the reasons of the ones that are not safe.
  judged: number;
  unsafe: Partial<Record<AutoReason, number>>;
}

// The batch: the safe suggestions of `list` (already ordered best first, tramos not yet answered) applied one after the
// other to the edits. `exclude`: keys that must not be taken (the ones the analyst took out). The result is one new
// TrackEdits; whoever applies it does it as one action.
export function planAutoAccept(ctx: AutoContext, list: TramoSuggestion[], minP: number, exclude: ReadonlySet<string> = new Set()): AutoPlan {
  const todo = list.filter((s) => !exclude.has(tramoKey(s)));
  const verdicts = judgeTramos(ctx, todo, minP);
  const unsafe: Partial<Record<AutoReason, number>> = {};
  for (const v of verdicts) if (!v.safe) for (const r of v.reasons) unsafe[r] = (unsafe[r] ?? 0) + 1;
  let edits = ctx.edits;
  const named = new Map(ctx.named);
  const accepted: AutoAccepted[] = [];
  let refused = 0;
  const keys: string[] = [];
  for (const v of verdicts) {
    if (!v.safe || v.prev === null) continue;
    const r = acceptTramo(edits, ctx.file, v.s, named);
    if (r.status !== "ok") {
      refused++;
      continue;
    }
    edits = r.edits;
    if (!named.has(v.s.person)) {
      const hit = Object.entries(edits.people).find(([, p]) => p.player_id === v.s.person);
      if (hit) named.set(v.s.person, Number(hit[0]));
    }
    accepted.push({ key: tramoKey(v.s), person: v.s.person, track: v.s.track, frame_ini: v.s.frame_ini, frame_fin: v.s.frame_fin, p: v.s.p, cost: v.s.cost, prev: v.prev });
    keys.push(tramoKey(v.s));
  }
  if (accepted.length) edits = { ...edits, anchorDoubts: [...(edits.anchorDoubts ?? []), ...keys], autoAccepted: [...(edits.autoAccepted ?? []), ...accepted] };
  return { accepted, edits, refused, judged: todo.length, unsafe };
}

// Takes the given automatic acceptances out: the stretch goes back to the identity it had, the suggestion is pending again
// (its key leaves anchorDoubts) and the record goes. A stretch that is no longer hers (changed by hand since) is left as
// it is: only the record goes (`changed` counts them).
export function revertAuto(edits: TrackEdits, file: TracksFile, recs: AutoAccepted[], named: Map<string, number>): { edits: TrackEdits; reverted: number; changed: number } {
  let next = edits;
  let reverted = 0;
  let changed = 0;
  const frames = file.frames;
  for (const rec of recs) {
    const id = named.get(rec.person);
    let hers = id !== undefined;
    let any = false;
    for (let i = lowerBound(frames, rec.frame_ini); hers && i < frames.length && frames[i].frame <= rec.frame_fin; i++) {
      const b = frames[i].boxes.find((x) => x[0] === rec.track);
      if (!b) continue;
      any = true;
      if (identityOf(b, frames[i].frame, next) !== id) hers = false;
    }
    if (hers && any) {
      const back = assignStretch(next, file, rec.track, rec.frame_ini, rec.frame_fin, rec.prev);
      if (back) {
        next = back;
        reverted++;
        continue;
      }
    }
    changed++;
  }
  const gone = new Set(recs.map((r) => r.key));
  const left = (next.autoAccepted ?? []).filter((r) => !gone.has(r.key));
  next = { ...next, anchorDoubts: (next.anchorDoubts ?? []).filter((k) => !gone.has(k)) };
  if (left.length) next.autoAccepted = left;
  else delete next.autoAccepted;
  return { edits: next, reverted, changed };
}

// One line for the button: «Aceptar las 12 seguras».
export const autoLabel = (n: number) => `Aceptar ${n === 1 ? "la 1 segura" : `las ${n} seguras`}`;
