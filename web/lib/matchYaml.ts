// The match data the app keeps (kind, date, teams, venue) written into matches/<folder>/match.yaml, where Python reads
// them. Only those lines change: every other line, and the comment at the end of a changed line, stay as they are.
// Pure functions.

export interface YamlMeta {
  kind?: string;
  date?: string;
  own_team_name?: string;
  other_team_name?: string;
  venue?: { name?: string; pitch_length_m?: number; pitch_width_m?: number };
}

const TOP = ["kind", "date", "own_team_name", "other_team_name"] as const;
const VENUE = ["name", "pitch_length_m", "pitch_width_m"] as const;

const unquote = (v: string) => {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};
// A value and its comment: `"Tec CCM"   # jornada 1` -> ["\"Tec CCM\"", "   # jornada 1"]. A # inside quotes is text.
function split(rest: string): [string, string] {
  let q: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(rest[i - 1]))) {
      const value = rest.slice(0, i).replace(/\s+$/, "");
      return [value, rest.slice(value.length)];
    }
  }
  return [rest.replace(/\s+$/, ""), ""];
}
// Numbers and plain words (kind: own) as they are; any other text in double quotes (dates stay text for Python).
const fmt = (v: string | number) => (typeof v === "number" || /^[a-z_]+$/.test(v) ? String(v) : JSON.stringify(v));

// The lines of the venue block: from `venue:` to the next line that is not indented.
function venueBlock(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => /^venue:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === "")) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return [start, end];
}

export function readYamlMeta(text: string): YamlMeta {
  const lines = text.split(/\r?\n/);
  const out: YamlMeta = {};
  for (const k of TOP) {
    const l = lines.find((x) => x.startsWith(`${k}:`));
    if (l) out[k] = unquote(split(l.slice(k.length + 1))[0]);
  }
  const b = venueBlock(lines);
  if (b) {
    const venue: NonNullable<YamlMeta["venue"]> = {};
    for (const l of lines.slice(b[0] + 1, b[1])) {
      const m = l.match(/^\s+(name|pitch_length_m|pitch_width_m):(.*)$/);
      if (!m) continue;
      const v = unquote(split(m[2])[0]);
      if (m[1] === "name") venue.name = v;
      else if (Number.isFinite(Number(v)) && v !== "") venue[m[1] as "pitch_length_m" | "pitch_width_m"] = Number(v);
    }
    out.venue = venue;
  }
  return out;
}

// The fields of `meta` that differ from what match.yaml says (empty values are not written: they do not erase).
export function yamlDiff(text: string, meta: YamlMeta): string[] {
  const cur = readYamlMeta(text);
  const out: string[] = [];
  for (const k of TOP) if (meta[k] && meta[k] !== cur[k]) out.push(k);
  for (const k of VENUE) {
    const v = meta.venue?.[k];
    if (v !== undefined && v !== "" && v !== cur.venue?.[k]) out.push(`venue.${k}`);
  }
  return out;
}

export function writeYamlMeta(text: string, meta: YamlMeta): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const setLine = (i: number, key: string, indent: string, value: string | number) => {
    const rest = lines[i].slice(lines[i].indexOf(":") + 1);
    const [, comment] = split(rest);
    lines[i] = `${indent}${key}: ${fmt(value)}${comment}`;
  };
  // Top-level keys: changed in place, or added after match_id (or at the top).
  for (const k of TOP) {
    const v = meta[k];
    if (!v) continue;
    const i = lines.findIndex((x) => x.startsWith(`${k}:`));
    if (i >= 0) setLine(i, k, "", v);
    else {
      const at = lines.findIndex((x) => x.startsWith("match_id:"));
      lines.splice(at + 1, 0, `${k}: ${fmt(v)}`);
    }
  }
  const venue = meta.venue;
  if (venue && VENUE.some((k) => venue[k] !== undefined && venue[k] !== "")) {
    let b = venueBlock(lines);
    if (!b) {
      // A new block before `videos:` (or at the end).
      const at = lines.findIndex((x) => x.startsWith("videos:"));
      const pos = at >= 0 ? at : lines.length;
      lines.splice(pos, 0, "venue:", "");
      b = [pos, pos + 1];
    }
    for (const k of VENUE) {
      const v = venue[k];
      if (v === undefined || v === "") continue;
      const [s, e] = venueBlock(lines) ?? b;
      const i = lines.slice(s + 1, e).findIndex((x) => new RegExp(`^\\s+${k}:`).test(x));
      if (i >= 0) setLine(s + 1 + i, k, lines[s + 1 + i].match(/^\s+/)?.[0] ?? "  ", v);
      else lines.splice(e, 0, `  ${k}: ${fmt(v)}`);
    }
  }
  return lines.join(eol);
}

// ------------------------------------------------------------------ the mask of one video

type Rect = [number, number, number, number];

// The lines of a video's block (`  - video_id: v1` and its indented lines).
function videoBlock(lines: string[], videoId: string): [number, number] | null {
  const start = lines.findIndex((l) => new RegExp(String.raw`^\s*-\s*video_id:\s*["']?${videoId}["']?\s*(#.*)?$`).test(l));
  if (start < 0) return null;
  const indent = (lines[start].match(/^\s*/)?.[0].length ?? 0) + 2;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || (lines[end].match(/^\s*/)?.[0].length ?? 0) >= indent) && !/^\s*-\s/.test(lines[end].slice(0, indent))) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  return [start, end];
}

// Rectangles not to look at in a video ([[x0, y0, x1, y1], ...] in its pixels): the scoreboard, the channel logo.
export function readVideoMask(text: string, videoId: string): Rect[] {
  const lines = text.split(/\r?\n/);
  const b = videoBlock(lines, videoId);
  if (!b) return [];
  const l = lines.slice(b[0] + 1, b[1]).find((x) => /^\s+mask:/.test(x));
  if (!l) return [];
  try {
    const v = JSON.parse(split(l.slice(l.indexOf(":") + 1))[0] || "[]") as unknown;
    return Array.isArray(v) ? (v.filter((r) => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number")) as Rect[]) : [];
  } catch {
    return [];
  }
}

// Writes (or removes, with no rectangles) the mask line inside the video's block; null if the video is not there.
export function writeVideoMask(text: string, videoId: string, rects: Rect[]): string | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const b = videoBlock(lines, videoId);
  if (!b) return null;
  const indent = " ".repeat((lines[b[0]].match(/^\s*/)?.[0].length ?? 0) + 2);
  const value = `[${rects.map((r) => `[${r.map((n) => Math.round(n)).join(", ")}]`).join(", ")}]`;
  const i = lines.slice(b[0] + 1, b[1]).findIndex((x) => /^\s+mask:/.test(x));
  if (i >= 0) {
    const at = b[0] + 1 + i;
    if (rects.length) lines[at] = `${indent}mask: ${value}`;
    else lines.splice(at, 1);
  } else if (rects.length) lines.splice(b[1], 0, `${indent}mask: ${value}`);
  return lines.join(eol);
}
