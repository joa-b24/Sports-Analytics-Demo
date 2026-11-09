// The colours the processing really measures on the shirts, grouped, to set the kits of a match from them. The eyedropper
// reads one patch of the screen; the tracking takes the median of the torso of each box (see detect.shirt_lab), which is
// duller and darker, so a vivid colour picked by eye can sit farther than MAX_COLOR_DISTANCE from what is measured and
// the person stays without a team. Pure functions: no files, no React.
import { MAX_COLOR_DISTANCE, TEAM_L_WEIGHT, colorDistance, hexToLab, kitOfColor, labToHex, type JerseyColors, type JerseyKey } from "./tracks.ts";

export interface MeasuredRow {
  track: number;
  // Shirt colour of the box in Lab (OpenCV scale, as the tracks file stores it).
  lab: number[];
  onPitch: boolean;
}
export interface MeasuredKit {
  hex: string;
  lab: number[];
  tracks: number;
  boxes: number;
  // The kit that already claims this colour (a reference within the distance), or null.
  kit: JerseyKey | null;
  // Distance to the nearest reference (null with no references at all).
  nearest: { key: JerseyKey; d: number } | null;
}

// Tracks with fewer boxes say little about a kit; colours under this share of the measured boxes are noise.
export const MIN_TRACK_BOXES = 15;
export const MIN_GROUP_BOXES = 40;
// Two tracks of one kit sit this close in Lab (full lightness weight).
export const GROUP_DISTANCE = 18;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function measuredKits(rows: MeasuredRow[], colors: Partial<JerseyColors> | undefined, refKeys: readonly JerseyKey[] = ["own", "own_gk", "opp", "opp_gk", "ref"]): MeasuredKit[] {
  const by = new Map<number, MeasuredRow[]>();
  for (const r of rows) by.set(r.track, [...(by.get(r.track) ?? []), r]);
  // One colour per track (median of its boxes), only tracks that are mostly on the pitch and long enough.
  const tracks = [...by.entries()].flatMap(([track, rs]) => {
    if (rs.length < MIN_TRACK_BOXES || rs.filter((r) => r.onPitch).length < rs.length / 2) return [];
    return [{ track, boxes: rs.length, lab: [0, 1, 2].map((c) => median(rs.map((r) => r.lab[c]))) }];
  });
  // Greedy grouping, the biggest first: a track joins the group whose centre is near, else starts one.
  const groups: { lab: number[]; tracks: number; boxes: number }[] = [];
  for (const t of tracks.sort((a, b) => b.boxes - a.boxes)) {
    const g = groups.find((x) => colorDistance(x.lab, t.lab, TEAM_L_WEIGHT) <= GROUP_DISTANCE);
    if (!g) groups.push({ lab: t.lab, tracks: 1, boxes: t.boxes });
    else {
      const w = g.boxes / (g.boxes + t.boxes);
      g.lab = g.lab.map((v, i) => v * w + t.lab[i] * (1 - w));
      g.tracks += 1;
      g.boxes += t.boxes;
    }
  }
  return groups
    .filter((g) => g.boxes >= MIN_GROUP_BOXES)
    .sort((a, b) => b.boxes - a.boxes)
    .map((g) => {
      const dist = refKeys.flatMap((key) => {
        const hex = colors?.[key];
        const lab = hex ? hexToLab(hex) : null;
        return lab ? [{ key, d: colorDistance(g.lab, lab, TEAM_L_WEIGHT) }] : [];
      });
      dist.sort((a, b) => a.d - b.d);
      return { hex: labToHex(g.lab), lab: g.lab, tracks: g.tracks, boxes: g.boxes, kit: kitOfColor(g.lab, colors), nearest: dist[0] ?? null };
    });
}

// Whether the group is a colour no reference claims: the people with it stay without a team.
export const unclaimed = (k: MeasuredKit) => k.nearest !== null && k.nearest.d > MAX_COLOR_DISTANCE;

// The rows of a tracks file: [track, x0, y0, x1, y1, conf, L, a, b, ..., on pitch at index 11].
export function rowsOfTracks(file: { frames: { boxes: (number | string | boolean)[][] }[] }): MeasuredRow[] {
  const out: MeasuredRow[] = [];
  for (const fr of file.frames)
    for (const b of fr.boxes) {
      const lab = [Number(b[6]), Number(b[7]), Number(b[8])];
      if (lab.every((v) => Number.isFinite(v))) out.push({ track: Number(b[0]), lab, onPitch: b[11] === true });
    }
  return out;
}
