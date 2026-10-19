import { ballStates, metersPerUnit, type FixedFile } from "./positions.ts";
import { PITCH, type EventType, type MatchEvent } from "./types.ts";

// Events suggested from the reviewed ball (rules agreed with the analyst on 2026-10-19). Pure functions.
//
// The rules only read the ball marked or reviewed by hand in the correction table (never the ball tracker or the
// players' tracker on their own): the stretches the ball review went through, its marks (by hand, or the tracker's
// ball where the review kept it) and the moments reviewed as «No se ve / fuera». Players are only used to know who
// touched the ball last.
// Nothing here becomes an event by itself: every suggestion is accepted, changed or rejected by the analyst.
//
//   Ball out over a touchline ............ throw-in for the team that did not touch it last.
//   Ball out over a goal line, by where it comes back:
//     in the goal area ................... goal kick of the defending team
//     on a corner of that line ........... corner of the attacking team
//     on the centre spot ................. goal of the attacking team
//     elsewhere .......................... goal kick or corner by the last touch (asks)
//   Ball lost from sight inside the pitch and back about where it was: a stoppage (foul, offside or just a pause),
//     restarted by a free kick of the team that touches it first (on the penalty spot: a penalty).
//   Ball carried or passed into the final third, or into the box, by a team that keeps it: entry.
//   Pass from a wide lane (outer or inner) of the final third that lands in the box, nearer the middle: cross.
//   Change of team in possession with the ball in play: loss and recovery; changes back and forth within 2 s: a duel,
//     won by the team left with the ball.
//
// Coordinates: the file is in the normalised pitch (105 x 68) as filmed; suggestions come out as events do, with the
// analysed team ("own") attacking towards x = 105. Distances and zones are in real meters of the venue.

export interface AutoInput {
  file: FixedFile;
  // Whether "own" attacks towards x = 105 in this video (as said in the correction table).
  ownRight: boolean;
  // Frame stretches the ball review went through (reviewedStretches of the samples seen and the hand marks).
  reviewed: [number, number][];
  // Frames reviewed as «No se ve / fuera» (no ball there).
  out: number[];
  // Long balls drawn by hand (from one mark to another): the ball was in play between them.
  links?: { from: number; to: number }[];
}

// One way to read a suggestion: the label and the events it adds. The first option is the most likely.
export interface AutoOption {
  label: string;
  events: AutoEvent[];
}
export interface AutoEvent {
  type: EventType;
  team: "own" | "opp";
  frame: number;
  x: number;
  y: number;
  x_end?: number | null;
  y_end?: number | null;
  outcome?: string | null;
  player_id?: string | null;
}
export type AutoRule = "out_touchline" | "out_goal_line" | "stoppage" | "final_third_entry" | "box_entry" | "cross" | "turnover" | "duel";
export interface Suggestion {
  // Stable while the marks around it do not change: a rejected suggestion stays rejected.
  id: string;
  rule: AutoRule;
  frame: number;
  // What was read, in a short sentence.
  why: string;
  // "high": the rule is clear (ball back on the corner, in the goal area...); "medium": read from the last touch.
  confidence: "high" | "medium";
  options: AutoOption[];
}

