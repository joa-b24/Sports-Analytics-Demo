// What the tracking gives the screens, from either source: the parts (positions frame by frame, computed on the spot) or
// the saved aggregates (lib/aggregates.ts). A screen asks this object for a heat map, the passes of a team, the block...
// and does not care where the answer comes from. With the aggregates a view that was not saved (a heat map of a player who
// has no name in the tracking, say) answers empty: it is never made up.
import type { TrackingAggregates } from "./aggregates.ts";
import { blockShape, type BlockShape } from "./blockShape.ts";
import { trackedNet, trackedPasses, type TrackedPasses } from "./passSources.ts";
import type { Net } from "./passes.ts";
import { physical, teamBlock, type PhysicalRow, type TeamBlock } from "./physical.ts";
import { trackingFacts, type PlayersInput, type TrackingFacts } from "./players.ts";
import { heatmapSmooth, markKeyPasses, passArrows, passNetwork, passStretches, playerTouchPoints, type Heat, type Oriented, type PassArrow, type PassNetwork, type PassStretch } from "./positions.ts";
import type { ReportTracking } from "./report.ts";
import type { Segment } from "./segments.ts";

type Side = "own" | "opp";
type KeyPass = { video_id?: string; t_video: number; player_id?: string | null };

export interface TrackingView {
  // "parts": computed from the positions; "agg": read from the aggregates; "none": there is no tracking.
  source: "parts" | "agg" | "none";
  // The parts, when there are (empty with the aggregates: whatever needs the positions frame by frame is not available).
  parts: Oriented[];
  // The ids of the match in the tracking files (the rivals named in the quick review are filed under them).
  matchIds: string[];
  has: { tracking: boolean; ball: boolean; names: boolean };
  // Length of the pitch in meters, when known.
  venueLength: number | null;
  physical(team: Side): PhysicalRow[];
  block(team: Side): TeamBlock | null;
  heat(team: Side, player?: string | null): Heat | null;
  passes(team: Side): TrackedPasses | null;
  net(team: Side): (Net & { unnamed: number }) | null;
  arrows(team: Side, keyPasses?: KeyPass[]): PassArrow[];
  passNetwork(team: Side): PassNetwork | null;
  touchPoints(team: Side, player: string): [number, number][];
  stretches(): PassStretch[];
  // The block by stretches of 5 or 10 minutes (null without positions or aggregates).
  shape(binMin: 5 | 10): BlockShape | null;
  // What the report reads from the positions and the ball, already worked out (only with the aggregates; with the positions
  // the report works it out itself).
  report(): ReportTracking | null;
  // What playerRows needs from the tracking; null with no tracking.
  facts(input: Omit<PlayersInput, "parts">): TrackingFacts | null;
}

export const NO_TRACKING: TrackingView = makeTrackingView({ parts: [], agg: null, segmentsByVideo: {}, videoIds: [] });

export function makeTrackingView({ parts, agg, segmentsByVideo, videoIds }: { parts: Oriented[]; agg: TrackingAggregates | null; segmentsByVideo: Record<string, Segment[]>; videoIds: string[] }): TrackingView {
  if (parts.length > 0) {
    return {
      source: "parts",
      parts,
      matchIds: [...new Set(parts.map((o) => o.file.match_id))],
      venueLength: parts[0]?.file.venue?.length_m ?? null,
      has: { tracking: true, ball: parts.some((o) => o.file.ball.length > 0), names: parts.some((o) => o.file.people.some((p) => p.player_id)) },
      physical: (t) => physical(parts, t),
      block: (t) => teamBlock(parts, t),
      heat: (t, p = null) => heatmapSmooth(parts, t, p),
      passes: (t) => trackedPasses(parts, t, segmentsByVideo),
      net: (t) => trackedNet(parts, t, segmentsByVideo),
      arrows: (t, k = []) => passArrows(parts, t, segmentsByVideo, k),
      passNetwork: (t) => passNetwork(parts, t, segmentsByVideo),
      touchPoints: (t, p) => playerTouchPoints(parts, t, p, segmentsByVideo),
      stretches: () => passStretches(parts, segmentsByVideo),
      shape: (m) => blockShape(parts, segmentsByVideo, videoIds, m),
      report: () => null,
      facts: (input) => trackingFacts({ ...input, parts }),
    };
  }
  if (agg) {
    return {
      source: "agg",
      parts: [],
      matchIds: [...new Set(agg.parts.map((x) => x.match_id))],
      has: agg.has,
      venueLength: agg.venue_length_m ?? null,
      physical: (t) => agg.facts.physical[t],
      block: (t) => agg.block[t],
      heat: (t, p = null) => (p ? (agg.heat.player[`${t}|${p}`] ?? null) : agg.heat.team[t]),
      passes: (t) => agg.passes[t],
      net: (t) => agg.net[t],
      arrows: (t, k = []) => markKeyPasses(agg.arrows[t], k),
      passNetwork: (t) => agg.passNetwork?.[t] ?? null,
      touchPoints: (t, p) => agg.touches[`${t}|${p}`] ?? [],
      stretches: () => agg.stretches,
      shape: (m) => agg.shape?.[String(m) as "5" | "10"] ?? null,
      report: () => agg.report ?? null,
      facts: () => agg.facts,
    };
  }
  return {
    source: "none",
    parts: [],
    matchIds: [],
    has: { tracking: false, ball: false, names: false },
    venueLength: null,
    physical: () => [],
    block: () => null,
    heat: () => null,
    passes: () => null,
    net: () => null,
    arrows: () => [],
    passNetwork: () => null,
    touchPoints: () => [],
    stretches: () => [],
    shape: () => null,
    report: () => null,
    facts: () => null,
  };
}
