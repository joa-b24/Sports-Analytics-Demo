// Technical details of a match: the parameters that the possession (and so the report) is computed with, kept PER MATCH
// in Match.tech (only what the analyst changed; the rest are the defaults, so a better default reaches every match that
// did not touch it). Everything that reads possession (report, summary, analysis, Playground) takes its parameters from
// here, so changing one changes the report. Pure functions, no file access.
import { DETECTED_TYPES, EVENT_DEFAULTS, type DetectedType, type EventParams } from "./eventDetect.ts";
import { EVENT_PARAM_FIELDS } from "./eventReview.ts";
import { PARAM_FIELDS, type ParamField } from "./playgroundPossession.ts";
import { POSSESSION_DEFAULTS, type PossessionParams } from "./possession.ts";
import type { Match } from "./types.ts";

type TechHolder = Pick<Match, "tech"> | null | undefined;

// The groups of the panel, in order. Each field of PARAM_FIELDS belongs to one.
export interface TechGroup {
  id: "control" | "ball" | "contest";
  title: string;
  help: string;
  keys: (keyof PossessionParams)[];
}
export const TECH_GROUPS: TechGroup[] = [
  {
    id: "control",
    title: "Posesión: toque y control",
    help: "Cuándo una jugadora toca el balón y cuándo ese toque cuenta como control de su equipo.",
    keys: ["controlM", "controlS", "maxCtrlSpeedMs", "gapS", "holdS"],
  },
  {
    id: "ball",
    title: "Balón: pausas y vuelos",
    help: "Cómo se reconoce un balón parado, una reanudación o un vuelo largo.",
    keys: ["restFlightMinMs", "restGapS", "stillRadiusM", "stillS", "restSpeedMs", "restS", "joinCutMaxM"],
  },
  {
    id: "contest",
    title: "Posesión: disputa",
    help: "Qué pasa cuando dos equipos están igual de cerca del balón.",
    keys: ["contestMarginM", "contestedHoldS"],
  },
];

// The parameters in force for a match: defaults with what the analyst changed over them (unknown or ill-typed keys and
// values out of the limits of their field are ignored, so an old or hand-edited backup cannot break the report).
export function possessionParamsOf(m: TechHolder): PossessionParams {
  const set = m?.tech?.possession;
  if (!set) return POSSESSION_DEFAULTS;
  const out: PossessionParams = { ...POSSESSION_DEFAULTS };
  for (const f of PARAM_FIELDS) {
    const v = set[f.key];
    if (typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max) Object.assign(out, { [f.key]: v });
  }
  if (typeof set.joinSegments === "boolean") out.joinSegments = set.joinSegments;
  return out;
}

// Only what differs from the defaults (what is stored).
export function diffFromDefaults(p: PossessionParams): Partial<Record<string, number | boolean>> {
  const out: Partial<Record<string, number | boolean>> = {};
  for (const k of Object.keys(POSSESSION_DEFAULTS) as (keyof PossessionParams)[]) if (p[k] !== POSSESSION_DEFAULTS[k]) out[k] = p[k];
  return out;
}

// The match with one parameter changed (a value equal to the default is dropped; with nothing left, `tech` goes away).
export function withTechParam(m: Match, key: keyof PossessionParams, value: number | boolean): Match {
  const next = diffFromDefaults({ ...possessionParamsOf(m), [key]: value });
  return withPossessionTech(m, next);
}
export const resetTech = (m: Match): Match => withPossessionTech(m, {});
function withPossessionTech(m: Match, possession: Partial<Record<string, number | boolean>>): Match {
  return withTech(m, { possession: Object.keys(possession).length ? possession : undefined });
}
// The match with some parts of `tech` replaced (undefined removes that part); with nothing left, `tech` goes away.
export function withTech(m: Match, patch: Partial<NonNullable<Match["tech"]>>): Match {
  const { tech: old, ...rest } = m;
  const next: NonNullable<Match["tech"]> = { ...old, ...patch };
  for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
  return Object.keys(next).length === 0 ? rest : { ...rest, tech: next };
}

// ------------------------------------------------------------------------------------------------- detected events
// Parameters of the event detectors (lib/eventDetect.ts), grouped «Eventos» in the panel; same rules as the possession's.
export const EVENT_TECH_GROUP = { id: "events", title: "Eventos", help: "Reglas con las que se detectan saques, faltas, pérdidas, entradas y centros desde las posiciones." } as const;
export function eventParamsOf(m: TechHolder): EventParams {
  const set = m?.tech?.events;
  const out: EventParams = { ...EVENT_DEFAULTS };
  if (!set) return out;
  for (const f of EVENT_PARAM_FIELDS) {
    const v = set[f.key];
    if (typeof v === "number" && Number.isFinite(v) && v >= f.min && v <= f.max) Object.assign(out, { [f.key]: v });
  }
  if (typeof set.crossInteriorOutsideBox === "boolean") out.crossInteriorOutsideBox = set.crossInteriorOutsideBox;
  return out;
}
export function eventDiff(p: EventParams): Partial<Record<string, number | boolean>> {
  const out: Partial<Record<string, number | boolean>> = {};
  for (const k of Object.keys(EVENT_DEFAULTS) as (keyof EventParams)[]) if (p[k] !== EVENT_DEFAULTS[k]) out[k] = p[k];
  return out;
}
export function withEventParam(m: Match, key: keyof EventParams, value: number | boolean): Match {
  const d = eventDiff({ ...eventParamsOf(m), [key]: value });
  return withTech(m, { events: Object.keys(d).length ? d : undefined });
}
export const resetEventTech = (m: Match): Match => withTech(m, { events: undefined });
export const eventTechChanged = (m: TechHolder): string[] => Object.keys(eventDiff(eventParamsOf(m)));

// Types of event whose detection the analyst accepted: from then on the detections of that type are created by themselves
// as accepted suggestions, labelled «automático». Only the list and the field live here.
export const AUTO_EVENT_LABEL = "Automático";
export const autoEventsOf = (m: TechHolder): DetectedType[] => (m?.tech?.autoEvents ?? []).filter((t): t is DetectedType => DETECTED_TYPES.includes(t as DetectedType));
export const isAutoEvent = (m: TechHolder, type: DetectedType) => autoEventsOf(m).includes(type);
export function withAutoEvent(m: Match, type: DetectedType, on: boolean): Match {
  const cur = autoEventsOf(m).filter((t) => t !== type);
  const next = on ? [...cur, type] : cur;
  return withTech(m, { autoEvents: next.length ? DETECTED_TYPES.filter((t) => next.includes(t)) : undefined });
}

export const techChanged = (m: TechHolder): string[] => Object.keys(diffFromDefaults(possessionParamsOf(m)));
export const fieldOf = (key: keyof PossessionParams): ParamField | undefined => PARAM_FIELDS.find((f) => f.key === key);

// One line for a header or a log: «distancia de control 2,5 m, ...» or the sentence for the defaults.
export function techSummary(m: TechHolder): string {
  const p = possessionParamsOf(m);
  const parts = techChanged(m).map((k) => {
    if (k === "joinSegments") return `unir tramos ${p.joinSegments ? "sí" : "no"}`;
    const f = fieldOf(k as keyof PossessionParams);
    return f ? `${f.label.toLowerCase()} ${p[f.key]} ${f.unit}` : k;
  });
  return parts.length === 0 ? "Parámetros por defecto" : `Parámetros cambiados: ${parts.join(", ")}`;
}
