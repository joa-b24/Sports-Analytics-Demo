// Board plays (the "Pizarrón" screen): designed set pieces with no match, and plays of a match copied onto the board.
// Pure functions over plain objects: no storage, no React. Times of a board are seconds from its start.
import type { Annotation } from "./annotations.ts";
import { TOKENS, defaultPositions } from "./stats.ts";
import {
  BOARD_CATEGORIES,
  PITCH,
  type Board,
  type BoardCategory,
  type BoardFraming,
  type BoardSide,
  type BoardStep,
  type BoardToken,
  type Play,
  type State,
} from "./types.ts";

// Seconds between a new step and the one before it.
export const STEP_S = 2;
// How long the last step lasts: a drawing of the last step is visible from it until this much later.
export const BOARD_TAIL_S = 1;
// Seconds between the steps taken from measured positions.
export const MEASURED_STEP_S = 2;

type Pos = Record<string, [number, number]>;

const defaultTokens = (): BoardToken[] => TOKENS.map((t) => ({ ...t }));

// --------------------------------------------------------------------------------------------- starting positions

// A corner taken from the top right corner by the team attacking to the right: [attackers, defenders, ball].
const CORNER_ATTACK: [number, number][] = [
  [8, 34], [48, 24], [48, 44], [86, 22], [93, 30], [95, 38], [99, 31], [100, 40], [92, 34], [85, 40], [102.2, 2.8],
];
const CORNER_DEFENCE: [number, number][] = [
  [104, 34], [104, 30.5], [102, 28], [100, 33], [100, 37], [98, 30], [96, 35], [94, 40], [89, 28], [88, 38], [62, 34],
];
const CORNER_BALL: [number, number] = [104.4, 0.7];

const mirror = ([x, y]: [number, number]): [number, number] => [PITCH.length - x, PITCH.width - y];

// Where the pieces start on a new board. The analysed team always attacks to the right; a set piece against us is the
// same one mirrored (the other team attacks to the left). Only a reference to move from, not a measurement.
export function startPositions(category: BoardCategory, side: BoardSide): Pos {
  if (category === "corner") {
    const pos: Pos = {};
    const attack = side === "for" ? CORNER_ATTACK : CORNER_ATTACK.map(mirror);
    const defence = side === "for" ? CORNER_DEFENCE : CORNER_DEFENCE.map(mirror);
    attack.forEach((p, i) => (pos[`${side === "for" ? "o" : "r"}${i + 1}`] = p));
    defence.forEach((p, i) => (pos[`${side === "for" ? "r" : "o"}${i + 1}`] = p));
    pos.ball = side === "for" ? CORNER_BALL : mirror(CORNER_BALL);
    return pos;
  }
  const pos = defaultPositions();
  const ball: Record<Exclude<BoardCategory, "corner">, [number, number]> = {
    free_kick: [80, 26],
    throw_in: [62, 0.5],
    build_up: [6, 34],
    other: [52.5, 34],
  };
  const b = ball[category];
  pos.ball = side === "for" ? b : mirror(b);
  return pos;
}

// Corners and free kicks start framed on the half where they are taken; the rest on the whole pitch.
export const defaultFraming = (category: BoardCategory, side: BoardSide): BoardFraming =>
  category === "corner" || category === "free_kick" ? (side === "for" ? "right" : "left") : "full";

export function newBoard(board_id: string, category: BoardCategory, side: BoardSide, title: string): Board {
  return {
    board_id,
    title,
    category,
    side,
    framing: defaultFraming(category, side),
    notes: "",
    tokens: defaultTokens(),
    keyframes: [{ t: 0, pos: startPositions(category, side), note: "" }],
    annotations: [],
  };
}

// ---------------------------------------------------------------------------------------------- saved boards

const isCategory = (c: unknown): c is BoardCategory => (BOARD_CATEGORIES as readonly unknown[]).includes(c);

// A board as saved, with the fields a backup may lack filled in.
export function normalizeBoard(b: Partial<Board> & { board_id: string }): Board {
  return {
    ...b,
    board_id: b.board_id,
    title: b.title ?? "Jugada",
    category: isCategory(b.category) ? b.category : "other",
    side: b.side === "against" ? "against" : "for",
    notes: b.notes ?? "",
    tokens: b.tokens?.length ? b.tokens : defaultTokens(),
    keyframes: [...(b.keyframes ?? [])].sort((x, y) => x.t - y.t),
    annotations: b.annotations ?? [],
    framing: b.framing === "right" || b.framing === "left" ? b.framing : "full",
  };
}

