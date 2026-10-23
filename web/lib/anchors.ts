import { dropBoxes, freshIdentity, merge, separateRun, setPerson, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

// Anchors mode of the correction table (docs/propuesta_union_tracks.md §5.5 and §5.7). Python
// (sportsan.tracking.anchors) suggests moments where a long, isolated piece of track is easy to name; the analyst names
// them (anchors); Python fills the rest between anchors (links) and leaves a short list of doubts. Files, per part, in
// matches/<id>/tracking/auto/: suggest_<part>.json, anchors_<part>.json (written by the app), links_<part>.json.
// Pure functions: no storage, no React.

export interface AnchorChain {
  id: number | string;
  team: string;
  t0: number;
  t1: number;
  n: number;
  boxes: [number, number][];
}
export interface AnchorSuggestion {
  chain: number | string;
  frame: number;
  track: number;
  score: number;
  why: "larga" | "aislada" | "incierta" | string;
}
export interface SuggestFile {
  part: string;
  fps: number;
  chains: AnchorChain[];
  suggestions: AnchorSuggestion[];
}
export interface Anchor {
  frame: number;
  track: number;
  // Identity of the person as in the table: her name (player_id).
  player: string;
}
export interface AnchorsFile {
  anchors: Anchor[];
}
export type DoubtKind = "salto" | "dos_sitios" | "union_dudosa" | "hueco_largo" | "sin_nombre";
export interface Doubt {
  kind: DoubtKind | string;
  frame: number;
  track: number;
  players: string[];
  note: string;
  // false = informative (hueco_largo, sin_nombre): counted in a summary, never a task. Missing (old files) = a task.
  task?: boolean;
}
export interface LinkIdentity {
  player: string;
  chains: (number | string)[];
  tracks: number[];
  t_ranges: [number, number][];
}
// A box of a player that Python left out where she had two in one frame (sportsan.tracking.doubles): off her path
// (ruta), or both boxes of a short overlap the path could not tell apart (ambas: the export fills the hole).
export interface LinkDrop {
  frame: number;
  track: number;
  player: string;
  reason: "ruta" | "ambas" | string;
}
export interface LinksFile {
  part: string;
  identities: LinkIdentity[];
  doubts: Doubt[];
  // Missing in files written before 2026-10-23.
  drops?: LinkDrop[];
  coverage: { per_player?: Record<string, number>; interpolated_s?: number };
  doubt_summary?: {
    tasks: number;
    by_kind: Record<string, number>;
    info: Record<string, number>;
    auto_resolved?: Record<string, number>;
    doubles?: { frames_before: number; frames_after: number; dropped: Record<string, number>; undecided: number };
  };
}

// What a fill would leave out, by reason (exclusión, ruta, ambas, salto), before applying it: for the warnings.
export const DROP_REASON_NAMES: Record<string, string> = { exclusion: "exclusión", ruta: "fuera de su ruta", ambas: "ambas cajas", salto: "salto" };
export function dropsByReason(links: Pick<LinksFile, "drops">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of links.drops ?? []) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}
export const reasonsText = (by: Record<string, number>) =>
  Object.entries(by)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} por ${DROP_REASON_NAMES[k] ?? k}`)
    .join(", ");

export const DENSITIES = [1, 2, 3, 4, 5] as const;
export const DEFAULT_DENSITY = 2;
export type Density = (typeof DENSITIES)[number];

// Name of a part from its tracks file: tracks_v1_6414_13699.json -> v1_6414_13699.
export const partOfTracks = (name: string) => name.replace(/^tracks_/, "").replace(/\.json$/, "");
export const partOfData = (f: Pick<TracksFile, "video_id" | "start_frame" | "end_frame">) => `${f.video_id}_${f.start_frame}_${f.end_frame}`;

// Repository paths of the three files of a part; the example files (written by hand, labelled in the app) live in
// tracking/auto/ejemplo/ so that the real ones are never mistaken for them.
// variant "exp": fill B, the recommended mode (fewer jumps), links_<part>_exp.json; A (links_<part>.json) is kept to compare.
export function anchorPaths(folder: string, part: string, example = false, variant?: "exp") {
  const dir = `matches/${folder}/tracking/auto${example ? "/ejemplo" : ""}`;
  return { dir, suggest: `${dir}/suggest_${part}.json`, anchors: `${dir}/anchors_${part}.json`, links: `${dir}/links_${part}${variant ? "_exp" : ""}.json` };
}

export const fillCommand = (matchId: string, part: string) => `python -m sportsan.tracking.anchors fill --match ${matchId} --part ${part}`;

export const suggestionKey = (s: Pick<AnchorSuggestion, "frame" | "track">) => `${s.track}:${s.frame}`;

// The suggestions to go through at a density (anchors per minute): best score first; one is kept only if no kept
// suggestion of the same chain is closer than 60 / density seconds. A chain shorter than that gets one at most.
export function filterByDensity(suggestions: AnchorSuggestion[], density: number, fps: number): AnchorSuggestion[] {
  const gap = (60 / Math.max(1, density)) * fps;
  const kept = new Map<string, number[]>();
  const out: AnchorSuggestion[] = [];
  const sorted = [...suggestions].sort((a, b) => b.score - a.score || a.frame - b.frame);
  for (const s of sorted) {
    const k = String(s.chain);
    const frames = kept.get(k) ?? [];
    if (frames.some((f) => Math.abs(f - s.frame) < gap)) continue;
    frames.push(s.frame);
    kept.set(k, frames);
    out.push(s);
  }
  return out;
}

// How many suggestions each density gets; `short` when a density adds none over the one below (there are not enough
// suggested moments for it: Python would need more, with --per-min).
export function densityCounts(suggestions: AnchorSuggestion[], fps: number): { density: number; n: number; short: boolean }[] {
  let prev = -1;
  return DENSITIES.map((d) => {
    const n = filterByDensity(suggestions, d, fps).length;
    const short = d > 1 && n <= prev;
    prev = n;
    return { density: d, n, short };
  });
}

// What is left to do: the suggestions of the density without an anchor of their chain near them and not skipped.
// An anchor names its whole chain, so a chain already anchored within the density's window needs no other.
export function pendingSuggestions(list: AnchorSuggestion[], anchors: Anchor[], skipped: string[], chains: AnchorChain[], density: number, fps: number): AnchorSuggestion[] {
  const skip = new Set(skipped);
  const chainOf = chainIndex(chains);
  const gap = (60 / Math.max(1, density)) * fps;
  const anchoredAt = new Map<string, number[]>();
  for (const a of anchors) {
    const c = chainOf.get(`${a.track}:${a.frame}`);
    const k = c === undefined ? `t${a.track}` : String(c);
    anchoredAt.set(k, [...(anchoredAt.get(k) ?? []), a.frame]);
  }
  return list.filter((s) => {
    if (skip.has(suggestionKey(s))) return false;
    const near = anchoredAt.get(String(s.chain)) ?? [];
    return !near.some((f) => Math.abs(f - s.frame) < gap) && !anchors.some((a) => a.track === s.track && a.frame === s.frame);
  });
}

// "<track>:<frame>" -> chain id, from the boxes of the chains.
export function chainIndex(chains: AnchorChain[]): Map<string, number | string> {
  const m = new Map<string, number | string>();
  for (const c of chains) for (const [frame, track] of c.boxes) m.set(`${track}:${frame}`, c.id);
  return m;
}

// One anchor per (track, frame): naming a box again replaces its name.
export function setAnchor(anchors: Anchor[], a: Anchor): Anchor[] {
  return [...anchors.filter((x) => !(x.track === a.track && x.frame === a.frame)), a].sort((x, y) => x.frame - y.frame || x.track - y.track);
}

// The identities filled by Python as ordinary edits of the table: every track of a player gets the identity of the
// person with that name (an existing one, or a new one named after her). A track claimed by two players is left as it
// was (and counted), and splits made by hand keep ruling inside their track. The double boxes Python resolved (`drops`)
// are left out box by box (TrackEdits.dropped), except those of protected people or tracks.
export function editsFromLinks(
  edits: TrackEdits,
  file: TracksFile,
  links: LinksFile,
  named: Map<string, number>,
  // When given: these people (and their tracks) are left as they are (see linksProtection).
  protect?: { ids: Set<number>; tracks: Set<number> },
): { edits: TrackEdits; players: number; tracks: number; conflicts: number[]; skipped: number; dropped: number; droppedBy: Record<string, number> } {
  const owners = new Map<number, Set<string>>();
  for (const id of links.identities) for (const t of id.tracks) owners.set(t, (owners.get(t) ?? new Set()).add(id.player));
  const conflicts = [...owners].filter(([, s]) => s.size > 1).map(([t]) => t).sort((a, b) => a - b);
  const bad = new Set(conflicts);
  const present = new Set<number>();
  for (const fr of file.frames) for (const b of fr.boxes) present.add(b[0]);

  let next: TrackEdits = { ...edits, identity: { ...edits.identity } };
  let players = 0;
  let tracks = 0;
  let skipped = 0;
  const target = new Map(named);
  for (const id of links.identities) {
    const all = id.tracks.filter((t) => !bad.has(t) && present.has(t));
    const mine = protect ? all.filter((t) => !protect.tracks.has(t)) : all;
    skipped += all.length - mine.length;
    // «No es jugadora» (player "__no__"): never a person of the table.
    if (!id.player || id.player === "__no__" || mine.length === 0) continue;
    if (protect && protect.ids.has(target.get(id.player) ?? Number.NaN)) {
      skipped += mine.length;
      continue;
    }
    let into = target.get(id.player);
    if (into === undefined) {
      // freshIdentity looks at the values of `identity`, so the next new one gets another number.
      into = freshIdentity(next, file);
      target.set(id.player, into);
      next = setPerson(next, into, { player_id: id.player });
    }
    for (const t of mine) {
      if (next.identity[String(t)] !== into) tracks++;
      next = { ...next, identity: { ...next.identity, [String(t)]: into } };
    }
    players++;
  }
  // Drops only where the player's identity was applied here: her tracks (not protected, not claimed twice).
  const applied = new Map<string, Set<number>>();
  for (const id of links.identities) {
    if (protect && protect.ids.has(named.get(id.player) ?? Number.NaN)) continue;
    applied.set(id.player, new Set(id.tracks.filter((t) => !bad.has(t) && present.has(t) && !(protect && protect.tracks.has(t)))));
  }
  const had = new Set((next.dropped ?? []).map((d) => `${d.track}:${d.frame}`));
  const droppedBy: Record<string, number> = {};
  const drops: { track: number; frame: number }[] = [];
  for (const d of links.drops ?? []) {
    const k = `${d.track}:${d.frame}`;
    if (!applied.get(d.player)?.has(d.track) || had.has(k)) continue;
    had.add(k);
    drops.push({ track: d.track, frame: d.frame });
    droppedBy[d.reason] = (droppedBy[d.reason] ?? 0) + 1;
  }
  const before = (next.dropped ?? []).length;
  next = dropBoxes(next, drops);
  return { edits: next, players, tracks, conflicts, skipped, dropped: (next.dropped ?? []).length - before, droppedBy };
}

// Who the fill must not touch unless asked: people verified (done) or with a name in the table. `list` is what the
// warning shows.
export function linksProtection(people: { id: number; player_id: string; done: boolean; tracks: number[] }[]) {
  const kept = people.filter((p) => p.done || p.player_id);
  return {
    ids: new Set(kept.map((p) => p.id)),
    tracks: new Set(kept.flatMap((p) => p.tracks)),
    list: kept.map((p) => ({ name: p.player_id || `#${p.id}`, done: p.done })).sort((a, b) => Number(b.done) - Number(a.done) || a.name.localeCompare(b.name)),
  };
}

