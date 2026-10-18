// Passes tagged by hand (pass 4 of the tagging): who passes to whom. The analyst types, in order, the player who has
// the ball at each touch; two touches in a row of the same team are a pass, and "lost" closes the chain with a pass
// that did not arrive. Pure functions: no storage, no React.
import { PITCH, type MatchEvent, type PassRow } from "./types.ts";

// What typing a player does: closes the pass from the player who had the ball (if any) and she becomes the holder.
export interface Holder {
  player_id: string;
  t: number;
}
export function touch(holder: Holder | null, player_id: string, t: number, base: Omit<PassRow, "pass_id" | "t_video" | "from_id" | "to_id" | "outcome">, id: string): { pass: PassRow | null; holder: Holder } {
  const pass =
    holder && holder.player_id !== player_id
      ? { ...base, pass_id: id, t_video: holder.t, from_id: holder.player_id, to_id: player_id, outcome: "complete" as const }
      : null;
  return { pass, holder: { player_id, t } };
}
// The holder loses it: a pass that did not reach anybody of her team.
export function lost(holder: Holder, base: Omit<PassRow, "pass_id" | "t_video" | "from_id" | "to_id" | "outcome">, id: string): PassRow {
  return { ...base, pass_id: id, t_video: holder.t, from_id: holder.player_id, to_id: null, outcome: "incomplete" };
}

// ------------------------------------------------------------------------------------------------ per player

export interface PlayerPasses {
  player_id: string;
  attempted: number;
  completed: number;
  received: number;
  // Who she passes to most (completed), with how many.
  partners: { player_id: string; count: number }[];
}
export function passStats(passes: PassRow[]): PlayerPasses[] {
  const by = new Map<string, PlayerPasses & { to: Map<string, number> }>();
  const get = (id: string) => {
    let p = by.get(id);
    if (!p) by.set(id, (p = { player_id: id, attempted: 0, completed: 0, received: 0, partners: [], to: new Map() }));
    return p;
  };
  for (const p of passes) {
    const a = get(p.from_id);
    a.attempted += 1;
    if (p.outcome === "complete" && p.to_id) {
      a.completed += 1;
      a.to.set(p.to_id, (a.to.get(p.to_id) ?? 0) + 1);
      get(p.to_id).received += 1;
    }
  }
  return [...by.values()]
    .map(({ to, ...p }) => ({ ...p, partners: [...to].map(([player_id, count]) => ({ player_id, count })).sort((x, y) => y.count - x.count) }))
    .sort((a, b) => b.attempted + b.received - (a.attempted + a.received));
}

// ------------------------------------------------------------------------------------------------ network

export interface NetNode {
  key: string;
  label: string;
  x: number;
  y: number;
  // Where the position comes from: the average of her tagged events with a position, or a ring when she has none.
  placed: "events" | "ring";
  touches: number;
}
export interface Net {
  nodes: NetNode[];
  edges: { a: string; b: string; count: number }[];
  passes: number;
  completed: number;
}

// Pass network of one team: an edge per pair of players with the completed passes between them (both ways). Each
// player is drawn at the average position of her tagged events (events are tagged attacking towards x = 105); the
// ones without any go on a ring in the middle of the pitch.
export function networkFromPasses(passes: PassRow[], events: MatchEvent[], team: "own" | "opp", label: (id: string) => string = (id) => id): Net {
  const mine = passes.filter((p) => p.team === team);
  const touches = new Map<string, number>();
  const edges = new Map<string, number>();
  for (const p of mine) {
    touches.set(p.from_id, (touches.get(p.from_id) ?? 0) + 1);
    if (p.outcome !== "complete" || !p.to_id) continue;
    touches.set(p.to_id, (touches.get(p.to_id) ?? 0) + 1);
    const k = p.from_id < p.to_id ? `${p.from_id}\u0000${p.to_id}` : `${p.to_id}\u0000${p.from_id}`;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  const pos = new Map<string, { x: number; y: number; n: number }>();
  for (const e of events) {
    if (e.team !== team || !e.player_id || e.x === null || e.y === null || !touches.has(e.player_id)) continue;
    const s = pos.get(e.player_id) ?? { x: 0, y: 0, n: 0 };
    pos.set(e.player_id, { x: s.x + e.x, y: s.y + e.y, n: s.n + 1 });
  }
  const unplaced = [...touches.keys()].filter((k) => !pos.has(k)).sort();
  const nodes: NetNode[] = [...touches].map(([key, n]) => {
    const s = pos.get(key);
    if (s) return { key, label: label(key), x: s.x / s.n, y: s.y / s.n, placed: "events" as const, touches: n };
    const i = unplaced.indexOf(key);
    const ang = (2 * Math.PI * i) / Math.max(1, unplaced.length) - Math.PI / 2;
    return { key, label: label(key), x: PITCH.length / 2 + 24 * Math.cos(ang), y: PITCH.width / 2 + 22 * Math.sin(ang), placed: "ring" as const, touches: n };
  });
  return {
    nodes,
    edges: [...edges].map(([k, count]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, count };
    }),
    passes: mine.length,
    completed: mine.filter((p) => p.outcome === "complete").length,
  };
}

// The same passes as rows of the contract (passes table, docs/data_contract.md).
export const PASS_COLUMNS = ["pass_id", "match_id", "video_id", "t_video", "period", "team", "from_id", "to_id", "outcome"] as const;
