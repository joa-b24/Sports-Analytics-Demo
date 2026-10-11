import { PITCH, type VenueSpec } from "./types";
import type { Pt } from "./homography";

// Reference model of a venue, in real meters. Origin: corner of the soccer pitch that is far from the camera and to
// its left; x along the length, y across the width (y grows toward the camera). Same orientation as the data contract.
// A venue is built from a VenueSpec: the built-in ones below, or the ones edited in Configuración (State.venues).

export interface Landmark {
  id: string;
  label: string;
  x: number;
  y: number;
  group: "football" | "hash" | "soccer";
  // False when the position rests on an assumption that still has to be checked against calibrated frames.
  exact: boolean;
}

export interface ModelLine {
  pts: Pt[];
  group: "football" | "soccer";
}

export interface Venue {
  venue_id: string;
  name: string;
  length_m: number;
  width_m: number;
  landmarks: Landmark[];
  lines: ModelLine[];
  // Drawing bounds of the diagram (the football field is longer than the soccer pitch).
  bounds: { x0: number; y0: number; x1: number; y1: number };
  // Paint colours of each family of lines, for the diagrams.
  colors: { football: string; soccer: string };
  spec: VenueSpec;
  // True when it comes from the code and has not been edited in the app.
  builtin: boolean;
}

const YARD = 0.9144;
// 60 ft, the college standard. Each venue can correct it once measured on calibrated frames.
export const DEFAULT_HASH_M = 60 * 0.3048;

function circle(cx: number, cy: number, r: number, from = 0, to = 2 * Math.PI, steps = 48): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

// Standard soccer markings for a pitch of L x W meters. `exact` says whether the pitch size itself is trusted.
function soccerMarkings(L: number, W: number, exact: boolean): { landmarks: Landmark[]; lines: ModelLine[] } {
  const cx = L / 2;
  const cy = W / 2;
  const landmarks: Landmark[] = [];
  const lines: ModelLine[] = [];
  const soccer = (id: string, label: string, x: number, y: number) => landmarks.push({ id, label, x, y, group: "soccer", exact });
  soccer("sc_c", "Centro de la cancha", cx, cy);
  soccer("sc_hf", "Media cancha · banda lejana", cx, 0);
  soccer("sc_hn", "Media cancha · banda cercana", cx, W);
  soccer("sc_cf", "Círculo central · punto lejano", cx, cy - 9.15);
  soccer("sc_cn", "Círculo central · punto cercano", cx, cy + 9.15);
  soccer("sc_cl", "Círculo central · punto izq.", cx - 9.15, cy);
  soccer("sc_cr", "Círculo central · punto der.", cx + 9.15, cy);
  for (const [tag, name, x0, dir] of [["l", "izq.", 0, 1], ["r", "der.", L, -1]] as const) {
    soccer(`sc_${tag}_cf`, `Esquina ${name} lejana`, x0, 0);
    soccer(`sc_${tag}_cn`, `Esquina ${name} cercana`, x0, W);
    soccer(`sc_${tag}_pf`, `Área grande ${name} · vértice lejano`, x0 + dir * 16.5, cy - 20.16);
    soccer(`sc_${tag}_pn`, `Área grande ${name} · vértice cercano`, x0 + dir * 16.5, cy + 20.16);
    soccer(`sc_${tag}_pgf`, `Área grande ${name} · línea de meta lejana`, x0, cy - 20.16);
    soccer(`sc_${tag}_pgn`, `Área grande ${name} · línea de meta cercana`, x0, cy + 20.16);
    soccer(`sc_${tag}_gf`, `Área chica ${name} · vértice lejano`, x0 + dir * 5.5, cy - 9.16);
    soccer(`sc_${tag}_gn`, `Área chica ${name} · vértice cercano`, x0 + dir * 5.5, cy + 9.16);
    soccer(`sc_${tag}_ps`, `Punto penal ${name}`, x0 + dir * 11, cy);
    const box = (d: number, h: number): Pt[] => [[x0, cy - h], [x0 + dir * d, cy - h], [x0 + dir * d, cy + h], [x0, cy + h]];
    lines.push({ pts: box(16.5, 20.16), group: "soccer" });
    lines.push({ pts: box(5.5, 9.16), group: "soccer" });
    // Penalty arc: the part of the 9.15 m circle around the penalty spot that lies outside the box.
    const a = Math.acos(5.5 / 9.15);
    lines.push({ pts: circle(x0 + dir * 11, cy, 9.15, dir === 1 ? -a : Math.PI - a, dir === 1 ? a : Math.PI + a, 16), group: "soccer" });
  }
  lines.push({ pts: [[0, 0], [L, 0], [L, W], [0, W], [0, 0]], group: "soccer" });
  lines.push({ pts: [[cx, 0], [cx, W]], group: "soccer" });
  lines.push({ pts: circle(cx, cy, 9.15), group: "soccer" });
  return { landmarks, lines };
}

