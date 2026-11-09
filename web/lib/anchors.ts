import { assignStretch, dropBoxes, freshIdentity, identityOf, merge, personFramesIn, separateRun, setPerson, type DetBox, type TracksFile } from "./tracks.ts";
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
  // How many suggestions Python would write at each density (anchors per minute): {"1": 132, "2": 248, ...}, plus other keys.
  available?: Record<string, unknown>;
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
  // Fill by stretches (docs/propuesta_union_tracks.md): [track_id, first_frame, last_frame], frames inclusive, indices
  // of tracks_<part>.json. When present the identity takes these stretches, not whole tracks. Missing = by track.
  segments?: [number, number, number][];
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
  // Free pure pieces that Python did not assign but found likely (union_dudosa, p >= 0.8, cost <= 1.0): the table offers
  // them one by one (pendingTramos). Only in links_<part>_exp_tramos.json; missing = nothing changes.
  suggestions?: TramoSuggestion[];
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
// variant "exp": fill B, the recommended mode (fewer jumps), links_<part>_exp_tramos.json; A (links_<part>.json) is kept to compare.
// The fill B is written by stretches to links_<part>_exp_tramos.json (Python, since 2026-10-25); `linksOld` is the file it
// used to write (links_<part>_exp.json), read only when the new one does not exist.
export function anchorPaths(folder: string, part: string, example = false, variant?: "exp") {
  const dir = `matches/${folder}/tracking/auto${example ? "/ejemplo" : ""}`;
  const base = { dir, suggest: `${dir}/suggest_${part}.json`, anchors: `${dir}/anchors_${part}.json` };
  if (!variant) return { ...base, links: `${dir}/links_${part}.json`, linksOld: null as string | null };
  return { ...base, links: `${dir}/links_${part}_exp_tramos.json`, linksOld: `${dir}/links_${part}_exp.json` as string | null };
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

// The density a suggest file was generated at (anchors per minute), read from the counts Python wrote next to it: the
// one whose count equals the number of suggestions of the file (the largest, when several tie). Null when the file does
// not say (an old one). The density is a choice made when generating, not a filter of the app: a file holds one
// suggestion per chain, so thinning it by density never removed anything (measured on the 4 real parts of
// 2026_09_25_tec_ccm_vs_anahuac: the same count at 1, 2, 3, 4 and 5 per minute).
export function densityChoices(s: Pick<SuggestFile, "available">): { density: number; n: number }[] {
  const av = s.available ?? {};
  return DENSITIES.flatMap((d) => (typeof av[String(d)] === "number" ? [{ density: d, n: av[String(d)] as number }] : []));
}
export function generatedDensity(s: Pick<SuggestFile, "suggestions" | "available">): number | null {
  const hit = densityChoices(s).filter((c) => c.n === s.suggestions.length);
  return hit.length ? hit[hit.length - 1].density : null;
}

// What is left to do: the suggestions of the density without an anchor of their chain near them and not skipped.
// An anchor names its whole chain, so a chain already anchored within the density's window needs no other.
// `chainOf` is the chainIndex of the chains when the caller already has it (building it walks every box of every chain).
export function pendingSuggestions(list: AnchorSuggestion[], anchors: Anchor[], skipped: string[], chains: AnchorChain[], density: number, fps: number, chainOf: Map<string, number | string> = chainIndex(chains)): AnchorSuggestion[] {
  const skip = new Set(skipped);
  const gap = (60 / Math.max(1, density)) * fps;
  const anchoredAt = new Map<string, number[]>();
  const anchored = new Set(anchors.map((a) => `${a.track}:${a.frame}`));
  for (const a of anchors) {
    const c = chainOf.get(`${a.track}:${a.frame}`);
    const k = c === undefined ? `t${a.track}` : String(c);
    anchoredAt.set(k, [...(anchoredAt.get(k) ?? []), a.frame]);
  }
  return list.filter((s) => {
    if (skip.has(suggestionKey(s))) return false;
    const near = anchoredAt.get(String(s.chain)) ?? [];
    return !near.some((f) => Math.abs(f - s.frame) < gap) && !anchored.has(`${s.track}:${s.frame}`);
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
//
// Fill by stretches: an identity with `segments` ([track, from, to], frames inclusive) does not take whole tracks but
// those stretches: each track is cut at their limits (TrackEdits.splits, noted in linkSplits) and each stretch goes to
// its person, so a track claimed by two players is cut, not left out. Outside the stretches a cut track goes back to
// what it was; hand splits inside a stretch are replaced by it. Stretches of different players that overlap on one
// track are left as they were (counted as conflicts). Without `segments` it works track by track as always.
// The result is one TrackEdits: applying it is one action for the undo.
export interface FillResult {
  edits: TrackEdits;
  players: number;
  tracks: number;
  conflicts: number[];
  skipped: number;
  dropped: number;
  droppedBy: Record<string, number>;
  // Stretches applied, tracks cut by them, and the seconds each player gets from them.
  stretches: number;
  cutTracks: number;
  stretchSeconds: Record<string, number>;
}
type Stretch = { player: string; a: number; b: number };

export function editsFromLinks(
  edits: TrackEdits,
  file: TracksFile,
  links: LinksFile,
  named: Map<string, number>,
  // When given: these people (and their tracks) are left as they are (see linksProtection).
  protect?: { ids: Set<number>; tracks: Set<number> },
): FillResult {
  const trackFrames = new Map<number, number[]>();
  for (const fr of file.frames) {
    for (const b of fr.boxes) {
      const list = trackFrames.get(b[0]);
      if (list) list.push(fr.frame);
      else trackFrames.set(b[0], [fr.frame]);
    }
  }
  const present = new Set(trackFrames.keys());
  const hasSegs = (id: LinkIdentity) => Array.isArray(id.segments) && id.segments.length > 0;
  const isNamed = (id: LinkIdentity) => !!id.player && id.player !== "__no__";

  // Whole-track claims (identities without segments) and stretches by track.
  const owners = new Map<number, Set<string>>();
  for (const id of links.identities) if (!hasSegs(id)) for (const t of id.tracks) owners.set(t, (owners.get(t) ?? new Set()).add(id.player));
  const stretches = new Map<number, Stretch[]>();
  for (const id of links.identities) {
    if (!hasSegs(id) || !isNamed(id)) continue;
    for (const [t, a, b] of id.segments as [number, number, number][]) {
      if (!present.has(t) || !(b >= a)) continue;
      // A stretch with no box of its track is nothing to apply.
      if (!(trackFrames.get(t) as number[]).some((f) => f >= a && f <= b)) continue;
      stretches.set(t, [...(stretches.get(t) ?? []), { player: id.player, a, b }]);
    }
  }
  // Tracks whose whole claim is in doubt: two owners, or claimed whole by one and by stretches of another.
  const wholeBad = new Set<number>();
  for (const [t, s] of owners) if (s.size > 1) wholeBad.add(t);
  for (const t of stretches.keys()) if (owners.has(t)) wholeBad.add(t);
  // Stretches of different players that overlap.
  const badStretch = new Set<Stretch>();
  const overlapTracks = new Set<number>();
  for (const [t, list] of stretches) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].player !== list[j].player && list[i].a <= list[j].b && list[j].a <= list[i].b) {
          badStretch.add(list[i]);
          badStretch.add(list[j]);
          overlapTracks.add(t);
        }
      }
    }
  }
  const conflicts = [...new Set([...wholeBad, ...overlapTracks])].sort((a, b) => a - b);

  let next: TrackEdits = { ...edits, identity: { ...edits.identity } };
  let players = 0;
  let tracks = 0;
  let skipped = 0;
  const target = new Map(named);
  const personFor = (player: string) => {
    let into = target.get(player);
    if (into === undefined) {
      // freshIdentity looks at the values of `identity`, so the next new one gets another number.
      // A new person lives only in `people` until a cut or a track points to her, so numbers already given count too.
      into = Math.max(freshIdentity(next, file), ...[...target.values()].map((v) => v + 1));
      target.set(player, into);
      next = setPerson(next, into, { player_id: player });
    }
    return into;
  };
  const protectedPlayer = (player: string) => !!protect && protect.ids.has(target.get(player) ?? Number.NaN);

  for (const id of links.identities) {
    if (hasSegs(id)) continue;
    const all = id.tracks.filter((t) => !wholeBad.has(t) && present.has(t));
    const mine = protect ? all.filter((t) => !protect.tracks.has(t)) : all;
    skipped += all.length - mine.length;
    // «No es jugadora» (player "__no__"): never a person of the table.
    if (!isNamed(id) || mine.length === 0) continue;
    if (protectedPlayer(id.player)) {
      skipped += mine.length;
      continue;
    }
    const into = personFor(id.player);
    for (const t of mine) {
      if (next.identity[String(t)] !== into) tracks++;
      next = { ...next, identity: { ...next.identity, [String(t)]: into } };
    }
    players++;
  }

  // The stretches, track by track.
  const applied: Stretch[] = [];
  const stretchSeconds: Record<string, number> = {};
  const made: { track: number; frame: number }[] = [];
  let cutTracks = 0;
  for (const [t, list] of stretches) {
    if (wholeBad.has(t)) continue;
    const usable = list.filter((s) => {
      if (badStretch.has(s)) return false;
      if ((protect && protect.tracks.has(t)) || protectedPlayer(s.player)) {
        skipped++;
        return false;
      }
      return true;
    });
    if (!usable.length) continue;
    usable.sort((x, y) => x.a - y.a || x.b - y.b);
    const frames = trackFrames.get(t) as number[];
    const spans = usable.map((s) => ({ s, nf: frames.find((f) => f > s.b) }));
    // Cuts of this track made by hand inside the stretches are replaced by them.
    const kept = next.splits.filter((x) => x.track !== t || !spans.some(({ s, nf }) => x.frame >= s.a && (nf === undefined || x.frame < nf)));
    const adds = new Map<number, { track: number; frame: number; identity: number }>();
    for (const { nf } of spans) {
      // Back to what the track was after the stretch, unless another stretch takes over right there.
      if (nf !== undefined && !usable.some((o) => o.a <= nf && o.b >= nf)) {
        const bx = file.frames.find((f) => f.frame === nf)?.boxes.find((x) => x[0] === t) as DetBox;
        adds.set(nf, { track: t, frame: nf, identity: identityOf(bx, nf, edits) });
      }
    }
    // Stretch starts last: where a stretch starts right after another, the new one rules.
    for (const { s } of spans) adds.set(s.a, { track: t, frame: s.a, identity: personFor(s.player) });
    for (const s of usable) {
      applied.push(s);
      stretchSeconds[s.player] = (stretchSeconds[s.player] ?? 0) + frames.filter((f) => f >= s.a && f <= s.b).length * (file.stride / file.fps);
    }
    next = { ...next, splits: [...kept.filter((x) => !(x.track === t && adds.has(x.frame))), ...adds.values()] };
    for (const x of adds.values()) made.push({ track: x.track, frame: x.frame });
    cutTracks++;
  }
  players += new Set(applied.map((s) => s.player)).size;
  if (made.length) next = { ...next, linkSplits: [...(next.linkSplits ?? []).filter((m) => !made.some((x) => x.track === m.track && x.frame === m.frame)), ...made] };

  // Drops only where the player's identity was applied here: her tracks (not protected, not claimed twice), or her stretches.
  const wholeTracks = new Map<string, Set<number>>();
  for (const id of links.identities) {
    if (hasSegs(id) || protectedPlayer(id.player)) continue;
    wholeTracks.set(id.player, new Set(id.tracks.filter((t) => !wholeBad.has(t) && present.has(t) && !(protect && protect.tracks.has(t)))));
  }
  const dropApplies = (d: LinkDrop) =>
    !!wholeTracks.get(d.player)?.has(d.track) || (stretches.get(d.track) ?? []).some((s) => applied.includes(s) && s.player === d.player && d.frame >= s.a && d.frame <= s.b);
  const had = new Set((next.dropped ?? []).map((d) => `${d.track}:${d.frame}`));
  const droppedBy: Record<string, number> = {};
  const drops: { track: number; frame: number }[] = [];
  for (const d of links.drops ?? []) {
    const k = `${d.track}:${d.frame}`;
    if (!dropApplies(d) || had.has(k)) continue;
    had.add(k);
    drops.push({ track: d.track, frame: d.frame });
    droppedBy[d.reason] = (droppedBy[d.reason] ?? 0) + 1;
  }
  const before = (next.dropped ?? []).length;
  next = dropBoxes(next, drops);
  return { edits: next, players, tracks, conflicts, skipped, dropped: (next.dropped ?? []).length - before, droppedBy, stretches: applied.length, cutTracks, stretchSeconds };
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

