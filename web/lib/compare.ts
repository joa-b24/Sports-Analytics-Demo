// Comparison of two fills of one part (Revisión tab of the correction table): version A (links_<part>.json) against
// version B (links_<part>_exp.json, the experiment). Each version keeps its own edits; the work done by hand in each
// one is measured from the edits right after «Resolver automático». Pure functions: no storage, no React.
import { doubtKey, isTask, sortDoubts, type Doubt, type LinksFile } from "./anchors.ts";
import { playerAnomalies } from "./anomalies.ts";
import { dropBoxes, identityOf, people, type DetBox, type TracksFile } from "./tracks.ts";
import type { PartReview, ReviewVersion, ReviewVersionId, TrackEdits } from "./types.ts";

// The rule of the automatic jump fix in A: out and back within this long (s).
export const EXCURSION_MAX_S = 0.8;
// A drop resolves a doubt of its track this close in time (s).
export const DOUBT_MATCH_S = 0.5;
export const DROP_REASONS = ["exclusion", "ruta", "ambas", "salto"] as const;
export const REASON_LABELS: Record<string, string> = { exclusion: "Exclusión", ruta: "Fuera de su ruta", ambas: "Ambas cajas", salto: "Salto" };

// The example of B (made in the app while Python's does not exist) is written apart, never as the real file.
export const exampleExpPath = (folder: string, part: string) => `matches/${folder}/tracking/auto/ejemplo/links_${part}_exp.json`;

const clone = (e: TrackEdits): TrackEdits => JSON.parse(JSON.stringify(e)) as TrackEdits;

// A review starts in A from the edits the part has now (before any fill): that is where both versions start.
export function startReview(key: string, current: TrackEdits): PartReview {
  return { key, active: "A", base: clone(current), A: {}, B: {} };
}

// Going to the other version: the open one is kept as it is, the other one is loaded (or the base, the first time).
// Never mixes: what comes back is exactly what was saved for that version.
export function switchVersion(review: PartReview, current: TrackEdits, to: ReviewVersionId): { review: PartReview; edits: TrackEdits } {
  if (to === review.active) return { review, edits: current };
  const from = review.active;
  const saved: ReviewVersion = { ...review[from], edits: clone(current) };
  const target = review[to].edits ?? review.base;
  return { review: { ...review, [from]: saved, active: to }, edits: clone({ ...target, key: current.key }) };
}

// The edits of a version: the live ones when it is open, the saved ones (or the base) otherwise.
export const versionEdits = (review: PartReview, v: ReviewVersionId, live: TrackEdits) => (review.active === v ? live : (review[v].edits ?? review.base));

// ---------------------------------------------------------------- work done by hand

export interface EditCount {
  merge: number;
  split: number;
  drop: number;
  remove: number;
  rename: number;
  total: number;
  // Corrections touching each player (by name).
  byPlayer: Record<string, number>;
}

// The identity a person ended in, following merges ("i<id>" -> id).
function resolveId(e: TrackEdits, id: number): number {
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const next = e.identity[`i${cur}`];
    if (next === undefined || next === cur) return cur;
    cur = next;
  }
  return cur;
}
const nameOf = (e: TrackEdits, id: number) => e.people[String(resolveId(e, id))]?.player_id || e.people[String(id)]?.player_id || "";
const trackOwner = (e: TrackEdits, track: number) => nameOf(e, e.identity[String(track)] ?? track);

