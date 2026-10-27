// The traffic-light board of the Playground: what the analyst can trust of the ball, the possession and the passes, with
// the rule of each colour written next to it. Nothing here is invented: a figure with nothing behind it says "sin
// revisar" / "sin datos" and has no colour. Also the sentence the report uses to show a possession figure with its
// coverage. Pure functions.
import type { PossessionSample, PossessionSummary } from "./possession.ts";

export type Light = "green" | "amber" | "red" | "none";
export const GREEN_MIN = 0.8;
export const AMBER_MIN = 0.5;
// Fewer verdicts than this say too little to call an accuracy green.
export const MIN_REVIEWS = 10;

export const SHARE_RULE = "Verde: 80 % o más. Ámbar: de 50 a 79 %. Rojo: menos de 50 %.";
export const ACCURACY_RULE = `${SHARE_RULE} Con menos de ${MIN_REVIEWS} revisiones nunca pasa de ámbar. El acierto es sobre lo revisado, no sobre todo el partido.`;

export const lightOf = (share: number | null): Light => (share === null || !Number.isFinite(share) ? "none" : share >= GREEN_MIN - 1e-9 ? "green" : share >= AMBER_MIN - 1e-9 ? "amber" : "red");
export const LIGHT_LABEL: Record<Light, string> = { green: "Bien", amber: "Con reservas", red: "Débil", none: "Sin dato" };
const RANK: Record<Light, number> = { red: 0, amber: 1, green: 2, none: 3 };
export const worstLight = (ls: Light[]): Light => ls.reduce<Light>((w, l) => (RANK[l] < RANK[w] ? l : w), "none");

const pct = (x: number) => `${Math.round(100 * x)} %`;

export interface Metric {
  label: string;
  text: string;
  light: Light;
  // Why it has this colour, when the rule alone does not say (e.g. few reviews).
  note?: string;
}
export interface Indicator {
  id: "ball" | "possession" | "passes";
  title: string;
  rule: string;
  metrics: Metric[];
}

// ------------------------------------------------------------------------------------------------- ball
export interface BallRow {
  video_id: string;
  label: string;
  alive_s: number;
  measured_s: number;
  share: number | null;
}
// Share of the alive frames (every sample but the dead ones) whose ball was measured (hand mark, tracker or event), by video.
export function ballMeasuredByVideo(samples: Pick<PossessionSample, "video_id" | "t0" | "t1" | "src" | "kind">[], labelOf: (video: string) => string = (v) => v): BallRow[] {
  const by = new Map<string, { alive: number; measured: number }>();
  for (const s of samples) {
    if (s.kind === "dead") continue;
    const e = by.get(s.video_id) ?? { alive: 0, measured: 0 };
    const dt = s.t1 - s.t0;
    e.alive += dt;
    if (s.src !== "interp") e.measured += dt;
    by.set(s.video_id, e);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([video_id, e]) => ({ video_id, label: labelOf(video_id), alive_s: e.alive, measured_s: e.measured, share: e.alive > 0 ? e.measured / e.alive : null }));
}
export function ballIndicator(rows: BallRow[]): Indicator {
  const metrics: Metric[] = rows.length
    ? rows.map((r) => ({
        label: `Balón medido · ${r.label}`,
        text: r.share === null ? "sin cuadros vivos" : `${pct(r.share)} de los cuadros vivos`,
        light: lightOf(r.share),
      }))
    : [{ label: "Balón medido", text: "sin partes procesadas", light: "none" }];
  return { id: "ball", title: "Balón", rule: `Medido = marcado a mano, del tracker o de un evento (no interpolado). ${SHARE_RULE}`, metrics };
}