// Regulation American football grid centred on (cx, cy). Exact by regulation; the hash marks depend on the standard used.
function footballGrid(cx: number, cy: number, hashFar: number, hashNear: number): { landmarks: Landmark[]; lines: ModelLine[]; x0: number; x1: number } {
  const half = (160 / 3 / 2) * YARD; // field is 53 1/3 yd wide
  const ySide = { f: cy - half, n: cy + half };
  const yHash = { f: ySide.f + hashFar, n: ySide.n - hashNear };
  const landmarks: Landmark[] = [];
  const lines: ModelLine[] = [];
  // k counts 5-yard lines from midfield: -10 and 10 are the goal lines, -12 and 12 the end lines.
  for (let k = -12; k <= 12; k++) {
    if (Math.abs(k) === 11) continue;
    const x = cx + k * 5 * YARD;
    const yards = 50 - Math.abs(k) * 5;
    const side = k < 0 ? "izq." : k > 0 ? "der." : "";
    const name = Math.abs(k) === 12 ? `Fondo ${side}` : yards === 0 ? `Línea de gol ${side}` : `Yarda ${yards} ${side}`.trim();
    lines.push({ pts: [[x, ySide.f], [x, ySide.n]], group: "football" });
    landmarks.push({ id: `yl${k}_fs`, label: `${name} · banda lejana`, x, y: ySide.f, group: "football", exact: true });
    landmarks.push({ id: `yl${k}_ns`, label: `${name} · banda cercana`, x, y: ySide.n, group: "football", exact: true });
    if (Math.abs(k) < 10) {
      landmarks.push({ id: `yl${k}_fh`, label: `${name} · marcas lejanas`, x, y: yHash.f, group: "hash", exact: false });
      landmarks.push({ id: `yl${k}_nh`, label: `${name} · marcas cercanas`, x, y: yHash.n, group: "hash", exact: false });
    }
  }
  const x0 = cx - 60 * YARD;
  const x1 = cx + 60 * YARD;
  lines.push({ pts: [[x0, ySide.f], [x1, ySide.f]], group: "football" });
  lines.push({ pts: [[x0, ySide.n], [x1, ySide.n]], group: "football" });
  return { landmarks, lines, x0, x1 };
}

export function buildVenue(spec: VenueSpec, builtin = false): Venue {
  const L = spec.length_m;
  const W = spec.width_m;
  const overlay = spec.kind === "football_overlay";
  // Over a football grid the soccer lines are the uncertain part; on a soccer-only pitch they are all there is.
  const soccer = soccerMarkings(L, W, !overlay);
  const grid = overlay
    ? footballGrid(L / 2 + (spec.grid_dx_m ?? 0), W / 2 + (spec.grid_dy_m ?? 0), spec.hash_far_m ?? DEFAULT_HASH_M, spec.hash_near_m ?? DEFAULT_HASH_M)
    : null;
  return {
    venue_id: spec.venue_id,
    name: spec.name,
    length_m: L,
    width_m: W,
    landmarks: [...(grid?.landmarks ?? []), ...soccer.landmarks],
    lines: [...(grid?.lines ?? []), ...soccer.lines],
    bounds: { x0: Math.min(0, grid?.x0 ?? 0) - 2, y0: -2, x1: Math.max(L, grid?.x1 ?? L) + 2, y1: W + 2 },
    colors: { football: spec.grid_color, soccer: spec.soccer_color },
    spec,
    builtin,
  };
}

export const BUILTIN_SPECS: VenueSpec[] = [
  {
    venue_id: "cueva_del_leon",
    name: "Estadio La Cueva del León",
    kind: "football_overlay",
    length_m: 100,
    width_m: 65,
    hash_far_m: DEFAULT_HASH_M,
    hash_near_m: DEFAULT_HASH_M,
    grid_dx_m: 0,
    grid_dy_m: 0,
    soccer_color: "#facc15",
    grid_color: "#cbd5e1",
  },
];

export const VENUES: Venue[] = BUILTIN_SPECS.map((s) => buildVenue(s, true));

// Built-in venues plus the ones saved in the app. A saved venue with the same id replaces the built-in one.
export function allVenues(custom: VenueSpec[]): Venue[] {
  const ids = new Set(custom.map((c) => c.venue_id));
  return [...VENUES.filter((v) => !ids.has(v.venue_id)), ...custom.map((c) => buildVenue(c))];
}

// Real venue meters -> normalised pitch of the data contract (105 x 68).
export function toNormalized(venue: Venue, p: Pt): Pt {
  return [(p[0] * PITCH.length) / venue.length_m, (p[1] * PITCH.width) / venue.width_m];
}
