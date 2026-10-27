// Possession as intervals (table possession_<video>, docs/definiciones_eventos.md 1.2) read from the positions of the
// corrected parts: players and ball, with the positions filled in holes ("interpolated") INCLUDED (decision of the
// analyst), each interval saying how much of it rests on interpolated data and on which ball source. Whoever consumes the
// table can filter by those flags; nothing is dropped here for being interpolated. Pure functions, no file access.
//
// Rules (parameters in POSSESSION_DEFAULTS, all calibratable):
//   - A touch: the nearest person within controlM (2 m) of the ball, if she can hold it (a team's player with a name or in
//     a team without names). If the nearest is a referee, someone with no team or a nameless leftover, the frame is
//     "blocked" (nobody), not handed to the next-nearest player (decideHolder, lib/positions.ts). Players of both teams
//     about as near: contested.
//   - Control: touches of one team held for controlS (0.3 s), the ball slower than maxCtrlSpeedMs (8 m/s) over the run,
//     tolerating gaps of gapS (0.3 s). A ball that only passes by is a touch, not a control.
//   - A control is CREDITED to a team only if it holds a MEASURED contact: a sample whose ball is measured (hand mark, tracker
//     or tagged event, not interpolated) and whose nearest person is measured too (not a filled-in hole). Positions
//     already interpolated are still used to compute everything else; a run of touches with no measured contact is
//     `unknown` with no team (flag no_measured_touch) and stays out of the percentage.
//   - What happens between two controls (the ball in flight) is decided looking FORWARD, with no time cap:
//       * the next credited control is of the same team as the last one: the whole gap is hers (kind control, flag flight);
//       * it is of the other team: nobody had it (kind loose, flag flight_lost) and the change happens at that control;
//       * there is none (a break, the end of the chain): the team keeps it holdS (3 s) after its last MEASURED touch and
//         only on a measured ball, never over interpolated positions.
//   - Restart gap: between two measured positions of the ball, a hole longer than restGapS (2 s) crossed at less than
//     restFlightMinMs (3 m/s on average, straight line / time) is a pause of the game (the ball was not seen, the
//     interpolation draws a slow flight to the restart): kind dead, no team, flag restart_gap. At that speed or more
//     it is a flight, however long it lasts.
//   - Still ball: within stillRadiusM (1.5 m) of where it was for stillS (4 s) or more is dead too, a player next to it or not
//     (the analyst holds the ball with «quieto» while a restart is prepared).
//   - A contested ball keeps the previous holder for contestedHoldS (2 s). A blocked frame, a ball out of the pitch or at
//     rest (dead) ends it. Contested samples with both boxes and the ball measured are listed as doubts (possessionDoubts).
//   - Tracker positions that jump faster than a ball can move (ballJumpFrames) are never a touch.
//   - Play stretches are JOINED: the video between two of them was skipped, but the ball is followed through the cut when
//     it is within joinCutMaxM of where it was (flag joined_cut). Farther, the state restarts (flag cut_reset). Never
//     across videos.
//   - kind says how solid an interval is: control (a sustained touch with a measured ball), contested, loose (nobody
//     has it), dead (out / at rest) or unknown (blocked, tracker jump, or a touch seen only on an interpolated ball: the
//     team is credited but there is no measured touch behind it: flag no_measured_touch).
import { ballJumpFrames } from "./parts.ts";
import { COVER_STEP_S, CONTEST_MARGIN_M, POSSESS_M, decideHolder, metersPerUnit, unnamedLeftovers, type FixedTeam, type HolderCand, type Oriented, type PossessionState } from "./positions.ts";
import type { Segment } from "./segments.ts";
import { colorDistance, MAX_COLOR_DISTANCE } from "./tracks.ts";
import { PITCH } from "./types.ts";

type Side = "own" | "opp";
export type PossessionTeam = Side | "none";
export type PossessionKind = "control" | "contested" | "loose" | "dead" | "unknown";
export type BallSrc = "manual" | "auto" | "event" | "interp";
export type Lab = [number, number, number];

export interface PossessionParams {
  controlM: number;
  controlS: number;
  contestMarginM: number;
  maxCtrlSpeedMs: number;
  gapS: number;
  holdS: number;
  contestedHoldS: number;
  restSpeedMs: number;
  restS: number;
  outMarginM: number;
  joinSegments: boolean;
  joinCutMaxM: number;
  // Restart gap (see header): hole of the measured ball longer than restGapS crossed slower than restFlightMinMs.
  restFlightMinMs: number;
  restGapS: number;
  // Still ball: the ball stays within stillRadiusM of where a stretch began for stillS or more (a ball held in place by the
  // analyst with «quieto», or waiting for a restart), even with a player next to it: dead, no team.
  stillRadiusM: number;
  stillS: number;
}
export const POSSESSION_DEFAULTS: PossessionParams = {
  controlM: POSSESS_M,
  controlS: 0.3,
  contestMarginM: CONTEST_MARGIN_M,
  maxCtrlSpeedMs: 8,
  gapS: 0.3,
  holdS: 3, // from the last measured touch, only over a measured ball (PASS_MAX_S was 5 and ran over interpolated ball)
  contestedHoldS: 2,
  restSpeedMs: 0.5,
  restS: 1.5,
  outMarginM: 0.75,
  joinSegments: true,
  joinCutMaxM: 12,
  restFlightMinMs: 3,
  restGapS: 2,
  stillRadiusM: 1.5,
  stillS: 4,
};

// Share of the assigned seconds read from the unreviewed tracker ball above which the report warns.
export const AUTO_WARN_SHARE = 0.5;

