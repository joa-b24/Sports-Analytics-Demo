// Aggregates of the tracking of a match: what the screens of the app compute from the positions (heat maps, passes, pass
// network, touches, block, physical load, the figures of every player), calculated once and saved in
// tracking/aggregates_<folder>.json. Reading that file is instant and small (a few hundred KB) where the tracking itself is
// tens of MB per part: it is what the phone and the tablet read (the lightweight copy of the match has no positions at all)
// and what the laptop reads instead of recalculating every time a tab is opened. Pure functions: no files, no React.
import { trackedNet, trackedPasses, type TrackedPasses } from "./passSources.ts";
import type { Net } from "./passes.ts";
import { blockShape, type BlockShape } from "./blockShape.ts";
import { teamBlock, type TeamBlock } from "./physical.ts";
import { trackingFacts, type TrackingFacts } from "./players.ts";
import { heatmapSmooth, namedPlayers, passArrows, passNetwork, passStretches, playerTouchPoints, type Heat, type Oriented, type PassArrow, type PassNetwork, type PassStretch } from "./positions.ts";
import { hashText, stableJson } from "./saveAll.ts";
import type { Segment } from "./segments.ts";
import { reportEvents, reportTracking, type ReportTracking } from "./report.ts";
import type { Match, MatchEvent } from "./types.ts";

export const AGG_VERSION = 1;
type Side = "own" | "opp";
const SIDES: Side[] = ["own", "opp"];
export const aggregatesPath = (folder: string) => `matches/${folder}/tracking/aggregates_${folder}.json`;

export interface AggregatesInput {
  match: Match;
  parts: Oriented[];
  // The videos of the match (the block by stretches of 5 and 10 minutes is read over them).
  videoIds: string[];
  events: MatchEvent[];
  segmentsByVideo: Record<string, Segment[]>;
  videoPeriods?: { video_id: string; period: number }[];
  videoHalves?: Record<string, { h1: [number, number]; h2: [number, number] }>;
}

export interface TrackingAggregates {
  version: number;
  // What it was calculated from (see aggregatesFingerprint): when it changes the file is stale and is built again.
  fingerprint: string;
  built_at: string;
  parts: { match_id: string; video_id: string; start_frame: number; end_frame: number; fps: number; own_right: boolean }[];
  // What the tracking has: positions, the ball followed, players with a name.
  has: { tracking: boolean; ball: boolean; names: boolean };
  // Length of the pitch in meters (the line of the block is drawn on the 105-wide pitch from it).
  venue_length_m: number | null;
  facts: TrackingFacts;
  block: Record<Side, TeamBlock>;
  heat: { team: Record<Side, Heat>; player: Record<string, Heat> };
  passes: Record<Side, TrackedPasses>;
  net: Record<Side, Net & { unnamed: number }>;
  arrows: Record<Side, PassArrow[]>;
  // The pass network of each team as the report draws it (players at their average position).
  passNetwork: Record<Side, PassNetwork>;
  // Where each named player touched the ball, by `${team}|${name}`.
  touches: Record<string, [number, number][]>;
  stretches: PassStretch[];
  // The block (height and width of each team) by stretches of 5 and of 10 minutes.
  shape: { "5": BlockShape; "10": BlockShape };
  // What the report reads from the positions and the ball (possession, passes, network, touches), worked out with the events
  // of the match when it was built.
  report: ReportTracking;
}

// What decides whether the aggregates are still good: the tracking files (name and size), the play stretches, the halves and
// the direction of play, and the events the figures lean on: substitutions and red cards (minutes played) and losses and
// recoveries (the possession).
export function aggregatesFingerprint(input: {
  files: { name: string; size: number }[];
  segmentsByVideo: Record<string, Segment[]>;
  videoPeriods?: { video_id: string; period: number }[];
  videoHalves?: unknown;
  attack: Record<string, string | null>;
  events: MatchEvent[];
}): string {
  const play = Object.fromEntries(Object.entries(input.segmentsByVideo).map(([v, segs]) => [v, segs.filter((g) => g.tipo === "juego").map((g) => [g.start, g.end])]));
  // Substitutions and red cards (who is on the pitch) and losses and recoveries (the possession is held to them).
  const subs = input.events.filter((e) => e.type === "substitution" || e.type === "loss" || e.type === "recovery" || (e.type === "foul" && e.detail === "red")).map((e) => [e.type, e.team, e.player_id, e.player_in, e.t_video, e.video_id ?? "v1"]);
  return hashText(stableJson({ v: AGG_VERSION, files: [...input.files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => [f.name, f.size]), play, periods: input.videoPeriods ?? [], halves: input.videoHalves ?? {}, attack: input.attack, subs }));
}

