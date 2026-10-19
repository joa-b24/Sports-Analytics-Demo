import type { Pt } from "./homography.ts";
import type { Landmark, Venue } from "./venue.ts";

// Calibration by lines: when the reference points are not in sight (out of frame, hidden by players), two visible
// lines of the pitch still give the point where they cross. A line is marked with two clicks anywhere along it and
// named after a line of the model; every pair of marked lines that cross in the model gives a computed point (in the
// image and in the model), used in the fit like a clicked one. The crossing may fall outside the frame: it is only
// computed, never drawn as a click. Pure functions.

export interface NamedLine {
  id: string;
  label: string;
  family: "soccer" | "football" | "hash";
  a: Pt;
  b: Pt;
  // False when the line rests on an assumption still to be checked (like its landmarks).
  exact: boolean;
}

// A line marked on a frame: two pixels on it and the line of the model it is.
export interface ImageLine {
  line_id: string;
  a: Pt;
  b: Pt;
}

// Prefix of the computed points: `ix:<line>+<line>` (the two ids sorted).
export const IX = "ix:";

// The straight lines of a venue model, built from its landmarks (so they follow the venue's measures).
export function namedLines(venue: Venue): NamedLine[] {
  const lm = new Map(venue.landmarks.map((l) => [l.id, l]));
  const out: NamedLine[] = [];
  const add = (id: string, label: string, family: NamedLine["family"], p: Landmark | Pt | undefined, q: Landmark | Pt | undefined) => {
    if (!p || !q) return;
    const a: Pt = Array.isArray(p) ? p : [p.x, p.y];
    const b: Pt = Array.isArray(q) ? q : [q.x, q.y];
    const exact = (Array.isArray(p) || p.exact) && (Array.isArray(q) || q.exact);
    out.push({ id, label, family, a, b, exact });
  };
  const g = (id: string) => lm.get(id);
  add("s_side_f", "Banda lejana", "soccer", g("sc_l_cf"), g("sc_r_cf"));
  add("s_side_n", "Banda cercana", "soccer", g("sc_l_cn"), g("sc_r_cn"));
  add("s_half", "Media cancha", "soccer", g("sc_hf"), g("sc_hn"));
  for (const [t, name] of [["l", "izq."], ["r", "der."]] as const) {
    const corner = g(`sc_${t}_cf`);
    add(`s_goal_${t}`, `Línea de meta ${name}`, "soccer", corner, g(`sc_${t}_cn`));
    add(`s_box_${t}`, `Área grande ${name} · frente`, "soccer", g(`sc_${t}_pf`), g(`sc_${t}_pn`));
    add(`s_boxf_${t}`, `Área grande ${name} · lado lejano`, "soccer", g(`sc_${t}_pgf`), g(`sc_${t}_pf`));
    add(`s_boxn_${t}`, `Área grande ${name} · lado cercano`, "soccer", g(`sc_${t}_pgn`), g(`sc_${t}_pn`));
    const gf = g(`sc_${t}_gf`);
    const gn = g(`sc_${t}_gn`);
    add(`s_ga_${t}`, `Área chica ${name} · frente`, "soccer", gf, gn);
    if (corner && gf && gn) {
      add(`s_gaf_${t}`, `Área chica ${name} · lado lejano`, "soccer", [corner.x, gf.y], gf);
      add(`s_gan_${t}`, `Área chica ${name} · lado cercano`, "soccer", [corner.x, gn.y], gn);
    }
  }
  add("f_side_f", "Banda lejana del americano", "football", g("yl-12_fs"), g("yl12_fs"));
  add("f_side_n", "Banda cercana del americano", "football", g("yl-12_ns"), g("yl12_ns"));
  add("f_hash_f", "Marcas lejanas del americano", "hash", g("yl-9_fh"), g("yl9_fh"));
  add("f_hash_n", "Marcas cercanas del americano", "hash", g("yl-9_nh"), g("yl9_nh"));
  for (let k = -12; k <= 12; k++) {
    const f = g(`yl${k}_fs`);
    if (f) add(`f_yl${k}`, f.label.replace(/ · banda lejana$/, ""), "football", f, g(`yl${k}_ns`));
  }
  return out;
}

// Where two infinite lines cross; null when they are (nearly) parallel.
export function crossing(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const den = d1x * d2y - d1y * d2x;
  const l1 = Math.hypot(d1x, d1y);
  const l2 = Math.hypot(d2x, d2y);
  // Less than about 3° between them: the crossing is not well defined.
  if (l1 === 0 || l2 === 0 || Math.abs(den) / (l1 * l2) < 0.05) return null;
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den;
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

// The computed points of a frame: every pair of marked lines that cross inside the venue (a few meters of margin).
export function linePoints(venue: Venue, lines: ImageLine[]): { landmark: Landmark; px: number; py: number }[] {
  const model = new Map(namedLines(venue).map((l) => [l.id, l]));
  const b = venue.bounds;
  const margin = 5;
  const out: { landmark: Landmark; px: number; py: number }[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const A = model.get(lines[i].line_id);
      const B = model.get(lines[j].line_id);
      if (!A || !B || A.id === B.id) continue;
      const m = crossing(A.a, A.b, B.a, B.b);
      if (!m || m[0] < b.x0 - margin || m[0] > b.x1 + margin || m[1] < b.y0 - margin || m[1] > b.y1 + margin) continue;
      const p = crossing(lines[i].a, lines[i].b, lines[j].a, lines[j].b);
      if (!p) continue;
      const [first, second] = [A, B].sort((x, y) => x.id.localeCompare(y.id));
      out.push({
        landmark: {
          id: `${IX}${first.id}+${second.id}`,
          label: `${first.label} × ${second.label}`,
          x: m[0],
          y: m[1],
          group: A.family === "soccer" && B.family === "soccer" ? "soccer" : "football",
          exact: A.exact && B.exact,
        },
        px: p[0],
        py: p[1],
      });
    }
  return out;
}

// Landmarks of a venue plus the computed points of some marked lines, by id (to resolve the points of an anchor).
export function landmarksWith(venue: Venue, lines: ImageLine[] | undefined): Map<string, Landmark> {
  const map = new Map(venue.landmarks.map((l) => [l.id, l]));
  for (const d of linePoints(venue, lines ?? [])) map.set(d.landmark.id, d.landmark);
  return map;
}
