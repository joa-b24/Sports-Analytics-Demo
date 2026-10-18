// Mirror of docs/data_contract.md (events) plus the web-only tables (matches, plays, sessions, boards).
import type { Annotation, ClipEdit } from "./annotations.ts";

export type Team = "own" | "opp" | "ref" | "unk";

export const EVENT_TYPES = [
  "shot",
  "goal",
  "loss",
  "recovery",
  "foul",
  "corner",
  "free_kick",
  "throw_in",
  "penalty",
  "key_pass",
  "other",
  // Extended catalogue (docs/preguntas_cuerpo_tecnico.md).
  "final_third_entry",
  "box_entry",
  "goal_kick",
  "cross",
  // Optional (2026-10-17): only tagged in the matches where the duels map is wanted.
  "duel",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<EventType, string> = {
  shot: "Tiro",
  goal: "Gol",
  loss: "Pérdida",
  recovery: "Recuperación",
  foul: "Falta",
  corner: "Córner",
  free_kick: "Tiro libre",
  throw_in: "Saque de banda",
  penalty: "Penal",
  key_pass: "Pase clave",
  other: "Otro",
  final_third_entry: "Entrada al último tercio",
  box_entry: "Entrada al área",
  goal_kick: "Saque de meta",
  cross: "Centro",
  duel: "Duelo",
};

// Keyboard shortcut for each event type in the tagging tool: a letter that recalls its Spanish name.
// "a" and "s" are taken (they choose the team). Keys are compared in lower case.
export const EVENT_KEYS: Record<EventType, string> = {
  shot: "t",
  goal: "g",
  loss: "x",
  recovery: "r",
  foul: "f",
  corner: "e",
  free_kick: "l",
  throw_in: "b",
  penalty: "p",
  key_pass: "k",
  other: "o",
  final_third_entry: "u",
  box_entry: "i",
  goal_kick: "m",
  cross: "c",
  duel: "d",
};

// Second datum of an event, by type. Same values as EVENT_OUTCOMES / EVENT_DETAILS in schema.py.
// Both are optional: empty means "not noted", never "did not happen".
export const EVENT_OUTCOMES: Partial<Record<EventType, Record<string, string>>> = {
  shot: { on_target: "A puerta", off_target: "Fuera", blocked: "Bloqueado" },
  corner: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  free_kick: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  cross: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  goal_kick: { kept: "La conservan", lost: "La pierden" },
  duel: { won: "Ganado", lost: "Perdido" },
};
export const EVENT_DETAILS: Partial<Record<EventType, Record<string, string>>> = {
  corner: { inswing: "Cerrado", outswing: "Abierto", short: "En corto" },
  goal_kick: { short: "En corto", long: "En largo" },
  recovery: { forward: "Pase adelante", backward: "Pase atrás" },
  duel: { aerial: "Aéreo", ground: "En el suelo" },
};
export const DETAIL_TITLES: Partial<Record<EventType, string>> = {
  corner: "Envío",
  goal_kick: "Salida",
  recovery: "Primer pase",
  duel: "Tipo",
};
// Keys for the options of the last tagged event, in order.
export const OUTCOME_KEYS = ["1", "2", "3"];
export const DETAIL_KEYS = ["7", "8", "9"];

// Event types with an end position, and which kind (same as END_TYPES / GOAL_TYPES in schema.py).
export const END_TYPES: readonly EventType[] = ["cross", "corner"];
export const GOAL_TYPES: readonly EventType[] = ["shot", "goal", "free_kick", "penalty"];
export const GOAL = { width: 7.32, height: 2.44 };

// own: a match of our team. rival: a match of a team we are going to play. reference: any other video worth studying
// (a style the coach wants to copy, for instance); it is analysed the same way.
export type MatchKind = "rival" | "own" | "reference";

// A result of the analysed team in a match that is not in the app, written by hand in the report.
export interface ManualResult {
  date: string; // aaaa-mm-dd
  opponent: string;
  home: boolean;
  goals_for: number;
  goals_against: number;
  competition: string;
}

// Texts and choices of the analyst for the report. The fields after `plan` came later (2026-10-17) and are optional:
// reports saved before them open with their defaults (normalizeReport in lib/report.ts).
export interface Report {
  resumen: string;
  fortalezas: string;
  debilidades: string;
  balon_parado: string;
  jugadoras_clave: string;
  plan: string;
  // Match conclusions: in a report of our own match it takes the place of the match plan.
  conclusiones?: string;
  // Matchday of the competition ("Jornada 2"), free text.
  jornada?: string;
  // Results of the analysed team in matches that are not in the app.
  results_manual?: ManualResult[];
  // The table of touches by player goes into the printout only when the analyst says so.
  print_touches?: boolean;
}

export const EMPTY_REPORT: Report = {
  resumen: "",
  fortalezas: "",
  debilidades: "",
  balon_parado: "",
  jugadoras_clave: "",
  plan: "",
  conclusiones: "",
  jornada: "",
  results_manual: [],
  print_touches: false,
};

// One video of a match. Times in events, plays and segment marks are times inside their own video.
export interface MatchVideo {
  video_id: string;
  youtube_id: string;
  label: string;
  // Half of the match this video belongs to (a half can come in several videos). Absent = first video 1, others 2.
  period?: 1 | 2;
}

export interface Match {
  match_id: string;
  name: string;
  kind: MatchKind;
  date: string;
  // `own` events belong to focus_team (in a scouting match, the rival being studied).
  focus_team: string;
  other_team: string;
  // Link of the first video. Kept in step with videos[0] for matches that have the list.
  youtube_id: string;
  // Absent in matches saved before a match could have several videos: then there is one, "v1".
  videos?: MatchVideo[];
  // Name of its folder in matches/ (where the video, the calibration and the tracking live). Absent = none yet.
  folder?: string;
  // Venue of the match (lib/venue.ts), chosen in its calibration.
  venue_id?: string;
  report: Report;
  is_demo?: boolean;
}

export interface MatchEvent {
  event_id: string;
  match_id: string;
  // Which video of the match t_video refers to. Absent = "v1".
  video_id?: string;
  t_video: number;
  period: 1 | 2;
  type: EventType;
  team: Team;
  player_id: string | null;
  x: number | null;
  y: number | null;
  outcome: string | null;
  // Missing in events tagged before the extended catalogue.
  detail?: string | null;
  note: string | null;
  // Where it ended (third tagging pass). Crosses and corners: where the ball landed, on the pitch.
  x_end?: number | null;
  y_end?: number | null;
  // Shots: where the ball crossed the goal line seen from the shooter, meters from the left post and height.
  goal_y?: number | null;
  goal_z?: number | null;
}

export interface Keyframe {
  t: number; // t_video
  pos: Record<string, [number, number]>; // token id -> meters
}

export interface Play {
  play_id: string;
  match_id: string;
  video_id?: string;
  title: string;
  t_start: number;
  t_end: number;
  note: string;
  keyframes: Keyframe[];
  // A set piece (ABP): the report lists it under set pieces. Absent = no.
  abp?: boolean;
}

// Kinds of board plays, each for or against us.
export const BOARD_CATEGORIES = ["corner", "free_kick", "throw_in", "build_up", "other"] as const;
export type BoardCategory = (typeof BOARD_CATEGORIES)[number];
export const BOARD_CATEGORY_LABELS: Record<BoardCategory, string> = {
  corner: "Córner",
  free_kick: "Tiro libre",
  throw_in: "Saque de banda",
  build_up: "Salida de balón",
  other: "Otra",
};
export type BoardSide = "for" | "against";
export const BOARD_SIDE_LABELS: Record<BoardSide, string> = { for: "A favor", against: "En contra" };

// What part of the pitch a board shows: all of it or one half (a set piece is seen better close up).
export type BoardFraming = "full" | "right" | "left";
export const BOARD_FRAMING_LABELS: Record<BoardFraming, string> = { full: "Cancha entera", right: "Mitad derecha", left: "Mitad izquierda" };

// A piece of the board: a player (with shirt number or role) or the ball.
export interface BoardToken {
  id: string;
  team: "own" | "opp" | "ball";
  label: string;
}

// A step of a board play: positions at time t (seconds from the start of the board) and a short note for its sheet.
export interface BoardStep extends Keyframe {
  note?: string;
}

// A play on the board (lib/boards.ts). Without match_id it is a designed set piece; with it, it came from a play of
// that match ("Pasar al pizarrón"), which is left as it was.
export interface Board {
  board_id: string;
  title: string;
  category: BoardCategory;
  side: BoardSide;
  notes: string;
  tokens: BoardToken[];
  keyframes: BoardStep[];
  // Drawings anchored to tokens (`player` with the token id) or to points of the pitch.
  annotations: Annotation[];
  // Absent = the whole pitch.
  framing?: BoardFraming;
  match_id?: string;
  play_id?: string;
}

export interface SessionRow {
  date: string;
  session_id: string;
  player_id: string;
  metrics: Record<string, number | null>;
  is_demo?: boolean;
}

// One reference point clicked on a video frame: a venue landmark and where it is in the image.
export interface AnchorPoint {
  landmark_id: string;
  px: number;
  py: number;
}

// Manual calibration of one frame. The homography is not stored: it is recomputed from the points.
export interface CalibAnchor {
  anchor_id: string;
  match_id: string;
  video_id: string;
  venue_id: string;
  frame: number;
  t_video: number;
  image_w: number;
  image_h: number;
  points: AnchorPoint[];
}

// Same values as the `tipo` column of segments.csv in the data contract.
export const SEGMENT_KINDS = ["juego", "pausa", "no_medible"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  juego: "Juego",
  pausa: "Pausa",
  no_medible: "No medible",
};

// A cut on the video timeline: from here on the video is `tipo`, until the next mark. "fin" closes the last stretch.
// segments.csv is derived from the marks (lib/segments.ts); the original video is never trimmed.
export interface SegmentMark {
  mark_id: string;
  match_id: string;
  video_id?: string;
  t_video: number;
  tipo: SegmentKind | "fin";
}

// Parameters of a venue edited in the app. The reference model (landmarks and lines) is built from them in lib/venue.ts.
export interface VenueSpec {
  venue_id: string;
  name: string;
  // "soccer": only soccer markings. "football_overlay": soccer markings painted over an American football grid.
  kind: "soccer" | "football_overlay";
  length_m: number;
  width_m: number;
  // Distance from each sideline of the football field to its hash marks (far side / side near the camera).
  hash_far_m?: number;
  hash_near_m?: number;
  // Centre of the football field relative to the centre of the soccer pitch.
  grid_dx_m?: number;
  grid_dy_m?: number;
  // Paint colours, used in the venue diagrams.
  soccer_color: string;
  grid_color: string;
}

// The person's corrections to the automatic tracks of one processed part (lib/tracks.ts). The file with the
// detections is never changed: these edits are applied on top of it.
export interface TrackEdits {
  // `${match_id}|${video_id}|${start_frame}_${end_frame}` of the tracks file.
  key: string;
  // "<track>" -> identity of a raw track; "i<identity>" -> identity it was merged into.
  identity: Record<string, number>;
  // By identity: team set by hand, name or shirt number, and whether the person is already reviewed.
  people: Record<string, { team?: Team; player_id?: string; done?: boolean }>;
  // Identities that are not players (a ball boy, a false detection).
  removed: number[];
  // From `frame` on, `track` is the new `identity`.
  splits: { track: number; frame: number; identity: number }[];
  // Feet position marked by hand (pixels) where the detector lost the person.
  manual: { identity: number; frame: number; px: number; py: number }[];
  // Single boxes left out: the second box of a player who was detected twice in that frame. Absent in older edits.
  dropped?: { track: number; frame: number }[];
  // Ball marked by hand on the video (pixels), one per frame. Absent in older edits.
  ball?: { frame: number; px: number; py: number }[];
  // Two ball marks joined by a straight line whatever the time between them: a long pass or a ball in the air, marked
  // only where it leaves and where it lands.
  ballLinks?: { from: number; to: number }[];
  // Pairs of identities rejected as "the same person" (suggestions declined in the table). Absent in older edits.
  rejected?: [number, number][];
  // Quick review (lib/quick.ts): names given on sample frames, and the samples already gone through.
  quick?: { labels: { frame: number; track: number; name: string; team?: "own" | "opp" }[]; seen: number[]; done?: string[] };
  // Ball review by samples: every how many seconds, and the sample frames already gone through (ball marked or not seen).
  ballReview?: { every: number; seen: number[] };
}

// A pass tagged by hand (pass 4 of the tagging): who to whom. to_id is null when it did not reach a teammate.
export interface PassRow {
  pass_id: string;
  match_id: string;
  video_id: string;
  t_video: number;
  period: 1 | 2;
  team: "own" | "opp";
  from_id: string;
  to_id: string | null;
  outcome: "complete" | "incomplete";
}

// A player of our squad. player_id is the name used everywhere (events, tracks, sessions); the number can change.
export interface RosterPlayer {
  player_id: string;
  number: number | null;
}

export interface State {
  matches: Match[];
  events: MatchEvent[];
  plays: Play[];
  sessions: SessionRow[];
  anchors: CalibAnchor[];
  segments: SegmentMark[];
  venues: VenueSpec[];
  trackEdits: TrackEdits[];
  // Our squad. Absent in backups made before it existed.
  roster: RosterPlayer[];
  // Passes tagged by hand. Absent in backups made before they existed.
  passes: PassRow[];
  // Board plays. Absent in backups made before the board existed.
  boards: Board[];
  // Drawings over the video of a play (lib/clips.ts). Absent in backups made before they existed.
  edits: ClipEdit[];
  // Shirt colours by match_id of the match folder, as #rrggbb.
  jerseys: Record<string, { own: string; opp: string; ref: string; own_gk?: string; opp_gk?: string }>;
}

export const PITCH = { length: 105, width: 68 };
