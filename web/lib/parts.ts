import { apply, orient } from "./homography.ts";
import { smoothTrack, type SmoothOptions, type TrackPoint } from "./smooth.ts";
import { droppedSet, editsKey, emptyEdits, identityOf, isDropped, nearestFrame, people, type JerseyColors, type TeamCode, type TracksFile } from "./tracks.ts";
import { PITCH, type MatchEvent, type TrackEdits } from "./types.ts";

// From corrected parts to what is exported: the path of every person on the pitch, the ball, and several parts of
// one video joined into a single file. Pure functions: no storage, no React.

// Pixels -> normalised pitch through the calibration of a frame. The homography goes to real meters of the venue.
export function pixelToPitch(file: TracksFile, H: number[] | null | undefined, px: number, py: number): [number, number] | null {
  if (!H) return null;
  const m = apply(orient(H, [[file.image_w / 2, file.image_h * 0.8]]) ?? H, [px, py]);
  if (!m) return null;
  return [(m[0] * PITCH.length) / (file.venue?.length_m ?? PITCH.length), (m[1] * PITCH.width) / (file.venue?.width_m ?? PITCH.width)];
}

// Path of every person of a part on the pitch, as measured: detections inside the pitch plus hand marks.
// Discarded identities and boxes left out are not included.
export function measuredPaths(file: TracksFile, edits: TrackEdits): Map<number, TrackPoint[]> {
  const out = new Map<number, TrackPoint[]>();
  const gone = new Set(edits.removed);
  const add = (id: number, point: TrackPoint) => {
    if (gone.has(id)) return;
    const list = out.get(id);
    if (list) list.push(point);
    else out.set(id, [point]);
  };
  const drop = droppedSet(edits);
  const H = new Map<number, number[] | null | undefined>();
  for (const fr of file.frames) {
    H.set(fr.frame, fr.H);
    for (const b of fr.boxes) {
      if (isDropped(drop, b, fr.frame)) continue;
      if (b[11] && b[9] !== null && b[10] !== null) add(identityOf(b, fr.frame, edits), { frame: fr.frame, x: b[9], y: b[10], source: "auto" });
    }
  }
  for (const m of edits.manual) {
    const p = pixelToPitch(file, H.get(m.frame), m.px, m.py);
    if (p) add(m.identity, { frame: m.frame, x: p[0], y: p[1], source: "manual" });
  }
  return out;
}

export const metersPerUnit = (file: TracksFile): [number, number] => [
  (file.venue?.length_m ?? PITCH.length) / PITCH.length,
  (file.venue?.width_m ?? PITCH.width) / PITCH.width,
];

// ---------------------------------------------------------------- ball

// Where a ball position comes from. None of them is a detection: the program does not track the ball.
//   manual        clicked on the video (taken to the pitch as if the ball were on the ground)
//   event         position of a tagged event at that moment
//   interpolated  straight line between two of the above that are close in time; never a measurement
export type BallSource = "manual" | "event" | "interpolated";
export interface BallPoint {
  frame: number;
  x: number;
  y: number;
  source: BallSource;
}

// Longest stretch between two known ball positions that is joined with a straight line (s).
export const BALL_FILL_S = 3;

// Tagged events as ball positions of a part. Events are tagged with the analysed team always attacking towards
// x = 105; `ownAttacksRight` says whether that is also true on the pitch of this video (if not, they are mirrored).
export function eventBall(file: TracksFile, events: MatchEvent[], ownAttacksRight: boolean): BallPoint[] {
  const out = new Map<number, BallPoint>();
  for (const e of events) {
    if (e.x === null || e.y === null || (e.video_id ?? "v1") !== file.video_id) continue;
    const f = Math.round(e.t_video * file.fps);
    if (f < file.start_frame || f >= file.end_frame) continue;
    const frame = nearestFrame(file, f);
    out.set(frame, { frame, x: ownAttacksRight ? e.x : PITCH.length - e.x, y: ownAttacksRight ? e.y : PITCH.width - e.y, source: "event" });
  }
  return [...out.values()].sort((a, b) => a.frame - b.frame);
}

