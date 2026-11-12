// What a clip needs from the tracking of its stretch, read from the match folder and cut into the copy that travels with the
// edit (`ClipEdit.snapshot`): the calibration of the processed frames and the positions of the people. The editor reads it live
// from the folder on this computer (components/clip/useClipData.ts); this module also builds it without the screen, so that every
// clip of a match can be prepared at once and then edited where the tracking files are not (the web build: laptop or tablet).
import type { ClipEdit, ClipSnapshot } from "./annotations.ts";
import { buildSnapshot, fixedFileName } from "./clips.ts";
import { loadFixedParts } from "./fixed.ts";
import { listLocal, readLocal, tracksParts } from "./local.ts";
import type { FixedFile } from "./positions.ts";
import type { TracksFile } from "./tracks.ts";
import type { Match, RosterPlayer } from "./types.ts";

export type Calib = { image_w: number; image_h: number; stride: number; fps: number; venue: { length_m: number; width_m: number } | null; homographies: [number, number[] | null][] };

// Calibration of the processed frames of a clip, read from the tracks_<video>_*.json parts it overlaps. A part is read once per
// session (they are large and never change).
const calibCache = new Map<string, Calib>();

export async function loadClipCalib(folder: string, videoId: string, t0: number, t1: number): Promise<Calib | null> {
  const dir = `matches/${folder}/tracking`;
  const names = tracksParts(await listLocal(dir), videoId);
  const parts: Calib[] = [];
  // The frame rate is known after the first part read; from then on, parts outside the clip are not read.
  let fps: number | null = null;
  for (const n of names) {
    const m = n.match(/_(\d+)_(\d+)\.json$/);
    if (!m) continue;
    if (fps && (Number(m[1]) > t1 * fps || Number(m[2]) < t0 * fps)) continue;
    const path = `${dir}/${n}`;
    let c = calibCache.get(path);
    if (!c) {
      try {
        const t = JSON.parse((await readLocal(path)) ?? "null") as TracksFile | null;
        if (!t?.frames) continue;
        c = {
          image_w: t.image_w,
          image_h: t.image_h,
          stride: t.stride,
          fps: t.fps,
          venue: t.venue?.length_m && t.venue?.width_m ? { length_m: t.venue.length_m, width_m: t.venue.width_m } : null,
          homographies: t.frames.map((f) => [f.frame, f.H ?? null]),
        };
        calibCache.set(path, c);
      } catch {
        continue;
      }
    }
    fps = c.fps;
    if (Number(m[1]) <= t1 * c.fps && Number(m[2]) >= t0 * c.fps) parts.push(c);
  }
  if (!parts.length) return null;
  return { ...parts[0], venue: parts.find((p) => p.venue)?.venue ?? null, homographies: parts.flatMap((p) => p.homographies).sort((a, b) => a[0] - b[0]) };
}

// The tracking part with most of the clip in it: corrected where there is one, otherwise the processed part.
export function pickClipFile(files: FixedFile[], edit: Pick<ClipEdit, "video_id" | "t_start" | "t_end">): FixedFile | null {
  const cover = (f: FixedFile) => Math.min(f.end_frame, edit.t_end * f.fps) - Math.max(f.start_frame, edit.t_start * f.fps);
  return files.filter((f) => f.video_id === edit.video_id && cover(f) > 0).sort((a, b) => Number(!!a.auto) - Number(!!b.auto) || cover(b) - cover(a))[0] ?? null;
}

export function snapshotOf(file: FixedFile | null, calib: Calib | null, edit: Pick<ClipEdit, "match_id" | "video_id" | "t_start" | "t_end">, roster: RosterPlayer[]): ClipSnapshot | null {
  if (!calib) return null;
  const venue = calib.venue ?? file?.venue ?? null;
  if (!venue) return null;
  const base: FixedFile = file ?? { kind: "tracks_fixed", match_id: edit.match_id, video_id: edit.video_id, fps: calib.fps, start_frame: 0, end_frame: 0, stride: calib.stride, people: [], ball: [], frames: [] };
  return buildSnapshot(base, { ...calib, venue }, roster, edit.t_start, edit.t_end);
}

// The snapshot of one clip read from the folder, without a screen: null when the folder has no calibration for that stretch.
export async function clipSnapshotFor(match: Match, edit: ClipEdit, roster: RosterPlayer[]): Promise<{ snapshot: ClipSnapshot; fixedFile: string | null } | null> {
  if (!match.folder) return null;
  const fixed = await loadFixedParts(match.folder, [edit.video_id]);
  const file = pickClipFile([...fixed.parts.map((p) => p.file), ...fixed.unoriented], edit);
  const calib = await loadClipCalib(match.folder, edit.video_id, edit.t_start, edit.t_end);
  const snapshot = snapshotOf(file, calib, edit, roster);
  return snapshot ? { snapshot, fixedFile: file ? fixedFileName(file) : null } : null;
}
