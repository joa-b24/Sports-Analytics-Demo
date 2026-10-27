// Passes of a team from the two sources the app has: the ones tagged by hand (PassRow, lib/passes.ts, kept so old
// data still shows) and the ones read from the tracking (ball + players, lib/positions.ts). Both are offered side by
// side: they are never added together (the same pass could be in both). Pure functions.
import { isMeasuredSource } from "./smooth.ts";
import { passesAndTurnovers, inStretches, orient, type Oriented, type Pass } from "./positions.ts";
import type { PlayerPasses } from "./passes.ts";
import type { Net, NetNode } from "./passes.ts";
import type { Segment } from "./segments.ts";

export type PassSource = "tracking" | "hand";
export const PASS_SOURCE_LABEL: Record<PassSource, string> = { tracking: "Del tracking", hand: "Marcados a mano" };

export interface TrackedPasses {
  // Completed passes and passes cut (the other team had the ball next) of the team, over the parts.
  completed: number;
  cut: number;
  // Completed passes read where the team has no names: they are team-level and approximate.
  approx: number;
  // Per named player. Empty when the team has no names.
  players: (PlayerPasses & { touches: number })[];
}

// Passes of one team read from the tracking: per named player (made, received, cut) and for the team. Passes where a
// team without names is involved are counted for the team only, flagged approximate.
export function trackedPasses(parts: Oriented[], team: "own" | "opp", playByVideo: Record<string, Segment[]> = {}): TrackedPasses {
  const usePlay = Object.values(playByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
  const by = new Map<string, PlayerPasses & { touches: number; to: Map<string, number> }>();
  const get = (id: string) => {
    let p = by.get(id);
    if (!p) by.set(id, (p = { player_id: id, attempted: 0, completed: 0, received: 0, partners: [], touches: 0, to: new Map() }));
    return p;
  };
  let completed = 0;
  let cut = 0;
  let approx = 0;
  for (const o of parts) {
    const f = o.file;
    const name = new Map(f.people.map((p) => [p.id, p.player_id]));
    const play = usePlay ? (playByVideo[f.video_id] ?? []) : null;
    const inPlay = (frame: number) => inStretches(play, frame / f.fps);
    const r = passesAndTurnovers(f);
    for (const t of r.touches) {
      const n = name.get(t.id);
      if (n && t.team === team && inPlay(t.frame)) get(n).touches++;
    }
    for (const p of r.passes) {
      if (p.team !== team || !inPlay(p.from_frame)) continue;
      completed++;
      if (p.approx) approx++;
      const a = name.get(p.from);
      const b = name.get(p.to);
      if (!a || !b) continue;
      const pa = get(a);
      pa.attempted++;
      pa.completed++;
      pa.to.set(b, (pa.to.get(b) ?? 0) + 1);
      get(b).received++;
    }
    for (const tv of r.turnovers) {
      if (tv.lost !== team || !inPlay(tv.from_frame)) continue;
      cut++;
      const a = name.get(tv.from);
      if (a) get(a).attempted++;
    }
  }
  const players = [...by.values()]
    .map(({ to, ...p }) => ({ ...p, partners: [...to].map(([player_id, count]) => ({ player_id, count })).sort((x, y) => y.count - x.count) }))
    .sort((a, b) => b.attempted + b.received - (a.attempted + a.received));
  return { completed, cut, approx, players };
}

// Pass network of a team from the tracking, in the shape of the network by hand. Each player at her average position
// (team attacking right); the passes between two named players are the edges. `placed: "tracking"`.
export function trackedNet(parts: Oriented[], team: "own" | "opp", playByVideo: Record<string, Segment[]> = {}): Net & { unnamed: number } {
  const usePlay = Object.values(playByVideo).some((segs) => segs.some((g) => g.tipo === "juego" && g.end !== null));
  const pos = new Map<string, { x: number; y: number; n: number }>();
  const touches = new Map<string, number>();
  const edges = new Map<string, number>();
  let passes = 0;
  let unnamed = 0;
  for (const o of parts) {
    const name = new Map(o.file.people.map((p) => [p.id, p.player_id]));
    const teamOf = new Map(o.file.people.map((p) => [p.id, p.team]));
    const play = usePlay ? (playByVideo[o.file.video_id] ?? []) : null;
    const inPlay = (frame: number) => inStretches(play, frame / o.file.fps);
    for (const fr of o.file.frames)
      for (const q of fr.positions) {
        const n = name.get(q.id);
        if (!n || teamOf.get(q.id) !== team || !isMeasuredSource(q.source)) continue;
        const [x, y] = orient(o, q.x, q.y);
        const s = pos.get(n) ?? { x: 0, y: 0, n: 0 };
        pos.set(n, { x: s.x + x, y: s.y + y, n: s.n + 1 });
      }
    const r = passesAndTurnovers(o.file);
    for (const t of r.touches) {
      const n = name.get(t.id);
      if (n && t.team === team && inPlay(t.frame)) touches.set(n, (touches.get(n) ?? 0) + 1);
    }
    for (const p of r.passes as Pass[]) {
      if (p.team !== team || !inPlay(p.from_frame)) continue;
      passes++;
      const a = name.get(p.from);
      const b = name.get(p.to);
      if (!a || !b) {
        unnamed++;
        continue;
      }
      const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const inEdges = new Set([...edges.keys()].flatMap((k) => k.split("\u0000")));
  const nodes: NetNode[] = [...pos]
    .filter(([k]) => inEdges.has(k) || touches.has(k))
    .map(([key, s]) => ({ key, label: key, x: s.x / s.n, y: s.y / s.n, placed: "tracking" as const, touches: touches.get(key) ?? 0 }));
  return {
    nodes,
    edges: [...edges].map(([k, count]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, count };
    }),
    passes,
    completed: passes,
    unnamed,
  };
}