// Ball marks made by hand on the video of a part, on the pitch. Marks on frames without calibration are left out.
export function manualBall(file: TracksFile, edits: TrackEdits): BallPoint[] {
  const H = new Map(file.frames.map((fr) => [fr.frame, fr.H]));
  const out: BallPoint[] = [];
  for (const m of edits.ball ?? []) {
    const p = pixelToPitch(file, H.get(m.frame), m.px, m.py);
    if (p) out.push({ frame: m.frame, x: p[0], y: p[1], source: "manual" });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

// One ball position per frame, with short stretches between known positions joined by a straight line on the
// processed frames. Longer stretches stay empty. Hand marks win: a tagged event (whose time and place are only
// roughly the ball's) is used only where no hand mark is within maxFillS, so it fills what was not marked instead of
// pulling the ball off its path.
export function ballPath(known: BallPoint[], fps: number, stride: number, maxFillS = BALL_FILL_S, links: { from: number; to: number }[] = []): BallPoint[] {
  // Two known positions inside a line drawn by hand are joined whatever the time between them.
  const linked = (a: number, b: number) => links.some((l) => l.from <= a && b <= l.to);
  const manual = known.filter((p) => p.source === "manual").map((p) => p.frame);
  const nearManual = (f: number) => manual.some((m) => Math.abs(m - f) / fps <= maxFillS);
  const byFrame = new Map<number, BallPoint>();
  for (const p of known) {
    if (p.source === "event" && nearManual(p.frame)) continue;
    const cur = byFrame.get(p.frame);
    if (!cur || (p.source === "manual" && cur.source !== "manual")) byFrame.set(p.frame, p);
  }
  const pts = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const out: BallPoint[] = [];
  pts.forEach((p, i) => {
    out.push(p);
    const next = pts[i + 1];
    if (!next || ((next.frame - p.frame) / fps > maxFillS && !linked(p.frame, next.frame))) return;
    for (let f = p.frame + stride; f < next.frame; f += stride) {
      const k = (f - p.frame) / (next.frame - p.frame);
      out.push({ frame: f, x: p.x + (next.x - p.x) * k, y: p.y + (next.y - p.y) * k, source: "interpolated" });
    }
  });
  return out;
}

// ---------------------------------------------------------------- several parts in one file

export interface Part {
  file: TracksFile;
  // Absent = the part has no corrections: its automatic identities are used as they are.
  edits?: TrackEdits;
}

// Between two parts in a row the tracker starts again, so everybody changes identity. A person seen at the very end
// of one part and one seen at the very start of the next are taken as the same when they are each other's nearest,
// close enough to have got there, of compatible teams, and nobody else is about as near.
export const LINK_EDGE_S = 0.5;
export const LINK_SLACK_M = 2;
export const LINK_SPEED_MS = 8;

export interface JoinOptions {
  colors?: Partial<JerseyColors>;
  // Cleaning of each person's path, applied after joining (so the hole at a boundary can be filled). null = as measured.
  smooth: { maxSpeedMs: number; maxFillS: number; windowS: number } | null;
  // Extra ball positions (from events), already on the pitch.
  ball?: BallPoint[];
}

export interface JoinedPerson {
  id: number;
  team: TeamCode;
  player_id: string | null;
  // Where she comes from: identity in each part ("<start>_<end>").
  sources: { part: string; id: number }[];
}

export interface Joined {
  schema_version: 2;
  kind: "tracks_fixed";
  match_id: string;
  video_id: string;
  fps: number;
  start_frame: number;
  end_frame: number;
  stride: number;
  // Real size of the venue (m): positions are normalised to 105 x 68, distances are measured in these meters.
  venue: { length_m: number; width_m: number } | null;
  parts: { start_frame: number; end_frame: number; corrected: boolean; linked_to_previous: number }[];
  smoothing: null | { max_speed_ms: number; max_fill_s: number; window_s: number; outliers: number; filled: number; openGaps: number };
  people: JoinedPerson[];
  ball: { frame: number; x: number; y: number; source: BallSource }[];
  frames: { frame: number; positions: { id: number; x: number; y: number; source: string; raw?: [number, number] }[] }[];
}

export const hasCorrections = (e: TrackEdits | undefined): boolean =>
  !!e &&
  (Object.keys(e.identity).length > 0 ||
    Object.keys(e.people).length > 0 ||
    e.removed.length > 0 ||
    e.splits.length > 0 ||
    e.manual.length > 0 ||
    (e.dropped ?? []).length > 0 ||
    (e.ball ?? []).length > 0);

const r2 = (v: number) => Math.round(v * 100) / 100;

// Joins parts of one video into a single corrected file. People with the same name are one person across parts;
// the unnamed are linked at each boundary between consecutive parts when it is clear who is who (see above).
// Throws an Error (message in Spanish, shown to the user) when the parts do not belong together.
export function joinParts(input: Part[], o: JoinOptions): Joined {
  if (input.length === 0) throw new Error("No hay partes que unir.");
  const parts = [...input].sort((a, b) => a.file.start_frame - b.file.start_frame);
  const first = parts[0].file;
  for (const [i, p] of parts.entries()) {
    const f = p.file;
    if (f.match_id !== first.match_id || f.video_id !== first.video_id) throw new Error("Las partes son de partidos o videos distintos.");
    if (f.stride !== first.stride || Math.abs(f.fps - first.fps) > 1e-6) throw new Error("Las partes se procesaron con distinto salto de cuadros.");
    if (i > 0 && f.start_frame < parts[i - 1].file.end_frame) throw new Error("Hay partes que se traslapan (¿la misma parte dos veces?).");
  }

  // Every person of every part is a node; groups of nodes are one person in the result.
  interface Node {
    part: number;
    id: number;
    team: TeamCode;
    name: string;
    points: TrackPoint[];
  }
  const nodes: Node[] = [];
  const perPart: number[][] = [];
  parts.forEach((p, k) => {
    const edits = p.edits ?? emptyEdits(editsKey(p.file));
    const paths = measuredPaths(p.file, edits);
    perPart.push([]);
    for (const q of people(p.file, edits, o.colors)) {
      const points = [...(paths.get(q.id) ?? [])].sort((a, b) => a.frame - b.frame);
      if (points.length === 0) continue; // never inside the pitch
      perPart[k].push(nodes.length);
      nodes.push({ part: k, id: q.id, team: q.team, name: q.player_id.trim(), points });
    }
  });

  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const groupName = new Map<number, string>();
  nodes.forEach((n, i) => n.name && groupName.set(i, n.name.toLowerCase()));
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent[rb] = ra;
    const name = groupName.get(ra) ?? groupName.get(rb);
    if (name) groupName.set(ra, name);
  };
  // Same name, same person.
  const byName = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (!n.name) return;
    const k = n.name.toLowerCase();
    const seen = byName.get(k);
    if (seen === undefined) byName.set(k, i);
    else union(seen, i);
  });

  // Boundaries between consecutive parts.
  const linked = parts.map(() => 0);
  for (let k = 1; k < parts.length; k++) {
    const [a, b] = [parts[k - 1].file, parts[k].file];
    if (b.start_frame - a.end_frame > a.stride) continue; // not in a row: nothing can be said
    const edge = LINK_EDGE_S * a.fps;
    const [mx, my] = metersPerUnit(a);
    const ends = perPart[k - 1].filter((i) => nodes[i].points[nodes[i].points.length - 1].frame >= a.end_frame - edge);
    const starts = perPart[k].filter((i) => nodes[i].points[0].frame <= b.start_frame + edge);
    const cost = (i: number, j: number): number | null => {
      const [p, q] = [nodes[i].points[nodes[i].points.length - 1], nodes[j].points[0]];
      const [ta, tb] = [nodes[i].team, nodes[j].team];
      if (ta !== "unk" && tb !== "unk" && ta !== tb) return null;
      const [na, nb] = [groupName.get(find(i)), groupName.get(find(j))];
      if (na && nb && na !== nb) return null;
      const d = Math.hypot((q.x - p.x) * mx, (q.y - p.y) * my);
      return d <= LINK_SLACK_M + (LINK_SPEED_MS * (q.frame - p.frame)) / a.fps ? d : null;
    };
    // Best and second best partner of each one, in both directions.
    const best = (from: number[], to: number[], c: (x: number, y: number) => number | null) =>
      new Map(
        from.map((x) => {
          const options = to.map((y) => ({ y, d: c(x, y) })).filter((v): v is { y: number; d: number } => v.d !== null);
          options.sort((u, v) => u.d - v.d);
          return [x, options] as const;
        }),
      );
    const fwd = best(ends, starts, cost);
    const back = best(starts, ends, (j, i) => cost(i, j));
    for (const [i, options] of fwd) {
      const top = options[0];
      if (!top) continue;
      const theirs = back.get(top.y) ?? [];
      const clear = (list: { d: number }[]) => list.length < 2 || list[1].d > list[0].d + 1;
      if (theirs[0]?.y === i && clear(options) && clear(theirs)) {
        union(i, top.y);
        linked[k]++;
      }
    }
  }

  // Groups -> people, numbered by first appearance.
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(i);
    else groups.set(r, [i]);
  });
  const ordered = [...groups.values()].sort((u, v) => nodes[u[0]].points[0].frame - nodes[v[0]].points[0].frame || nodes[u[0]].id - nodes[v[0]].id);
  const opt: SmoothOptions | null = o.smooth ? { fps: first.fps, stride: first.stride, metersPerUnit: metersPerUnit(first), ...o.smooth } : null;
  const totals = { outliers: 0, filled: 0, openGaps: 0 };
  const peopleOut: JoinedPerson[] = [];
  const byFrame = new Map<number, Joined["frames"][number]["positions"]>();
  ordered.forEach((members, n) => {
    const id = n + 1;
    const named = members.find((i) => nodes[i].name);
    const team = members.map((i) => nodes[i].team).find((t) => t !== "unk") ?? "unk";
    peopleOut.push({
      id,
      team,
      player_id: named !== undefined ? nodes[named].name : null,
      sources: members.map((i) => ({ part: `${parts[nodes[i].part].file.start_frame}_${parts[nodes[i].part].file.end_frame}`, id: nodes[i].id })),
    });
    let pts = members.flatMap((i) => nodes[i].points).sort((a, b) => a.frame - b.frame);
    if (opt) {
      const done = smoothTrack(pts, opt);
      pts = done.points;
      totals.outliers += done.report.outliers;
      totals.filled += done.report.filled;
      totals.openGaps += done.report.openGaps;
    }
    for (const q of pts) {
      const row = { id, x: r2(q.x), y: r2(q.y), source: q.source as string, ...(q.raw ? { raw: [r2(q.raw[0]), r2(q.raw[1])] as [number, number] } : {}) };
      const list = byFrame.get(q.frame);
      if (list) list.push(row);
      else byFrame.set(q.frame, [row]);
    }
  });

  const knownBall = [...(o.ball ?? []), ...parts.flatMap((p) => (p.edits ? manualBall(p.file, p.edits) : []))];
  const ballLinks = parts.flatMap((p) => p.edits?.ballLinks ?? []);
  const last = parts[parts.length - 1].file;
  return {
    schema_version: 2,
    kind: "tracks_fixed",
    match_id: first.match_id,
    video_id: first.video_id,
    fps: first.fps,
    start_frame: first.start_frame,
    end_frame: last.end_frame,
    stride: first.stride,
    venue: first.venue?.length_m && first.venue?.width_m ? { length_m: first.venue.length_m, width_m: first.venue.width_m } : null,
    parts: parts.map((p, k) => ({ start_frame: p.file.start_frame, end_frame: p.file.end_frame, corrected: hasCorrections(p.edits), linked_to_previous: linked[k] })),
    smoothing: o.smooth ? { max_speed_ms: o.smooth.maxSpeedMs, max_fill_s: o.smooth.maxFillS, window_s: o.smooth.windowS, ...totals } : null,
    people: peopleOut,
    ball: ballPath(knownBall, first.fps, first.stride, BALL_FILL_S, ballLinks).map((b) => ({ frame: b.frame, x: r2(b.x), y: r2(b.y), source: b.source })),
    // The processed frames of every part, plus the frames filled in the hole between two parts.
    frames: [...new Set([...parts.flatMap((p) => p.file.frames.map((fr) => fr.frame)), ...byFrame.keys()])]
      .sort((a, b) => a - b)
      .map((frame) => ({ frame, positions: byFrame.get(frame) ?? [] })),
  };
}