// Keys of the players in the anchors pass: 1-9, 0, then the QWERTY rows, without the keys that already mean something
// there (n skips, f full screen, z zoom, h highlight; Enter and space anchor).
// x marks «No es jugadora».
export const ANCHOR_RESERVED_KEYS = ["n", "f", "z", "h", "x"];
export const PLAYER_KEYS = [..."1234567890qwertyuiopasdfghjklzxcvbm"].filter((k) => !ANCHOR_RESERVED_KEYS.includes(k));

// Order of the doubts: the ones that make the data wrong first (one player in two places, impossible jumps), then the
// doubtful joins, the pieces without a name and the long holes; inside each kind, by time.
const DOUBT_ORDER: Record<string, number> = { dos_sitios: 0, salto: 1, union_dudosa: 2, sin_nombre: 3, hueco_largo: 4 };
export const DOUBT_LABELS: Record<string, string> = {
  dos_sitios: "En dos sitios",
  salto: "Salto",
  union_dudosa: "Unión dudosa",
  sin_nombre: "Sin nombre",
  hueco_largo: "Hueco largo",
};
export const doubtKey = (d: Pick<Doubt, "kind" | "frame" | "track">) => `${d.kind}:${d.frame}:${d.track}`;

// A doubt the person must review; the informative ones (task === false) are not.
export const isTask = (d: Pick<Doubt, "task">) => d.task !== false;

