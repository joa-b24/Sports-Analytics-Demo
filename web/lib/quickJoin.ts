import { separateRange, RUN_MS, SLACK_M } from "./suggestions.ts";
import { clash, dropBoxes, droppedSet, identityOf, isDropped, merge, offCamera, type Person, type TeamCode, type TracksFile } from "./tracks.ts";
import { PITCH, type TrackEdits } from "./types.ts";

// «Unión rápida» of the anchors mode: goes through the holes of ONE player in order and, for each, offers the pieces of
// other people that could fill it (they fit in time and distance at both ends). One key joins the best one; nothing is
// joined by itself. The «está en dos sitios» stop of the table is not asked: the piece is cut out of the person who has
// it (she keeps what is before and after) and given to the player. Pure functions.

// A hole of 2 to 7 s where the player is out of the camera's reach needs no filling (green).
export const GREEN_MIN_S = 2;
export const GREEN_MAX_S = 7;
export const MAX_CANDIDATES = 4;
// A piece is one run of boxes with holes of at most this long (s).
const RUN_GAP_S = 0.5;

export interface QuickCandidate {
  // The person who has the piece now (an identity of the table) and her name, if any.
  from: number;
  name: string;
  verified: boolean;
  // First and last frame of the piece, inside the hole.
  a: number;
  b: number;
  seconds: number;
  // A raw track of the piece (to highlight it) and the sum of the two distances at its ends (m): lower is better.
  track: number;
  cost: number;
  // The person has boxes before and after the piece: it is cut out of her.
  twoSides: boolean;
}
export interface QuickHole {
  // Last frame before the hole and first one after it.
  a: number;
  b: number;
  seconds: number;
  offCamera: boolean;
  // Out of camera and 2-7 s: nothing to fill.
  green: boolean;
  candidates: QuickCandidate[];
}

export const holeKey = (h: Pick<QuickHole, "a" | "b">) => `${h.a}:${h.b}`;

type Pt = { frame: number; x: number; y: number; track: number };

// `green`: seconds [min, max] of a hole out of the camera that needs nothing (Detalles técnicos; default 2 to 7).
export function quickHoles(file: TracksFile, edits: TrackEdits, ppl: Person[], personId: number, green: [number, number] = [GREEN_MIN_S, GREEN_MAX_S]): QuickHole[] {
  const P = ppl.find((p) => p.id === personId);
  if (!P) return [];
  const sx = (file.venue?.length_m ?? PITCH.length) / PITCH.length;
  const sy = (file.venue?.width_m ?? PITCH.width) / PITCH.width;
  const drop = droppedSet(edits);
  const gone = new Set(edits.removed);
  const at = new Map<number, Pt[]>();
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame) || !b[11] || b[9] === null || b[10] === null) continue;
      const id = identityOf(b, fr.frame, edits);
      if (gone.has(id)) continue;
      const list = at.get(id) ?? [];
      if (list[list.length - 1]?.frame === fr.frame) continue;
      list.push({ frame: fr.frame, x: b[9] * sx, y: b[10] * sy, track: b[0] });
      at.set(id, list);
    }
  }
  const mine = new Map((at.get(personId) ?? []).map((p) => [p.frame, p]));
  const byId = new Map(ppl.map((p) => [p.id, p]));
  const runGap = Math.max(RUN_GAP_S * file.fps, file.stride * 1.5);
  const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
  const out: QuickHole[] = [];
  for (const [a, b] of P.gaps) {
    const pa = mine.get(a);
    const pb = mine.get(b);
    const seconds = (b - a) / file.fps;
    const off = offCamera(file, edits, personId, [a, b]);
    const candidates: QuickCandidate[] = [];
    if (pa && pb) {
      for (const [id, list] of at) {
        if (id === personId) continue;
        const Q = byId.get(id);
        if (!Q || (P.team !== "unk" && Q.team !== "unk" && (P.team as TeamCode) !== (Q.team as TeamCode))) continue;
        const inside = list.filter((p) => p.frame > a && p.frame < b);
        if (inside.length < 2) continue;
        let start = 0;
        for (let i = 1; i <= inside.length; i++) {
          if (i < inside.length && inside[i].frame - inside[i - 1].frame <= runGap) continue;
          const run = inside.slice(start, i);
          start = i;
          if (run.length < 2) continue;
          const first = run[0];
          const last = run[run.length - 1];
          const d1 = dist(pa, first);
          const d2 = dist(last, pb);
          if (d1 > SLACK_M + (RUN_MS * (first.frame - a)) / file.fps || d2 > SLACK_M + (RUN_MS * (b - last.frame)) / file.fps) continue;
          candidates.push({
            from: id,
            name: Q.player_id,
            verified: Q.done,
            a: first.frame,
            b: last.frame,
            seconds: (last.frame - first.frame + file.stride) / file.fps,
            track: run[Math.floor(run.length / 2)].track,
            cost: Math.round((d1 + d2) * 100) / 100,
            twoSides: Q.first < first.frame && Q.last > last.frame,
          });
        }
      }
      candidates.sort((x, y) => x.cost - y.cost || y.seconds - x.seconds);
    }
    out.push({ a, b, seconds, offCamera: off, green: off && seconds >= green[0] && seconds <= green[1], candidates: candidates.slice(0, MAX_CANDIDATES) });
  }
  return out;
}

// Holes still to go through (the green ones need nothing) and the seconds they add up to.
export function quickProgress(holes: QuickHole[], skipped: Set<string> = new Set()): { left: number; leftS: number; green: number } {
  const todo = holes.filter((h) => !h.green && !skipped.has(holeKey(h)));
  return { left: todo.length, leftS: todo.reduce((t, h) => t + h.seconds, 0), green: holes.filter((h) => h.green).length };
}

// The piece goes to the player. Where its owner has it between two parts of her own path, those parts stay with her and
// only the piece moves. Null when the piece cannot be given (she already has a box elsewhere in those frames).
export function applyQuickJoin(file: TracksFile, edits: TrackEdits, ppl: Person[], personId: number, c: Pick<QuickCandidate, "from" | "a" | "b">): { edits: TrackEdits; cut: boolean } | null {
  const Q = ppl.find((p) => p.id === c.from);
  if (!Q) return null;
  let base = edits;
  let piece = c.from;
  let cut = false;
  if (!(Q.first >= c.a && Q.last <= c.b)) {
    const s = separateRange(edits, file, c.from, c.a, c.b);
    if (s.identity === null) return null;
    base = s.edits;
    piece = s.identity;
    cut = true;
  }
  const k = clash(file, base, personId, piece);
  if (k.apart.length > 0) return null;
  return { edits: merge(dropBoxes(base, k.drop), personId, piece), cut };
}