// Rule thresholds.
export const AUTO = {
  // A stretch without ball longer than this (s) is a gap even with no «No se ve» in it (ballPath does not fill it).
  gapS: 3,
  // How near a line the ball must be last seen (m) for a gap to be the ball going out over it.
  edgeM: 4,
  // A mark this far beyond a line (m) is a ball out (calibration noise is about a metre), and once out it is back in
  // play only at a mark this far inside every line (m).
  beyondM: 0.75,
  backInM: 1,
  // A last touch older than this (s) before the ball went out does not say who put it out.
  lastTouchS: 6,
  // Restart spots (m): goal area, corner, centre, penalty spot.
  goalAreaDepthM: 6.5,
  goalAreaHalfM: 10.5,
  cornerM: 3.5,
  centreM: 5,
  penaltySpotM: 2,
  // A stoppage restarts about where the ball was lost (m).
  stoppageM: 8,
  // After a restart the ball has to move this far from its spot (m) before it can go out again: while it waits for
  // the kick (a goal kick, a throw-in) the holes between marks are not new exits.
  restartMoveM: 3,
  // Entries: the next touch must be of the same team within this time (s); the same team cannot enter again within
  // `entryCooldownS`, and the ball has to go back `entryHysteresisM` behind the line first.
  entryConfirmS: 5,
  entryCooldownS: 5,
  entryHysteresisM: 3,
  // Crosses: the ball reaches the box within this time (s) and moves this much towards the middle (m).
  crossMaxS: 4,
  crossInwardM: 4,
  crossLateralM: 6,
  // Changes of team in possession less than this apart (s) are one dispute: a duel.
  duelS: 2,
  // A suggestion within this time (s) of an event of the same type and team already tagged is left out.
  duplicateS: 4,
} as const;

const BOX = { depth: 16.5, half: 20.16 };

type Side = "own" | "opp";
const other = (t: Side): Side => (t === "own" ? "opp" : "own");

interface Pt {
  frame: number;
  x: number; // real meters, own attacking towards x = L
  y: number;
}