// What changed by hand from `from` to `to`: merges (a person or a raw track moved to another identity), splits, boxes
// left out (one per track and run of boxes), people removed and names changed. Each one counts for the players it
// touches (before and after).
export function countEdits(from: TrackEdits, to: TrackEdits): EditCount {
  const c: EditCount = { merge: 0, split: 0, drop: 0, remove: 0, rename: 0, total: 0, byPlayer: {} };
  const hit = (...names: string[]) => {
    for (const n of new Set(names.filter(Boolean))) c.byPlayer[n] = (c.byPlayer[n] ?? 0) + 1;
  };
  for (const [k, v] of Object.entries(to.identity)) {
    if (from.identity[k] === v) continue;
    c.merge++;
    if (k.startsWith("i")) hit(nameOf(from, Number(k.slice(1))), nameOf(to, v));
    else hit(trackOwner(from, Number(k)), nameOf(to, v));
  }
  const splitKey = (s: { track: number; frame: number }) => `${s.track}:${s.frame}`;
  const oldSplits = new Set(from.splits.map(splitKey));
  for (const s of to.splits) {
    if (oldSplits.has(splitKey(s))) continue;
    c.split++;
    hit(trackOwner(from, s.track));
  }
  const oldDrops = new Set((from.dropped ?? []).map(splitKey));
  const newDrops = (to.dropped ?? []).filter((d) => !oldDrops.has(splitKey(d))).sort((a, b) => a.track - b.track || a.frame - b.frame);
  // One «quitar» per track and stretch (a cut of ±0.5 s is one action): a new group after a gap of more than 2 s of frames.
  let last: { track: number; frame: number } | null = null;
  for (const d of newDrops) {
    if (!last || last.track !== d.track || d.frame - last.frame > 60) {
      c.drop++;
      hit(trackOwner(from, d.track));
    }
    last = d;
  }
  const oldRemoved = new Set(from.removed);
  for (const id of to.removed) {
    if (oldRemoved.has(id)) continue;
    c.remove++;
    hit(nameOf(from, id));
  }
  for (const [id, p] of Object.entries(to.people)) {
    const before = from.people[id]?.player_id ?? "";
    const after = p.player_id ?? "";
    if (before === after) continue;
    c.rename++;
    hit(before, after);
  }
  c.total = c.merge + c.split + c.drop + c.remove + c.rename;
  return c;
}

// ---------------------------------------------------------------- «Resolver automático»

export interface AutoDrop {
  track: number;
  frame: number;
  player: string;
  reason: string;
}

// Version A brings no drops: the boxes of named players that jump out and come back within EXCURSION_MAX_S
// (the excursion rule of lib/anomalies.ts), as drops with reason «salto».
export function jumpExcursionDrops(file: TracksFile, edits: TrackEdits, maxS = EXCURSION_MAX_S): AutoDrop[] {
  const out: AutoDrop[] = [];
  const ok = new Set(edits.anomalyOk ?? []);
  for (const a of playerAnomalies(file, edits)) {
    if (a.kind !== "player" || a.until === undefined || !a.name || a.person === undefined) continue;
    if ((a.until - a.frame) / file.fps > maxS) continue;
    if (ok.has(`player:${a.person}:${a.frame}`)) continue;
    for (const fr of file.frames) {
      if (fr.frame < a.frame || fr.frame >= a.until) continue;
      for (const b of fr.boxes as DetBox[]) if (identityOf(b, fr.frame, edits) === a.person) out.push({ track: b[0], frame: fr.frame, player: a.name, reason: "salto" });
    }
  }
  return out;
}

// Applies the automatic drops of a version (B: the drops of its links; A: the jump excursions) as TrackEdits.dropped,
// and marks as resolved the doubts (tasks) of the same track within DOUBT_MATCH_S of a drop.
export function autoResolve(
  edits: TrackEdits,
  file: TracksFile,
  links: LinksFile | null,
  version: ReviewVersionId,
): { edits: TrackEdits; doubts: string[]; byReason: Record<string, { boxes: number; doubts: number }> } {
  const present = new Set<string>();
  for (const fr of file.frames) for (const b of fr.boxes) present.add(`${b[0]}:${fr.frame}`);
  const already = new Set((edits.dropped ?? []).map((d) => `${d.track}:${d.frame}`));
  const raw: AutoDrop[] = version === "B" ? (links?.drops ?? []).map((d) => ({ ...d })) : jumpExcursionDrops(file, edits);
  const drops = raw.filter((d) => present.has(`${d.track}:${d.frame}`) && !already.has(`${d.track}:${d.frame}`));
  const byReason: Record<string, { boxes: number; doubts: number }> = {};
  for (const d of drops) (byReason[d.reason] ??= { boxes: 0, doubts: 0 }).boxes++;
  const resolved = new Set(edits.anchorDoubts ?? []);
  const win = DOUBT_MATCH_S * file.fps;
  const doubts: string[] = [];
  for (const d of links?.doubts ?? []) {
    if (!isTask(d) || resolved.has(doubtKey(d))) continue;
    const m = drops.find((x) => x.track === d.track && Math.abs(x.frame - d.frame) <= win);
    if (!m) continue;
    doubts.push(doubtKey(d));
    (byReason[m.reason] ??= { boxes: 0, doubts: 0 }).doubts++;
  }
  // Unique boxes only (a box dropped for two reasons counts once).
  const next = dropBoxes(edits, drops);
  return { edits: { ...next, anchorDoubts: [...new Set([...(edits.anchorDoubts ?? []), ...doubts])] }, doubts, byReason };
}