// Numbers in the saved file keep two decimals: more is noise for a heat map or an arrow.
const r2 = (n: number) => Math.round(n * 100) / 100;
const roundHeat = (h: Heat): Heat => ({ ...h, seconds: h.seconds.map(r2), total: r2(h.total) });

const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));

// Builds the aggregates from the parts. Async only to give the screen a turn between the heavy steps (one heat map per
// player over every frame takes a while): the calculation itself is the same pure code the screens use.
export async function buildAggregates(input: AggregatesInput & { fingerprint: string }, onProgress: (done: number, total: number) => void = () => {}): Promise<TrackingAggregates> {
  const { parts, events, segmentsByVideo, videoPeriods, videoHalves } = input;
  const names = Object.fromEntries(SIDES.map((s) => [s, namedPlayers(parts, s).map((n) => n.name)])) as Record<Side, string[]>;
  const total = 9 + names.own.length * 2 + names.opp.length * 2;
  let done = 0;
  const step = async () => {
    onProgress(++done, total);
    await tick();
  };
  const facts = trackingFacts({ events, parts, playByVideo: segmentsByVideo, videoPeriods, videoHalves });
  await step();
  const block = { own: teamBlock(parts, "own"), opp: teamBlock(parts, "opp") };
  await step();
  const passes = { own: trackedPasses(parts, "own", segmentsByVideo), opp: trackedPasses(parts, "opp", segmentsByVideo) };
  await step();
  const net = { own: trackedNet(parts, "own", segmentsByVideo), opp: trackedNet(parts, "opp", segmentsByVideo) };
  await step();
  const passNet = { own: passNetwork(parts, "own", segmentsByVideo), opp: passNetwork(parts, "opp", segmentsByVideo) };
  await step();
  const arrows = {
    own: passArrows(parts, "own", segmentsByVideo).map((a) => ({ ...a, x1: r2(a.x1), y1: r2(a.y1), x2: r2(a.x2), y2: r2(a.y2), t: r2(a.t), t_end: r2(a.t_end) })),
    opp: passArrows(parts, "opp", segmentsByVideo).map((a) => ({ ...a, x1: r2(a.x1), y1: r2(a.y1), x2: r2(a.x2), y2: r2(a.y2), t: r2(a.t), t_end: r2(a.t_end) })),
  };
  await step();
  const stretches = passStretches(parts, segmentsByVideo);
  await step();
  const shape = { "5": blockShape(parts, segmentsByVideo, input.videoIds, 5), "10": blockShape(parts, segmentsByVideo, input.videoIds, 10) };
  await step();
  const report = reportTracking({ match: input.match, parts, segmentsByVideo, raw: reportEvents(input.match, events) });
  await step();
  const heat = { team: { own: roundHeat(heatmapSmooth(parts, "own")), opp: roundHeat(heatmapSmooth(parts, "opp")) }, player: {} as Record<string, Heat> };
  const touches: Record<string, [number, number][]> = {};
  for (const s of SIDES)
    for (const n of names[s]) {
      heat.player[`${s}|${n}`] = roundHeat(heatmapSmooth(parts, s, n));
      await step();
      touches[`${s}|${n}`] = playerTouchPoints(parts, s, n, segmentsByVideo).map(([x, y]) => [r2(x), r2(y)]);
      await step();
    }
  return {
    version: AGG_VERSION,
    fingerprint: input.fingerprint,
    built_at: new Date().toISOString(),
    parts: parts.map((o) => ({ match_id: o.file.match_id, video_id: o.file.video_id, start_frame: o.file.start_frame, end_frame: o.file.end_frame, fps: o.file.fps, own_right: o.ownRight })),
    has: { tracking: parts.length > 0, ball: parts.some((o) => o.file.ball.length > 0), names: names.own.length + names.opp.length > 0 },
    venue_length_m: parts[0]?.file.venue?.length_m ?? null,
    facts,
    block,
    heat,
    passes,
    net,
    arrows,
    passNetwork: passNet,
    touches,
    stretches,
    shape,
    report,
  };
}

// A saved file read back: null when it is not one of ours or comes from another version of the format.
export function parseAggregates(text: string | null): TrackingAggregates | null {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as TrackingAggregates;
    return a && a.version === AGG_VERSION && typeof a.fingerprint === "string" && a.facts && a.heat && a.passes ? a : null;
  } catch {
    return null;
  }
}

// The physical rows are part of the facts: this keeps them where the screens look for them.
export const physicalOf = (a: TrackingAggregates, team: Side) => a.facts.physical[team];
