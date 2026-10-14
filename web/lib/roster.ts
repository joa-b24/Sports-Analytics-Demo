import type { RosterPlayer } from "./types.ts";

// Squad list. Pure functions: no storage, no React.

// Numbers given to players whose usual number is not known yet: from 99 down, so they are easy to spot and change.
export const UNKNOWN_FROM = 99;

// One player per line: "#31 Sama", "31 Sama", "Sama #31" or just "Ivonne". Players without a number get a free one
// from 99 down. Names already in `current` keep their place (a new number replaces the old one).
export function parseRoster(text: string, current: RosterPlayer[] = []): RosterPlayer[] {
  const out = current.map((p) => ({ ...p }));
  const byName = new Map(out.map((p) => [p.player_id.toLowerCase(), p]));
  const pending: RosterPlayer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^#?\s*(\d{1,3})[\s.,:-]+(.+)$/) ?? line.match(/^(.+?)\s+#\s*(\d{1,3})$/);
    let name = line;
    let number: number | null = null;
    if (m) {
      const numFirst = /^\d/.test(m[1]);
      number = Number(numFirst ? m[1] : m[2]);
      name = (numFirst ? m[2] : m[1]).trim();
    }
    name = name.replace(/^#\s*/, "").trim();
    if (!name) continue;
    const had = byName.get(name.toLowerCase());
    if (had) {
      if (number !== null) had.number = number;
      continue;
    }
    const p = { player_id: name, number };
    byName.set(name.toLowerCase(), p);
    out.push(p);
    if (number === null) pending.push(p);
  }
  const used = new Set(out.map((p) => p.number).filter((n): n is number => n !== null));
  let next = UNKNOWN_FROM;
  for (const p of pending) {
    while (used.has(next)) next--;
    p.number = next;
    used.add(next);
  }
  return out;
}

// Players by number, the unknown ones (high numbers) last.
export const sortRoster = (list: RosterPlayer[]) =>
  [...list].sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.player_id.localeCompare(b.player_id, "es"));

// Two players with the same number: each number should belong to one player.
export function repeatedNumbers(list: RosterPlayer[]): number[] {
  const seen = new Map<number, number>();
  for (const p of list) if (p.number !== null) seen.set(p.number, (seen.get(p.number) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}