// `info` = the informative doubts (holes, chains without a name): never pending, shown as a summary line.
export function sortDoubts(doubts: Doubt[], resolved: string[] = []): { pending: Doubt[]; done: Doubt[]; info: Doubt[] } {
  const r = new Set(resolved);
  const info = doubts.filter((d) => !isTask(d));
  const sorted = doubts.filter(isTask).sort((a, b) => (DOUBT_ORDER[a.kind] ?? 9) - (DOUBT_ORDER[b.kind] ?? 9) || a.frame - b.frame || a.track - b.track);
  return { pending: sorted.filter((d) => !r.has(doubtKey(d))), done: sorted.filter((d) => r.has(doubtKey(d))), info };
}

// The frames of `track` in the run around `frame` (no hole longer than maxGap frames), at most `half` frames each side:
// what «quitar cuadros» takes out of a doubt.
export function runAround(file: TracksFile, track: number, frame: number, maxGap: number, half: number): number[] {
  const frames = file.frames.filter((f) => f.boxes.some((b) => b[0] === track)).map((f) => f.frame);
  const i = frames.findIndex((f) => f >= frame);
  if (i < 0 || Math.abs(frames[i] - frame) > maxGap) return [];
  let a = i;
  let b = i;
  while (a > 0 && frames[a] - frames[a - 1] <= maxGap && frame - frames[a - 1] <= half) a--;
  while (b < frames.length - 1 && frames[b + 1] - frames[b] <= maxGap && frames[b + 1] - frame <= half) b++;
  return frames.slice(a, b + 1);
}

