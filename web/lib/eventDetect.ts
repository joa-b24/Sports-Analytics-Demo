// Detectors of events from positions (task ED-1, docs/definiciones_eventos.md). Pure functions: no file access, no React.
//
// What goes in: the corrected parts (players and ball, `Oriented`: the analysed team always attacks towards x = 105),
// the stretches of play of each video and the possession intervals (lib/possession.ts, only read: kind "control" and its
// team). What comes out: suggestions (DetectedEvent) that nobody has accepted: the analyst reviews them in
// Playground > Eventos. Nothing here uses the events tagged by hand.
//
// Decisions of the analyst in force:
//   - Restarts (throw_in, free_kick, corner, penalty, goal_kick) are marked at the RESTART (first movement of the stopped
//     ball), with the position of the stopped ball.
//   - foul (and offside, which comes out as foul too) is marked at the START of the pause; the review decides.
//   - loss is ANY change of possession; recovery is a detail added in the review, never emitted here.
//   - box_entry / final_third_entry: tracking + possession.
//   - cross: from any non-central lane to the central lane (5 lanes of W / 5); the detail says exterior or interior.
//   - Play stretches are JOINED to detect: a stretch that starts with the ball at rest on a corner, a free kick or a throw-in
//     is recognised as a restart even if its start was not seen (flag from_cut). Stretches closer than 0.1 s are one.
//
// A ball that is not measured (interpolated or missing) never decides a touch, a rest point or a crossing; only the
// measured samples are used. A ball not seen between two measured samples at the same spot is a ball at rest (the hole is
// kept in the flags: ball_gap). Geometry is in real meters of the venue, with own attacking to x = L; the output is in
// the units of the contract (105 x 68), like the events.
import { metersPerUnit, orient, unnamedLeftovers, type FixedFile, type FixedPosition, type Oriented } from "./positions.ts";
import type { PossessionRow } from "./possession.ts";
import type { Segment } from "./segments.ts";
import { PITCH } from "./types.ts";

export type DetectedType = "throw_in" | "corner" | "goal_kick" | "penalty" | "free_kick" | "foul" | "loss" | "final_third_entry" | "box_entry" | "cross";
export const DETECTED_TYPES: DetectedType[] = ["throw_in", "free_kick", "corner", "penalty", "goal_kick", "foul", "loss", "final_third_entry", "box_entry", "cross"];
export type DetectedTeam = "own" | "opp" | "unk";
export type Confidence = "high" | "medium" | "low";

export interface DetectedEvent {
  id: string;
  type: DetectedType;
  video_id: string;
  segment_id: string;
  t_video: number;
  x: number; // units of the contract (105 x 68), own attacking to x = 105
  y: number;
  x_end?: number | null; // corner and cross: where the ball went
  y_end?: number | null;
  team: DetectedTeam;
  player: string | null; // name from the squad; null if the person has none (flag unnamed)
  detail: string;
  rule: string;
  rule_version: string;
  confidence: Confidence;
  flags: string[];
}

// ------------------------------------------------------------------------------------------------- parameters
export interface EventParams {
  // ball at rest and restarts
  restRadiusM: number; // the ball moves less than this from where it was: it is still at rest
  restS: number; // seconds at rest before a restart counts
  moveM: number; // the ball must get this far from the rest point to count as a restart
  moveWindowS: number; // ... within this time after leaving the rest radius
  headS: number; // a restart seen at the start of a stretch must be taken within this time of the start
  gapEntryS: number; // a hole of the ball longer than this before the rest is a ball "not seen" (entry gap)
  takerM: number; // the taker is the nearest person within this distance of the stopped ball
  lineBandM: number; // throw-in: rest this close to a touchline
  cornerM: number; // corner: rest this close to a corner
  boxDepthM: number; // goal kick: rest within this depth of the goal line ...
  boxHalfM: number; // ... and this far from the middle of the goal
  penaltyM: number; // penalty: rest this close to the mark (11 m)
  penaltyS: number;
  freeKickS: number; // free kick: rest at least this long, players slow
  pauseSpeedMs: number; // median speed of the players during the rest below which it is a pause of the game
  centerM: number; // rest this close to the middle is a kick-off, not an event
  // possession change
  lossGapS: number; // control of the other team within this time of the last touch is a change
  lossBallTolS: number; // the last measured ball must be at most this far before the end of the interval
  // entries
  thirdFrac: number; // last third starts at this fraction of the pitch length (70 / 105)
  areaDepthM: number;
  areaHalfM: number;
  hystM: number; // before crossing the line the ball was at least this far behind it
  cooldownS: number;
  confirmS: number; // the team keeps the ball this long after crossing
  // cross
  crossMaxS: number;
  crossLateralM: number;
  crossInteriorOutsideBox: boolean; // from the interior lane only outside the box (inside it is a cut-back)
  // touch
  touchM: number; // a person this close to a measured ball touches it
  contestM: number; // two teams within this margin of each other: contested, no touch
}
export const EVENT_DEFAULTS: EventParams = {
  restRadiusM: 1.5,
  restS: 1.5,
  moveM: 3,
  moveWindowS: 2,
  headS: 20,
  gapEntryS: 2,
  takerM: 2.5,
  lineBandM: 1.5,
  cornerM: 3.5,
  boxDepthM: 6.5,
  boxHalfM: 10.5,
  penaltyM: 1.5,
  penaltyS: 3,
  freeKickS: 3,
  pauseSpeedMs: 1.5,
  centerM: 5,
  lossGapS: 5,
  lossBallTolS: 1.5,
  thirdFrac: 70 / 105,
  areaDepthM: 16.5,
  areaHalfM: 20.16,
  hystM: 3,
  cooldownS: 5,
  confirmS: 5,
  crossMaxS: 4,
  crossLateralM: 10,
  crossInteriorOutsideBox: true,
  touchM: 2,
  contestM: 0.5,
};

