import { BALL_FILL_S, autoBall, ballPath, ballStateRanges, eventBall, manualBall, measuredPaths, metersPerUnit, viewPolygon, type BallAuto } from "./parts.ts";
import { SMOOTH_DEFAULTS, extrapolateEnds, smoothTrack, type SmoothReport, type TrackPoint } from "./smooth.ts";
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
  // Salto máximo del balón (m/s) de Detalles técnicos; absent: BALL_JUMP_MS.
  ballJumpMs?: number;
  // Hold each named person still before her first and after her last position of the part (source "extrapolated", invented:
  // drawn dimmer, excluded from every measure). Default: on when the paths are cleaned, never on "as measured".
  extrapolate?: boolean;
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
  const refIds = new Set(opts.showRefs ? [] : ppl.filter((p) => (p.team === "ref" && !p.teamByHand && !p.player_id) || offPitch(p)).map((p) => p.id));
  const paths = measuredPaths(file, edits);
  const known = [
    ...(opts.attackRight === true || opts.attackRight === false ? eventBall(file, opts.events ?? [], opts.attackRight) : []),
    ...autoBall(file, opts.ballAuto ?? null, edits, true, opts.ballJumpMs),
    ...manualBall(file, edits),
  ];
  const ballStates = ballStateRanges(edits);
  const ball = ballPath(known, file.fps, file.stride, BALL_FILL_S, edits.ballLinks ?? [], ballStates);
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
  const frameNumbers = file.frames.map((fr) => fr.frame).sort((a, b) => a - b);
  const extrapolate = !!cfg && opts.extrapolate !== false;
  // Only the people with a name are held still: a loose fragment of a few seconds padded across the whole part is a ghost
  // and made a part with 1,000 fragments weigh 278 MB (more than the app may write: the save failed).
  const named = new Set(ppl.filter((p) => p.player_id).map((p) => p.id));
  let extrapolated = 0;
  const byFrameOut = new Map<number, { id: number; x: number; y: number; source: string; raw?: [number, number] }[]>();
  for (const id of paths.keys()) {
    if (refIds.has(id)) continue;
    let pts = cfg ? (cleaned.get(id)?.points ?? []) : [...(paths.get(id) ?? [])].sort((u, v) => u.frame - v.frame);
    if (extrapolate && named.has(id)) {
      const ext = extrapolateEnds(pts, frameNumbers);
      pts = ext.points;
      extrapolated += ext.added;
    }
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
    smoothing: cfg ? { max_speed_ms: cfg.maxSpeedMs, max_fill_s: Number.isFinite(cfg.maxFillS) ? cfg.maxFillS : null, window_s: cfg.windowS, ...totals, extrapolated } : null,
    people: ppl.filter((q) => !refIds.has(q.id)).map((q) => ({ id: q.id, team: q.team, player_id: q.player_id || null, tracks: q.tracks })),
    // Ball on the pitch: "manual", "auto", "event" or "interpolated". `aerial`: the ground projection of a ball in the air
    // (never a touch).
    ball: ball.map((b) => ({ frame: b.frame, x: r2(b.x), y: r2(b.y), source: b.source, ...(b.aerial ? { aerial: true } : {}) })),
    // «No se ve» / «fuera» stretches marked by hand: frames [from, to) (to null: to the end of the part). Inside «out» there
    // is no ball: the ball is dead until the next visible mark. Always present (empty: everything visible).
    ball_states: ballStates,
    // Positions in the normalised pitch. source: "auto", "manual", "interpolated" (never a measurement) or "extrapolated" (held still outside what was seen: invented, measures skip it). `raw` is the
    // measured position when smoothing moved it. `view`: what the camera saw in each frame, on the pitch.
    frames: file.frames.map((fr) => {
      const v = viewPolygon(file, fr.H);
      return { frame: fr.frame, positions: byFrameOut.get(fr.frame) ?? [], ...(v ? { view: v } : {}) };
    }),
  };
  const note = cfg
    ? `Suavizado: ${totals.outliers} microsalto(s) quitado(s), ${totals.filled} posición(es) rellenada(s), ${totals.openGaps} hueco(s) vacío(s)${extrapolated ? `, ${extrapolated} posición(es) mantenidas quietas fuera de lo observado (extrapoladas, no cuentan en ninguna métrica)` : ""}.`
    : "Tal como se midió, sin suavizar ni rellenar.";
  return { out, totals, note };
}