// ---------------------------------------------------------------- comparison

export interface VersionMetrics {
  version: ReviewVersionId;
  loaded: string | null;
  example: boolean;
  pending: Record<string, number>;
  pending_total: number;
  resolved_by_hand: number;
  auto_boxes: Record<string, number>;
  auto_doubts: number;
  double_boxes: number;
  impossible_jumps: number;
  manual: EditCount | null;
  seconds: number;
  actions: number;
  verified: string[];
}

export function versionMetrics(
  file: TracksFile,
  edits: TrackEdits,
  links: LinksFile | null,
  v: ReviewVersion,
  version: ReviewVersionId,
  timing: { s: number }[],
): VersionMetrics {
  const doubts = sortDoubts(links?.doubts ?? [], edits.anchorDoubts ?? []);
  const pending: Record<string, number> = {};
  for (const d of doubts.pending) pending[d.kind] = (pending[d.kind] ?? 0) + 1;
  // «Resolver automático» undone with Ctrl + Z: its doubts are no longer resolved or its boxes are back. Then it does
  // not count (nor the work by hand measured from it) until it is pressed again.
  const live = new Set(edits.anchorDoubts ?? []);
  const autoOn = !!v.auto && v.auto.doubts.every((k) => live.has(k)) && (v.checkpoint?.dropped?.length ?? 0) <= (edits.dropped?.length ?? 0);
  const auto = new Set(autoOn ? v.auto!.doubts : []);
  const named = people(file, edits).filter((p) => p.player_id);
  const ok = new Set(edits.anomalyOk ?? []);
  const jumps = playerAnomalies(file, edits).filter((a) => a.kind === "player" && a.name && !ok.has(`player:${a.person}:${a.frame}`));
  return {
    version,
    loaded: v.loaded ?? null,
    example: !!v.example,
    pending,
    pending_total: doubts.pending.length,
    resolved_by_hand: doubts.done.filter((d: Doubt) => !auto.has(doubtKey(d))).length,
    auto_boxes: Object.fromEntries(Object.entries(autoOn ? v.auto!.byReason : {}).map(([k, x]) => [k, x.boxes])),
    auto_doubts: auto.size,
    double_boxes: named.reduce((n, p) => n + p.conflicts.length, 0),
    impossible_jumps: jumps.length,
    manual: v.checkpoint && (autoOn || !v.auto) ? countEdits(v.checkpoint, edits) : null,
    seconds: Math.round(timing.reduce((x, t) => x + Math.min(60, Math.max(0, t.s)), 0) * 10) / 10,
    actions: timing.length,
    verified: v.verified ?? [],
  };
}

