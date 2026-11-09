// Clip edits (drawings over the video of a play): what an edit needs from the tracking of its part, positions with the
// 1-second rule, the calibration of each frame and the labels of players. Pure functions, no storage, no React.
import { isMeasuredSource } from "./smooth.ts";
import { HIGHLIGHT_SHAPES, type Annotation, type ClipEdit, type ClipSnapshot, type LabelMode, type Pt, type ResolveContext } from "./annotations.ts";
import type { FixedFile } from "./positions.ts";
import type { Play, RosterPlayer } from "./types.ts";

// A player not seen for less than this is drawn on the straight line between where she was lost and found; longer,
// the drawing tied to her is hidden. Positions the smoothing filled in (`interpolated`) count as not seen.
export const MAX_HOLE_S = 1;

export const editFileName = (edit_id: string) => `edit_${edit_id}.json`;
export const editPath = (folder: string, edit_id: string) => `matches/${folder}/edits/${editFileName(edit_id)}`;

export function newEdit(edit_id: string, play: Play): ClipEdit {
  return {
    edit_id,
    match_id: play.match_id,
    video_id: play.video_id ?? "v1",
    t_start: play.t_start,
    t_end: play.t_end,
    title: play.title,
    freezes: [],
    annotations: [],
    label_mode: "number",
    play_id: play.play_id,
    fixed_file: null,
    snapshot: null,
  };
}

// An edit as saved, with what a backup may lack filled in.
export function normalizeEdit(e: Partial<ClipEdit> & { edit_id: string }): ClipEdit {
  return migrateEdit({
    ...e,
    edit_id: e.edit_id,
    match_id: e.match_id ?? "",
    video_id: e.video_id ?? "v1",
    t_start: e.t_start ?? 0,
    t_end: e.t_end ?? 0,
    title: e.title ?? "Clip",
    freezes: e.freezes ?? [],
    annotations: e.annotations ?? [],
    label_mode: e.label_mode === "name" || e.label_mode === "none" ? e.label_mode : "number",
  });
}

// A clip saved before the studio dropped the box mark: a highlight whose shape is not one of today's (the old «box»)
// opens as the oval; the rest of the clip is left as it was. Returns the same object when there is nothing to change.
export function migrateEdit(e: ClipEdit): ClipEdit {
  const known = (v: unknown) => (HIGHLIGHT_SHAPES as readonly unknown[]).includes(v);
  const bad = (a: Annotation) => a.style.shape !== undefined && !known(a.style.shape);
  const defaultBad = e.highlight_shape !== undefined && !known(e.highlight_shape);
  if (!defaultBad && !e.annotations.some(bad)) return e;
  const next: ClipEdit = { ...e, annotations: e.annotations.map((a) => (bad(a) ? { ...a, style: { ...a.style, shape: "oval" } } : a)) };
  if (defaultBad) next.highlight_shape = "oval";
  return next;
}

// --------------------------------------------------------------------------------------------- calibration

// Calibration of a frame from the processed frames around it: the frame itself, the blend of the two around it when
// they are at most `maxGap` frames apart, or the nearest one within half of that. Null when there is none close.
// Each H is scaled to unit norm with a consistent sign before blending (an H is only defined up to scale).
export function homographyAt(hs: [number, number[] | null][], frame: number, maxGap: number): number[] | null {
  let a: [number, number[]] | null = null;
  let b: [number, number[]] | null = null;
  for (const [f, H] of hs) {
    if (!H) continue;
    if (f <= frame && (!a || f > a[0])) a = [f, H];
    if (f >= frame && (!b || f < b[0])) b = [f, H];
  }
  if (a && a[0] === frame) return a[1];
  if (a && b && b[0] - a[0] <= maxGap) {
    const na = unit(a[1]);
    let nb = unit(b[1]);
    if (na.reduce((s, v, i) => s + v * nb[i], 0) < 0) nb = nb.map((v) => -v);
    const w = (frame - a[0]) / (b[0] - a[0]);
    return na.map((v, i) => v * (1 - w) + nb[i] * w);
  }
  const near = [a, b].filter((x): x is [number, number[]] => x !== null).sort((x, y) => Math.abs(x[0] - frame) - Math.abs(y[0] - frame))[0];
  return near && Math.abs(near[0] - frame) <= maxGap / 2 ? near[1] : null;
}
const unit = (H: number[]) => {
  const n = Math.hypot(...H) || 1;
  return H.map((v) => v / n);
};

// Largest blend gap for a snapshot: two processed steps, and at least half a second.
export const hGap = (s: Pick<ClipSnapshot, "fps" | "stride">) => Math.max(2 * s.stride, Math.round(s.fps / 2));

// ------------------------------------------------------------------------------------------------- positions

