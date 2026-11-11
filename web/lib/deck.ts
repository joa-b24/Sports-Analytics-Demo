// The presentation of a match: slides made of charts saved from the analysis (a PNG each) with a title and a note.
// Pure: no storage, no React. The state keeps one deck per match (State.decks).

// A simple piece drawn over a slide. Positions are fractions of the slide (x of its width, y of its height, from the top
// left). text: at x, y, `size` is a fraction of the height. rect: x, y, w, h. arrow: from x, y to x2, y2.
export type SlideItemKind = "text" | "rect" | "arrow";
export interface SlideItem {
  id: string;
  kind: SlideItemKind;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  text?: string;
  size?: number;
  // A name of SLIDE_COLORS.
  color: string;
}
export const SLIDE_COLORS = ["ink", "own", "opp", "warn", "danger", "ok"] as const;
export const SLIDE_COLOR_VAR: Record<string, string> = {
  ink: "var(--color-ink)",
  own: "var(--color-own)",
  opp: "var(--color-opp)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  ok: "var(--color-ok)",
};

export interface Slide {
  id: string;
  title: string;
  note: string;
  // «chart» (default): the chart as an image. «blank»: only the pieces drawn on it. «clip»: an edited clip of the match
  // (Estudio), played from its exported MP4.
  kind?: "chart" | "blank" | "clip" | "board";
  // The chart as a PNG data URL, as the analyst saw it (colours of the app). Absent in blank and clip slides.
  image?: string;
  // The clip of a «clip» slide (edit_id of an edit of the match).
  clip?: string;
  // A «board» slide plays an animation: a board of the pizarrón (board_id) or the animation of a play of Estudio (play_id).
  board?: string;
  play?: string;
  // Text, boxes and arrows over the slide.
  items?: SlideItem[];
  // The panel of the dashboard it came from: adding the same panel again refreshes this slide instead of repeating it.
  source?: string;
  at: number; // ms
}
export interface Deck {
  match_id: string;
  slides: Slide[];
}

export const slidesOf = (decks: Deck[] | undefined, match_id: string): Slide[] => decks?.find((d) => d.match_id === match_id)?.slides ?? [];

const withSlides = (decks: Deck[] | undefined, match_id: string, f: (s: Slide[]) => Slide[]): Deck[] => {
  const list = decks ?? [];
  const next = f(slidesOf(list, match_id));
  const rest = list.filter((d) => d.match_id !== match_id);
  return next.length ? [...rest, { match_id, slides: next }] : rest;
};

export const addSlide = (decks: Deck[] | undefined, match_id: string, slide: Slide) => withSlides(decks, match_id, (s) => [...s, slide]);
export const removeSlide = (decks: Deck[] | undefined, match_id: string, id: string) => withSlides(decks, match_id, (s) => s.filter((x) => x.id !== id));
export const editSlide = (decks: Deck[] | undefined, match_id: string, id: string, patch: Partial<Pick<Slide, "title" | "note" | "items">>) =>
  withSlides(decks, match_id, (s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));

// One place up (-1) or down (+1); the ends stay where they are.
export const moveSlide = (decks: Deck[] | undefined, match_id: string, id: string, by: -1 | 1) =>
  withSlides(decks, match_id, (s) => {
    const i = s.findIndex((x) => x.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= s.length) return s;
    const out = [...s];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });

// A slide with no chart: pieces only (a title card, a lineup) or a clip of the match.
export const blankSlide = (id: string, title = "Diapositiva"): Slide => ({ id, title, note: "", kind: "blank", items: [], at: Date.now() });
export const clipSlide = (id: string, edit_id: string, title: string): Slide => ({ id, title, note: "", kind: "clip", clip: edit_id, items: [], at: Date.now() });

// An animated slide: a board of the pizarrón or the animation of a play of the match.
export const boardSlide = (id: string, ref: { board: string } | { play: string }, title: string): Slide => ({ id, title, note: "", kind: "board", ...ref, items: [], at: Date.now() });

// The pieces of a slide after an edit of one of them (or after adding or removing one).
export const upsertItem = (items: SlideItem[] | undefined, item: SlideItem): SlideItem[] => {
  const list = items ?? [];
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
};
export const dropItem = (items: SlideItem[] | undefined, id: string): SlideItem[] => (items ?? []).filter((x) => x.id !== id);

// Adds a chart slide, or, if a slide of the same source exists, refreshes its image (its title, note and pieces stay).
export function upsertChartSlide(decks: Deck[] | undefined, match_id: string, slide: Slide): Deck[] {
  return withSlides(decks, match_id, (list) => {
    const same = slide.source ? list.find((x) => x.source === slide.source) : undefined;
    return same ? list.map((x) => (x === same ? { ...x, image: slide.image, at: slide.at } : x)) : [...list, slide];
  });
}
