import { videoFileOf } from "./downloads.ts";
import { hasCorrections } from "./parts.ts";
import type { Segment } from "./segments.ts";
import { missingEnd, missingReview } from "./tagging.ts";
import type { MatchEvent, Play, TrackEdits } from "./types.ts";

// Where a match stands in each step of its analysis, for the bar of steps over its tabs. Pure functions.
//   done: nothing left · partial: started · todo: not started · optional: can be skipped (the analysis works with
//   tagged events only; calibration and tracking add positions).

export type StepState = "done" | "partial" | "todo" | "optional";
export interface StepStatus {
  state: StepState;
  text: string;
}
export type StepId = "calibration" | "segments" | "tracking" | "ball" | "tag" | "plays" | "board" | "analysis" | "report";

// What is in the folder of the match (app/api/local), when it can be read.
export interface FolderFiles {
  // File names in tracking/.
  tracking: string[];
  // File names in video/ (absent: not listed, so a missing video is not reported).
  video?: string[];
}

export interface StepInput {
  videoIds: string[];
  // Videos registered with a link (YouTube): the ones that must have a file in video/ (lib/downloads.ts).
  linked?: string[];
  folder?: string;
  venueId?: string;
  segmentsByVideo: Record<string, Segment[]>;
  events: MatchEvent[];
  plays: Play[];
  trackEdits: TrackEdits[];
  files: FolderFiles | null;
  // Plays on the board (the board is not tied to a match: all of them).
  boards?: number;
}

const fmtMin = (s: number) => `${Math.round(s / 60)} min`;
const of = (a: number, b: number) => `${a} de ${b}`;

export function matchSteps(i: StepInput): Record<StepId, StepStatus> {
  const play = (v: string) => (i.segmentsByVideo[v] ?? []).filter((s) => s.tipo === "juego" && s.end !== null);
  const stretches = i.videoIds.reduce((n, v) => n + play(v).length, 0);
  const playSeconds = i.videoIds.reduce((n, v) => n + play(v).reduce((t, s) => t + ((s.end as number) - s.start), 0), 0);
  const withPlay = i.videoIds.filter((v) => play(v).length > 0).length;
  const names = i.files?.tracking ?? [];
  const noFolder = !i.folder;
  // Registered videos whose file is not in the folder: calibration and tracking need the file, YouTube is not enough.
  const lacking = i.files?.video ? (i.linked ?? []).filter((v) => !videoFileOf(i.files?.video, v)) : [];
  const noVideo = (st: StepStatus): StepStatus => (lacking.length ? { ...st, text: `${st.text} · falta el video${lacking.length > 1 ? ` (${lacking.join(", ")})` : ""}` } : st);

  // Calibration: one library per video (built from a calibrated sweep).
  const libs = i.videoIds.filter((v) => names.includes(`library_${v}.npz`)).length;
  const calibration: StepStatus = noFolder
    ? { state: "optional", text: "falta la carpeta" }
    : !i.files
      ? { state: "optional", text: i.venueId ? "sede elegida" : "sin acceso a la carpeta" }
      : libs === i.videoIds.length
        ? { state: "done", text: `biblioteca ${of(libs, i.videoIds.length)}` }
        : { state: libs > 0 || i.venueId ? "partial" : "optional", text: `biblioteca ${of(libs, i.videoIds.length)}${i.venueId ? " · sede elegida" : ""}` };

  const segments: StepStatus =
    withPlay === i.videoIds.length && stretches > 0
      ? { state: "done", text: `${stretches} tramos · ${fmtMin(playSeconds)} de juego` }
      : stretches > 0
        ? { state: "partial", text: `${of(withPlay, i.videoIds.length)} videos · ${stretches} tramos` }
        : { state: "todo", text: "sin marcar" };

  // Tracking: processed parts against the stretches of play, and how many of them have corrections.
  const parts = names.filter((n) => /^tracks_v\d+_\d+_\d+\.json$/.test(n));
  const keys = new Set(parts.map((n) => n.replace(/^tracks_(v\d+)_(\d+)_(\d+)\.json$/, `${i.folder}|$1|$2_$3`)));
  const correctedKeys = i.trackEdits.filter((e) => keys.has(e.key) && hasCorrections(e)).map((e) => e.key);
  const corrected = correctedKeys.length;
  // Corrected in this browser but without its tracks_fixed file in the folder: the analysis and the report do not see
  // those corrections until the part is saved.
  const unsaved = correctedKeys.filter((k) => {
    const [, v, range] = k.split("|");
    return !names.includes(`tracks_fixed_${v}_${range}.json`);
  }).length;
  const tracking: StepStatus = noFolder || !i.files
    ? { state: "optional", text: noFolder ? "falta la carpeta" : "sin acceso a la carpeta" }
    : parts.length === 0
      ? { state: "optional", text: "sin procesar" }
      : {
          state: corrected === parts.length && unsaved === 0 ? "done" : "partial",
          text: `${parts.length} parte(s)${stretches ? ` de ${stretches} tramos` : ""} · ${corrected} corregida(s)${unsaved ? ` · ${unsaved} sin guardar` : ""}`,
        };

  // Ball: processed parts with the ball marked by hand (in the correction table).
  const withBall = i.trackEdits.filter((e) => keys.has(e.key) && ((e.ball?.length ?? 0) > 0 || (e.ballReview?.seen.length ?? 0) > 0)).length;
  const ball: StepStatus =
    parts.length === 0
      ? { state: "optional", text: "necesita tracking" }
      : { state: withBall === parts.length ? "done" : withBall > 0 ? "partial" : "todo", text: `${of(withBall, parts.length)} partes con balón` };

  const toReview = i.events.filter((e) => missingReview(e).length > 0).length;
  const withEnd = i.events.filter((e) => missingEnd(e) !== null);
  const toEnd = withEnd.filter((e) => missingEnd(e)).length;
  const tag: StepStatus =
    i.events.length === 0
      ? { state: "todo", text: "sin eventos" }
      : {
          state: toReview === 0 && toEnd === 0 ? "done" : "partial",
          text: `${i.events.length} eventos · ${toReview} por revisar${withEnd.length ? ` · ${toEnd} sin destino` : ""}`,
        };

  const animated = i.plays.filter((p) => p.keyframes.length > 0).length;
  const plays: StepStatus =
    i.plays.length === 0
      ? { state: "optional", text: "ninguna marcada" }
      : { state: animated === i.plays.length ? "done" : "partial", text: `${of(animated, i.plays.length)} animadas` };

  const board: StepStatus = i.boards ? { state: "done", text: `${i.boards} jugada(s)` } : { state: "optional", text: "sin jugadas" };

  const metrics = i.videoIds.filter((v) => names.includes(`team_metrics_${v}.json`)).length;
  const analysis: StepStatus =
    i.events.length === 0
      ? { state: "todo", text: "necesita eventos" }
      : { state: "done", text: metrics ? "con forma del equipo" : "con eventos" };
  const report: StepStatus = i.events.length === 0 ? { state: "todo", text: "necesita eventos" } : { state: "done", text: "listo para imprimir" };

  return { calibration: noVideo(calibration), segments, tracking: noVideo(tracking), ball, tag, plays, board, analysis, report };
}