// ------------------------------------------------------------------------------------------------- reviews
export interface ReviewCount {
  reviewed: number;
  correct: number;
  // Verdicts about intervals that no longer exist with the current parameters: they do not count (see currentReviews).
  stale?: number;
}
// The verdicts that are about something in the current list (ids), and how many are not.
export function currentReviews(reviews: { id: string; verdict: string }[], ids: Set<string>): ReviewCount {
  const mine = reviews.filter((r) => ids.has(r.id));
  return { reviewed: mine.length, correct: mine.filter((r) => r.verdict === "correct").length, stale: reviews.length - mine.length };
}
export const sumReviews = (xs: ReviewCount[]): ReviewCount => ({
  reviewed: xs.reduce((a, x) => a + x.reviewed, 0),
  correct: xs.reduce((a, x) => a + x.correct, 0),
  stale: xs.reduce((a, x) => a + (x.stale ?? 0), 0),
});
export function accuracyMetric(label: string, noun: string, r: ReviewCount): Metric {
  const staleNote = r.stale ? `${r.stale} revisiones son de otros parámetros o de datos que cambiaron y no cuentan.` : undefined;
  if (r.reviewed <= 0) return { label, text: `${noun} revisados: 0 · sin revisar`, light: "none", note: staleNote };
  const acc = r.correct / r.reviewed;
  let light = lightOf(acc);
  let note: string | undefined = staleNote;
  if (r.reviewed < MIN_REVIEWS && light === "green") {
    light = "amber";
    note = [`Solo ${r.reviewed} revisiones: aún pocas para dar el verde.`, staleNote].filter(Boolean).join(" ");
  }
  return { label, text: `${noun} revisados: ${r.reviewed} · correctos: ${r.correct} (${pct(acc)} de lo revisado)`, light, note };
}

// ------------------------------------------------------------------------------------------------- possession
export function possessionIndicator(summary: Pick<PossessionSummary, "coverage" | "contact_coverage"> | null, rev: ReviewCount): Indicator {
  const cover = summary?.coverage ?? null;
  const contact = summary?.contact_coverage ?? null;
  const metrics: Metric[] = [
    { label: "Cobertura", text: cover === null ? "sin tiempo vivo" : `${pct(cover)} del tiempo vivo con dueño`, light: lightOf(cover) },
    { label: "Contacto medido", text: contact === null ? "sin tiempo vivo" : `${pct(contact)} del tiempo vivo con toque medido`, light: lightOf(contact) },
    accuracyMetric("Revisión", "Intervalos", rev),
  ];
  return { id: "possession", title: "Posesión", rule: `Cobertura y contacto: ${SHARE_RULE} Revisión: ${ACCURACY_RULE}`, metrics };
}

export function passesIndicator(rev: ReviewCount): Indicator {
  return { id: "passes", title: "Pases", rule: ACCURACY_RULE, metrics: [accuracyMetric("Revisión", "Pases", rev)] };
}

// ------------------------------------------------------------------------------------------------- the report
export interface PossessionCover {
  cover: number | null;
  contact: number | null;
  // "calculada sobre el 82 % del tiempo vivo; el 61 % es contacto medido": always shown next to the possession.
  text: string;
  // Set when either is under 50 %: the figure rests on too little of the game.
  warning: string | null;
}
export function possessionCover(d: Partial<Pick<PossessionSummary, "coverage" | "contact_coverage">> | null | undefined): PossessionCover {
  const cover = d?.coverage ?? null;
  const contact = d?.contact_coverage ?? null;
  const text =
    cover === null
      ? "cobertura desconocida (sin tiempo vivo medido)"
      : `calculada sobre el ${pct(cover)} del tiempo vivo${contact !== null ? `; el ${pct(contact)} es contacto medido` : ""}`;
  const low = (cover !== null && cover < AMBER_MIN) || (contact !== null && contact < AMBER_MIN);
  const warning = low
    ? `Cobertura baja: ${cover !== null ? `solo el ${pct(cover)} del tiempo vivo tiene dueño` : "sin cobertura"}${contact !== null ? ` y el ${pct(contact)} es contacto medido` : ""}. Tómala como orientativa.`
    : null;
  return { cover, contact, text, warning };
}