// ------------------------------------------------------------------------------------------------- rows
export interface PossessionFlags {
  ball_interp: boolean; // part of the interval rests on an interpolated ball
  player_interp: boolean; // a player counted as holder was at an interpolated position
  ball_source: BallSrc | "mixed"; // the source with most seconds
  ball_s: Record<BallSrc, number>; // seconds by ball source
  notes: string[]; // joined_cut, cut_reset, blocked, ball_jump, no_measured_touch, flight, flight_lost, restart_gap, rest, out, ...
}
export interface PossessionRow {
  video_id: string;
  segment_id: string; // the first stretch it touches; see notes `joined_cut`
  t_start: number;
  t_end: number;
  team: PossessionTeam;
  first_player: string | null;
  last_player: string | null;
  kind: PossessionKind;
  flags: PossessionFlags;
}

// The two boxes about as near to the ball in a contested sample.
export interface ContestBox {
  key: string;
  id: number;
  team: FixedTeam;
  name: string | null;
  d: number; // meters to the ball
  interp: boolean;
}
export interface Contest {
  a: ContestBox; // the nearest
  b: ContestBox; // the nearest of the other team
  margin: number; // b.d - a.d
}

// One ball position with what was decided about it. Time is the video's.
export interface PossessionSample {
  video_id: string;
  part: number; // start_frame of the part it was read from
  segment_id: string;
  frame: number;
  t0: number;
  t1: number;
  followed: boolean;
  src: BallSrc;
  team: PossessionTeam;
  kind: PossessionKind;
  player_interp: boolean;
  notes: string[];
  owner: string | null; // key of the person who decided the sample (holder or blocker), see personKey
  // The sample is itself a measured contact (ball and box measured) inside a credited control.
  contact: boolean;
  contest: Contest | null;
}
export interface PossessionResult {
  rows: PossessionRow[];
  samples: PossessionSample[];
  params: PossessionParams;
}

// ------------------------------------------------------------------------------------------------- prepare
export const personKey = (video_id: string, part: number, id: number) => `${video_id}|${part}|${id}`;

interface PCand extends HolderCand {
  key: string;
  name: string | null;
}
interface PSample {
  video_id: string;
  part: number;
  segment_id: string;
  seg: number;
  frame: number;
  t: number;
  dt: number;
  pt: number; // play clock: seconds of play since the video's first stretch (the cuts squeezed out)
  mx: number; // ball in meters of the venue
  my: number;
  source: string;
  src: BallSrc;
  jump: boolean;
  followed: boolean;
  out: boolean;
  noPlayers: boolean;
  speed: number | null; // m/s to the previous sample of the chain
  restGap: boolean; // an interpolated sample inside a slow hole between two measured ones (see header)
  cutBefore: "joined" | "reset" | null;
  cands: PCand[];
}
export interface PreparedPossession {
  samples: PSample[];
  playUsed: boolean;
  names: Map<string, { name: string | null; team: FixedTeam; video_id: string; part: number; id: number }>;
}

const SRC_RANK: Record<string, number> = { manual: 3, auto: 2, event: 1, interpolated: 0 };
const srcOf = (s: string): BallSrc => (s === "interpolated" ? "interp" : s === "manual" || s === "auto" ? s : "event");
const closedPlay = (segs: Segment[] | undefined) =>
  (segs ?? []).filter((g) => g.tipo === "juego" && g.end !== null).sort((a, b) => a.start - b.start);

