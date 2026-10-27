import type { FixedParts } from "@/lib/fixed";
import type { PossessionParams, PossessionResult } from "@/lib/possession";
import type { Segment } from "@/lib/segments";
import type { Match, MatchVideo } from "@/lib/types";

// What the sections of the Playground share, computed once in Playground.tsx: the corrected parts, the play stretches, the
// parameters of the match (lib/tech.ts) and the possession table computed with them (the board and the possession and
// passes checks read the same one).
export interface PlaygroundCtx {
  match: Match;
  folder: string;
  videos: MatchVideo[];
  videoIds: string[];
  // Null while the files are being read.
  fixed: FixedParts | null;
  segmentsByVideo: Record<string, Segment[]>;
  params: PossessionParams;
  // Null when the match has no part with positions.
  result: PossessionResult | null;
  // A check saved its verdicts: the board reads them again.
  notifyReview: () => void;
}