// ---------------------------------------------------------------- «Unión dudosa» of one click (suggestions of the tramos file)

// A free pure piece of a track that Python would give to `person` (p >= 0.8, cost <= 1.0): [frame_ini, frame_fin] of
// `track`, frames inclusive. It is never assigned by itself: the analyst accepts or rejects each one.
export interface TramoSuggestion {
  kind: "union_dudosa" | string;
  person: string;
  track: number;
  frame_ini: number;
  frame_fin: number;
  p: number;
  cost: number;
}
// What marks a suggestion as accepted or rejected (kept in TrackEdits.anchorDoubts, so «Empezar de cero» clears it).
export const tramoKey = (s: Pick<TramoSuggestion, "track" | "frame_ini" | "frame_fin">) => `sug:${s.track}:${s.frame_ini}:${s.frame_fin}`;

// The suggestions still to answer: best p first, then lowest cost, then by time.
// `min`: floor of p and ceiling of cost (Detalles técnicos); Python writes p >= 0.8 and cost <= 1.0, so this can only be stricter.
export function pendingTramos(links: Pick<LinksFile, "suggestions"> | null | undefined, resolved: string[] = [], min: { p: number; maxCost: number } = { p: 0, maxCost: Infinity }): TramoSuggestion[] {
  const done = new Set(resolved);
  return (links?.suggestions ?? [])
    .filter((s) => s.kind === "union_dudosa" && s.person && s.frame_fin >= s.frame_ini && s.p >= min.p && s.cost <= min.maxCost && !done.has(tramoKey(s)))
    .sort((a, b) => b.p - a.p || a.cost - b.cost || a.frame_ini - b.frame_ini || a.track - b.track);
}

