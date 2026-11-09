// The presentation of a match: slides made of charts saved from the analysis (a PNG each) with a title and a note.
// Pure: no storage, no React. The state keeps one deck per match (State.decks).

export interface Slide {
  id: string;
  title: string;
  note: string;
  // The chart as a PNG data URL, as the analyst saw it (colours of the app).
  image: string;
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
export const editSlide = (decks: Deck[] | undefined, match_id: string, id: string, patch: Partial<Pick<Slide, "title" | "note">>) =>
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
