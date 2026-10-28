import { setAnchor, type Anchor, type AnchorFocus, type FocusMark } from "./anchors.ts";
import { NOT_PLAYER } from "./doubts.ts";
import { boxTeamOf, droppedSet, fileTeamRefs, identityOf, isDropped, type DetBox, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

// «Muestras» of the anchors mode: instants where many of OUR players are in view, so one frame lets the analyst name a
// lot of boxes. The program proposes the frames (static: they depend only on the tracks file and the two parameters of
// Detalles técnicos); the analyst names the boxes with the same player keys as in «Anclas», and every name is an ordinary
// anchor (frame, track, player). Pure functions: no storage, no React.

export const NOT_PLAYER_NAME = NOT_PLAYER;

// A team fields 11: a frame with more own boxes than that has doubled or false boxes (measured: up to 14), harder to name,
// so it ranks below one with the right number (score 22 - n beyond 11). The threshold still counts every own box.
export const TEAM_SIZE = 11;
const score = (n: number) => (n <= TEAM_SIZE ? n : 2 * TEAM_SIZE - n);

export interface Sample {
  frame: number;
  // Boxes of our team on the pitch in that frame (by shirt colour).
  own: number;
}

// Frames with at least `minPlayers` own boxes on the pitch, picked best first (closest to a full team from below; earlier on a tie) with at
// least `gapS` seconds between two of them, in time order. One pass over the file; the result is the same until the file
// or a parameter changes, so callers keep it with useMemo.
export function findSamples(file: TracksFile, gapS: number, minPlayers: number): Sample[] {
  const refs = fileTeamRefs(file);
  const cands: Sample[] = [];
  for (const fr of file.frames) {
    let n = 0;
    for (const b of fr.boxes) if (b[11] && boxTeamOf(b, refs) === "own") n++;
    if (n >= minPlayers) cands.push({ frame: fr.frame, own: n });
  }
  cands.sort((a, b) => score(b.own) - score(a.own) || a.frame - b.frame);
  const gap = gapS * file.fps;
  const kept: Sample[] = [];
  for (const c of cands) if (kept.every((k) => Math.abs(k.frame - c.frame) >= gap)) kept.push(c);
  return kept.sort((a, b) => a.frame - b.frame);
}

export interface SampleBox {
  track: number;
  // Identity of the box in the table (after the edits).
  id: number;
  box: DetBox;
  // Her name: the anchor of this box in this frame, else the name of her identity in the table; null = nobody yet.
  name: string | null;
  // The name comes from an anchor made in this frame (not from the table).
  anchored: boolean;
}

// The own boxes of a frame, left to right (stable order for the labels). `nameOfId`: name of each identity of the table.
export function sampleBoxes(file: TracksFile, edits: TrackEdits, frame: number, anchors: readonly Anchor[], nameOfId: ReadonlyMap<number, string>): SampleBox[] {
  const fr = file.frames.find((f) => f.frame === frame);
  if (!fr) return [];
  const refs = fileTeamRefs(file);
  const drop = droppedSet(edits);
  const here = new Map(anchors.filter((a) => a.frame === frame).map((a) => [a.track, a.player]));
  const out: SampleBox[] = [];
  for (const box of fr.boxes) {
    if (!box[11] || isDropped(drop, box, frame) || boxTeamOf(box, refs) !== "own") continue;
    const id = identityOf(box, frame, edits);
    const anchor = here.get(box[0]);
    out.push({ track: box[0], id, box, name: anchor ?? nameOfId.get(id) ?? null, anchored: anchor !== undefined });
  }
  return out.sort((a, b) => a.box[1] - b.box[1] || a.track - b.track);
}

// «8 de 11 nombradas»: boxes with a real name over the own boxes that are players (those marked «no es jugadora» are not).
export function sampleProgress(boxes: SampleBox[]): { named: number; total: number } {
  const players = boxes.filter((b) => b.name !== NOT_PLAYER_NAME);
  return { named: players.filter((b) => b.name).length, total: players.length };
}

// Naming a box in a frame: its anchor (one per box), and the same player has no other anchor in this frame (she is in one
// place at a time: the new box replaces the old one).
export function nameInSample(anchors: Anchor[], a: Anchor): Anchor[] {
  const rest = a.player === NOT_PLAYER_NAME ? anchors : anchors.filter((x) => !(x.frame === a.frame && x.player === a.player && x.track !== a.track));
  return setAnchor(rest, a);
}

// What the video highlights in a sample: one mark per own box (the label says who she is or «?»; the selected one gets
// its own colour). `labelOf` shortens a name for the circle.
export const SAMPLE_COLORS = { named: "var(--color-ok)", open: "var(--color-warn)", selected: "var(--color-accent-300)" };
export function sampleFocus(frame: number, boxes: SampleBox[], selected: number | null, labelOf: (name: string) => string): AnchorFocus {
  const marks: FocusMark[] = boxes.map((b) => ({
    track: b.track,
    label: b.name === null ? "?" : b.name === NOT_PLAYER_NAME ? "x" : labelOf(b.name),
    what: b.name ? (b.name === NOT_PLAYER_NAME ? `trozo ${b.track}: no es jugadora` : `trozo ${b.track}: ${b.name}`) : `trozo ${b.track}`,
    color: b.track === selected ? SAMPLE_COLORS.selected : b.name ? SAMPLE_COLORS.named : SAMPLE_COLORS.open,
  }));
  return { frame, marks };
}
