// Shape of each team over the match (width, length, height of the line and of the block) read straight from the
// positions of the correction table, with no step outside the app. Same definitions as
// src/sportsan/metrics/team_blocks.py (which writes team_metrics_<video>.json): only the team of each person counts,
// not who she is. Pure functions.
//
// Only what the camera saw counts (positions filled inside holes are not measurements), and a frame with fewer than
// MIN_VISIBLE field players of a team does not count: what is measured describes the zone of the play.
import { metersPerUnit, orient, type Oriented } from "./positions.ts";
import type { Segment } from "./segments.ts";
import { PITCH } from "./types.ts";

export const MIN_VISIBLE = 7;
export const GK_GAP_M = 8;
export const LINE_PLAYERS = 4;
// A stretch of minutes needs at least this many valid frames to give a value.
export const MIN_FRAMES_PER_BIN = 10;

export type ShapeMeasure = "line_height" | "block_height" | "width" | "length";
export interface ShapeValues {
  width: number | null;
  length: number | null;
  line_height: number | null;
  block_height: number | null;
  // Share of the frames of the stretch that counted (enough players in view).
  valid_share: number;
}
export interface ShapeBin {
  bin: number;
  from_min: number;
  to_min: number;
  frames: number;
  own: ShapeValues;
  opp: ShapeValues;
}
export interface BlockShape {
  bins: ShapeBin[];
  // Frames that counted / frames with that team seen at all, over the whole match.
  valid: { own: number; opp: number };
  frames: { own: number; opp: number };
  // "play": minutes of play of the stretches `juego`; "video": minutes of the video (no stretches marked).
  clock: "play" | "video";
}

interface Row {
  clock: number; // s on the clock of the bin
  own: Frame | null;
  opp: Frame | null;
}
interface Frame {
  valid: boolean;
  width: number;
  length: number;
  line: number;
  block: number;
}

// One frame of one team: positions as [depth (m from its own goal), y (m)].
function oneFrame(depth: number[], ys: number[]): Frame {
  const idx = depth.map((_, i) => i).sort((a, b) => depth[a] - depth[b]);
  let d = idx.map((i) => depth[i]);
  let y = idx.map((i) => ys[i]);
  // The keeper goes when she is alone far behind.
  if (d.length >= 2 && d[1] - d[0] > GK_GAP_M) {
    d = d.slice(1);
    y = y.slice(1);
  }
  if (d.length < MIN_VISIBLE) return { valid: false, width: 0, length: 0, line: 0, block: 0 };
  const mean = (v: number[]) => v.reduce((t, x) => t + x, 0) / v.length;
  return {
    valid: true,
    width: Math.max(...y) - Math.min(...y),
    length: d[d.length - 1] - d[0],
    line: mean(d.slice(0, LINE_PLAYERS)),
    block: mean(d),
  };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Seconds of play before the start of each stretch of `videoIds[k]`, for a clock that runs over the videos in order.
function playClock(videoIds: string[], play: Record<string, Segment[]>): { at: (video: string, t: number) => number | null; any: boolean } {
  const base = new Map<string, number>();
  let acc = 0;
  let any = false;
  for (const v of videoIds) {
    base.set(v, acc);
    for (const g of play[v] ?? []) if (g.tipo === "juego" && g.end !== null) acc += g.end - g.start;
  }
  for (const v of videoIds) if ((play[v] ?? []).some((g) => g.tipo === "juego" && g.end !== null)) any = true;
  return {
    any,
    at(video, t) {
      let before = 0;
      for (const g of (play[video] ?? []).filter((s) => s.tipo === "juego" && s.end !== null).sort((a, b) => a.start - b.start)) {
        if (t >= g.start && t < (g.end as number)) return (base.get(video) ?? 0) + before + (t - g.start);
        before += (g.end as number) - g.start;
      }
      return null;
    },
  };
}

// Shape of both teams by stretches of `binMin` minutes of play. Heights are meters from each team's own goal (with the
// analysed team attacking right, the rival defends x = 105). `videoIds`: the videos in match order.
export function blockShape(parts: Oriented[], play: Record<string, Segment[]>, videoIds: string[], binMin: 5 | 10): BlockShape {
  const clock = playClock(videoIds, play);
  const videoBase = new Map<string, number>();
  let vAcc = 0;
  for (const v of videoIds) {
    videoBase.set(v, vAcc);
    const ends = parts.filter((o) => o.file.video_id === v).map((o) => o.file.end_frame / o.file.fps);
    vAcc += ends.length ? Math.max(...ends) : 0;
  }
  const rows: Row[] = [];
  const frames = { own: 0, opp: 0 };
  const valid = { own: 0, opp: 0 };
  for (const o of parts) {
    const f = o.file;
    const [mx, my] = metersPerUnit(f);
    const team = new Map(f.people.map((p) => [p.id, p.team]));
    for (const fr of f.frames) {
      const t = fr.frame / f.fps;
      const c = clock.any ? clock.at(f.video_id, t) : (videoBase.get(f.video_id) ?? 0) + t;
      if (c === null) continue;
      const d: Record<"own" | "opp", number[]> = { own: [], opp: [] };
      const y: Record<"own" | "opp", number[]> = { own: [], opp: [] };
      for (const q of fr.positions) {
        const tm = team.get(q.id);
        if ((tm !== "own" && tm !== "opp") || q.source === "interpolated") continue;
        const [x, yy] = orient(o, q.x, q.y);
        d[tm].push((tm === "own" ? x : PITCH.length - x) * mx);
        y[tm].push(yy * my);
      }
      const row: Row = { clock: c, own: null, opp: null };
      for (const tm of ["own", "opp"] as const) {
        if (d[tm].length === 0) continue;
        frames[tm]++;
        row[tm] = oneFrame(d[tm], y[tm]);
        if (row[tm]?.valid) valid[tm]++;
      }
      rows.push(row);
    }
  }
  const byBin = new Map<number, Row[]>();
  for (const r of rows) {
    const b = Math.floor(r.clock / (binMin * 60));
    byBin.set(b, [...(byBin.get(b) ?? []), r]);
  }
  const values = (rs: Row[], tm: "own" | "opp"): ShapeValues => {
    const seen = rs.filter((r) => r[tm] !== null);
    const ok = seen.filter((r) => r[tm]?.valid).map((r) => r[tm] as Frame);
    const med = (pick: (x: Frame) => number) => (ok.length >= MIN_FRAMES_PER_BIN ? median(ok.map(pick)) : null);
    return {
      width: med((x) => x.width),
      length: med((x) => x.length),
      line_height: med((x) => x.line),
      block_height: med((x) => x.block),
      valid_share: seen.length ? ok.length / seen.length : 0,
    };
  };
  const bins = [...byBin]
    .sort((a, b) => a[0] - b[0])
    .map(([b, rs]) => ({ bin: b, from_min: b * binMin, to_min: (b + 1) * binMin, frames: rs.length, own: values(rs, "own"), opp: values(rs, "opp") }));
  return { bins, valid, frames, clock: clock.any ? "play" : "video" };
}
