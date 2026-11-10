// The sections of the report: what each one shows, what it needs, and the default layout. The analyst chooses which
// to show and in what order (Report.sections); a section without its data hides itself anyway, so a match tagged by
// hand only shows what events can say. Sections after «General» describe one team at a time (Report.focus).

export type SectionNeed = "events" | "ball" | "tracking" | "names" | "dev";
export interface SectionDef {
  id: string;
  title: string;
  needs: SectionNeed;
  // True for the ones that compare both teams side by side (they ignore the focus).
  both?: boolean;
  // True for sections that cannot be computed yet: they stay in the library, locked, with their reason.
  locked?: string;
}

export const REPORT_SECTIONS: SectionDef[] = [
  { id: "general", title: "General", needs: "events", both: true },
  { id: "block", title: "Bloque", needs: "tracking" },
  { id: "transitions", title: "Transiciones", needs: "events" },
  { id: "shots", title: "Tiros", needs: "events" },
  { id: "crosses", title: "Centros", needs: "events" },
  { id: "network", title: "Red de pases", needs: "names" },
  { id: "pass_map", title: "Mapa de pases", needs: "ball" },
  { id: "touches", title: "Toques por jugadora", needs: "names" },
  { id: "zones", title: "Pérdidas y recuperaciones por zona", needs: "events" },
  { id: "duels", title: "Duelos", needs: "events" },
  { id: "physical", title: "Distancia y velocidad", needs: "names" },
  { id: "set_pieces", title: "Balón parado", needs: "events", both: true },
  { id: "key_players", title: "Jugadoras clave", needs: "events" },
  { id: "notes", title: "Fortalezas, debilidades y plan", needs: "events" },
  { id: "plays", title: "Jugadas para revisar", needs: "events" },
  { id: "results", title: "Últimos resultados", needs: "events" },
  // Library: representations planned that need data or code the app does not have yet.
  { id: "pressure", title: "Presión (PPDA)", needs: "dev", locked: "Requiere los pases del rival etiquetados o leídos del balón" },
  { id: "patterns", title: "Patrones de juego", needs: "dev", locked: "En desarrollo" },
  { id: "runs", title: "Carreras sin balón", needs: "dev", locked: "En desarrollo: requiere el tracking con nombres de los dos equipos" },
];

export const DEFAULT_SECTIONS = REPORT_SECTIONS.filter((s) => !s.locked).map((s) => s.id);
const byId = new Map(REPORT_SECTIONS.map((s) => [s.id, s]));
export const sectionDef = (id: string) => byId.get(id);

// The sections to show, in order: the analyst's layout (unknown ids dropped, locked ones never shown) or the default.
// Sections «x:<id>» are charts added from the dashboard: they stay only while their extra exists.
export const EXTRA_PREFIX = "x:";
export function layoutOf(sections: string[] | undefined, extras: { id: string }[] = []): string[] {
  const own = new Set(extras.map((x) => `${EXTRA_PREFIX}${x.id}`));
  const list = (sections ?? [...DEFAULT_SECTIONS, ...own]).filter((id) => (byId.has(id) && !byId.get(id)?.locked) || own.has(id));
  return [...new Set(list)];
}

// The report with a chart added as a section at the end. The same source (the panel it came from) is refreshed, not repeated.
export function withExtra<R extends { sections?: string[]; extras?: { id: string; title: string; image: string; source?: string }[] }>(report: R, extra: { id: string; title: string; image: string; source?: string }): R {
  const extras = report.extras ?? [];
  const same = extra.source ? extras.find((x) => x.source === extra.source) : undefined;
  if (same) return { ...report, extras: extras.map((x) => (x === same ? { ...x, image: extra.image, title: extra.title } : x)) };
  const layout = layoutOf(report.sections, extras);
  return { ...report, extras: [...extras, extra], sections: [...layout, `${EXTRA_PREFIX}${extra.id}`] };
}
// The report without one of its added charts.
export function withoutExtra<R extends { sections?: string[]; extras?: { id: string }[] }>(report: R, id: string): R {
  return { ...report, extras: (report.extras ?? []).filter((x) => x.id !== id), sections: report.sections?.filter((s) => s !== `${EXTRA_PREFIX}${id}`) };
}

// Moves a section one place up (-1) or down (+1) in the layout; returns a new list.
export function moveSection(layout: string[], id: string, by: -1 | 1): string[] {
  const i = layout.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= layout.length) return layout;
  const out = [...layout];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// Shows or hides a section: a shown one is appended at the end of the layout.
export function toggleSection(layout: string[], id: string): string[] {
  return layout.includes(id) ? layout.filter((x) => x !== id) : [...layout, id];
}

export const NEED_TEXT: Record<SectionNeed, string> = {
  events: "Requiere eventos etiquetados",
  ball: "Requiere el balón seguido",
  tracking: "Requiere partes del tracking revisadas",
  names: "Requiere nombres en el tracking y el balón seguido",
  dev: "En desarrollo",
};