// How much of the time in play has a ball, and where it is missing. A mark (by hand or from an event) covers its frame,
// two marks less than fillS apart cover what lies between them (the straight line drawn there), and `out` are the
// moments reviewed as "out of play / not in sight", each covering outHalf frames to each side: they are left out of the
// count. Stretches missing shorter than two processed frames are not reported.
export function ballCoverage(o: {
  marks: number[];
  out: number[];
  from: number;
  to: number;
  fps: number;
  stride: number;
  outHalf: number;
  fillS?: number;
  links?: { from: number; to: number }[];
}): { share: number; missing: [number, number][] } {
  const fill = (o.fillS ?? BALL_FILL_S) * o.fps;
  const merge = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const [a, b] of list.sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const clip = ([a, b]: [number, number]): [number, number] | null => {
    const x = Math.max(o.from, a);
    const y = Math.min(o.to, b);
    return y > x ? [x, y] : null;
  };
  const marks = [...new Set(o.marks)].sort((a, b) => a - b);
  const covered = merge(
    [
      ...marks.map((m) => [m - o.stride / 2, m + o.stride / 2] as [number, number]),
      ...marks.slice(1).flatMap((m, i) => (m - marks[i] <= fill ? [[marks[i], m] as [number, number]] : [])),
      ...(o.links ?? []).map((l) => [l.from, l.to] as [number, number]),
    ].flatMap((x) => {
      const c = clip(x);
      return c ? [c] : [];
    }),
  );
  const outs = merge(
    o.out
      .map((f) => [f - o.outHalf, f + o.outHalf] as [number, number])
      .flatMap((x) => {
        const c = clip(x);
        return c ? [c] : [];
      }),
  );
  // In play and without a ball: the stretch minus what is covered minus what is out.
  const taken = merge([...covered, ...outs]);
  const missing: [number, number][] = [];
  let at = o.from;
  for (const [a, b] of taken) {
    if (a - at >= 2 * o.stride) missing.push([at, a]);
    at = Math.max(at, b);
  }
  if (o.to - at >= 2 * o.stride) missing.push([at, o.to]);
  const len = (l: [number, number][]) => l.reduce((n, [a, b]) => n + (b - a), 0);
  const inPlay = Math.max(1, o.to - o.from - len(outs));
  return { share: Math.max(0, Math.min(1, 1 - len(missing) / inPlay)), missing };
}