export function comparisonMarkdown(matchId: string, part: string, rows: VersionMetrics[]): string {
  const kinds = [...new Set(rows.flatMap((r) => Object.keys(r.pending)))].sort();
  const reasons = [...new Set(rows.flatMap((r) => Object.keys(r.auto_boxes)))].sort();
  const cell = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "—" : String(n));
  const lines = [
    `# Comparación A vs B · ${matchId} · ${part}`,
    "",
    ...rows.filter((r) => r.example).map((r) => `> Versión ${r.version}: datos de EJEMPLO generados en la app, no del experimento de Python.`),
    "",
    `| | ${rows.map((r) => r.version).join(" | ")} |`,
    `|---|${rows.map(() => "---").join("|")}|`,
    `| Relleno | ${rows.map((r) => r.loaded ?? "sin cargar").join(" | ")} |`,
    `| Tareas pendientes | ${rows.map((r) => r.pending_total).join(" | ")} |`,
    ...kinds.map((k) => `| · ${k} | ${rows.map((r) => cell(r.pending[k] ?? 0)).join(" | ")} |`),
    `| Dudas resueltas a mano | ${rows.map((r) => r.resolved_by_hand).join(" | ")} |`,
    `| Dudas autoresueltas | ${rows.map((r) => r.auto_doubts).join(" | ")} |`,
    ...reasons.map((k) => `| Cajas quitadas · ${REASON_LABELS[k] ?? k} | ${rows.map((r) => cell(r.auto_boxes[k] ?? 0)).join(" | ")} |`),
    `| Cajas dobles que quedan | ${rows.map((r) => r.double_boxes).join(" | ")} |`,
    `| Saltos imposibles que quedan | ${rows.map((r) => r.impossible_jumps).join(" | ")} |`,
    `| Ediciones manuales | ${rows.map((r) => cell(r.manual?.total)).join(" | ")} |`,
    `| · unir / partir / quitar / descartar / renombrar | ${rows.map((r) => (r.manual ? `${r.manual.merge} / ${r.manual.split} / ${r.manual.drop} / ${r.manual.remove} / ${r.manual.rename}` : "—")).join(" | ")} |`,
    `| Cronómetro (s) | ${rows.map((r) => r.seconds).join(" | ")} |`,
    `| Jugadoras verificadas | ${rows.map((r) => r.verified.length).join(" | ")} |`,
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- example of B

// While links_<part>_exp.json does not exist: a version B made here from A, labelled as an example. The same
// identities and doubts; as drops, the second box of each named player who has two in a frame («ruta») and her jump
// excursions («salto»). It is not the experiment: only something to try the screen with.
export function exampleExp(links: LinksFile, file: TracksFile, edits: TrackEdits): LinksFile & { variant: string; example: true } {
  const drops: AutoDrop[] = [];
  const named = new Map(people(file, edits).filter((p) => p.player_id).map((p) => [p.id, p.player_id]));
  for (const fr of file.frames) {
    const seen = new Set<number>();
    for (const b of fr.boxes as DetBox[]) {
      const id = identityOf(b, fr.frame, edits);
      const name = named.get(id);
      if (!name) continue;
      if (seen.has(id)) drops.push({ track: b[0], frame: fr.frame, player: name, reason: "ruta" });
      seen.add(id);
    }
  }
  drops.push(...jumpExcursionDrops(file, edits, 1.5));
  return { ...links, variant: "exp", example: true, drops };
}

// ---------------------------------------------------------------- «Empezar de cero esta parte»

// What the browser forgets of a part: its comparison (the edits go back to the snapshot taken at «Empezar la
// comparación», or, without one, keep everything but the resolved doubts), the stopwatch of that part and the
// skipped anchors (preference keys returned for the caller to clear).
export function resetPart<T extends { trackEdits: TrackEdits[]; reviews?: PartReview[] }>(
  state: T,
  key: string,
  part: string,
  folder: string,
  timing: { part?: string }[],
): { state: T; timing: { part?: string }[]; prefKeys: string[]; summary: { review: boolean; doubts: number; timing: number } } {
  const review = (state.reviews ?? []).find((r) => r.key === key);
  const cur = state.trackEdits.find((e) => e.key === key);
  const doubts = new Set([...(cur?.anchorDoubts ?? []), ...(review?.A.edits?.anchorDoubts ?? []), ...(review?.B.edits?.anchorDoubts ?? [])]).size;
  let next: TrackEdits | undefined;
  if (review) next = clone(review.base);
  else if (cur) {
    next = { ...cur };
    delete next.anchorDoubts;
  }
  const trackEdits = next ? [...state.trackEdits.filter((e) => e.key !== key), next] : state.trackEdits;
  const kept = timing.filter((t) => t.part !== part);
  return {
    state: { ...state, trackEdits, reviews: (state.reviews ?? []).filter((r) => r.key !== key) },
    timing: kept,
    prefKeys: [`anchors:skipped:${folder}:${part}`, `anchors:skipped:${folder}:${part}:ejemplo`],
    summary: { review: !!review, doubts, timing: timing.length - kept.length },
  };
}
