// Technical details of a match: the parameters that the possession (and so the report) is computed with, kept PER MATCH
// in Match.tech (only what the analyst changed; the rest are the defaults, so a better default reaches every match that
// did not touch it). Everything that reads possession (report, summary, analysis, Playground) takes its parameters from
// here, so changing one changes the report. Pure functions, no file access.
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
  const { tech: _old, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
  return Object.keys(possession).length === 0 ? rest : { ...rest, tech: { possession } };
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
