"use client";

import { useMemo } from "react";
import { useStore } from "./store";
import { matchOfFolder, trackingParamsOf, type TrackingParams } from "./techTracking";
import type { Match } from "./types";

// Detalles técnicos (tracking) of the match of a folder, or of the match with that id: a hook, so the workspace
// components can use its values as stable dependencies.
export function useTrackingTech(folder: string | undefined, matchId?: string): { match: Match | undefined; params: TrackingParams } {
  const { matches } = useStore();
  const match = matchOfFolder(matches, folder) ?? (matchId ? matches.find((m) => m.match_id === matchId) : undefined);
  const params = useMemo(() => trackingParamsOf(match), [match]);
  return { match, params };
}