// The ball is "there" once it is this close to the point where it ends up resting.
const REST_ARRIVE_M = 0.5;
const REST_KEYS: (keyof EventParams)[] = ["restRadiusM", "restS", "moveM", "moveWindowS", "headS", "gapEntryS", "takerM", "touchM", "contestM"];
const FREE_KEYS: (keyof EventParams)[] = [...REST_KEYS, "freeKickS", "pauseSpeedMs", "centerM"];
const TOUCH_KEYS: (keyof EventParams)[] = ["touchM", "contestM"];
// The parameters that change what each type detects: the rule version of a type is the hash of these (and of the rule revision).
export const TYPE_KEYS: Record<DetectedType, (keyof EventParams)[]> = {
  throw_in: [...REST_KEYS, "lineBandM", "cornerM", "boxDepthM", "boxHalfM", "penaltyM", "centerM"],
  corner: [...REST_KEYS, "cornerM", "centerM"],
  goal_kick: [...REST_KEYS, "boxDepthM", "boxHalfM", "cornerM", "centerM"],
  penalty: [...REST_KEYS, "penaltyM", "penaltyS", "cornerM", "centerM"],
  free_kick: [...FREE_KEYS, "lineBandM", "cornerM", "boxDepthM", "boxHalfM", "penaltyM", "penaltyS"],
  foul: [...FREE_KEYS, "lineBandM", "cornerM", "boxDepthM", "boxHalfM", "penaltyM", "penaltyS"],
  loss: [...FREE_KEYS, "lineBandM", "cornerM", "boxDepthM", "boxHalfM", "penaltyM", "penaltyS", "lossGapS", "lossBallTolS"],
  final_third_entry: [...TOUCH_KEYS, "thirdFrac", "hystM", "cooldownS", "confirmS"],
  box_entry: [...TOUCH_KEYS, "areaDepthM", "areaHalfM", "hystM", "cooldownS", "confirmS"],
  cross: [...TOUCH_KEYS, "thirdFrac", "areaDepthM", "cornerM", "crossMaxS", "crossLateralM", "crossInteriorOutsideBox"],
};
// Revision of the code of the rules: bump it when a detector changes without changing its parameters.
export const EVENT_RULE_REV = 1;