// «Quitar cuadros» of a doubt: the boxes of its track this long on each side.
export const DROP_HALF_S = 0.5;
export const dropHalfFrames = (fps: number) => Math.round(fps * DROP_HALF_S);

// The doubt after (dir 1) or before (dir -1) the one with `key` in the pending list, going round; the first one when
// `key` is not in it. Null when nothing else is pending.
export function stepDoubt(pending: Doubt[], key: string | null, dir: 1 | -1): Doubt | null {
  if (!pending.length) return null;
  const i = key === null ? -1 : pending.findIndex((d) => doubtKey(d) === key);
  if (i < 0) return dir === 1 ? pending[0] : pending[pending.length - 1];
  if (pending.length === 1) return null;
  return pending[(i + dir + pending.length) % pending.length];
}
// What to open once the doubt `key` is resolved: the one that came after it (or the first, if it was the last).
export function afterResolve(pending: Doubt[], key: string): Doubt | null {
  const rest = pending.filter((d) => doubtKey(d) !== key);
  const i = pending.findIndex((d) => doubtKey(d) === key);
  if (!rest.length) return null;
  return i < 0 ? rest[0] : (rest[i] ?? rest[0]);
}

// A click on one of the boxes of a doubt says «this is her»: the player is the name of that box (or, when it has none,
// the doubt's first player, and the box joins her); every other highlighted box of that same player is cut out of her
// (its run becomes a person of its own). Boxes of other people are not touched.
export function pickInDoubt(
  edits: TrackEdits,
  file: TracksFile,
  frame: number,
  chosen: { track: number; id: number },
  highlighted: { track: number; id: number }[],
  playerOf: (id: number) => string | undefined,
  named: Map<string, number>,
  doubtPlayers: string[],
): { edits: TrackEdits; player: string | null; cut: number } {
  const own = playerOf(chosen.id);
  const player = own ?? doubtPlayers[0] ?? null;
  let next = edits;
  let cut = 0;
  const herId = own !== undefined ? chosen.id : player !== null ? named.get(player) : undefined;
  for (const h of highlighted) {
    if (h.track === chosen.track) continue;
    if (!(h.id === chosen.id || (player !== null && playerOf(h.id) === player) || (herId !== undefined && h.id === herId))) continue;
    const sep = separateRun(next, file, h.track, frame);
    if (!sep) continue;
    next = sep.edits;
    cut++;
  }
  if (own === undefined && player !== null) {
    if (herId !== undefined) next = merge(next, herId, chosen.id);
    else next = setPerson(next, chosen.id, { player_id: player });
  }
  return { edits: next, player, cut };
}