// Positions of the people of a snapshot at video time t, by identity. Measured or marked-by-hand positions only; a
// hole shorter than MAX_HOLE_S (beyond the normal step between processed frames) is bridged, a longer one hides the
// player. Past the first or last position she is only placed within one step of it.
export function snapshotContext(s: Pick<ClipSnapshot, "fps" | "stride" | "tracks">): ResolveContext {
  const seen = new Map<string, [number, number, number][]>();
  for (const [id, rows] of Object.entries(s.tracks))
    seen.set(
      id,
      rows.filter((r) => isMeasuredSource(r[3])).map((r) => [r[0], r[1], r[2]] as [number, number, number]).sort((x, y) => x[0] - y[0]),
    );
  const step = s.stride / s.fps;
  return {
    positionOf: (identity, t) => {
      const rows = seen.get(String(identity));
      if (!rows?.length) return null;
      const f = t * s.fps;
      let i = 0;
      while (i < rows.length && rows[i][0] <= f) i++;
      const a = rows[i - 1];
      const b = rows[i];
      if (a && a[0] === f) return [a[1], a[2]];
      if (a && b) {
        const hole = (b[0] - a[0]) / s.fps - step;
        if (hole >= MAX_HOLE_S) return null;
        const w = (f - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
      }
      const end = a ?? b;
      return Math.abs(end[0] - f) / s.fps <= step ? [end[1], end[2]] : null;
    },
  };
}

// What a player is called on screen. number: her shirt number (from the squad), nothing if it is not known; name: her
// name, or the number if she has none; none: nothing. In number mode a name is never returned.
export function labelFor(identity: number | string, mode: LabelMode, s: Pick<ClipSnapshot, "people"> | null | undefined): string | null {
  if (mode === "none" || !s) return null;
  const p = s.people.find((x) => String(x.id) === String(identity));
  if (!p) return null;
  const number = p.number !== null && p.number !== undefined ? String(p.number) : null;
  return mode === "name" ? (p.player_id ?? number) : number;
}

// ------------------------------------------------------------------------------------------------- snapshot

// The part of the tracking an edit needs, for t_start..t_end (with one processed step of margin): the calibration of
// each processed frame and the positions of everyone seen. Numbers come from the squad by name.
export function buildSnapshot(
  fixed: FixedFile,
  calib: { image_w: number; image_h: number; stride: number; venue: { length_m: number; width_m: number }; homographies: [number, number[] | null][] },
  roster: RosterPlayer[],
  t_start: number,
  t_end: number,
): ClipSnapshot {
  const f0 = Math.floor(t_start * fixed.fps) - calib.stride;
  const f1 = Math.ceil(t_end * fixed.fps) + calib.stride;
  const tracks: ClipSnapshot["tracks"] = {};
  for (const fr of fixed.frames) {
    if (fr.frame < f0 || fr.frame > f1) continue;
    for (const q of fr.positions) (tracks[String(q.id)] ??= []).push([fr.frame, round3(q.x), round3(q.y), q.source]);
  }
  const ids = new Set(Object.keys(tracks));
  return {
    fps: fixed.fps,
    stride: calib.stride,
    image_w: calib.image_w,
    image_h: calib.image_h,
    venue: calib.venue,
    homographies: calib.homographies.filter(([f]) => f >= f0 && f <= f1),
    people: fixed.people
      .filter((p) => ids.has(String(p.id)))
      .map((p) => ({ id: p.id, team: p.team, player_id: p.player_id, number: roster.find((r) => r.player_id === p.player_id)?.number ?? null })),
    tracks,
  };
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// Name of the tracking file whose identities an edit uses.
export const fixedFileName = (f: Pick<FixedFile, "video_id" | "start_frame" | "end_frame" | "auto">) =>
  `${f.auto ? "tracks" : "tracks_fixed"}_${f.video_id}_${f.start_frame}_${f.end_frame}.json`;

// ----------------------------------------------------------------------------------------------- editing

// The person nearest to a click on the frame (pixels), among those placed at that moment, within `maxPx`.
export function personAt(click: Pt, placed: { id: number | string; px: Pt }[], maxPx: number): number | string | null {
  let best: number | string | null = null;
  let bestD = maxPx;
  for (const p of placed) {
    const d = Math.hypot(p.px[0] - click[0], p.px[1] - click[1]);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

// A drawing made while the video sits on a stop appears in that stop: it starts there and is added to its reveal list.
export function addToEdit(edit: ClipEdit, a: Annotation, now: number): ClipEdit {
  const stop = edit.freezes.find((f) => Math.abs(f.t - now) < 0.05);
  if (!stop) return { ...edit, annotations: [...edit.annotations, a] };
  return {
    ...edit,
    annotations: [...edit.annotations, { ...a, t_in: stop.t }],
    freezes: edit.freezes.map((f) => (f === stop ? { ...f, reveal: [...f.reveal, a.id] } : f)),
  };
}

export function removeFromEdit(edit: ClipEdit, id: string): ClipEdit {
  return {
    ...edit,
    annotations: edit.annotations.filter((a) => a.id !== id),
    freezes: edit.freezes.map((f) => ({ ...f, reveal: f.reveal.filter((r) => r !== id) })),
  };
}
