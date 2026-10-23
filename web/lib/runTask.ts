// Python tasks launched from the app (app/api/run): the anchors mode asks sportsan.tracking.anchors to suggest or fill
// a part. Pure functions: what arguments are allowed, and what the progress log and the saved status say.
// The progress log is the one written by anchors_cli.Progress: tracking/revision/progreso_<task>_<part>.log, one line
// per step: "HH:MM:SS <phase> <n>/<total> <pct>% ETA <s>s (total <s>s)".

export type RunTask = "suggest" | "fill";
export interface RunArgs {
  task: RunTask;
  match: string;
  part: string;
  perMin?: string;
  // "exp": the experimental fill (variant B, links_<part>_exp.json). Only for fill.
  variant?: "exp";
}
export type RunState = "idle" | "running" | "done" | "error";
export interface RunStatus {
  state: RunState;
  phase: string;
  done: number;
  total: number;
  pct: number;
  eta_s: number | null;
  message: string;
}
// What the server keeps next to the log (run_<task>_<part>.json).
export interface RunRecord {
  state: "running" | "done" | "error";
  pid?: number;
  started: number;
  ended?: number;
  code?: number | null;
}

const SAFE = /^[A-Za-z0-9_-]{1,120}$/;
export const PER_MIN = ["1", "2", "3", "4", "5", "hybrid"] as const;

// Strict whitelist: anything else is refused (the values go to a command line).
export function validateRunArgs(body: unknown): { ok: true; args: RunArgs } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Petición vacía." };
  const b = body as Record<string, unknown>;
  if (b.task !== "suggest" && b.task !== "fill") return { ok: false, error: "Tarea desconocida." };
  if (typeof b.match !== "string" || !SAFE.test(b.match)) return { ok: false, error: "Partido no válido." };
  if (typeof b.part !== "string" || !SAFE.test(b.part)) return { ok: false, error: "Parte no válida." };
  let perMin: string | undefined;
  if (b.perMin !== undefined && b.perMin !== null) {
    const p = String(b.perMin);
    if (!(PER_MIN as readonly string[]).includes(p)) return { ok: false, error: "Anclas por minuto: de 1 a 5 o «hybrid»." };
    perMin = p;
  }
  let variant: "exp" | undefined;
  if (b.variant !== undefined && b.variant !== null && b.variant !== "") {
    if (b.variant !== "exp" || b.task !== "fill") return { ok: false, error: "Variante no válida." };
    variant = "exp";
  }
  return { ok: true, args: { task: b.task, match: b.match, part: b.part, perMin, ...(variant ? { variant } : {}) } };
}

export function runArgv(a: RunArgs): string[] {
  const argv = ["-m", "sportsan.tracking.anchors", a.task, "--match", a.match, "--part", a.part];
  if (a.task === "suggest" && a.perMin) argv.push("--per-min", a.perMin);
  if (a.task === "fill" && a.variant === "exp") argv.push("--variant", "exp");
  return argv;
}

// Repository paths of the files of a run.
// The experimental fill keeps its own record and output (_exp); its progress log may be either name.
export function runPaths(match: string, task: RunTask, part: string, variant?: "exp") {
  const dir = `matches/${match}/tracking/revision`;
  const p = variant ? `${part}_exp` : part;
  return { progress: `${dir}/progreso_${task}_${p}.log`, progressAlt: `${dir}/progreso_${task}_${part}.log`, record: `${dir}/run_${task}_${p}.json`, output: `${dir}/run_${task}_${p}.log` };
}

const LINE = /^\S+\s+(.+?)\s+(\d+)\/(\d+)\s+(\d+)%\s+ETA\s+(\S+?)s\b/;

// Last progress line of the log, or null.
export function parseProgress(text: string): { phase: string; done: number; total: number; pct: number; eta_s: number | null } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    const eta = Number(m[5]);
    return { phase: m[1], done: Number(m[2]), total: Number(m[3]), pct: Number(m[4]), eta_s: Number.isFinite(eta) ? eta : null };
  }
  return null;
}

// A short message in Spanish from the output of a failed run (never the dump itself).
export function errorMessage(output: string, code: number | null | undefined): string {
  if (/ModuleNotFoundError|No module named/.test(output)) return "Falta instalar algo de Python en .venv (pip install -e \".[dev]\").";
  if (/FileNotFoundError|No such file/.test(output)) return "Falta un archivo de la parte (¿tracks de esta parte o sugerencias/anclas?).";
  if (/MemoryError/.test(output)) return "Python se quedó sin memoria.";
  if (/ENOENT|python\.exe/.test(output) && code == null) return "No se encontró .venv/Scripts/python.exe en la raíz del repositorio.";
  return `Python terminó con error${code != null ? ` (código ${code})` : ""}.`;
}

const PHASES: Record<string, string> = { lectura: "Leyendo", pies: "Pies", trozos: "Trozos", candidatos: "Candidatos", relleno: "Rellenando" };
export const phaseName = (p: string) => PHASES[p] ?? p;

// Status of a run from its record, its progress log and its output. `alive`: whether the process is still running
// (a record left "running" by a server that restarted is an error, not an eternal run).
export function runStatus(record: RunRecord | null, progress: string, output: string, alive: boolean): RunStatus {
  const p = parseProgress(progress);
  const base = { phase: p?.phase ?? "", done: p?.done ?? 0, total: p?.total ?? 0, pct: p?.pct ?? 0, eta_s: p?.eta_s ?? null };
  if (!record) return { state: "idle", ...base, message: "" };
  if (record.state === "running" && !alive) return { state: "error", ...base, message: "El proceso se detuvo sin terminar (¿se reinició la app?)." };
  if (record.state === "running") return { state: "running", ...base, message: "" };
  if (record.state === "done") return { state: "done", ...base, pct: 100, eta_s: 0, message: "" };
  return { state: "error", ...base, message: errorMessage(output, record.code) };
}

// «Empezar de cero esta parte» (Revisión): the only files it may delete. Anchors and fills of the part
// (tracking/auto/{anchors,links}_<part>*.json) and the logs of its fill runs (tracking/revision/{progreso,run}_fill_<part>*).
// Never suggest_, tracks_ or labels_. `name` is a bare file name (no path).
export function resettableFile(dir: "auto" | "revision", part: string, name: string): boolean {
  if (!SAFE.test(part) || name.includes("/") || name.includes("\\")) return false;
  const p = part.replace(/[-]/g, "\-");
  const re = dir === "auto" ? new RegExp(`^(anchors|links)_${p}(_[A-Za-z0-9]+)?\.json$`) : new RegExp(`^(progreso|run)_fill_${p}(_exp)?\.(log|json)$`);
  return re.test(name);
}
export const resetDirs = (match: string) => ({ auto: `matches/${match}/tracking/auto`, revision: `matches/${match}/tracking/revision` });