// Ball positions of all the parts of each video, in play stretches, one per frame, with the people near each.
export function preparePossession(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, p: PossessionParams = POSSESSION_DEFAULTS): PreparedPossession {
  const playUsed = Object.keys(segmentsByVideo).some((v) => closedPlay(segmentsByVideo[v]).length > 0);
  const out: PSample[] = [];
  const names: PreparedPossession["names"] = new Map();
  const videos = [...new Set(parts.map((o) => o.file.video_id))];
  for (const video of videos) {
    const segs = playUsed ? closedPlay(segmentsByVideo[video]) : [{ segment_id: "all", start: 0, end: Infinity as number | null, tipo: "juego" as const }];
    if (segs.length === 0) continue;
    const offsets: number[] = [];
    let acc = 0;
    for (const g of segs) {
      offsets.push(acc);
      acc += (g.end as number) - g.start;
    }
    const byFrame = new Map<number, PSample>();
    for (const o of parts.filter((q) => q.file.video_id === video)) {
      const f = o.file;
      const [mx, my] = metersPerUnit(f);
      const leftover = new Set(unnamedLeftovers(f).map((l) => l.id));
      const person = new Map(f.people.map((q) => [q.id, q]));
      const posAt = new Map(f.frames.map((fr) => [fr.frame, fr.positions]));
      const jumps = ballJumpFrames(f.ball, f.fps, mx, my);
      const marks = f.ball.filter((b) => b.source === "manual" || b.source === "auto").map((b) => b.frame).sort((a, b) => a - b);
      const followedAt = (frame: number) => {
        let lo = 0;
        let hi = marks.length - 1;
        if (hi < 0) return false;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (marks[mid] < frame) lo = mid + 1;
          else hi = mid;
        }
        return Math.min(Math.abs(marks[lo] - frame), lo > 0 ? Math.abs(marks[lo - 1] - frame) : Infinity) / f.fps <= 3;
      };
      for (const b of f.ball) {
        const t = b.frame / f.fps;
        const seg = segs.findIndex((g) => t >= g.start && t < (g.end as number));
        if (seg < 0) continue;
        const prev = byFrame.get(b.frame);
        if (prev && (SRC_RANK[prev.source] ?? 0) >= (SRC_RANK[b.source] ?? 0)) continue;
        const ps = posAt.get(b.frame);
        const bx = b.x * mx;
        const by = b.y * my;
        const cands: PCand[] = (ps ?? []).flatMap((q) => {
          const pe = person.get(q.id);
          if (!pe) return [];
          const key = personKey(video, f.start_frame, q.id);
          if (!names.has(key)) names.set(key, { name: pe.player_id, team: pe.team, video_id: video, part: f.start_frame, id: q.id });
          return [{ id: q.id, key, name: pe.player_id, team: pe.team, d: Math.hypot(q.x * mx - bx, q.y * my - by), x: q.x * mx, y: q.y * my, leftover: leftover.has(q.id), interp: q.source === "interpolated" }];
        });
        const lenM = PITCH.length * mx;
        const widM = PITCH.width * my;
        byFrame.set(b.frame, {
          video_id: video,
          part: f.start_frame,
          segment_id: segs[seg].segment_id,
          seg,
          frame: b.frame,
          t,
          dt: 0,
          pt: t - segs[seg].start + offsets[seg],
          mx: bx,
          my: by,
          source: b.source,
          src: srcOf(b.source),
          jump: b.source === "auto" && jumps.has(b.frame),
          followed: b.source === "manual" || b.source === "auto" || followedAt(b.frame),
          out: b.source !== "interpolated" && (bx < -p.outMarginM || bx > lenM + p.outMarginM || by < -p.outMarginM || by > widM + p.outMarginM),
          noPlayers: !ps,
          speed: null,
          restGap: false,
          cutBefore: null,
          cands: cands.filter((c) => c.d <= p.controlM + 1e-9),
        });
      }
    }
    const list = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
    const stride = parts.find((o) => o.file.video_id === video)?.file;
    const fps = stride?.fps ?? 30;
    list.forEach((s, i) => {
      const next = list[i + 1];
      const step = Math.max(1, stride?.stride ?? 1);
      const frames = next ? Math.max(1, Math.min(step, next.frame - s.frame)) : step;
      const segEnd = segs[s.seg].end as number;
      s.dt = Math.min(frames / fps, Math.max(1e-3, segEnd - s.t));
      const prev = list[i - 1];
      if (!prev) return;
      const gap = (s.frame - prev.frame) / fps;
      if (s.seg !== prev.seg) {
        // A cut between play stretches: joined while the ball stays where it was.
        const dist = Math.hypot(s.mx - prev.mx, s.my - prev.my);
        s.cutBefore = p.joinSegments && dist <= p.joinCutMaxM ? "joined" : "reset";
      } else if (gap > 0 && gap <= 0.5) s.speed = Math.hypot(s.mx - prev.mx, s.my - prev.my) / gap;
    });
    // Restart gaps: between two consecutive measured positions of the ball (same chain, no cut reset), a hole longer than
    // restGapS crossed at less than restFlightMinMs is a pause, not a flight.
    let lastM = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].src === "interp") continue;
      const a = lastM;
      lastM = i;
      if (a < 0 || i - a < 2) continue;
      let chain = true;
      for (let k = a + 1; k <= i; k++) if (list[k].cutBefore === "reset") chain = false;
      if (!chain) continue;
      const gap = list[i].pt - list[a].pt;
      if (gap <= p.restGapS) continue;
      if (Math.hypot(list[i].mx - list[a].mx, list[i].my - list[a].my) / gap < p.restFlightMinMs) for (let k = a + 1; k < i; k++) list[k].restGap = true;
    }
    out.push(...list);
  }
  return { samples: out, playUsed, names };
}

// ------------------------------------------------------------------------------------------------- label
export type Overrides = Map<string, Side | "none">;
type Base = "T" | "C" | "B" | "F" | "N";

const ownerName = (prep: PreparedPossession, key: string | null) => {
  if (!key) return null;
  const n = prep.names.get(key);
  return n ? (n.name ?? `#${n.id}`) : null;
};