export interface TramoResult {
  // ok: applied; same: the piece was already hers; overlap: she has other boxes in those frames; empty: the track has no box there.
  status: "ok" | "same" | "overlap" | "empty";
  edits: TrackEdits;
  // Frames where she already has another box (status overlap).
  overlap: number;
}

// Accepting: the stretch of the track goes to the person with that name (a new one, named, if the table has none yet).
// It is a single new TrackEdits, so Ctrl + Z undoes it in one step. Resolving it (the key) is up to the caller.
export function acceptTramo(edits: TrackEdits, file: TracksFile, s: TramoSuggestion, named: Map<string, number>): TramoResult {
  const frames = file.frames.filter((f) => f.frame >= s.frame_ini && f.frame <= s.frame_fin && f.boxes.some((x) => x[0] === s.track));
  if (frames.length === 0) return { status: "empty", edits, overlap: 0 };
  let id = named.get(s.person);
  let next = edits;
  if (id === undefined) {
    id = freshIdentity(edits, file);
    next = setPerson(edits, id, { player_id: s.person });
  }
  const mine = id;
  if (frames.every((f) => identityOf(f.boxes.find((x) => x[0] === s.track) as DetBox, f.frame, edits) === mine)) return { status: "same", edits, overlap: 0 };
  const clash = personFramesIn(file, edits, mine, s.frame_ini, s.frame_fin, s.track);
  if (clash.length > 0) return { status: "overlap", edits, overlap: clash.length };
  const done = assignStretch(next, file, s.track, s.frame_ini, s.frame_fin, mine);
  return done ? { status: "ok", edits: done, overlap: 0 } : { status: "empty", edits, overlap: 0 };
}

