// Mirror of docs/data_contract.md (events) plus the web-only tables (matches, plays, sessions).

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
};

// Keyboard shortcut for each event type in the tagging tool.
export const EVENT_KEYS: Record<EventType, string> = {
  shot: "1",
  goal: "2",
  loss: "3",
  recovery: "4",
  foul: "5",
  corner: "6",
  free_kick: "7",
  throw_in: "8",
  penalty: "9",
  key_pass: "0",
  other: "-",
  final_third_entry: "t",
  box_entry: "r",
  goal_kick: "g",
  cross: "c",
};

// Second datum of an event, by type. Same values as EVENT_OUTCOMES / EVENT_DETAILS in schema.py.
// Both are optional: empty means "not noted", never "did not happen".
export const EVENT_OUTCOMES: Partial<Record<EventType, Record<string, string>>> = {
  shot: { on_target: "A puerta", off_target: "Fuera", blocked: "Bloqueado" },
  corner: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  free_kick: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  cross: { shot: "Remate", cleared: "Despeje", play_on: "Sigue la jugada" },
  goal_kick: { kept: "La conservan", lost: "La pierden" },
};
export const EVENT_DETAILS: Partial<Record<EventType, Record<string, string>>> = {
  corner: { inswing: "Cerrado", outswing: "Abierto", short: "En corto" },
  goal_kick: { short: "En corto", long: "En largo" },
  recovery: { forward: "Pase adelante", backward: "Pase atrás" },
};
export const DETAIL_TITLES: Partial<Record<EventType, string>> = {
  corner: "Envío",
  goal_kick: "Salida",
  recovery: "Primer pase",
};
// Keys for the options of the last tagged event, in order.
export const OUTCOME_KEYS = ["z", "x", "v"];
export const DETAIL_KEYS = ["b", "n", "m"];

export type MatchKind = "rival" | "own";

export interface Report {
  resumen: string;
  fortalezas: string;
  debilidades: string;
  balon_parado: string;
  jugadoras_clave: string;
  plan: string;
}

export const EMPTY_REPORT: Report = {
  resumen: "",
  fortalezas: "",
  debilidades: "",
  balon_parado: "",
  jugadoras_clave: "",
  plan: "",
};

// One video of a match. Times in events, plays and segment marks are times inside their own video.
export interface MatchVideo {
  video_id: string;
  youtube_id: string;
  label: string;
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

export interface State {
  matches: Match[];
  events: MatchEvent[];
  plays: Play[];
  sessions: SessionRow[];
  anchors: CalibAnchor[];
  segments: SegmentMark[];
  venues: VenueSpec[];
}

export const PITCH = { length: 105, width: 68 };