// Decides every sample (touch / contested / blocked / free) and then the possession over the chain of samples.
export function labelPossession(prep: PreparedPossession, p: PossessionParams = POSSESSION_DEFAULTS, overrides: Overrides = new Map()): PossessionResult {
  const S = prep.samples;
  const n = S.length;
  const base: Base[] = new Array(n);
  const holderKey: (string | null)[] = new Array(n).fill(null);
  const holderTeam: (Side | null)[] = new Array(n).fill(null);
  const holderInterp: boolean[] = new Array(n).fill(false);
  const blockerKey: (string | null)[] = new Array(n).fill(null);
  const contest: (Contest | null)[] = new Array(n).fill(null);
  const boxOf = (c: PCand): ContestBox => ({ key: c.key, id: c.id, team: c.team, name: c.name, d: c.d, interp: c.interp });
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (s.noPlayers) {
      base[i] = "N";
      continue;
    }
    const cands = s.cands.flatMap((c) => {
      const o = overrides.get(c.key);
      return o === undefined ? [c] : o === "none" ? [] : [{ ...c, team: o as FixedTeam }];
    });
    const dec = decideHolder(cands, p.controlM, p.contestMarginM);
    if (s.jump) {
      // A tracker position inside an impossible jump: never a touch.
      base[i] = "F";
    } else if (dec.kind === "touch") {
      base[i] = "T";
      holderKey[i] = dec.cand.key;
      holderTeam[i] = dec.cand.team as Side;
      holderInterp[i] = dec.cand.interp;
    } else if (dec.kind === "contested") {
      base[i] = "C";
      contest[i] = { a: boxOf(dec.a), b: boxOf(dec.b), margin: dec.b.d - dec.a.d };
    } else if (dec.kind === "blocked") {
      base[i] = "B";
      blockerKey[i] = dec.cand.key;
    } else base[i] = "F";
  }
  // A measured contact: a touch with a measured ball (not interpolated) and a measured box.
  const measured: boolean[] = S.map((s, i) => base[i] === "T" && s.src !== "interp" && !holderInterp[i] && !s.jump);

  // contiguous: no hole in the ball between two samples of a chain (the chain never crosses videos or resets).
  const contig = (a: number, b: number) => a >= 0 && b < n && S[a].video_id === S[b].video_id && S[b].cutBefore !== "reset" && S[b].pt - (S[a].pt + S[a].dt) <= Math.max(0.25, S[a].dt);
  const sameChain = (a: number, b: number) => a >= 0 && S[a].video_id === S[b].video_id && S[b].cutBefore !== "reset";

  // Dead: out of the pitch (measured), a restart gap, or at rest (measured, slow) with nobody near for restS.
  const dead: boolean[] = S.map((s) => s.out || s.restGap);
  for (let i = 0; i < n; ) {
    if (base[i] !== "F" || S[i].src === "interp" || (S[i].speed ?? 0) >= p.restSpeedMs) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && contig(j, j + 1) && base[j + 1] === "F" && S[j + 1].src !== "interp" && (S[j + 1].speed ?? 0) < p.restSpeedMs) j++;
    if (S[j].pt + S[j].dt - S[i].pt >= p.restS) for (let k = i; k <= j; k++) dead[k] = true;
    i = j + 1;
  }

  // Still ball (see stillRadiusM): dead even with a player right next to it.
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && contig(j, j + 1) && !S[j + 1].jump && Math.hypot(S[j + 1].mx - S[i].mx, S[j + 1].my - S[i].my) <= p.stillRadiusM) j++;
    if (j > i && S[j].pt + S[j].dt - S[i].pt >= p.stillS) {
      for (let k = i; k <= j; k++) dead[k] = true;
      i = j + 1;
    } else i++;
  }

  // Control runs: touches of one team held for controlS. `weak`: the run has no measured contact (no credit).
  const ctrl: (Side | null)[] = new Array(n).fill(null);
  const weak: boolean[] = new Array(n).fill(false);
  const shortTouch: boolean[] = new Array(n).fill(false);
  const closeRun = (first: number, last: number, team: Side) => {
    if (first < 0) return;
    const dur = S[last].pt + S[last].dt - S[first].pt;
    const speeds: number[] = [];
    for (let k = first + 1; k <= last; k++) if (S[k].speed !== null) speeds.push(S[k].speed as number);
    speeds.sort((a, b) => a - b);
    const med = speeds.length ? speeds[speeds.length >> 1] : 0;
    if (dur + 1e-9 >= p.controlS && med < p.maxCtrlSpeedMs) {
      let noMeasure = true;
      for (let k = first; k <= last; k++) if (measured[k]) noMeasure = false;
      for (let k = first; k <= last; k++) {
        if (S[k].jump) continue; // the control goes on around a tracker jump, but the jump itself is not credited
        ctrl[k] = team;
        weak[k] = noMeasure;
      }
    } else for (let k = first; k <= last; k++) if (base[k] === "T") shortTouch[k] = true;
  };
  let runFirst = -1;
  let runLast = -1;
  let runTeam: Side | null = null;
  for (let i = 0; i < n; i++) {
    const t = base[i] === "T" ? holderTeam[i] : null;
    if (runFirst >= 0 && !sameChain(runLast, i)) {
      closeRun(runFirst, runLast, runTeam as Side);
      runFirst = -1;
    }
    if (t) {
      const gapOk = runFirst >= 0 && runTeam === t && S[i].pt - (S[runLast].pt + S[runLast].dt) <= p.gapS + 1e-9;
      if (!gapOk) {
        if (runFirst >= 0) closeRun(runFirst, runLast, runTeam as Side);
        runFirst = i;
        runTeam = t;
      }
      runLast = i;
    } else if (runFirst >= 0 && (base[i] === "C" || base[i] === "B" || dead[i])) {
      closeRun(runFirst, runLast, runTeam as Side);
      runFirst = -1;
    }
  }
  if (runFirst >= 0) closeRun(runFirst, runLast, runTeam as Side);

  // Possession over the chain, looking forward (see header). The samples between a credited control and the next
  // event wait in `pending` until it is known whether the next control confirms them.
  const team: PossessionTeam[] = new Array(n).fill("none");
  const kind: PossessionKind[] = new Array(n).fill("loose");
  const notes: string[][] = S.map(() => []);
  const owner: (string | null)[] = new Array(n).fill(null);
  const contact: boolean[] = new Array(n).fill(false);
  type Held = { team: Side; pt: number; mPt: number; key: string | null };
  let holder = null as Held | null;
  let contestedFrom: number | null = null;
  let pending: number[] = [];
  const credit = (i: number, h: Held, note: string) => {
    team[i] = h.team;
    kind[i] = "control";
    owner[i] = h.key;
    const at = notes[i].indexOf("no_measured_touch");
    if (at >= 0) notes[i].splice(at, 1);
    notes[i].push("flight", note);
  };
  // `confirm`: the team of the next credited control; null when the flight ends in a break instead.
  const resolve = (confirm: Side | null) => {
    const h = holder;
    if (pending.length > 0 && h) {
      if (confirm !== null && confirm === h.team) for (const i of pending) credit(i, h, "flight_confirmed");
      else if (confirm !== null) for (const i of pending) notes[i].push("flight_lost");
      else {
        let ok = true;
        for (const i of pending) {
          if (ok && S[i].src !== "interp" && S[i].pt - h.mPt <= p.holdS + 1e-9) credit(i, h, "hold_measured");
          else ok = false;
        }
      }
    }
    pending = [];
  };
  for (let i = 0; i < n; i++) {
    const s = S[i];
    if (!sameChain(i - 1, i)) {
      resolve(null);
      holder = null;
      contestedFrom = null;
      if (i > 0 && s.cutBefore === "reset") notes[i].push("cut_reset");
    } else if (s.cutBefore === "joined") notes[i].push("joined_cut");
    if (dead[i]) {
      resolve(null);
      team[i] = "none";
      kind[i] = "dead";
      notes[i].push(s.restGap ? "restart_gap" : s.out ? "out" : "rest");
      holder = null;
      contestedFrom = null;
      continue;
    }
    if (ctrl[i] && !weak[i]) {
      const t = ctrl[i] as Side;
      resolve(t);
      holder = { team: t, pt: s.pt + s.dt, mPt: measured[i] ? s.pt + s.dt : holder && holder.team === t ? holder.mPt : s.pt + s.dt, key: holderKey[i] ?? (holder as Held | null)?.key ?? null };
      team[i] = t;
      kind[i] = "control";
      contact[i] = measured[i];
      owner[i] = holderKey[i];
      contestedFrom = null;
      continue;
    }
    if (base[i] === "B") {
      resolve(null);
      kind[i] = "unknown";
      notes[i].push("blocked");
      owner[i] = blockerKey[i];
      holder = null;
      contestedFrom = null;
      continue;
    }
    if (base[i] === "C") {
      resolve(null);
      if (contestedFrom === null) contestedFrom = s.pt;
      kind[i] = "contested";
      if (holder && s.pt - contestedFrom <= p.contestedHoldS) team[i] = holder.team;
      continue;
    }
    contestedFrom = null;
    if (s.jump) {
      resolve(null);
      kind[i] = "unknown";
      notes[i].push("ball_jump");
      continue;
    }
    if (base[i] === "N") {
      resolve(null);
      kind[i] = "unknown";
      notes[i].push("no_players");
      continue;
    }
    if (shortTouch[i]) notes[i].push("short_touch");
    if (ctrl[i]) {
      // A run with no measured contact: the team is not credited; it may still be confirmed as part of a flight.
      kind[i] = "unknown";
      notes[i].push("no_measured_touch");
    }
    if (holder) pending.push(i);
  }
  resolve(null);

  const samples: PossessionSample[] = S.map((s, i) => ({
    video_id: s.video_id,
    part: s.part,
    segment_id: s.segment_id,
    frame: s.frame,
    t0: s.t,
    t1: s.t + s.dt,
    followed: s.followed,
    src: s.src,
    team: team[i],
    kind: kind[i],
    player_interp: team[i] !== "none" && !!ctrl[i] && !weak[i] && holderInterp[i],
    notes: notes[i],
    owner: owner[i],
    contact: contact[i],
    contest: contest[i],
  }));

  // Rows: consecutive samples with the same team and kind, without a hole between them.
  const rows: PossessionRow[] = [];
  let cur: { rows: number[]; row: PossessionRow } | null = null;
  const flush = () => {
    if (cur) rows.push(cur.row);
    cur = null;
  };
  for (let i = 0; i < n; i++) {
    const s = S[i];
    const open = cur as { rows: number[]; row: PossessionRow } | null;
    const last = open ? open.rows[open.rows.length - 1] : -1;
    const same = open !== null && open.row.team === team[i] && open.row.kind === kind[i] && contig(last, i);
    if (!same) {
      flush();
      cur = {
        rows: [],
        row: {
          video_id: s.video_id,
          segment_id: s.segment_id,
          t_start: s.t,
          t_end: s.t + s.dt,
          team: team[i],
          first_player: null,
          last_player: null,
          kind: kind[i],
          flags: { ball_interp: false, player_interp: false, ball_source: s.src, ball_s: { manual: 0, auto: 0, event: 0, interp: 0 }, notes: [] },
        },
      };
    }
    const c = cur as unknown as { rows: number[]; row: PossessionRow };
    c.rows.push(i);
    const r = c.row;
    r.t_end = s.t + s.dt;
    r.flags.ball_s[s.src] += s.dt;
    if (s.src === "interp") r.flags.ball_interp = true;
    if (samples[i].player_interp) r.flags.player_interp = true;
    for (const note of notes[i]) if (!r.flags.notes.includes(note)) r.flags.notes.push(note);
    if (ctrl[i] && !weak[i] && team[i] !== "none") {
      const nm = ownerName(prep, holderKey[i]);
      if (r.first_player === null) r.first_player = nm;
      r.last_player = nm ?? r.last_player;
    }
  }
  flush();
  for (const r of rows) {
    const e = Object.entries(r.flags.ball_s) as [BallSrc, number][];
    const total = e.reduce((a, [, v]) => a + v, 0);
    const top = e.sort((a, b) => b[1] - a[1])[0];
    r.flags.ball_source = top[1] >= total - 1e-9 ? top[0] : "mixed";
  }
  return { rows, samples, params: p };
}