// The boards of a state; a state saved before the board existed has none.
export const boardsOf = (s: Partial<State>): Board[] => (s.boards ?? []).map(normalizeBoard);

export function filterBoards(boards: Board[], f: { category?: BoardCategory | "all"; side?: BoardSide | "all" }): Board[] {
  return boards
    .filter((b) => (!f.category || f.category === "all" || b.category === f.category) && (!f.side || f.side === "all" || b.side === f.side))
    .sort((a, b) => a.title.localeCompare(b.title, "es", { numeric: true }));
}

// ------------------------------------------------------------------------------------------------------ steps

// The time span of step i: from it to the next one (the last one lasts BOARD_TAIL_S).
export function stepSpan(board: Board, i: number): { t_in: number; t_out: number } {
  const k = board.keyframes;
  return { t_in: k[i].t, t_out: k[i + 1]?.t ?? k[i].t + BOARD_TAIL_S };
}

// A drawing that starts at step `from` and lasts until the end of step `to`.
export function spanOfSteps(board: Board, from: number, to: number): { t_in: number; t_out: number } {
  return { t_in: stepSpan(board, from).t_in, t_out: stepSpan(board, Math.max(from, to)).t_out };
}

// Indices of the steps where a drawing is visible.
export const stepsOf = (board: Board, a: Pick<Annotation, "t_in" | "t_out">): number[] =>
  board.keyframes.flatMap((k, i) => (k.t >= a.t_in && k.t < a.t_out ? [i] : []));

export const boardDuration = (board: Board): number =>
  board.keyframes.length ? board.keyframes[board.keyframes.length - 1].t + BOARD_TAIL_S : 0;

// A new step at the end, STEP_S after the last one, with the pieces where they were.
export function addStep(board: Board): Board {
  const last = board.keyframes[board.keyframes.length - 1];
  const step: BoardStep = last ? { t: round1(last.t + STEP_S), pos: clonePos(last.pos), note: "" } : { t: 0, pos: startPositions(board.category, board.side), note: "" };
  return { ...board, keyframes: [...board.keyframes, step] };
}

// Removes step i and the drawings that start at it. Drawings that only go through it keep their times.
export function removeStep(board: Board, i: number): Board {
  const t = board.keyframes[i]?.t;
  if (t === undefined) return board;
  return {
    ...board,
    keyframes: board.keyframes.filter((_, j) => j !== i),
    annotations: board.annotations.filter((a) => a.t_in !== t),
  };
}

export function moveToken(board: Board, step: number, id: string, p: [number, number]): Board {
  return {
    ...board,
    keyframes: board.keyframes.map((k, j) => (j === step ? { ...k, pos: { ...k.pos, [id]: p } } : k)),
  };
}

// Takes a token off the board (from every step) and the drawings tied to it; or puts it back where the step before has
// it or, if none, at its starting position.
export function toggleToken(board: Board, id: string): Board {
  const on = board.keyframes.some((k) => k.pos[id]);
  if (on)
    return {
      ...board,
      keyframes: board.keyframes.map((k) => {
        const pos = { ...k.pos };
        delete pos[id];
        return { ...k, pos };
      }),
      annotations: board.annotations.filter((a) => !a.anchors.some((x) => x.kind === "player" && x.identity === id)),
    };
  const start = startPositions(board.category, board.side)[id] ?? [PITCH.length / 2, PITCH.width / 2];
  return { ...board, keyframes: board.keyframes.map((k) => ({ ...k, pos: { ...k.pos, [id]: start } })) };
}

// SVG viewBox of a framing, in pitch meters with a 2 m margin. The whole pitch leaves room under it for the attack
// direction; a half does not show it.
export function framingBox(framing: BoardFraming | undefined): [number, number, number, number] {
  if (framing === "right") return [PITCH.length / 2 - 2, -2, PITCH.length / 2 + 4, PITCH.width + 4];
  if (framing === "left") return [-2, -2, PITCH.length / 2 + 4, PITCH.width + 4];
  return [-2, -2, PITCH.length + 4, PITCH.width + 8];
}

