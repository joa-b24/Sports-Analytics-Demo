import { BALL_FILL_S, autoBall, ballPath, eventBall, manualBall, measuredPaths, metersPerUnit, viewPolygon, type BallAuto } from "./parts.ts";
import { SMOOTH_DEFAULTS, smoothTrack, type SmoothReport, type TrackPoint } from "./smooth.ts";
import { people, type JerseyColors, type TracksFile } from "./tracks.ts";
import type { MatchEvent, TrackEdits } from "./types.ts";

// tracks_fixed_<part>.json from a part and its corrections: the one export used by the «Guardar» of the table and by
// «Guardar todo» of the match (lib/saveMatch.ts). Pure: no storage, no React.

// People seen on the pitch less than this share of their frames (and without a name or a team by hand) are left out
// as if they were referees (people walking along the touchline).
export const OFF_PITCH_SHARE = 0.1;

export interface SmoothCfg {
  maxSpeedMs: number;
  maxFillS: number;
  windowS: number;
}
// What the table uses when nobody touched its export dialog: smoothing on, every hole filled.
export const DEFAULT_SMOOTH: SmoothCfg = { ...SMOOTH_DEFAULTS, maxFillS: Number.POSITIVE_INFINITY };

export interface FixedOptions {
  colors?: Partial<JerseyColors>;
  // null: exported as measured.
  smooth: SmoothCfg | null;
  showRefs?: boolean;
  // Tagged events of the match (their positions become ball marks) and where the analysed team attacks in this video
  // (null: unknown, events give no ball).
  events?: MatchEvent[];
  attackRight?: boolean | null;
  ballAuto?: BallAuto | null;
}

export interface FixedResult {
  out: Record<string, unknown>;
  totals: { outliers: number; filled: number; openGaps: number };
  note: string;
}

export const fixedName = (f: Pick<TracksFile, "video_id" | "start_frame" | "end_frame">) => `tracks_fixed_${f.video_id}_${f.start_frame}_${f.end_frame}.json`;

export function buildFixed(file: TracksFile, edits: TrackEdits, opts: FixedOptions): FixedResult {
  const ppl = people(file, edits, opts.colors);
  const offPitch = (p: (typeof ppl)[number]) => p.onPitchShare < OFF_PITCH_SHARE && !p.player_id && !p.teamByHand;
  const refIds = new Set(opts.showRefs ? [] : ppl.filter((p) => (p.team === "ref" && !p.teamByHand) || offPitch(p)).map((p) => p.id));
  const paths = measuredPaths(file, edits);
  const known = [
    ...(opts.attackRight === true || opts.attackRight === false ? eventBall(file, opts.events ?? [], opts.attackRight) : []),
    ...autoBall(file, opts.ballAuto ?? null, edits),
    ...manualBall(file, edits),
  ];
  const ball = ballPath(known, file.fps, file.stride, BALL_FILL_S, edits.ballLinks ?? []);
  const cfg = opts.smooth;
  const cleaned = new Map<number, { points: TrackPoint[]; report: SmoothReport }>();
  if (cfg) {
    const o = { fps: file.fps, stride: file.stride, metersPerUnit: metersPerUnit(file), ...cfg };
    for (const [id, pts] of paths) cleaned.set(id, smoothTrack(pts, o));
  }
  const totals = [...cleaned.values()].reduce(
    (t, c) => ({ outliers: t.outliers + c.report.outliers, filled: t.filled + c.report.filled, openGaps: t.openGaps + c.report.openGaps }),
    { outliers: 0, filled: 0, openGaps: 0 },
  );
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const byFrameOut = new Map<number, { id: number; x: number; y: number; source: string; raw?: [number, number] }[]>();
  for (const id of paths.keys()) {
    if (refIds.has(id)) continue;
    const pts = cfg ? (cleaned.get(id)?.points ?? []) : [...(paths.get(id) ?? [])].sort((u, v) => u.frame - v.frame);
    for (const q of pts) {
      const row = { id, x: r2(q.x), y: r2(q.y), source: q.source, ...(q.raw ? { raw: [r2(q.raw[0]), r2(q.raw[1])] as [number, number] } : {}) };
      const list = byFrameOut.get(q.frame);
      if (list) list.push(row);
      else byFrameOut.set(q.frame, [row]);
    }
  }
  const out = {
    schema_version: 2,
    kind: "tracks_fixed",
    match_id: file.match_id,
    video_id: file.video_id,
    fps: file.fps,
    // Real size of the venue: positions are normalised to 105 x 68, distances are measured in these meters.
    venue: file.venue?.length_m && file.venue?.width_m ? { length_m: file.venue.length_m, width_m: file.venue.width_m } : null,
    start_frame: file.start_frame,
    end_frame: file.end_frame,
    stride: file.stride,
    // How the paths were cleaned; null when exported as measured. max_fill_s null: every hole filled.
    smoothing: cfg ? { max_speed_ms: cfg.maxSpeedMs, max_fill_s: Number.isFinite(cfg.maxFillS) ? cfg.maxFillS : null, window_s: cfg.windowS, ...totals } : null,
    people: ppl.filter((q) => !refIds.has(q.id)).map((q) => ({ id: q.id, team: q.team, player_id: q.player_id || null, tracks: q.tracks })),
    // Ball on the pitch: "manual", "auto", "event" or "interpolated".
    ball: ball.map((b) => ({ frame: b.frame, x: r2(b.x), y: r2(b.y), source: b.source })),
    // Positions in the normalised pitch. source: "auto", "manual" or "interpolated" (never a measurement). `raw` is the
    // measured position when smoothing moved it. `view`: what the camera saw in each frame, on the pitch.
    frames: file.frames.map((fr) => {
      const v = viewPolygon(file, fr.H);
      return { frame: fr.frame, positions: byFrameOut.get(fr.frame) ?? [], ...(v ? { view: v } : {}) };
    }),
  };
  const note = cfg
    ? `Suavizado: ${totals.outliers} microsalto(s) quitado(s), ${totals.filled} posición(es) rellenada(s), ${totals.openGaps} hueco(s) vacío(s).`
    : "Tal como se midió, sin suavizar ni rellenar.";
  return { out, totals, note };
}