export function possessionIntervals(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, params: Partial<PossessionParams> = {}, overrides: Overrides = new Map()): PossessionResult {
  const p = { ...POSSESSION_DEFAULTS, ...params };
  return labelPossession(preparePossession(parts, segmentsByVideo, p), p, overrides);
}

// ------------------------------------------------------------------------------------------------- summary
export interface TeamSeconds {
  own: number;
  opp: number;
  none: number;
}
const zero = (): TeamSeconds => ({ own: 0, opp: 0, none: 0 });
export interface PossessionSummary {
  total_s: number;
  seconds: TeamSeconds;
  // Share of the team with the ball (own of own + opp), null when nobody had it.
  pct_own: number | null;
  by_source: Record<BallSrc, TeamSeconds>;
  by_kind: Record<PossessionKind, TeamSeconds>;
  // Of the assigned seconds: those on an interpolated ball, on interpolated players, and on the tracker's ball.
  assigned_ball_interp_s: number;
  assigned_player_interp_s: number;
  auto_share: number | null;
  // The tracker's ball (never reviewed by hand) carries more than AUTO_WARN_SHARE of the assigned time.
  auto_dominant: boolean;
  // Same split using only what rests on measured positions of ball and players (no interpolation anywhere).
  measured: TeamSeconds;
  pct_own_measured: number | null;
  // Coverage: of the time the game was alive (total minus dead), the share credited to a team (every credited second
  // rests on a measured contact, directly or confirmed by the next control) and the share that is itself a measured
  // contact. The rest is unknown / loose / contested and is not in the denominator of pct_own.
  dead_s: number;
  restart_s: number; // dead seconds that are restart gaps (the ball not seen during a pause)
  alive_s: number;
  contact_s: number;
  coverage: number | null;
  contact_coverage: number | null;
}
const share = (own: number, opp: number) => (own + opp > 0 ? own / (own + opp) : null);