export function ruleVersion(type: DetectedType, p: EventParams): string {
  const text = JSON.stringify([EVENT_RULE_REV, type, ...TYPE_KEYS[type].map((k) => [k, p[k]])]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
export const paramsFor = (p: Partial<EventParams> = {}): EventParams => ({ ...EVENT_DEFAULTS, ...p });

export const RULE_NAME: Record<DetectedType, string> = {
  throw_in: "restart.throw_in",
  corner: "restart.corner",
  goal_kick: "restart.goal_kick",
  penalty: "restart.penalty",
  free_kick: "restart.free_kick",
  foul: "pause.foul",
  loss: "possession.loss",
  final_third_entry: "entry.final_third",
  box_entry: "entry.box",
  cross: "cross.lane",
};

// ------------------------------------------------------------------------------------------------- samples
interface Cand {
  key: string;
  id: number;
  name: string | null;
  team: "own" | "opp";
  d: number;
  interp: boolean;
}
interface BS {
  video_id: string;
  chain: number;
  segment_id: string;
  frame: number;
  t: number;
  x: number; // meters, own attacking to x = L
  y: number;
  meas: boolean; // measured (not interpolated)
  out: boolean; // measured beyond a line
  touch: Cand | null; // a measured, uncontested touch
  nearOwn: Cand | null;
  nearOpp: Cand | null;
  near6: number; // persons of the two teams within 6 m
  ps: FixedPosition[] | null;
  f: FixedFile;
}
interface Chain {
  idx: number;
  video_id: string;
  start: number;
  end: number;
  samples: BS[];
}
interface Geo {
  mx: number;
  my: number;
  L: number;
  W: number;
  c: number;
}

const SRC_RANK: Record<string, number> = { manual: 3, auto: 2, event: 1, interpolated: 0 };
const closedPlay = (segs: Segment[] | undefined) => (segs ?? []).filter((g) => g.tipo === "juego" && g.end !== null).sort((a, b) => a.start - b.start);
const CONTINUOUS_S = 0.1;

function buildChains(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, p: EventParams): { chains: Chain[]; geo: Map<string, Geo> } {
  const chains: Chain[] = [];
  const geo = new Map<string, Geo>();
  const videos = [...new Set(parts.map((o) => o.file.video_id))];
  const playUsed = Object.keys(segmentsByVideo).some((v) => closedPlay(segmentsByVideo[v]).length > 0);
  for (const video of videos) {
    const segs = playUsed ? closedPlay(segmentsByVideo[video]) : [{ segment_id: "all", start: 0, end: Infinity as number | null, tipo: "juego" as const }];
    if (segs.length === 0) continue;
    const first = parts.find((o) => o.file.video_id === video) as Oriented;
    const [mx, my] = metersPerUnit(first.file);
    const g: Geo = { mx, my, L: PITCH.length * mx, W: PITCH.width * my, c: (PITCH.width * my) / 2 };
    geo.set(video, g);
    // Stretches closer than CONTINUOUS_S are one chain.
    const chainOfSeg: number[] = [];
    const base = chains.length;
    let idx = base - 1;
    segs.forEach((s, i) => {
      const prev = segs[i - 1];
      if (!prev || s.start - (prev.end as number) > CONTINUOUS_S) {
        idx++;
        chains.push({ idx, video_id: video, start: s.start, end: s.end as number, samples: [] });
      } else chains[idx].end = s.end as number;
      chainOfSeg.push(idx);
    });
    const byFrame = new Map<number, BS & { rank: number }>();
    for (const o of parts.filter((q) => q.file.video_id === video)) {
      const f = o.file;
      const leftover = new Set(unnamedLeftovers(f).map((l) => l.id));
      const person = new Map(f.people.map((q) => [q.id, q]));
      const posAt = new Map(f.frames.map((fr) => [fr.frame, fr.positions]));
      for (const b of f.ball) {
        const t = b.frame / f.fps;
        const si = segs.findIndex((s) => t >= s.start && t < (s.end as number));
        if (si < 0) continue;
        const rank = SRC_RANK[b.source] ?? 0;
        const prev = byFrame.get(b.frame);
        if (prev && prev.rank >= rank) continue;
        const [ox, oy] = orient(o, b.x, b.y);
        const x = ox * mx;
        const y = oy * my;
        const meas = b.source !== "interpolated";
        const ps = posAt.get(b.frame) ?? null;
        let nearOwn: Cand | null = null;
        let nearOpp: Cand | null = null;
        let near6 = 0;
        for (const q of ps ?? []) {
          const pe = person.get(q.id);
          if (!pe || (pe.team !== "own" && pe.team !== "opp") || leftover.has(q.id)) continue;
          const [qx, qy] = orient(o, q.x, q.y);
          const d = Math.hypot(qx * mx - x, qy * my - y);
          if (d > 6) continue;
          near6++;
          const cand: Cand = { key: `${f.start_frame}|${q.id}`, id: q.id, name: pe.player_id, team: pe.team, d, interp: q.source === "interpolated" };
          if (pe.team === "own") {
            if (!nearOwn || d < nearOwn.d) nearOwn = cand;
          } else if (!nearOpp || d < nearOpp.d) nearOpp = cand;
        }
        let touch: Cand | null = null;
        if (meas && nearOwn !== nearOpp) {
          const a = nearOwn && (!nearOpp || nearOwn.d <= nearOpp.d) ? nearOwn : nearOpp;
          const other = a === nearOwn ? nearOpp : nearOwn;
          if (a && a.d <= p.touchM && !a.interp && (!other || other.d - a.d >= p.contestM)) touch = a;
        }
        byFrame.set(b.frame, {
          rank,
          video_id: video,
          chain: chainOfSeg[si],
          segment_id: segs[si].segment_id,
          frame: b.frame,
          t,
          x,
          y,
          meas,
          out: meas && (x < -0.75 || x > g.L + 0.75 || y < -0.75 || y > g.W + 0.75),
          touch,
          nearOwn,
          nearOpp,
          near6,
          ps,
          f,
        });
      }
    }
    for (const s of [...byFrame.values()].sort((a, b) => a.frame - b.frame)) chains[s.chain].samples.push(s);
  }
  return { chains, geo };
}

// ------------------------------------------------------------------------------------------------- helpers
const other = (t: "own" | "opp"): "own" | "opp" => (t === "own" ? "opp" : "own");
const nameOf = (c: Cand | null) => c?.name ?? null;
const r2 = (v: number) => Math.round(v * 100) / 100;

// Median speed (m/s) of the measured persons between samples i0..i1 of a chain; null if fewer than 4 persons are followed.
function medianSpeed(ch: Chain, i0: number, i1: number, g: Geo): number | null {
  const dist = new Map<number, number>();
  const time = new Map<number, number>();
  let span = 0;
  for (let k = i0; k < i1; k++) {
    const a = ch.samples[k];
    const b = ch.samples[k + 1];
    if (!a.ps || !b.ps || a.f !== b.f) continue;
    const dt = (b.frame - a.frame) / a.f.fps;
    if (dt <= 0 || dt > 1) continue;
    span += dt;
    const next = new Map(b.ps.map((q) => [q.id, q]));
    for (const q of a.ps) {
      const r = next.get(q.id);
      if (!r || q.source === "interpolated" || r.source === "interpolated") continue;
      dist.set(q.id, (dist.get(q.id) ?? 0) + Math.hypot((r.x - q.x) * g.mx, (r.y - q.y) * g.my));
      time.set(q.id, (time.get(q.id) ?? 0) + dt);
    }
  }
  const sp = [...dist].filter(([id]) => (time.get(id) ?? 0) >= 0.5 * span && span > 0).map(([id, d]) => d / (time.get(id) as number)).sort((a, b) => a - b);
  return sp.length >= 4 ? sp[sp.length >> 1] : null;
}

function confidenceOf(flags: string[]): Confidence {
  const n = flags.filter((f) => f !== "unnamed" && f !== "from_cut").length + (flags.includes("from_cut") ? 1 : 0);
  return n === 0 ? "high" : n === 1 ? "medium" : "low";
}

interface Restart {
  video_id: string;
  chain: number;
  type: "center" | "throw_in" | "corner" | "goal_kick" | "penalty" | "free_kick";
  team: DetectedTeam;
  t_start: number;
  t_res: number;
}

// ------------------------------------------------------------------------------------------------- main
export function detectEvents(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, possessionRows: PossessionRow[], params: Partial<EventParams> = {}): DetectedEvent[] {
  const p = paramsFor(params);
  const possession = [...possessionRows].sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_start - b.t_start);
  const { chains, geo } = buildChains(parts, segmentsByVideo, p);
  const out: DetectedEvent[] = [];
  const restarts: Restart[] = [];
  const versions = Object.fromEntries(DETECTED_TYPES.map((t) => [t, ruleVersion(t, p)])) as Record<DetectedType, string>;

  const emit = (e: Omit<DetectedEvent, "id" | "rule" | "rule_version" | "confidence"> & { confidence?: Confidence }, g: Geo) => {
    const flags = [...new Set(e.flags)];
    const ev: DetectedEvent = {
      ...e,
      x: r2(e.x / g.mx),
      y: r2(e.y / g.my),
      x_end: e.x_end === undefined || e.x_end === null ? e.x_end : r2(e.x_end / g.mx),
      y_end: e.y_end === undefined || e.y_end === null ? e.y_end : r2(e.y_end / g.my),
      t_video: r2(e.t_video),
      id: `${e.type}|${e.video_id}|${r2(e.t_video).toFixed(2)}|${e.team}`,
      rule: RULE_NAME[e.type],
      rule_version: versions[e.type],
      flags,
      confidence: e.confidence ?? confidenceOf(flags),
    };
    out.push(ev);
    return ev;
  };

  // ---------------- restarts and pauses (per chain)
  for (const ch of chains) {
    const g = geo.get(ch.video_id) as Geo;
    const M: number[] = [];
    ch.samples.forEach((s, i) => {
      if (s.meas) M.push(i);
    });
    const prevChain = chains.find((c) => c.video_id === ch.video_id && c.idx === ch.idx - 1);
    let m = 0;
    while (m < M.length) {
      const a0 = ch.samples[M[m]];
      // The rest run: measured samples inside restRadiusM of the first one (a lone outlier is skipped).
      let e = m;
      for (let j = m + 1; j < M.length; j++) {
        const s = ch.samples[M[j]];
        if (Math.hypot(s.x - a0.x, s.y - a0.y) <= p.restRadiusM) {
          e = j;
          continue;
        }
        let back = false;
        for (let k = j + 1; k <= Math.min(M.length - 1, j + 2); k++) if (Math.hypot(ch.samples[M[k]].x - a0.x, ch.samples[M[k]].y - a0.y) <= p.restRadiusM) back = true;
        if (!back) break;
      }
      // The rest point is the median of the run (the first and last samples may be the ball arriving or leaving); the rest
      // starts when the ball got there and ends at the last sample still there.
      const xs = [];
      const ys = [];
      for (let k = m; k <= e; k++) {
        xs.push(ch.samples[M[k]].x);
        ys.push(ch.samples[M[k]].y);
      }
      xs.sort((u, v) => u - v);
      ys.sort((u, v) => u - v);
      const rx = xs[xs.length >> 1];
      const ry = ys[ys.length >> 1];
      const here = (k: number) => Math.hypot(ch.samples[M[k]].x - rx, ch.samples[M[k]].y - ry) <= REST_ARRIVE_M;
      let sIdx = m;
      while (sIdx < e && !here(sIdx)) sIdx++;
      let eIdx = e;
      while (eIdx > sIdx && !here(eIdx)) eIdx--;
      const a = ch.samples[M[sIdx]];
      const last = { ...ch.samples[M[eIdx]], x: rx, y: ry };
      const dur = last.t - a.t;
      const farOut = last.x < -2 || last.x > g.L + 2 || last.y < -2 || last.y > g.W + 2;
      if (dur < p.restS || e + 1 >= M.length || farOut) {
        m = Math.max(m + 1, e === m ? m + 1 : e);
        continue;
      }
      // Confirm that it leaves: some measured sample moveM away within moveWindowS of the first one outside the radius.
      const k0 = e + 1;
      let left = -1;
      for (let k = k0; k < M.length && ch.samples[M[k]].t - ch.samples[M[k0]].t <= p.moveWindowS; k++) {
        if (Math.hypot(ch.samples[M[k]].x - last.x, ch.samples[M[k]].y - last.y) >= p.moveM) {
          left = k;
          break;
        }
      }
      if (left < 0) {
        m = e + 1;
        continue;
      }
      const nextRest = e + 1;
      // Entry: how the ball got there.
      const prev = sIdx > 0 ? ch.samples[M[sIdx - 1]] : null;
      let entry: "cut" | "out" | "gap" | "live";
      let outBefore = a.out;
      for (let k = Math.max(0, sIdx - 3); k < sIdx; k++) if (ch.samples[M[k]].out) outBefore = true;
      for (let k = sIdx; k <= e; k++) if (ch.samples[M[k]].out) outBefore = true;
      if (!prev) entry = a.t - ch.start <= 5 ? "cut" : "gap";
      else if (outBefore) entry = "out";
      else if (a.t - prev.t > p.gapEntryS) entry = "gap";
      else entry = "live";
      if (entry === "cut" && last.t - ch.start > p.headS) {
        m = nextRest;
        continue;
      }
      const flags: string[] = [];
      if (entry === "cut") flags.push("from_cut");
      if (entry === "gap") flags.push("ball_gap");
      const gapAfter = ch.samples[M[nextRest]].t - last.t;
      if (gapAfter > 1) flags.push("ball_gap");
      const ax = last.x;
      const ay = last.y;
      const aOut = outBefore && (ax < 0 || ax > g.L || ay < 0 || ay > g.W);
      // Taker: the nearest person to the stopped ball in its last second.
      let taker: Cand | null = null;
      for (let k = e; k >= sIdx && last.t - ch.samples[M[k]].t <= 1; k--) {
        const s = ch.samples[M[k]];
        for (const c of [s.nearOwn, s.nearOpp]) if (c && c.d <= p.takerM && !c.interp && (!taker || c.d < taker.d)) taker = c;
      }
      if (!taker) {
        for (let k = nextRest; k < M.length && ch.samples[M[k]].t - last.t <= 4; k++) {
          const c = ch.samples[M[k]].touch;
          if (c) {
            taker = c;
            break;
          }
        }
      }
      const cornerD = Math.min(...[[0, 0], [0, g.W], [g.L, 0], [g.L, g.W]].map(([cx, cy]) => Math.hypot(ax - cx, ay - cy)));
      const goalLineD = Math.min(ax, g.L - ax);
      const lastPoss = (): DetectedTeam => {
        for (let i = rowsBefore(possession, ch.video_id, a.t); i >= 0; i--) {
          const r = possession[i];
          if (r.video_id !== ch.video_id || a.t - r.t_end > 8) return "unk";
          if (r.kind === "control" && r.team !== "none") return other(r.team);
        }
        return "unk";
      };
      let type: Restart["type"] | null = null;
      let team: DetectedTeam = "unk";
      if (Math.hypot(ax - g.L / 2, ay - g.c) <= p.centerM) type = "center";
      else if (cornerD <= p.cornerM) {
        type = "corner";
        team = ax > g.L / 2 ? "own" : "opp";
      } else if (goalLineD <= p.boxDepthM && Math.abs(ay - g.c) <= p.boxHalfM && entry !== "live") {
        type = "goal_kick";
        team = ax < g.L / 2 ? "own" : "opp";
      } else if (Math.min(Math.hypot(ax - 11, ay - g.c), Math.hypot(ax - (g.L - 11), ay - g.c)) <= p.penaltyM && dur >= p.penaltyS && ch.samples[M[Math.floor((sIdx + e) / 2)]].near6 <= 2) {
        type = "penalty";
        team = ax > g.L / 2 ? "own" : "opp";
      } else if (ay <= p.lineBandM || ay >= g.W - p.lineBandM || aOut) {
        type = "throw_in";
      } else if (dur >= p.freeKickS || (entry === "cut" && dur >= p.restS)) {
        type = "free_kick";
      }
      if (type !== null) {
        // The pause of the game: for a free kick or a penalty the players are almost still.
        let pauseOk = true;
        if (type === "free_kick" || type === "penalty") {
          const lo = M[sIdx];
          const hi = M[eIdx];
          const sp = medianSpeed(ch, lo, hi, g);
          if (sp === null) {
            pauseOk = false;
          } else if (sp >= p.pauseSpeedMs) pauseOk = false;
        }
        if (pauseOk) {
          if (type === "free_kick") team = taker ? taker.team : "unk";
          if (type === "throw_in") {
            const fb = lastPoss();
            if (taker && fb !== "unk" && fb !== taker.team) flags.push("team_discrepancy");
            team = taker ? taker.team : fb;
            if (!taker && fb !== "unk") flags.push("team_fallback");
          }
          if (team === "unk") flags.push("team_unk");
          if (taker && !taker.name) flags.push("unnamed");
          // Where the ball goes after a corner: the first touch of someone other than the taker within 4 s.
          let xe: number | null = null;
          let ye: number | null = null;
          if (type === "corner") {
            for (let k = nextRest; k < M.length && ch.samples[M[k]].t - last.t <= 4; k++) {
              const s = ch.samples[M[k]];
              if (s.touch && (!taker || s.touch.key !== taker.key)) {
                xe = s.x;
                ye = s.y;
                break;
              }
            }
          }
          restarts.push({ video_id: ch.video_id, chain: ch.idx, type, team, t_start: a.t, t_res: last.t });
          if (type !== "center") {
            const player = taker && taker.team === team ? nameOf(taker) : null;
            emit({ type, video_id: ch.video_id, segment_id: last.segment_id, t_video: last.t, x: ax, y: ay, x_end: xe, y_end: ye, team, player, detail: entry === "cut" ? "desde un corte" : "", flags: [...flags] }, g);
            if (type === "free_kick" || type === "penalty") {
              // The foul: at the start of the pause. Across a cut, the end of the previous stretch.
              const fteam: DetectedTeam = team === "unk" ? "unk" : other(team);
              if (entry === "cut") {
                const pc = prevChain;
                const ps = pc ? pc.samples.filter((s) => s.meas) : [];
                const lastP = ps.length ? ps[ps.length - 1] : null;
                if (pc && lastP && pc.end - lastP.t <= 3) {
                  emit({ type: "foul", video_id: ch.video_id, segment_id: lastP.segment_id, t_video: lastP.t, x: lastP.x, y: lastP.y, team: fteam, player: null, detail: type === "penalty" ? "penal" : "", flags: ["from_cut", "cut_stop", ...(fteam === "unk" ? ["team_unk"] : [])] }, g);
                }
              } else if (entry !== "out") {
                emit({ type: "foul", video_id: ch.video_id, segment_id: a.segment_id, t_video: a.t, x: ax, y: ay, team: fteam, player: null, detail: type === "penalty" ? "penal" : "", flags: [...flags.filter((f) => f !== "from_cut"), ...(fteam === "unk" ? ["team_unk"] : [])] }, g);
              }
            }
          }
        }
      }
      m = nextRest;
    }
  }

  // ---------------- possession change
  const ctrl = new Map<string, PossessionRow[]>();
  for (const r of possession) if (r.kind === "control" && r.team !== "none") ctrl.set(r.video_id, [...(ctrl.get(r.video_id) ?? []), r]);
  const chainAt = (video: string, t: number) => chains.find((c) => c.video_id === video && t >= c.start - 1e-6 && t <= c.end + 1e-6) ?? null;
  for (const [video, rows] of ctrl) {
    rows.sort((a, b) => a.t_start - b.t_start);
    const g = geo.get(video);
    if (!g) continue;
    for (let i = 0; i + 1 < rows.length; i++) {
      const A = rows[i];
      const B = rows[i + 1];
      if (A.team === B.team) continue;
      const cA = chainAt(video, A.t_end - 0.05);
      const cB = chainAt(video, B.t_start + 0.05);
      if (!cA || !cB || cA.idx !== cB.idx) continue;
      const gap = B.t_start - A.t_end;
      let detail = "";
      const between = possession.filter((r) => r.video_id === video && r.t_start >= A.t_end - 1e-6 && r.t_end <= B.t_start + 1e-6);
      const rs = restarts.find((r) => r.video_id === video && r.t_res >= A.t_end - 0.5 && r.t_res <= B.t_start + 1);
      if (rs && rs.type === "center") continue;
      if (gap <= p.lossGapS) {
        detail = rs ? (rs.type === "free_kick" || rs.type === "penalty" ? "falta" : "sale") : between.some((r) => r.kind === "contested") ? "disputa" : "directa";
      } else if (rs && rs.team === B.team) detail = rs.type === "free_kick" || rs.type === "penalty" ? "falta" : "sale";
      else continue;
      // Last touch of the team that loses it: the last measured touch inside its interval.
      let touchS: BS | null = null;
      for (let k = cA.samples.length - 1; k >= 0; k--) {
        const s = cA.samples[k];
        if (s.t > A.t_end + 1e-6) continue;
        if (s.t < A.t_start - 1e-6) break;
        if (s.touch && s.touch.team === A.team) {
          touchS = s;
          break;
        }
      }
      const flags: string[] = [];
      let at: BS | null = touchS;
      if (!at) {
        flags.push("no_touch_sample");
        for (let k = cA.samples.length - 1; k >= 0; k--) {
          const s = cA.samples[k];
          if (s.t > A.t_end + 1e-6) continue;
          if (s.meas) {
            at = s;
            break;
          }
        }
        if (!at || A.t_end - at.t > p.lossBallTolS) continue;
      }
      if (touchS && !touchS.touch?.name) flags.push("unnamed");
      emit({ type: "loss", video_id: video, segment_id: at.segment_id, t_video: at.t, x: at.x, y: at.y, team: A.team as "own" | "opp", player: touchS ? nameOf(touchS.touch) : null, detail, flags }, g);
    }
  }

  // ---------------- entries to the last third and to the box
  const teamAt = (video: string, t: number): DetectedTeam => {
    const rows = ctrl.get(video) ?? [];
    const i = rowsBefore(rows, video, t + 1e-6);
    const r = rows[i];
    return r && t < r.t_end + 1e-6 && r.team !== "none" ? r.team : "unk";
  };
  for (const ch of chains) {
    const g = geo.get(ch.video_id) as Geo;
    const M = ch.samples.filter((s) => s.meas);
    const lines: { type: DetectedType; X: number; inBox: boolean }[] = [
      { type: "final_third_entry", X: p.thirdFrac * g.L, inBox: false },
      { type: "box_entry", X: g.L - p.areaDepthM, inBox: true },
    ];
    for (const team of ["own", "opp"] as const) {
      const xa = (s: BS) => (team === "own" ? s.x : g.L - s.x);
      for (const ln of lines) {
        let lastAt = -Infinity;
        for (let k = 1; k < M.length; k++) {
          const a = M[k - 1];
          const b = M[k];
          if (b.t - a.t > 1 || b.out || a.out) continue;
          if (!(xa(a) < ln.X && xa(b) >= ln.X)) continue;
          if (ln.inBox && Math.abs(b.y - g.c) > p.areaHalfM) continue;
          // Behind the line before: at least hystM, within the last 6 s.
          let behind = false;
          for (let q = k - 1; q >= 0 && b.t - M[q].t <= 6; q--) if (xa(M[q]) <= ln.X - p.hystM) behind = true;
          if (!behind || b.t - lastAt < p.cooldownS) continue;
          if (teamAt(ch.video_id, b.t) !== team) continue;
          // She keeps it: no control of the other team starts within confirmS.
          const rowsO = (ctrl.get(ch.video_id) ?? []).filter((r) => r.team !== team && r.t_start > b.t - 1e-6 && r.t_start <= b.t + p.confirmS);
          if (rowsO.length > 0) continue;
          const flags: string[] = [];
          if (ch.end - b.t < p.confirmS) {
            if (!ln.inBox) continue;
            flags.push("truncated");
          }
          const near = team === "own" ? (b.nearOwn ?? a.nearOwn) : (b.nearOpp ?? a.nearOpp);
          const who = near && near.d <= 3.5 ? near : null;
          if (who && !who.name) flags.push("unnamed");
          lastAt = b.t;
          emit({ type: ln.type, video_id: ch.video_id, segment_id: b.segment_id, t_video: b.t, x: b.x, y: b.y, team, player: nameOf(who), detail: "", flags }, g);
        }
      }
    }
  }

  // ---------------- crosses
  for (const ch of chains) {
    const g = geo.get(ch.video_id) as Geo;
    const M = ch.samples.filter((s) => s.meas);
    const half = g.W / 10; // the central lane is W / 5 wide
    const X3 = p.thirdFrac * g.L;
    let k = 0;
    while (k < M.length) {
      const s0 = M[k];
      if (!s0.touch) {
        k++;
        continue;
      }
      const who = s0.touch;
      let e = k;
      while (e + 1 < M.length && M[e + 1].t - M[e].t <= 0.5 && M[e + 1].touch?.key === who.key) e++;
      const rel = M[e];
      k = e + 1;
      const team = who.team;
      const xa = (s: BS) => (team === "own" ? s.x : g.L - s.x);
      const dy = Math.abs(rel.y - g.c);
      if (dy <= half || xa(rel) < X3) continue;
      const exterior = dy >= (3 * g.W) / 10;
      const cornerD = Math.min(Math.hypot(rel.x, Math.min(rel.y, g.W - rel.y)), Math.hypot(g.L - rel.x, Math.min(rel.y, g.W - rel.y)));
      if (cornerD <= p.cornerM) continue;
      if (!exterior && p.crossInteriorOutsideBox && xa(rel) >= g.L - p.areaDepthM) continue;
      let dest: BS | null = null;
      for (let q = e + 1; q < M.length && M[q].t - rel.t <= p.crossMaxS; q++) {
        const s = M[q];
        if (s.touch?.key === who.key) break;
        if (!s.out && Math.abs(s.y - g.c) <= half && Math.abs(s.y - rel.y) >= p.crossLateralM && xa(s) >= X3) {
          dest = s;
          break;
        }
        if (s.touch) break;
      }
      if (!dest) continue;
      const flags: string[] = [];
      if (!who.name) flags.push("unnamed");
      if (dest.t - M[M.indexOf(dest) - 1].t > 1.5) flags.push("ball_gap");
      emit({ type: "cross", video_id: ch.video_id, segment_id: rel.segment_id, t_video: rel.t, x: rel.x, y: rel.y, x_end: dest.x, y_end: dest.y, team, player: nameOf(who), detail: exterior ? "exterior" : "interior", flags }, g);
    }
  }

  return out.sort((a, b) => a.video_id.localeCompare(b.video_id) || a.t_video - b.t_video || a.type.localeCompare(b.type));
}

// Index of the last row with t_start <= t in a list sorted by time (all of one video, or the whole list); -1 if none.
function rowsBefore(rows: PossessionRow[], video: string, t: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    const before = r.video_id < video || (r.video_id === video && r.t_start <= t);
    if (before) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