// Printable area that fits both A4 and letter with the page margins of globals.css (mm): the widest width, so a
// percentage is never larger than planned, and the shortest height. Then what a page header and the caption and
// note of each step take (the header with up to three lines of notes), and the gap between steps.
export const SHEET = { w: 188, h: 245, header: 30, caption: 14, gap: 5 };

// How the steps of a printed page are laid out: in how many columns, and how wide each pitch is (% of its column),
// as large as `perPage` steps of this framing allow on one page.
export function sheetLayout(perPage: number, framing: BoardFraming | undefined): { cols: number; itemPct: number } {
  const [, , vw, vh] = framingBox(framing);
  const ratio = vh / vw;
  let best = { cols: 1, w: 0 };
  for (let cols = 1; cols <= perPage; cols++) {
    const rows = Math.ceil(perPage / cols);
    const colW = (SHEET.w - SHEET.gap * (cols - 1)) / cols;
    const byHeight = ((SHEET.h - SHEET.header - SHEET.gap * (rows - 1)) / rows - SHEET.caption) / ratio;
    const w = Math.min(colW, byHeight);
    if (w > best.w + 0.5) best = { cols, w };
  }
  const colW = (SHEET.w - SHEET.gap * (best.cols - 1)) / best.cols;
  return { cols: best.cols, itemPct: Math.floor((best.w / colW) * 100) };
}

// Pages of the printed sheets: `perPage` steps on each.
export function sheetPages<T>(steps: T[], perPage: number): T[][] {
  const n = Math.max(1, Math.round(perPage));
  const out: T[][] = [];
  for (let i = 0; i < steps.length; i += n) out.push(steps.slice(i, i + n));
  return out;
}

// --------------------------------------------------------------------------------------------- from a match play

// Measured positions at time t of the video (lib/positions.ts `positionsAt`), oriented with our team attacking to the
// right. `label` is what the token shows (the shirt number when known); never a name.
export type MeasuredAt = (t: number) => {
  players: { id: number; team: string; x: number; y: number; label?: string }[];
  ball: [number, number] | null;
} | null;

// A play of a match copied onto the board. With measured positions, one step every MEASURED_STEP_S seconds (and the
// end) with the players then in frame: only those, nobody is added. Otherwise its keyframes, as they are. Times are
// counted from the start of the play; the play itself does not change.
export function boardFromPlay(play: Play, board_id: string, measured?: MeasuredAt): Board {
  const base: Board = {
    board_id,
    title: play.title,
    category: "other",
    side: "for",
    notes: play.note,
    tokens: defaultTokens(),
    keyframes: [],
    annotations: [],
    match_id: play.match_id,
    play_id: play.play_id,
  };
  if (measured) {
    const times: number[] = [];
    for (let t = play.t_start; t < play.t_end - 1e-6; t += MEASURED_STEP_S) times.push(t);
    times.push(play.t_end);
    const tokens = new Map<string, BoardToken>();
    const steps: BoardStep[] = [];
    for (const t of times) {
      const m = measured(t);
      if (!m) continue;
      const pos: Pos = {};
      for (const p of m.players) {
        if (p.team !== "own" && p.team !== "opp") continue;
        const id = `m${p.id}`;
        if (!tokens.has(id)) tokens.set(id, { id, team: p.team, label: p.label ?? "" });
        pos[id] = [p.x, p.y];
      }
      if (m.ball) pos.ball = [m.ball[0], m.ball[1]];
      steps.push({ t: round1(t - play.t_start), pos, note: "" });
    }
    if (steps.length > 0) {
      const ball: BoardToken[] = steps.some((s) => s.pos.ball) ? [{ id: "ball", team: "ball", label: "" }] : [];
      return { ...base, tokens: [...tokens.values(), ...ball], keyframes: steps };
    }
  }
  const kfs = [...play.keyframes].sort((a, b) => a.t - b.t);
  const t0 = Math.min(play.t_start, kfs[0]?.t ?? play.t_start);
  return { ...base, keyframes: kfs.map((k) => ({ t: round1(k.t - t0), pos: clonePos(k.pos), note: "" })) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const clonePos = (p: Pos): Pos => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [v[0], v[1]]]));