// `followedOnly`: count only the time the ball was followed (as the report does).
export function summarizePossession(samples: PossessionSample[], followedOnly = true): PossessionSummary {
  const seconds = zero();
  const measured = zero();
  const by_source: Record<BallSrc, TeamSeconds> = { manual: zero(), auto: zero(), event: zero(), interp: zero() };
  const by_kind: Record<PossessionKind, TeamSeconds> = { control: zero(), contested: zero(), loose: zero(), dead: zero(), unknown: zero() };
  let ballInterp = 0;
  let playerInterp = 0;
  let restart = 0;
  let contact = 0;
  for (const s of samples) {
    if (followedOnly && !s.followed) continue;
    const dt = s.t1 - s.t0;
    if (s.notes.includes("restart_gap")) restart += dt;
    if (s.contact) contact += dt;
    seconds[s.team] += dt;
    by_source[s.src][s.team] += dt;
    by_kind[s.kind][s.team] += dt;
    if (s.team !== "none") {
      if (s.src === "interp") ballInterp += dt;
      if (s.player_interp) playerInterp += dt;
      if (s.src !== "interp" && !s.player_interp) measured[s.team] += dt;
    } else measured.none += dt;
  }
  const assigned = seconds.own + seconds.opp;
  const auto = by_source.auto.own + by_source.auto.opp;
  const dead = by_kind.dead.own + by_kind.dead.opp + by_kind.dead.none;
  const alive = assigned + seconds.none - dead;
  return {
    total_s: assigned + seconds.none,
    seconds,
    pct_own: share(seconds.own, seconds.opp),
    by_source,
    by_kind,
    assigned_ball_interp_s: ballInterp,
    assigned_player_interp_s: playerInterp,
    auto_share: assigned > 0 ? auto / assigned : null,
    auto_dominant: assigned > 0 && auto / assigned > AUTO_WARN_SHARE,
    measured,
    pct_own_measured: share(measured.own, measured.opp),
    dead_s: dead,
    restart_s: restart,
    alive_s: alive,
    contact_s: contact,
    coverage: alive > 0 ? assigned / alive : null,
    contact_coverage: alive > 0 ? contact / alive : null,
  };
}

// The possession as cells of COVER_STEP_S per video (what lib/report.ts counts coverage and possession on): one cell is
// own, opp or unassigned, and a stretch seen in two files counts once.
export function possessionCellsOf(samples: PossessionSample[], cells: Map<string, PossessionState> = new Map()): Map<string, PossessionState> {
  for (const s of samples) {
    if (!s.followed) continue;
    const who: PossessionState = s.team === "none" ? "unassigned" : s.team;
    for (let k = Math.floor(s.t0 / COVER_STEP_S); k * COVER_STEP_S < s.t1; k++) {
      const key = `${s.video_id}|${k}`;
      if (!cells.has(key)) cells.set(key, who);
    }
  }
  return cells;
}

// ------------------------------------------------------------------------------------------------- CSV
export const POSSESSION_COLUMNS = ["video_id", "segment_id", "t_start", "t_end", "team", "first_player", "last_player", "kind", "flags"] as const;
export const possessionPath = (folder: string, videoId: string) => `matches/${folder}/possession_${videoId}.csv`;

export function flagsText(f: PossessionFlags): string {
  return [...(f.ball_interp ? ["ball_interp"] : []), ...(f.player_interp ? ["player_interp"] : []), `ball_source=${f.ball_source}`, ...f.notes].join(",");
}
const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const r3 = (v: number) => String(Math.round(v * 1000) / 1000);

// One CSV per video, ready for writeLocal(possessionPath(folder, video), text). Rows of other videos are left out.
export function possessionCsv(rows: PossessionRow[], videoId?: string): string {
  const body = rows
    .filter((r) => videoId === undefined || r.video_id === videoId)
    .map((r) => [r.video_id, r.segment_id, r3(r.t_start), r3(r.t_end), r.team, r.first_player ?? "", r.last_player ?? "", r.kind, flagsText(r.flags)].map((v) => q(String(v))).join(","));
  return [POSSESSION_COLUMNS.join(","), ...body].join("\n") + "\n";
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Reads a possession_<video>.csv back. `ball_s` is not stored (the CSV keeps only the dominant source): zeros.
export function parsePossessionCsv(text: string): PossessionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const head = splitCsv(lines[0]);
  const at = (c: string) => head.indexOf(c);
  if (POSSESSION_COLUMNS.some((c) => at(c) < 0)) return [];
  return lines.slice(1).flatMap((l) => {
    const v = splitCsv(l);
    const g = (c: string) => v[at(c)] ?? "";
    const team = g("team");
    const kind = g("kind");
    if (!["own", "opp", "none"].includes(team) || !["control", "contested", "loose", "dead", "unknown"].includes(kind)) return [];
    const tokens = g("flags").split(",").filter(Boolean);
    const src = tokens.find((t) => t.startsWith("ball_source="))?.slice(12) ?? "mixed";
    return [
      {
        video_id: g("video_id"),
        segment_id: g("segment_id"),
        t_start: Number(g("t_start")),
        t_end: Number(g("t_end")),
        team: team as PossessionTeam,
        first_player: g("first_player") || null,
        last_player: g("last_player") || null,
        kind: kind as PossessionKind,
        flags: {
          ball_interp: tokens.includes("ball_interp"),
          player_interp: tokens.includes("player_interp"),
          ball_source: src as BallSrc | "mixed",
          ball_s: { manual: 0, auto: 0, event: 0, interp: 0 },
          notes: tokens.filter((t) => t !== "ball_interp" && t !== "player_interp" && !t.startsWith("ball_source=")),
        },
      },
    ];
  });
}

// ------------------------------------------------------------------------------------------------- suspect boxes
export type SuspectReason = "opp_like_own" | "staff_as_team" | "unk_near_ball" | "contested_pair";

