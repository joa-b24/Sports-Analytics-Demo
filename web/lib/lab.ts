// Laboratorio: pure helpers to list, read and compare the experiments of the models (unions, ball, events, metrics).
// No file access here: components/lab reads the files through lib/local.ts (app/api/local) and passes the text in.

export type LabLine = "uniones" | "balon" | "eventos" | "mediciones" | "otros";
export type LabKind = "informe" | "log" | "metricas";

export const LAB_LINES: { id: LabLine; label: string }[] = [
  { id: "uniones", label: "Uniones" },
  { id: "balon", label: "Balón" },
  { id: "eventos", label: "Eventos" },
  { id: "mediciones", label: "Mediciones" },
  { id: "otros", label: "Otros" },
];

export interface Experiment {
  // Path relative to the repository, as app/api/local understands it.
  path: string;
  name: string;
  kind: LabKind;
  line: LabLine;
  // Match folder the file belongs to ("" when it lives at matches/ or docs/).
  match: string;
  size: number;
  mtime: number;
  // Rotulado de ejemplo: true only for the built-in sample (never read from disk).
  sample?: boolean;
}

const LINE_WORDS: [LabLine, RegExp][] = [
  ["balon", /ball|balon/],
  ["eventos", /event|offside|fuera_de_lugar/],
  ["mediciones", /metric|medicion|posesion|possession|pases|passes|fisic|physical|forma|team_shape/],
  ["uniones", /union|link|reid|ancla|anchor|tracklet|cobertura|relleno|grupos|priors|secuencias|dobles|refine|diagnostico|stitch|identidad/],
];

// Line of an experiment from its file name (and, for informes_agentes, its line code L1..L4).
export function lineOf(name: string): LabLine {
  const n = name.toLowerCase();
  const l = n.match(/^l([1-4])[_-]/);
  if (l) return (["uniones", "balon", "eventos", "mediciones"] as const)[Number(l[1]) - 1];
  for (const [line, re] of LINE_WORDS) if (re.test(n)) return line;
  return "otros";
}

export function kindOf(name: string): LabKind | null {
  const n = name.toLowerCase();
  if (n.endsWith(".md")) return "informe";
  if (n.endsWith(".log") && !n.endsWith(".err.log")) return "log";
  if (/metrics?.*\.json$/.test(n)) return "metricas";
  return null;
}

export function experimentOf(dir: string, e: { name: string; dir: boolean; size: number; mtime?: number }): Experiment | null {
  if (e.dir) return null;
  const kind = kindOf(e.name);
  if (!kind) return null;
  const match = dir.match(/^matches\/([\w.-]+)\//)?.[1] ?? "";
  return { path: `${dir}/${e.name}`, name: e.name, kind, line: lineOf(e.name), match, size: e.size, mtime: e.mtime ?? 0 };
}

// ---------- Logs: "03:04:21 cuadros 40/1420 3% ETA 326s (total 10s)" ----------

export interface LogProgress {
  stage: string;
  done: number;
  total: number;
  pct: number | null;
  etaS: number | null;
  totalS: number | null;
  finished: boolean;
  lastLine: string;
  lines: number;
  // Percent over time, for the sparkline (at most 60 points).
  series: number[];
}

const LOG_LINE = /^(\S+)\s+(.+?)\s+(\d+)\/(\d+)\s+(\d+(?:\.\d+)?)%\s+ETA\s+(\S+?)s?\s+\(total\s+(\d+(?:\.\d+)?)s\)/;

export function parseLog(text: string): LogProgress | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const pcts: number[] = [];
  let last: RegExpMatchArray | null = null;
  for (const l of lines) {
    const m = l.match(LOG_LINE);
    if (m) {
      last = m;
      pcts.push(Number(m[5]));
    }
  }
  const lastLine = lines[lines.length - 1];
  if (!last) return { stage: "", done: 0, total: 0, pct: null, etaS: null, totalS: null, finished: false, lastLine, lines: lines.length, series: [] };
  const eta = Number(last[6]);
  const step = Math.max(1, Math.ceil(pcts.length / 60));
  return {
    stage: last[2],
    done: Number(last[3]),
    total: Number(last[4]),
    pct: Number(last[5]),
    etaS: Number.isFinite(eta) ? eta : null,
    totalS: Number(last[7]),
    finished: Number(last[5]) >= 100 || /\blisto\b|terminado|finished/i.test(last[2]),
    lastLine,
    lines: lines.length,
    series: pcts.filter((_, i) => i % step === 0 || i === pcts.length - 1),
  };
}

