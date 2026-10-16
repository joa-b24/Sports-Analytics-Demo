import { droppedSet, identityOf, isDropped, people, type JerseyColors, type TeamCode, type TracksFile } from "./tracks.ts";
import type { TrackEdits } from "./types.ts";

// The corrections of a part as labels: for every original box (frame, track), whose it is after the edits. With
// them, sportsan.tracking.evaluate measures how much work a way of joining tracks would leave, and the labels keep
// meaning the same if the part is processed again, because the key is the original box, not an identity.
// Players' names never leave the browser here: only whether a person was named. Pure functions.

export type BoxStatus = "player" | "dropped" | "removed";

export interface LabelsFile {
  schema_version: 1;
  kind: "tracks_labels";
  match_id: string;
  video_id: string;
  fps: number;
  stride: number;
  start_frame: number;
  end_frame: number;
  source: { schema_version: number | null; tracker: string | null; assoc: string | null };
  exported_at: string;
  // Every box of the file, the discarded ones too. `track` is the original column 0, never the identity.
  frames: { frame: number; boxes: { track: number; label: number | null; status: BoxStatus }[] }[];
  manual: { label: number; frame: number; px: number; py: number }[];
  // Only the people marked as reviewed count as truth when measuring.
  people: { label: number; team: TeamCode; reviewed: boolean; named: boolean }[];
  // Pairs rejected as "the same person" in the correction table: negative examples.
  rejected: [number, number][];
  // The edits as they are, to rebuild everything (names taken out).
  edits: Omit<TrackEdits, "people"> & { people: Record<string, { team?: string; done?: boolean; named?: boolean }> };
}

export const labelsName = (f: Pick<TracksFile, "video_id" | "start_frame" | "end_frame">) => `labels_${f.video_id}_${f.start_frame}_${f.end_frame}.json`;

export function buildLabels(file: TracksFile, edits: TrackEdits, colors?: Partial<JerseyColors>, now: Date = new Date()): LabelsFile {
  const removed = new Set(edits.removed);
  const drop = droppedSet(edits);
  const frames = file.frames.map((fr) => ({
    frame: fr.frame,
    boxes: fr.boxes.map((b) => {
      if (isDropped(drop, b, fr.frame)) return { track: b[0], label: null, status: "dropped" as const };
      const label = identityOf(b, fr.frame, edits);
      return { track: b[0], label, status: removed.has(label) ? ("removed" as const) : ("player" as const) };
    }),
  }));
  const ppl = people(file, edits, colors).map((p) => ({ label: p.id, team: p.team, reviewed: p.done, named: p.player_id.trim() !== "" }));
  const safePeople: LabelsFile["edits"]["people"] = {};
  for (const [id, meta] of Object.entries(edits.people)) {
    safePeople[id] = { ...(meta.team ? { team: meta.team } : {}), ...(meta.done ? { done: true } : {}), named: !!meta.player_id?.trim() };
  }
  const meta = file as TracksFile & { schema_version?: number; tracker?: string; assoc?: { method?: string } | null };
  return {
    schema_version: 1,
    kind: "tracks_labels",
    match_id: file.match_id,
    video_id: file.video_id,
    fps: file.fps,
    stride: file.stride,
    start_frame: file.start_frame,
    end_frame: file.end_frame,
    source: { schema_version: meta.schema_version ?? null, tracker: meta.tracker ?? null, assoc: meta.assoc?.method ?? null },
    exported_at: now.toISOString(),
    frames,
    manual: edits.manual.map((m) => ({ label: edits.identity[`i${m.identity}`] ?? m.identity, frame: m.frame, px: m.px, py: m.py })),
    people: ppl,
    rejected: (edits.rejected ?? []).map(([a, b]) => [a, b] as [number, number]),
    edits: { ...edits, people: safePeople },
  };
}