export interface Suspect {
  reason: SuspectReason;
  video_id: string;
  part: number; // start_frame of the part (person ids are per part)
  person_id: number;
  key: string;
  name: string | null;
  team: FixedTeam;
  // The moment (s of the video) where she matters most: the start of her longest stretch deciding the possession.
  t: number;
  // Seconds of possession decided by her boxes (as holder or as blocker).
  influence_s: number;
  // What the possession would do if she were taken as that team (own / opp) or removed (none): change in seconds.
  effect_if: Partial<Record<Side | "none", TeamSeconds>>;
  note: string;
  // contested_pair only: the two boxes about as near to the ball (this suspect is the nearest one, `other` the nearest of
  // the other team), the smallest margin between them and when the doubt ends. effect_if.own / .opp then mean «if the box
  // of our team / of the rival wins» (the other one removed).
  other?: ContestBox;
  box?: ContestBox;
  margin_m?: number;
  t_end?: number;
}
export interface SuspectOptions {
  params?: Partial<PossessionParams>;
  // Shirt colour of each team (Lab, OpenCV scale as in lib/tracks.ts). Without them the colour reasons are not checked.
  teamLab?: Partial<Record<Side | "ref", Lab>>;
  // Colour of one person of a part (Person.lab of lib/tracks.ts `people`). tracks_fixed carries NO colour: the caller
  // takes it from the raw tracks_*.json of the part and the correction table.
  labOf?: (video_id: string, part: number, id: number) => Lab | null;
  top?: number;
  minSeconds?: number;
  // How many contested_pair doubts at most (the longest ones) enter the queue.
  doubts?: number;
}

const deltaOf = (a: PossessionSummary, b: PossessionSummary): TeamSeconds => ({
  own: Math.round((b.seconds.own - a.seconds.own) * 10) / 10,
  opp: Math.round((b.seconds.opp - a.seconds.opp) * 10) / 10,
  none: Math.round((b.seconds.none - a.seconds.none) * 10) / 10,
});

// A doubt of the nearest-box rule: contested samples (two boxes of different teams within contestMarginM of each other
// in distance to the ball) where the ball and both boxes are measured, grouped while the same pair stays contested.
export interface PossessionDoubt {
  video_id: string;
  t: number;
  t_end: number;
  seconds: number;
  a: ContestBox; // the nearest at the sample of the smallest margin
  b: ContestBox; // the nearest of the other team
  margin: number; // smallest b.d - a.d
}
export function possessionDoubts(samples: PossessionSample[]): PossessionDoubt[] {
  const out: PossessionDoubt[] = [];
  let cur: PossessionDoubt | null = null;
  let curKey = "";
  let lastEnd = -1;
  for (const s of samples) {
    const c = s.contest;
    if (!c || s.src === "interp" || c.a.interp || c.b.interp || !s.followed) continue;
    const key = [c.a.key, c.b.key].sort().join("&");
    if (cur && key === curKey && s.video_id === cur.video_id && s.t0 - lastEnd < 0.25) {
      cur.t_end = s.t1;
      cur.seconds += s.t1 - s.t0;
      if (c.margin < cur.margin) {
        cur.margin = c.margin;
        cur.a = c.a;
        cur.b = c.b;
      }
    } else {
      if (cur) out.push(cur);
      cur = { video_id: s.video_id, t: s.t0, t_end: s.t1, seconds: s.t1 - s.t0, a: c.a, b: c.b, margin: c.margin };
      curKey = key;
    }
    lastEnd = s.t1;
  }
  if (cur) out.push(cur);
  return out;
}

