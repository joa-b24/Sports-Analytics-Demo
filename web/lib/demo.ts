import { defaultPositions } from "./stats";
import { EMPTY_REPORT, type EventType, type Match, type MatchEvent, type Play, type SessionRow, type State } from "./types";

// Synthetic example data so every screen can be shown before real data exists.
// Everything created here carries is_demo / a "demo" id and is labelled as such in the UI.

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_MATCH_ID = "demo_rival";

const WEIGHTS: [EventType, number][] = [
  ["loss", 22],
  ["recovery", 22],
  ["shot", 10],
  ["goal", 2],
  ["foul", 8],
  ["corner", 5],
  ["free_kick", 5],
  ["throw_in", 10],
  ["key_pass", 6],
];

export function buildDemo(): State {
  const r = rng(7);
  const match: Match = {
    match_id: DEMO_MATCH_ID,
    name: "Rival A vs Equipo B (EJEMPLO)",
    kind: "rival",
    date: "2026-09-27",
    focus_team: "Rival A",
    other_team: "Equipo B",
    youtube_id: "",
    report: { ...EMPTY_REPORT },
    is_demo: true,
  };

  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  const events: MatchEvent[] = [];
  for (let i = 0; i < 90; i++) {
    let pick = r() * total;
    let type: EventType = "other";
    for (const [t, w] of WEIGHTS) {
      pick -= w;
      if (pick <= 0) {
        type = t;
        break;
      }
    }
    const own = r() < 0.55;
    // Attacking events sit near the goal that team attacks (own -> right, opp -> left).
    const attacking = type === "shot" || type === "goal" || type === "corner" || type === "key_pass";
    let x = attacking ? 75 + r() * 28 : 10 + r() * 85;
    if (!own) x = 105 - x;
    const t = 300 + r() * 5000;
    events.push({
      event_id: `demo_e${i}`,
      match_id: DEMO_MATCH_ID,
      t_video: Math.round(t * 10) / 10,
      period: t < 2800 ? 1 : 2,
      type,
      team: own ? "own" : "opp",
      player_id: null,
      x: Math.round(x * 10) / 10,
      y: Math.round((6 + r() * 56) * 10) / 10,
      outcome: null,
      note: null,
    });
  }
  events.sort((a, b) => a.t_video - b.t_video);

  const k0 = defaultPositions();
  const shift = (pos: Record<string, [number, number]>, dx: number, ball: [number, number]) => {
    const out: Record<string, [number, number]> = {};
    for (const [id, [x, y]] of Object.entries(pos)) {
      const amount = id === "o1" || id === "r1" ? dx * 0.2 : dx;
      out[id] = [Math.min(103, Math.max(2, x + amount + (r() - 0.5) * 4)), Math.min(66, Math.max(2, y + (r() - 0.5) * 5))];
    }
    out.ball = ball;
    return out;
  };
  const play: Play = {
    play_id: "demo_p1",
    match_id: DEMO_MATCH_ID,
    title: "Salida por banda derecha (ejemplo)",
    t_start: 600,
    t_end: 615,
    note: "Animación de ejemplo hecha con keyframes manuales.",
    keyframes: [
      { t: 600, pos: { ...k0, ball: [25, 58] } },
      { t: 605, pos: shift(k0, 8, [48, 60]) },
      { t: 610, pos: shift(k0, 16, [78, 56]) },
      { t: 615, pos: shift(k0, 20, [96, 36]) },
    ],
  };

  const sessions: SessionRow[] = [];
  const players = Array.from({ length: 14 }, (_, i) => `J${String(i + 1).padStart(2, "0")}`);
  for (let s = 0; s < 12; s++) {
    const d = new Date(Date.UTC(2026, 8, 1 + s * 2 + Math.floor(s / 3)));
    const date = d.toISOString().slice(0, 10);
    const load = 0.7 + 0.5 * r();
    players.forEach((p, pi) => {
      const fit = 0.85 + (pi % 5) * 0.06;
      const dist = 4200 * load * fit * (0.9 + r() * 0.2);
      sessions.push({
        date,
        session_id: `demo_s${s + 1}`,
        player_id: p,
        is_demo: true,
        metrics: {
          duration_min: Math.round(70 * load),
          total_distance_m: Math.round(dist),
          hsr_distance_m: Math.round(dist * (0.06 + r() * 0.05)),
          sprints: Math.round(6 + r() * 14 * load),
          max_speed_kmh: Math.round((22 + r() * 6) * 10) / 10,
          hr_avg: Math.round(140 + r() * 25),
          hr_max: Math.round(178 + r() * 18),
        },
      });
    });
  }

  return { matches: [match], events, plays: [play], sessions, anchors: [] };
}