export function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  if (r < 3600) return `${Math.floor(r / 60)} min ${r % 60} s`;
  return `${Math.floor(r / 3600)} h ${Math.floor((r % 3600) / 60)} min`;
}

// ---------- Reports (Markdown) ----------

export interface ReportTable {
  section: string;
  header: string[];
  rows: string[][];
}

export interface ParsedReport {
  title: string;
  intro: string[];
  tables: ReportTable[];
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isSep = (l: string) => isRow(l) && cells(l).every((c) => /^:?-{2,}:?$/.test(c));

export function parseReport(md: string): ParsedReport {
  const lines = md.split(/\r?\n/);
  let title = "";
  let section = "";
  const intro: string[] = [];
  const tables: ReportTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (!title && h[1].length === 1) title = h[2].trim();
      else section = h[2].trim();
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      tables.push({ section, header, rows });
      continue;
    }
    if (!tables.length && !section && l.trim() && intro.length < 6) intro.push(l.trim());
  }
  return { title, intro, tables };
}

// "98.90 %" -> 98.9, "1,5" -> 1.5, "—" / text -> null.
export function numberOf(cell: string): number | null {
  const c = cell.replace(/[`*]/g, "").trim();
  const m = c.match(/^[-+]?\d+(?:[.,]\d+)?(?=\s*(?:%|s|m|px|min|h)?$)/);
  if (!m) return null;
  const v = Number(m[0].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// Every numeric cell of the tables as "sección › fila › columna" -> value. Rows are named by their leading text cells.
export function reportMetrics(rep: ParsedReport): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of rep.tables) {
    const seen = new Map<string, number>();
    for (const row of t.rows) {
      const labelParts: string[] = [];
      let k = 0;
      while (k < row.length - 1 && numberOf(row[k]) === null && row[k] !== "") labelParts.push(row[k++]);
      if (!labelParts.length) labelParts.push(row[0] ?? "");
      let base = labelParts.join(" / ");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      if (n > 1) base = `${base} (${n})`;
      for (let c = k; c < row.length; c++) {
        const v = numberOf(row[c]);
        if (v === null) continue;
        out.set([t.section, base, t.header[c] ?? `col ${c + 1}`].filter(Boolean).join(" › "), v);
      }
    }
  }
  return out;
}

// Numeric leaves of a metrics JSON (ball_metrics_v1.json...) as "ruta.a.b" -> value; null leaves are skipped.
export function jsonMetrics(value: unknown, prefix = "", out = new Map<string, number>()): Map<string, number> {
  if (typeof value === "number" && Number.isFinite(value)) out.set(prefix, value);
  else if (Array.isArray(value)) value.forEach((v, i) => jsonMetrics(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) jsonMetrics(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export interface MetricDiff {
  key: string;
  a: number | null;
  b: number | null;
  delta: number | null;
}

// Metrics of two runs side by side; a metric missing on one side stays missing (null), never zero.
export function compareMetrics(a: Map<string, number>, b: Map<string, number>): MetricDiff[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((key) => {
    const x = a.get(key) ?? null;
    const y = b.get(key) ?? null;
    return { key, a: x, b: y, delta: x !== null && y !== null ? y - x : null };
  });
}

export function fmtNum(v: number | null): string {
  if (v === null) return "—";
  return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
}

// ---------- Sample (rotulado como ejemplo en la pantalla) ----------

export const SAMPLE_REPORT_A = "# Ejemplo A\n\n## Uniones\n\n| Agrupación | Pureza | Total a mano |\n|---|---|---|\n| Hoy | 94.2 % | 516 |\n| Unión ≥ 0.9 | 99.3 % | 1099 |\n";
export const SAMPLE_REPORT_B = "# Ejemplo B\n\n## Uniones\n\n| Agrupación | Pureza | Total a mano |\n|---|---|---|\n| Hoy | 94.2 % | 516 |\n| Unión ≥ 0.9 | 99.6 % | 940 |\n";
export const SAMPLE_LOG = "00:00:01 cuadros 0/100 0% ETA nans (total 0s)\n00:00:30 cuadros 40/100 40% ETA 45s (total 30s)\n00:01:00 cuadros 80/100 80% ETA 15s (total 60s)\n";