// Review queue of the boxes that decide the possession and may be wrong:
//   opp_like_own   a person of the rival whose shirt colour is nearer to ours than to the rival's;
//   staff_as_team  a person of a team who is far from every team colour, or who stands still along the touchline
//                  (staff, bench, referee in a vest);
//   unk_near_ball  a box with no team (or a nameless leftover) that blocks the ball for a while;
//   contested_pair two boxes of different teams about as near to the ball (possessionDoubts): the possession could go
//                  either way, and effect_if says how many seconds move if one or the other wins.
// Sorted by influence. Each one says the change in seconds of possession if the box were taken as the other team or removed.
export function suspectBoxes(parts: Oriented[], segmentsByVideo: Record<string, Segment[]>, o: SuspectOptions = {}): Suspect[] {
  const p = { ...POSSESSION_DEFAULTS, ...(o.params ?? {}) };
  const prep = preparePossession(parts, segmentsByVideo, p);
  const base = labelPossession(prep, p);
  const baseSum = summarizePossession(base.samples);
  // Samples decided by each box.
  const by = new Map<string, { role: "holder" | "blocker"; idx: number[] }>();
  base.samples.forEach((s, i) => {
    if (!s.owner || !s.followed || (s.team === "none" && !s.notes.includes("blocked"))) return;
    const role = s.notes.includes("blocked") ? "blocker" : "holder";
    const e = by.get(s.owner) ?? { role, idx: [] };
    e.idx.push(i);
    by.set(s.owner, e);
  });
  // Where each person stands (for the touchline test): only those that matter.
  const stats = new Map<string, { n: number; line: number; minX: number; maxX: number }>();
  for (const f of parts.map((q) => q.file)) {
    const [mx, my] = metersPerUnit(f);
    const wid = PITCH.width * my;
    for (const fr of f.frames)
      for (const pos of fr.positions) {
        const key = personKey(f.video_id, f.start_frame, pos.id);
        if (!by.has(key) || pos.source === "interpolated") continue;
        const e = stats.get(key) ?? { n: 0, line: 0, minX: Infinity, maxX: -Infinity };
        e.n++;
        const y = pos.y * my;
        if (y < 2 || y > wid - 2) e.line++;
        e.minX = Math.min(e.minX, pos.x * mx);
        e.maxX = Math.max(e.maxX, pos.x * mx);
        stats.set(key, e);
      }
  }
  const min = o.minSeconds ?? 0.5;
  const found: Omit<Suspect, "effect_if">[] = [];
  const tr = o.teamLab ?? {};
  for (const [key, e] of by) {
    const info = prep.names.get(key);
    if (!info) continue;
    const dts = e.idx.map((i) => base.samples[i].t1 - base.samples[i].t0);
    const influence = dts.reduce((a, b) => a + b, 0);
    if (influence < min) continue;
    // Start of her longest stretch.
    let bestT = base.samples[e.idx[0]].t0;
    let bestLen = 0;
    let runStart = 0;
    for (let k = 1; k <= e.idx.length; k++) {
      if (k === e.idx.length || e.idx[k] !== e.idx[k - 1] + 1) {
        const len = e.idx.slice(runStart, k).reduce((a, i) => a + base.samples[i].t1 - base.samples[i].t0, 0);
        if (len > bestLen) {
          bestLen = len;
          bestT = base.samples[e.idx[runStart]].t0;
        }
        runStart = k;
      }
    }
    const mk = (reason: SuspectReason, note: string): Omit<Suspect, "effect_if"> => ({ reason, video_id: info.video_id, part: info.part, person_id: info.id, key, name: info.name, team: info.team, t: bestT, influence_s: Math.round(influence * 10) / 10, note });
    const lab = o.labOf?.(info.video_id, info.part, info.id) ?? null;
    const st = stats.get(key);
    const onLine = st !== undefined && st.n >= 10 && st.line / st.n >= 0.9 && st.maxX - st.minX < 15;
    if (e.role === "blocker" || info.team === "unk" || info.team === "ref") {
      found.push(mk("unk_near_ball", info.team === "ref" ? "Árbitro o similar junto al balón: nadie se lleva la posesión." : "Caja sin equipo (o sobrante sin nombre) junto al balón: ¿es nuestra, rival o ajena?"));
      continue;
    }
    if (info.team === "opp" && lab && tr.own && tr.opp && colorDistance(lab, tr.own, 1) < colorDistance(lab, tr.opp, 1)) {
      found.push(mk("opp_like_own", "Marcada rival, pero su camiseta se parece más a la nuestra."));
      continue;
    }
    const far = lab && (info.team === "own" || info.team === "opp") && tr[info.team] && colorDistance(lab, tr[info.team] as Lab, 1) > MAX_COLOR_DISTANCE;
    if ((info.team === "own" || info.team === "opp") && (onLine || far)) {
      found.push(mk("staff_as_team", onLine ? "Casi siempre pegada a la banda y sin moverse a lo largo: parece cuerpo técnico o banca." : "Su color está lejos del de su equipo: ¿cuerpo técnico, árbitro?"));
    }
  }
  found.sort((a, b) => b.influence_s - a.influence_s);
  const top = o.top ?? 30;
  const doubts = possessionDoubts(base.samples)
    .filter((d) => d.seconds >= 0.2)
    .sort((x, y) => y.seconds - x.seconds)
    .slice(0, Math.min(top, o.doubts ?? 10));
  const topN = found.slice(0, Math.max(0, top - doubts.length));
  const pairs: Suspect[] = doubts.map((d) => {
    const ownBox = d.a.team === "own" ? d.a : d.b;
    const oppBox = d.a.team === "own" ? d.b : d.a;
    // Taking one box as the winner = removing the other.
    const wins = (loser: ContestBox) => deltaOf(baseSum, summarizePossession(labelPossession(prep, p, new Map([[loser.key, "none" as const]])).samples));
    const nearest = d.a;
    return {
      reason: "contested_pair" as const,
      video_id: d.video_id,
      part: prep.names.get(nearest.key)?.part ?? 0,
      person_id: nearest.id,
      key: `${d.a.key}&${d.b.key}`,
      name: nearest.name,
      team: nearest.team,
      t: d.t,
      influence_s: Math.round(d.seconds * 10) / 10,
      note: `Dos cajas de equipos distintos casi igual de cerca del balón (diferencia ${d.margin.toFixed(2)} m): nuestra a ${ownBox.d.toFixed(2)} m, rival a ${oppBox.d.toFixed(2)} m.`,
      effect_if: { own: wins(oppBox), opp: wins(ownBox) },
      other: d.b,
      box: d.a,
      margin_m: Math.round(d.margin * 100) / 100,
      t_end: d.t_end,
    };
  });
  const rest = topN.map((s) => {
    const tryAs = (v: Side | "none") => deltaOf(baseSum, summarizePossession(labelPossession(prep, p, new Map([[s.key, v]])).samples));
    const effect_if: Suspect["effect_if"] =
      s.reason === "opp_like_own" ? { own: tryAs("own") } : s.reason === "staff_as_team" ? { none: tryAs("none") } : { own: tryAs("own"), opp: tryAs("opp"), none: tryAs("none") };
    return { ...s, effect_if };
  });
  return [...rest, ...pairs].sort((a, b) => b.influence_s - a.influence_s);
}

// Lab of every person of the parts from `people()` of lib/tracks.ts, ready to be the `labOf` of suspectBoxes.
export function labIndex(entries: { video_id: string; part: number; people: { id: number; lab: Lab }[] }[]): NonNullable<SuspectOptions["labOf"]> {
  const m = new Map<string, Lab>();
  for (const e of entries) for (const p of e.people) m.set(personKey(e.video_id, e.part, p.id), p.lab);
  return (video_id, part, id) => m.get(personKey(video_id, part, id)) ?? null;
}

// Whether to warn that the possession rests mostly on the tracker's ball.
export const autoWarning = (s: PossessionSummary): string | null =>
  s.auto_dominant
    ? `El ${Math.round(100 * (s.auto_share ?? 0))} % de la posesión asignada se lee del balón del tracker, sin marcas tuyas: tómala como aproximada hasta revisar el balón.`
    : null;