export function autoEvents(input: AutoInput): Suggestion[] {
  const f = input.file;
  const [mx, my] = metersPerUnit(f);
  const L = PITCH.length * mx;
  const W = PITCH.width * my;
  const fps = f.fps;
  const inReview = (frame: number) => input.reviewed.some(([a, b]) => frame >= a && frame <= b);
  // Normalised as filmed -> real meters with own attacking right, and back to the event's normalised coordinates.
  const real = (x: number, y: number): [number, number] => (input.ownRight ? [x * mx, y * my] : [(PITCH.length - x) * mx, (PITCH.width - y) * my]);
  const norm = (p: { x: number; y: number }) => ({ x: round(p.x / mx), y: round(p.y / my) });

  // The ball the rules read: hand marks and kept tracker positions (precise), and the lines between them.
  const ballFile: FixedFile = { ...f, ball: f.ball.filter((b) => b.source !== "event") };
  const toPt = (b: { frame: number; x: number; y: number }): Pt => {
    const [x, y] = real(b.x, b.y);
    return { frame: b.frame, x, y };
  };
  // A hand mark is reviewed by definition; the tracker's ball only where the review went through.
  const precise = ballFile.ball.filter((b) => b.source === "manual" || (b.source === "auto" && inReview(b.frame))).sort((a, b) => a.frame - b.frame).map(toPt);
  const path = ballFile.ball.filter((b) => inReview(b.frame)).sort((a, b) => a.frame - b.frame).map(toPt);
  const ballAt = new Map(path.map((p) => [p.frame, p]));

  // Who touched the ball (only where it was precise and the player measured).
  const name = new Map(f.people.map((p) => [p.id, p.player_id]));
  const touches = ballStates(ballFile)
    .flatMap((s) => (s.touch && inReview(s.frame) ? [s.touch] : []))
    .map((t) => ({ frame: t.frame, team: t.team as Side, player: name.get(t.id) ?? null }));
  const lastTouchBefore = (frame: number, maxS: number) => {
    let best: (typeof touches)[number] | null = null;
    for (const t of touches) if (t.frame <= frame && frame - t.frame <= maxS * fps) best = t;
    return best;
  };
  const firstTouchAfter = (frame: number, maxS: number) => touches.find((t) => t.frame >= frame && t.frame - frame <= maxS * fps) ?? null;

  const linked = (a: number, b: number) => (input.links ?? []).some((l) => l.from <= a && b <= l.to);
  // A stretch without ball says something only if the review went through all of it.
  const allReviewed = (a: number, b: number) => input.reviewed.some(([x, y]) => x <= a && b <= y);
  const outBetween = (a: number, b: number) => input.out.some((o) => o > a && o < b);
  const outside = (p: Pt) => p.x < -AUTO.beyondM || p.x > L + AUTO.beyondM || p.y < -AUTO.beyondM || p.y > W + AUTO.beyondM;
  // Back on the pitch after being out: clearly inside, not a mark on the line while the ball is fetched.
  const clearlyIn = (p: Pt) => p.x >= AUTO.backInM && p.x <= L - AUTO.backInM && p.y >= AUTO.backInM && p.y <= W - AUTO.backInM;
  const near = (p: Pt, x: number, y: number, r: number) => Math.hypot(p.x - x, p.y - y) <= r;

  const out: Suggestion[] = [];
  // Moments the ball was dead (from going out or stopping until the restart): no entries, crosses or changes of team
  // are read across them.
  const dead: [number, number][] = [];

  // ------------------------------------------------------------------ ball out and stoppages
  // Which line the ball crossed: the one it is beyond, or the nearest one within edgeM, preferring the one it was
  // moving towards.
  const lineOf = (p: Pt, prev: Pt | null): "touch" | "goal_left" | "goal_right" | null => {
    if (p.y < -AUTO.beyondM || p.y > W + AUTO.beyondM) return "touch";
    if (p.x < -AUTO.beyondM) return "goal_left";
    if (p.x > L + AUTO.beyondM) return "goal_right";
    const v = prev && p.frame > prev.frame ? { x: p.x - prev.x, y: p.y - prev.y } : { x: 0, y: 0 };
    const cands = [
      { line: "touch" as const, d: Math.min(p.y, W - p.y), toward: p.y < W / 2 ? -v.y : v.y },
      { line: "goal_left" as const, d: p.x, toward: -v.x },
      { line: "goal_right" as const, d: L - p.x, toward: v.x },
    ].filter((c) => c.d <= AUTO.edgeM);
    if (cands.length === 0) return null;
    cands.sort((a, b) => b.toward - a.toward || a.d - b.d);
    return cands[0].line;
  };

  // The last restart found, and whether the ball is still on its spot at a frame (waiting for the kick).
  let lastRestart: Pt | null = null;
  const waiting = (frame: number) =>
    lastRestart !== null &&
    frame >= lastRestart.frame &&
    precise.every((q) => q.frame < (lastRestart as Pt).frame || q.frame > frame || near(q, (lastRestart as Pt).x, (lastRestart as Pt).y, AUTO.restartMoveM));
  for (let i = 0; i < precise.length; i++) {
    const p = precise[i];
    const prev = i > 0 ? precise[i - 1] : null;
    if (waiting(p.frame)) continue;
    let exit: Pt | null = null;
    let restart: Pt | null = null;
    let line: ReturnType<typeof lineOf> = null;
    // Where to go on reading after a ball out (its restart).
    let resume = -1;
    if (outside(p) && (!prev || !outside(prev))) {
      // A mark beyond a line: the ball is out there. It restarts at the next mark clearly back on the pitch.
      exit = p;
      line = lineOf(p, prev);
      // A throw-in is taken from the line itself; over a goal line the ball is fetched behind it, so only a mark clearly
      // inside counts as the restart (or one on a corner).
      // A corner is taken on the corner itself.
      const onCorner = (q: Pt) => [0, L].some((x) => near(q, x, 0, AUTO.cornerM) || near(q, x, W, AUTO.cornerM));
      resume = precise.findIndex((q, j) => j > i && (line === "touch" ? !outside(q) : clearlyIn(q) || onCorner(q)));
      restart = resume >= 0 ? precise[resume] : null;
    } else if (!outside(p) && i + 1 < precise.length) {
      const q = precise[i + 1];
      const gap = (q.frame - p.frame) / fps;
      if (outside(q) || linked(p.frame, q.frame)) continue;
      if (!outBetween(p.frame, q.frame) && (gap <= AUTO.gapS || !allReviewed(p.frame, q.frame))) continue;
      exit = p;
      restart = q;
      line = lineOf(p, prev);
      if (line === null) {
        // Lost from sight inside the pitch: a stoppage if it comes back about where it was.
        if (!near(q, p.x, p.y, AUTO.stoppageM)) continue;
        dead.push([p.frame, q.frame]);
        out.push(stoppage(p, q));
        lastRestart = q;
        continue;
      }
    }
    if (!exit || !restart || !line) {
      // Out until the end of what was reviewed: nothing more to read here.
      if (exit && outside(exit)) break;
      continue;
    }
    dead.push([exit.frame, restart.frame]);
    lastRestart = restart;
    const s = line === "touch" ? throwIn(exit, restart) : goalLine(exit, restart, line === "goal_right" ? "own" : "opp");
    if (s) out.push(s);
    if (resume > i) i = resume - 1;
  }

  function throwIn(exit: Pt, restart: Pt): Suggestion {
    const last = lastTouchBefore(exit.frame, AUTO.lastTouchS);
    // The team that did not touch it last; without a touch, the team of whoever touches it first after the restart.
    const first = firstTouchAfter(restart.frame, 3);
    const team = last ? other(last.team) : (first?.team ?? null);
    const at = norm({ x: restart.x, y: restart.y < W / 2 ? 0 : W });
    const why = last ? `Salió por la banda tras un toque ${of(last.team)}.` : "Salió por la banda (sin toque claro antes).";
    const ev = (t: Side): AutoEvent => ({ type: "throw_in", team: t, frame: restart.frame, ...at });
    return {
      id: `out_touchline:${exit.frame}`,
      rule: "out_touchline",
      frame: restart.frame,
      why,
      confidence: last ? "high" : "medium",
      options: team ? [{ label: `Saque de banda ${of(team)}`, events: [ev(team)] }, { label: `Saque de banda ${of(other(team))}`, events: [ev(other(team))] }] : [
        { label: "Saque de banda de nosotras", events: [ev("own")] },
        { label: "Saque de banda del rival", events: [ev("opp")] },
      ],
    };
  }

  // `attacking`: the team that attacks the goal of that line.
  function goalLine(exit: Pt, restart: Pt, attacking: Side): Suggestion {
    const defending = other(attacking);
    const lineX = attacking === "own" ? L : 0;
    const last = lastTouchBefore(exit.frame, AUTO.lastTouchS);
    const kick: AutoOption = { label: `Saque de meta ${of(defending)}`, events: [{ type: "goal_kick", team: defending, frame: restart.frame, ...norm(restart) }] };
    const cornerX = attacking === "own" ? L : 0;
    const cornerY = exit.y < W / 2 ? 0 : W;
    const corner: AutoOption = { label: `Córner ${of(attacking)}`, events: [{ type: "corner", team: attacking, frame: restart.frame, ...norm({ x: cornerX, y: cornerY }) }] };
    // The goal: at the last touch of the attacking team (the shot), or where the ball was last seen.
    const shooter = last && last.team === attacking ? last : null;
    const shotAt = shooter ? (ballAt.get(shooter.frame) ?? exit) : exit;
    const goal: AutoOption = {
      label: `Gol ${of(attacking)}`,
      events: [{ type: "goal", team: attacking, frame: shooter?.frame ?? exit.frame, ...norm(shotAt), player_id: shooter?.player ?? null }],
    };
    const base = { id: `out_goal_line:${exit.frame}`, rule: "out_goal_line" as const, frame: restart.frame };
    if (Math.abs(restart.x - lineX) <= AUTO.goalAreaDepthM && Math.abs(restart.y - W / 2) <= AUTO.goalAreaHalfM)
      return { ...base, why: "Salió por la línea de fondo y reaparece en el área chica.", confidence: "high", options: [kick, corner, goal] };
    if (near(restart, cornerX, 0, AUTO.cornerM) || near(restart, cornerX, W, AUTO.cornerM))
      return { ...base, why: "Salió por la línea de fondo y reaparece en la esquina.", confidence: "high", options: [corner, kick, goal] };
    if (near(restart, L / 2, W / 2, AUTO.centreM))
      return { ...base, frame: goal.events[0].frame, why: "Salió por la línea de fondo y reaparece en el centro del campo.", confidence: "high", options: [goal, kick, corner] };
    if (last?.team === defending) return { ...base, why: `Salió por la línea de fondo tras un toque ${of(defending)}.`, confidence: "medium", options: [corner, kick, goal] };
    if (last?.team === attacking) return { ...base, why: `Salió por la línea de fondo tras un toque ${of(attacking)}.`, confidence: "medium", options: [kick, corner, goal] };
    return { ...base, why: "Salió por la línea de fondo (sin toque claro antes).", confidence: "medium", options: [kick, corner, goal] };
  }

  function stoppage(lost: Pt, back: Pt): Suggestion {
    const taker = firstTouchAfter(back.frame, 3);
    const penaltyOf = near(back, L - 11, W / 2, AUTO.penaltySpotM) ? ("own" as Side) : near(back, 11, W / 2, AUTO.penaltySpotM) ? ("opp" as Side) : null;
    const at = norm(back);
    const id = `stoppage:${lost.frame}`;
    if (penaltyOf)
      return {
        id,
        rule: "stoppage",
        frame: back.frame,
        why: "El juego se detuvo y el balón reaparece en el punto penal.",
        confidence: "high",
        options: [{ label: `Penal para ${teamName(penaltyOf)}`, events: [{ type: "penalty", team: penaltyOf, frame: back.frame, ...at }, { type: "foul", team: other(penaltyOf), frame: lost.frame, ...at }] }],
      };
    const why = `El balón dejó de verse ${round((back.frame - lost.frame) / fps)} s y vuelve donde estaba.`;
    const options = (r: Side): AutoOption[] => [
      { label: `Falta ${of(other(r))} · tiro libre ${of(r)}`, events: [{ type: "foul", team: other(r), frame: lost.frame, ...at }, { type: "free_kick", team: r, frame: back.frame, ...at }] },
      { label: `Fuera de lugar ${of(other(r))}`, events: [{ type: "offside", team: other(r), frame: lost.frame, ...at }, { type: "free_kick", team: r, frame: back.frame, ...at }] },
      { label: "Solo una pausa (lesión, balón perdido…)", events: [] },
    ];
    if (taker) return { id, rule: "stoppage", frame: back.frame, why: `${why} Lo toca primero ${teamName(taker.team)}.`, confidence: "medium", options: options(taker.team) };
    return { id, rule: "stoppage", frame: back.frame, why, confidence: "medium", options: [...options("own").slice(0, 2), ...options("opp")] };
  }

  const isDead = (frame: number) => dead.some(([a, b]) => frame >= a && frame <= b);
  const crossesDead = (a: number, b: number) => dead.some(([x, y]) => x < b && a < y);

  // ------------------------------------------------------------------ entries (final third and box)
  // For a team, how far up the pitch the ball is (its attacking direction) and whether it is in the box it attacks.
  const up = (p: Pt, t: Side) => (t === "own" ? p.x : L - p.x);
  const inBox = (p: Pt, t: Side) => up(p, t) >= L - BOX.depth && up(p, t) <= L + AUTO.beyondM && Math.abs(p.y - W / 2) <= BOX.half;
  const entries = (rule: "final_third_entry" | "box_entry", inside: (p: Pt, t: Side) => boolean, behind: (p: Pt, t: Side) => boolean) => {
    for (const t of ["own", "opp"] as Side[]) {
      let armed = true;
      let lastAt = -Infinity;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        if (behind(b, t)) armed = true;
        if (b.frame - a.frame > 2 * f.stride || isDead(b.frame)) continue;
        if (!armed || inside(a, t) || !inside(b, t)) continue;
        const holder = lastTouchBefore(b.frame, AUTO.entryConfirmS);
        if (!holder || holder.team !== t) continue;
        const next = firstTouchAfter(b.frame, AUTO.entryConfirmS);
        if (next && next.team !== t) continue;
        if (!next && rule === "final_third_entry") continue;
        if ((b.frame - lastAt) / fps < AUTO.entryCooldownS) continue;
        armed = false;
        lastAt = b.frame;
        out.push({
          id: `${rule}:${t}:${b.frame}`,
          rule,
          frame: b.frame,
          why: rule === "box_entry" ? `El balón entra al área con ${teamName(t)} en posesión.` : `El balón entra al último tercio y ${t === "own" ? "lo conservamos" : "el rival lo conserva"}.`,
          confidence: next ? "high" : "medium",
          options: [{ label: rule === "box_entry" ? `Entrada al área ${of(t)}` : `Entrada al último tercio ${of(t)}`, events: [{ type: rule, team: t, frame: b.frame, ...norm(b), player_id: holder.player }] }],
        });
      }
    }
  };
  entries(
    "final_third_entry",
    (p, t) => up(p, t) >= (2 * L) / 3,
    (p, t) => up(p, t) < (2 * L) / 3 - AUTO.entryHysteresisM,
  );
  entries("box_entry", inBox, (p, t) => up(p, t) < L - BOX.depth - AUTO.entryHysteresisM || Math.abs(p.y - W / 2) > BOX.half + AUTO.entryHysteresisM);

  // ------------------------------------------------------------------ crosses
  for (let i = 0; i < touches.length; i++) {
    const a = touches[i];
    const start = ballAt.get(a.frame);
    if (!start) continue;
    const t = a.team;
    const wide = Math.abs(start.y - W / 2) >= W / 10; // outside the central lane (5 lanes across)
    const cornerFlag = near(start, t === "own" ? L : 0, 0, AUTO.cornerM) || near(start, t === "own" ? L : 0, W, AUTO.cornerM);
    if (!wide || cornerFlag || up(start, t) < (2 * L) / 3 || inBox(start, t)) continue;
    // Where the ball lands: its last position in the box up to the next touch (or within crossMaxS).
    const next = touches[i + 1];
    const until = Math.min(next ? next.frame : Infinity, a.frame + AUTO.crossMaxS * fps);
    const landing = path.filter((p) => p.frame > a.frame && p.frame <= until && inBox(p, t)).pop();
    if (!landing || crossesDead(a.frame, landing.frame)) continue;
    if (Math.abs(landing.y - W / 2) > Math.abs(start.y - W / 2) - AUTO.crossInwardM || Math.abs(landing.y - start.y) < AUTO.crossLateralM) continue;
    const end = norm(landing);
    out.push({
      id: `cross:${t}:${a.frame}`,
      rule: "cross",
      frame: a.frame,
      why: `Pase desde la banda del último tercio que cae en el área${next && next.frame <= until ? (next.team === t ? " y lo toca una compañera" : " y lo toca el rival") : ""}.`,
      confidence: "medium",
      options: [{ label: `Centro ${of(t)}`, events: [{ type: "cross", team: t, frame: a.frame, ...norm(start), x_end: end.x, y_end: end.y, player_id: a.player }] }],
    });
  }

  // ------------------------------------------------------------------ losses, recoveries and duels
  // Changes of team in possession. When the ball goes back and forth within duelS it is a dispute: the changes are read
  // together as one duel, won by the team left with the ball (and a loss only if that is not the team that had it).
  const changes: { a: (typeof touches)[number]; b: (typeof touches)[number]; from: Pt; to: Pt }[] = [];
  for (let i = 1; i < touches.length; i++) {
    const a = touches[i - 1];
    const b = touches[i];
    if (a.team === b.team || b.frame - a.frame > 5 * fps || crossesDead(a.frame, b.frame)) continue;
    const from = ballAt.get(a.frame);
    const to = ballAt.get(b.frame);
    if (from && to) changes.push({ a, b, from, to });
  }
  const groups: (typeof changes)[] = [];
  for (const c of changes) {
    const g = groups[groups.length - 1];
    if (g && c.a.frame - g[g.length - 1].b.frame <= AUTO.duelS * fps) g.push(c);
    else groups.push([c]);
  }
  for (const g of groups) {
    const first = g[0];
    const last = g[g.length - 1];
    const had = first.a.team;
    const kept = last.b.team;
    const turnover: AutoEvent[] =
      had === kept
        ? []
        : [
            { type: "loss", team: had, frame: first.a.frame, ...norm(first.from), player_id: first.a.player },
            { type: "recovery", team: kept, frame: last.b.frame, ...norm(last.to), player_id: last.b.player },
          ];
    if (g.length === 1) {
      out.push({
        id: `turnover:${first.a.frame}:${first.b.frame}`,
        rule: "turnover",
        frame: first.b.frame,
        why: `El balón pasa ${of(had)} ${toTeam(kept)}.`,
        confidence: "medium",
        options: [{ label: `Pérdida ${of(had)} y recuperación ${of(kept)}`, events: turnover }],
      });
      continue;
    }
    // The duel is noted from our side: won or lost by us, where the dispute started.
    const duel: AutoEvent = { type: "duel", team: "own", frame: first.b.frame, ...norm(first.to), outcome: kept === "own" ? "won" : "lost", player_id: kept === "own" ? last.b.player : null };
    out.push({
      id: `duel:${first.a.frame}:${last.b.frame}`,
      rule: "duel",
      frame: first.b.frame,
      why: `Disputa de ${round((last.b.frame - first.a.frame) / fps)} s: el balón va y viene y se lo queda ${teamName(kept)}.`,
      confidence: "medium",
      options:
        had === kept
          ? [
              { label: `Duelo ${kept === "own" ? "ganado" : "perdido"} (sigue ${teamName(kept)})`, events: [duel] },
              { label: "Nada: solo un rebote", events: [] },
            ]
          : [
              { label: `Duelo ${kept === "own" ? "ganado" : "perdido"} y pérdida ${of(had)}`, events: [duel, ...turnover] },
              { label: `Solo la pérdida ${of(had)}`, events: turnover },
            ],
    });
  }

  return out.sort((a, b) => a.frame - b.frame);
}

