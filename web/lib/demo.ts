import { defaultPositions } from "./stats";
import { EMPTY_REPORT, type EventType, type Match, type MatchEvent, type Play, type SegmentMark, type SessionRow, type State } from "./types";

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
  ["final_third_entry", 16],
  ["box_entry", 8],
  ["goal_kick", 8],
  ["cross", 8],
];

const pick = <T,>(r: () => number, options: readonly T[]): T => options[Math.floor(r() * options.length)];

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
  let seq = 0;
  // Attacking events sit near the goal that team attacks (own -> right, opp -> left).
  const push = (type: EventType, own: boolean, t: number, zone: "attack" | "third" | "defend" | "any", extra: Partial<MatchEvent> = {}) => {
    let x = zone === "attack" ? 80 + r() * 23 : zone === "third" ? 70 + r() * 6 : zone === "defend" ? 2 + r() * 6 : 10 + r() * 85;
    if (!own) x = 105 - x;
    events.push({
      event_id: `demo_e${seq++}`,
      match_id: DEMO_MATCH_ID,
      t_video: Math.round(t * 10) / 10,
      period: t < 2880 ? 1 : 2,
      type,
      team: own ? "own" : "opp",
      player_id: null,
      x: Math.round(x * 10) / 10,
      y: Math.round((6 + r() * 56) * 10) / 10,
      outcome: null,
      detail: null,
      note: null,
      ...extra,
    });
  };
  const shot = (own: boolean, t: number) =>
    r() < 0.12 ? push("goal", own, t, "attack") : push("shot", own, t, "attack", { outcome: pick(r, ["on_target", "off_target", "off_target", "blocked"]) });

  for (let i = 0; i < 150; i++) {
    let roll = r() * total;
    let type: EventType = "other";
    for (const [t, w] of WEIGHTS) {
      roll -= w;
      if (roll <= 0) {
        type = t;
        break;
      }
    }
    const own = r() < 0.55;
    // Play runs 3:00-48:00 and 63:00-108:00 of the video; the marks below describe the same stretches.
    const half = r() < 0.5 ? 180 : 3780;
    const t = half + r() * 2690;
    const setPiece = { outcome: pick(r, ["shot", "cleared", "cleared", "play_on"]) };
    if (type === "shot" || type === "goal") shot(own, t);
    else if (type === "corner") push(type, own, t, "attack", { ...setPiece, detail: pick(r, ["inswing", "inswing", "outswing", "short"]) });
    else if (type === "free_kick") push(type, own, t, "any", setPiece);
    else if (type === "cross") push(type, own, t, "attack", setPiece);
    else if (type === "goal_kick") push(type, own, t, "defend", { detail: pick(r, ["short", "long", "long"]), outcome: pick(r, ["kept", "lost"]) });
    else if (type === "final_third_entry") push(type, own, t, "third");
    else if (type === "key_pass") push(type, own, t, "attack");
    else if (type === "box_entry") {
      push(type, own, t, "attack");
      if (r() < 0.4) shot(own, t + 3 + r() * 8);
    } else if (type === "recovery") {
      push(type, own, t, "any", { detail: pick(r, ["forward", "forward", "backward"]) });
      if (r() < 0.2) shot(own, t + 5 + r() * 8);
    } else if (type === "loss") {
      push(type, own, t, "any");
      if (r() < 0.14) shot(!own, t + 5 + r() * 8);
      else if (r() < 0.25) push("recovery", own, t + 2 + r() * 5, "any", { detail: pick(r, ["forward", "backward"]) });
    } else push(type, own, t, "any");
  }
  events.sort((a, b) => a.t_video - b.t_video);

  const marks: SegmentMark[] = (
    [
      [0, "pausa"],
      [180, "juego"],
      [2880, "pausa"],
      [3780, "juego"],
      [6480, "fin"],
    ] as const
  ).map(([t_video, tipo], i) => ({ mark_id: `demo_g${i}`, match_id: DEMO_MATCH_ID, t_video, tipo }));

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

  // Six weeks, four sessions a week, so the acute:chronic ratio has the history it needs.
  const sessions: SessionRow[] = [];
  const players = Array.from({ length: 14 }, (_, i) => `J${String(i + 1).padStart(2, "0")}`);
  const WEEKDAYS = [0, 1, 3, 4];
  for (let s = 0; s < 24; s++) {
    const week = Math.floor(s / 4);
    const d = new Date(Date.UTC(2026, 7, 24 + week * 7 + WEEKDAYS[s % 4]));
    const date = d.toISOString().slice(0, 10);
    const load = 0.7 + 0.5 * r();
    const scale = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
    players.forEach((p, pi) => {
      const fit = 0.85 + (pi % 5) * 0.06;
      const dist = 4200 * load * fit * (0.9 + r() * 0.2);
      // Two players ramp up in the last week, one eases off: the ratio should tell them apart.
      const push = week === 5 ? (pi === 2 || pi === 9 ? 1.5 : pi === 6 ? 0.45 : 1) : 1;
      // Not everyone wears a watch: those rows take the duration of the session from the others.
      const hasWatch = pi % 4 !== 3;
      const tired = Math.min(7, Math.max(1, Math.round(2 + load * 2 * push + r() * 1.5)));
      sessions.push({
        date,
        session_id: `demo_s${s + 1}`,
        player_id: p,
        is_demo: true,
        metrics: {
          duration_min: hasWatch ? Math.round(70 * load) : null,
          total_distance_m: hasWatch ? Math.round(dist * push) : null,
          hsr_distance_m: hasWatch ? Math.round(dist * push * (0.06 + r() * 0.05)) : null,
          sprints: hasWatch ? Math.round(6 + r() * 14 * load) : null,
          max_speed_kmh: hasWatch ? Math.round((22 + r() * 6) * 10) / 10 : null,
          hr_avg: hasWatch ? Math.round(140 + r() * 25) : null,
          hr_max: hasWatch ? Math.round(178 + r() * 18) : null,
          rpe: Math.min(10, Math.max(1, Math.round((3 + load * 3.2) * push + (r() - 0.5) * 1.6))),
          sleep_hours: Math.round((6 + r() * 2.5) * 2) / 2,
          sleep_q: scale(1, 5),
          stress: scale(1, 5),
          fatigue: tired,
          soreness: Math.min(7, Math.max(1, tired + scale(-1, 1))),
          energy: Math.min(10, Math.max(1, 10 - tired + scale(-1, 1))),
        },
      });
    });
  }

  return { matches: [match], events, plays: [play], sessions, anchors: [], segments: marks, venues: [], trackEdits: [],
    roster: [], jerseys: {} };
}
