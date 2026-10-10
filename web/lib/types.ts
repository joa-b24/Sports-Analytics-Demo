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
};

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

export interface Match {
  match_id: string;
  name: string;
  kind: MatchKind;
  date: string;
  // `own` events belong to focus_team (in a scouting match, the rival being studied).
  focus_team: string;
  other_team: string;
  youtube_id: string;
  report: Report;
  is_demo?: boolean;
}

export interface MatchEvent {
  event_id: string;
  match_id: string;
  t_video: number;
  period: 1 | 2;
  type: EventType;
  team: Team;
  player_id: string | null;
  x: number | null;
  y: number | null;
  outcome: string | null;
  note: string | null;
}

export interface Keyframe {
  t: number; // t_video
  pos: Record<string, [number, number]>; // token id -> meters
}

export interface Play {
  play_id: string;
  match_id: string;
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

export interface State {
  matches: Match[];
  events: MatchEvent[];
  plays: Play[];
  sessions: SessionRow[];
  anchors: CalibAnchor[];
}

export const PITCH = { length: 105, width: 68 };