const round = (v: number) => Math.round(v * 10) / 10;
const teamName = (t: Side) => (t === "own" ? "nosotras" : "el rival");
const of = (t: Side) => (t === "own" ? "de nosotras" : "del rival");
const toTeam = (t: Side) => (t === "own" ? "a nosotras" : "al rival");

// Stretches reviewed in the ball review: each sample gone through (and each hand mark, wherever it was made) covers half
// the interval to each side.
export function reviewedStretches(seen: number[], everyS: number, fps: number): [number, number][] {
  const half = (everyS * fps) / 2;
  const out: [number, number][] = [];
  for (const s of [...seen].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && s - half <= last[1] + 1) last[1] = s + half;
    else out.push([s - half, s + half]);
  }
  return out;
}

// Suggestions not yet decided: the rejected ones, and the ones whose first event is already tagged (same type and team
// within AUTO.duplicateS), are left out.
export function pending(suggestions: Suggestion[], events: Pick<MatchEvent, "type" | "team" | "t_video" | "video_id">[], videoId: string, fps: number, rejected: string[]): Suggestion[] {
  const no = new Set(rejected);
  const tagged = (e: AutoEvent) =>
    events.some((o) => (o.video_id ?? "v1") === videoId && o.type === e.type && o.team === e.team && Math.abs(o.t_video - e.frame / fps) < AUTO.duplicateS);
  return suggestions.filter((s) => !no.has(s.id) && !s.options.some((o) => o.events.length > 0 && tagged(o.events[0])));
}