// ---------------------------------------------------------------- what to highlight on the video

// A box to highlight: by raw track, or every box of the person with that name. `label` is drawn next to it.
export interface FocusMark {
  track?: number;
  player?: string;
  label: string;
  // What it is, for the line that says it is not in the frame.
  what: string;
}
// Colour of the highlighted boxes by their number (1, 2, 3...): tokens of globals.css.
export const FOCUS_COLORS = ["var(--color-warn)", "var(--color-accent-300)", "var(--color-ok)", "var(--color-danger)"];
export interface AnchorFocus {
  frame: number;
  marks: FocusMark[];
}

// The marks of a suggestion: its box.
export const suggestionFocus = (s: Pick<AnchorSuggestion, "frame" | "track">): AnchorFocus => ({ frame: s.frame, marks: [{ track: s.track, label: "?", what: `trozo ${s.track}` }] });

// The marks of a doubt: every player of it (all her boxes in the frame: «en dos sitios» shows both) and its track,
// numbered 1, 2, ... in that order.
export function doubtFocus(d: Pick<Doubt, "frame" | "track" | "players">): AnchorFocus {
  const marks: FocusMark[] = d.players.map((p, i) => ({ player: p, label: String(i + 1), what: p }));
  marks.push({ track: d.track, label: String(marks.length + 1), what: `trozo ${d.track}` });
  return { frame: d.frame, marks };
}

// The boxes of the frame each mark points to, and the marks with none. A box goes to the first mark that claims it.
export function focusBoxes<B extends readonly unknown[]>(
  marks: FocusMark[],
  shown: { b: B; id: number }[],
  playerOf: (id: number) => string | undefined,
): { found: { mark: FocusMark; index: number; b: B; id: number }[]; missing: FocusMark[]; same: { mark: FocusMark; as: FocusMark }[] } {
  const used = new Set<number>();
  const found: { mark: FocusMark; index: number; b: B; id: number }[] = [];
  const missing: FocusMark[] = [];
  const same: { mark: FocusMark; as: FocusMark }[] = [];
  marks.forEach((mark, index) => {
    const hits = shown.filter((x) => !used.has(x.b[0] as number) && (mark.track !== undefined ? x.b[0] === mark.track : mark.player !== undefined && playerOf(x.id) === mark.player));
    // The track of a doubt is often a box of one of its players: then it is already marked, not missing.
    const already = mark.track !== undefined ? found.find((f) => f.b[0] === mark.track) : undefined;
    if (already) same.push({ mark, as: already.mark });
    else if (!hits.length) missing.push(mark);
    for (const h of hits) {
      used.add(h.b[0] as number);
      found.push({ mark, index, b: h.b, id: h.id });
    }
  });
  return { found, missing, same };
}

// ---------------------------------------------------------------- stopwatch of the session

export interface TimedAction {
  kind: "ancla" | "saltar" | "duda" | "verificar";
  s: number;
  at: number;
  part?: string;
  // Version of the old comparison tab (A or B) in actions measured with it; absent since.
  version?: "A" | "B";
}
// A pause longer than this is not work on the action (she stepped away): it counts as this much.
export const MAX_ACTION_S = 60;

const median = (xs: number[]) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function timingSummary(actions: TimedAction[]) {
  const capped = actions.map((a) => ({ ...a, s: Math.min(MAX_ACTION_S, Math.max(0, a.s)) }));
  const kinds = ["ancla", "saltar", "duda"] as const;
  const per = Object.fromEntries(
    kinds.map((k) => {
      const xs = capped.filter((a) => a.kind === k).map((a) => a.s);
      return [k, { n: xs.length, total_s: xs.reduce((x, y) => x + y, 0), median_s: median(xs) }];
    }),
  ) as Record<(typeof kinds)[number], { n: number; total_s: number; median_s: number }>;
  return { n: capped.length, total_s: capped.reduce((x, a) => x + a.s, 0), median_s: median(capped.map((a) => a.s)), per, cap_s: MAX_ACTION_S };
}