// ---------------------------------------------------------------- warning when anchoring on an impure chain

// A chain that overlaps in time with another chain already anchored to the SAME player: one of the two has someone else
// in the overlap (a chain that grew over two people). `from`/`to` are the frames both cover.
export interface ChainOverlap {
  chain: number | string;
  other: number | string;
  player: string;
  from: number;
  to: number;
}
// First and last frame of a chain, from its boxes (null when it has none).
export function chainFrames(c: Pick<AnchorChain, "boxes">): [number, number] | null {
  if (c.boxes.length === 0) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const [f] of c.boxes) {
    if (f < a) a = f;
    if (f > b) b = f;
  }
  return [a, b];
}
export function chainLookup(chains: AnchorChain[]): Map<string, AnchorChain> {
  return new Map(chains.map((c) => [String(c.id), c]));
}
// The overlaps of the chain of `cand` with the chains already anchored to `cand.player` (one per other chain).
export function chainOverlaps(lookup: Map<string, AnchorChain>, index: Map<string, number | string>, anchors: Anchor[], cand: Anchor): ChainOverlap[] {
  if (!cand.player || cand.player === "__no__") return [];
  const cid = index.get(`${cand.track}:${cand.frame}`);
  const mine = cid === undefined ? undefined : lookup.get(String(cid));
  const span = mine ? chainFrames(mine) : null;
  if (cid === undefined || !span) return [];
  const seen = new Set<string>();
  const out: ChainOverlap[] = [];
  for (const a of anchors) {
    if (a.player !== cand.player) continue;
    const oid = index.get(`${a.track}:${a.frame}`);
    if (oid === undefined || String(oid) === String(cid) || seen.has(String(oid))) continue;
    const other = lookup.get(String(oid));
    const os = other ? chainFrames(other) : null;
    if (!os) continue;
    const from = Math.max(span[0], os[0]);
    const to = Math.min(span[1], os[1]);
    if (from > to) continue;
    seen.add(String(oid));
    out.push({ chain: cid, other: oid, player: cand.player, from, to });
  }
  return out.sort((x, y) => x.from - y.from);
}
// What a chain does inside the overlap: its stretch on each raw track, from the first to the last box there.
export function overlapStretches(chain: Pick<AnchorChain, "boxes">, from: number, to: number): { track: number; a: number; b: number }[] {
  const by = new Map<number, { a: number; b: number }>();
  for (const [frame, track] of chain.boxes) {
    if (frame < from || frame > to) continue;
    const cur = by.get(track);
    if (!cur) by.set(track, { a: frame, b: frame });
    else {
      cur.a = Math.min(cur.a, frame);
      cur.b = Math.max(cur.b, frame);
    }
  }
  return [...by].map(([track, r]) => ({ track, ...r })).sort((x, y) => x.a - y.a);
}
// «Partir»: each stretch becomes a person of its own (unnamed); «descartar»: its boxes are left out. One TrackEdits.
export function resolveOverlap(edits: TrackEdits, file: TracksFile, chain: Pick<AnchorChain, "boxes">, from: number, to: number, how: "partir" | "descartar"): { edits: TrackEdits; boxes: number } {
  let next = edits;
  let boxes = 0;
  if (how === "descartar") {
    const list = chain.boxes.filter(([f]) => f >= from && f <= to).map(([frame, track]) => ({ track, frame }));
    const before = (next.dropped ?? []).length;
    next = dropBoxes(next, list);
    return { edits: next, boxes: (next.dropped ?? []).length - before };
  }
  for (const st of overlapStretches(chain, from, to)) {
    const made = assignStretch(next, file, st.track, st.a, st.b, freshIdentity(next, file));
    if (!made) continue;
    next = made;
    boxes++;
  }
  return { edits: next, boxes };
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
  // Colour of its outline (a token of globals.css); missing = by number, FOCUS_COLORS.
  color?: string;
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
