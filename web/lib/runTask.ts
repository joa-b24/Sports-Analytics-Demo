// Python tasks launched from the app (app/api/run): the anchors mode asks sportsan.tracking.anchors to suggest or fill
// a part. Pure functions: what arguments are allowed, and what the progress log and the saved status say.
// The progress log is the one written by anchors_cli.Progress: tracking/revision/progreso_<task>_<part>.log, one line
// per step: "HH:MM:SS <phase> <n>/<total> <pct>% ETA <s>s (total <s>s)".

// "refine": sportsan.tracking.refine (feet and smoothed calibration of the part, in place with a backup .pre_refine.json).
// "ball": sportsan.tracking.ball run (the ball tracker on one part; writes ball_auto_<part>.json, never accepted by itself).
// "train": sportsan.tracking.ball train with the hand samples of a video (Playground > Balón); `part` is the video id (v2).
export type RunTask = "suggest" | "fill" | "refine" | "ball" | "train";
export interface RunArgs {
  task: RunTask;
  match: string;
  part: string;
  perMin?: string;
  // "exp": the experimental fill (variant B, links_<part>_exp.json). Only for fill.
  variant?: "exp";
  // Only for ball: probability to accept (0.8-0.99) and whether to overwrite an existing ball_auto_ (--force).
  accept?: number;
  force?: boolean;
  // Only for fill: cost of leaving a chain unnamed (--unnamed-cost) and, only in the experimental fill, the policy of the
  // tramos (--seg-max-cost, --seg-min-entry-p, --seg-internal-p, --seg-reject-close). Absent = the Python defaults.
  unnamedCost?: number;
  seg?: SegPolicyArgs;
}
export interface SegPolicyArgs {
  maxCost?: number;
  minEntryP?: number;
  internalP?: number;
  rejectClose?: boolean;
}
// Limits of those numbers (the same as the fields of Detalles técnicos).
export const SEG_LIMITS = { maxCost: [0.1, 5], minEntryP: [0.5, 1], internalP: [0.5, 1], unnamedCost: [0.5, 10] } as const;
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
  if (b.task !== "suggest" && b.task !== "fill" && b.task !== "refine" && b.task !== "ball" && b.task !== "train") return { ok: false, error: "Tarea desconocida." };
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
  let accept: number | undefined;
  if (b.accept !== undefined && b.accept !== null && b.accept !== "") {
    const a = Number(b.accept);
    if (b.task !== "ball" || !Number.isFinite(a) || a < 0.8 || a > 0.99) return { ok: false, error: "Probabilidad de aceptación: entre 0,80 y 0,99 (solo balón)." };
    accept = a;
  }
  const force = b.force === true;
  if (b.force !== undefined && b.force !== null && typeof b.force !== "boolean") return { ok: false, error: "Valor no válido." };
  if (force && b.task !== "ball") return { ok: false, error: "Valor no válido." };
  let unnamedCost: number | undefined;
  if (b.unnamedCost !== undefined && b.unnamedCost !== null) {
    const c = b.unnamedCost;
    const [lo, hi] = SEG_LIMITS.unnamedCost;
    if (b.task !== "fill" || typeof c !== "number" || !Number.isFinite(c) || c < lo || c > hi) return { ok: false, error: `Costo de dejar sin nombre: entre ${lo} y ${hi} (solo relleno).` };
    unnamedCost = c;
  }
  let seg: SegPolicyArgs | undefined;
  if (b.seg !== undefined && b.seg !== null) {
    if (b.task !== "fill" || variant !== "exp" || typeof b.seg !== "object" || Array.isArray(b.seg)) return { ok: false, error: "Los umbrales del relleno solo valen para la variante B." };
    const o = b.seg as Record<string, unknown>;
    const out: SegPolicyArgs = {};
    for (const k of Object.keys(o)) {
      if (o[k] === undefined) continue;
      if (k === "rejectClose") {
        if (typeof o[k] !== "boolean") return { ok: false, error: "Abstención por empate: sí o no." };
        out.rejectClose = o[k] as boolean;
      } else if (k === "maxCost" || k === "minEntryP" || k === "internalP") {
        const v = o[k];
        const [lo, hi] = SEG_LIMITS[k];
        if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return { ok: false, error: `Umbral del relleno fuera de rango (${lo} a ${hi}).` };
        out[k] = v;
      } else return { ok: false, error: "Umbral del relleno desconocido." };
    }
    if (Object.keys(out).length) seg = out;
  }
  return {
    ok: true,
    args: { task: b.task, match: b.match, part: b.part, perMin, ...(variant ? { variant } : {}), ...(accept !== undefined ? { accept } : {}), ...(force ? { force } : {}), ...(unnamedCost !== undefined ? { unnamedCost } : {}), ...(seg ? { seg } : {}) },
  };
}

export function runArgv(a: RunArgs): string[] {
  if (a.task === "train") return ["-m", "sportsan.tracking.ball", "train", "--match", a.match, "--samples", `matches/${a.match}/tracking/ball_samples_${a.part}.json`];
  if (a.task === "ball") {
    const argv = ["-m", "sportsan.tracking.ball", "run", "--match", a.match, "--part", `tracks_${a.part}.json`];
    if (a.accept !== undefined) argv.push("--accept", String(a.accept));
    if (a.force) argv.push("--force");
    return argv;
  }
  if (a.task === "refine") return ["-m", "sportsan.tracking.refine", "--match", a.match, "--part", a.part];
  const argv = ["-m", "sportsan.tracking.anchors", a.task, "--match", a.match, "--part", a.part];
  if (a.task === "suggest" && a.perMin) argv.push("--per-min", a.perMin);
  if (a.task === "fill" && a.unnamedCost !== undefined) argv.push("--unnamed-cost", String(a.unnamedCost));
  if (a.task === "fill" && a.variant === "exp") {
    argv.push("--variant", "exp");
    if (a.seg?.maxCost !== undefined) argv.push("--seg-max-cost", String(a.seg.maxCost));
    if (a.seg?.minEntryP !== undefined) argv.push("--seg-min-entry-p", String(a.seg.minEntryP));
    if (a.seg?.internalP !== undefined) argv.push("--seg-internal-p", String(a.seg.internalP));
    if (a.seg?.rejectClose !== undefined) argv.push("--seg-reject-close", a.seg.rejectClose ? "yes" : "no");
  }
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
  if (/unrecognized arguments:.*--samples/.test(output)) return "El entrenamiento con muestras (--samples) aún no está disponible en sportsan.tracking.ball.";
  if (/No hay modelo/.test(output)) return "No hay modelo de balón entrenado (weights/ball_model.pt).";
  if (/falta la medida de la sede/.test(output)) return "Falta la medida de la sede en match.yaml.";
  if (/MemoryError/.test(output)) return "Python se quedó sin memoria.";
  if (/ENOENT|python\.exe/.test(output) && code == null) return "No se encontró .venv/Scripts/python.exe en la raíz del repositorio.";
  return `Python terminó con error${code != null ? ` (código ${code})` : ""}.`;
}

const PHASES: Record<string, string> = { lectura: "Leyendo", pies: "Pies", trozos: "Trozos", candidatos: "Candidatos", relleno: "Rellenando", "calibración": "Calibración", posiciones: "Posiciones", escritura: "Guardando", listo: "Listo", cuadros: "Buscando el balón", muestras: "Leyendo muestras", entrenamiento: "Entrenando", validación: "Validando", "decisión": "Decidiendo" };
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
  const re = dir === "auto" ? new RegExp(`^(anchors|links)_${p}(_[A-Za-z0-9]+)*\.json$`) : new RegExp(`^(progreso|run)_fill_${p}(_exp)?\.(log|json)$`);
  return re.test(name);
}
export const resetDirs = (match: string) => ({ auto: `matches/${match}/tracking/auto`, revision: `matches/${match}/tracking/revision` });

// ------------------------------------------------------------------------------------------------- «pipeline»
// The two general commands of sportsan.tracking.pipeline (tracking / fill-ball), launched from «Procesos del partido».
// They keep their own state (tracking/revision/pipeline_<command>.json, written by Python) and progress log, so a page
// reload or a restart of the app picks them up again by reading those files. Same discipline as the other tasks: every
// value is checked against a whitelist before it reaches a command line.
export type PipelineCommand = "tracking" | "fill-ball";
export const PIPELINE_COMMANDS: readonly PipelineCommand[] = ["tracking", "fill-ball"];
export interface PipelineArgs {
  command: PipelineCommand;
  match: string;
  // Only this video (default: all the videos of the match).
  video?: string;
  // «Prueba rápida» (tracking only): a short stretch with the same steps, report in tracking/revision/quick/.
  quick?: boolean;
  quickS?: number;
  // Say what it would do, without running (never writes state).
  plan?: boolean;
  resume?: boolean;
  force?: boolean;
  // tracking: meters around the pitch where people are searched (Detalles técnicos).
  bandMarginM?: number;
  // fill-ball: ball model, probability to accept and the fill policy (Detalles técnicos).
  model?: string;
  accept?: number;
  unnamedCost?: number;
  seg?: SegPolicyArgs;
}
export const QUICK_S_LIMITS = [10, 300] as const;
const MODEL_FILE = /^weights\/ball_model[A-Za-z0-9_.-]*\.pt$/;

export function validatePipelineArgs(body: unknown): { ok: true; args: PipelineArgs } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Petición vacía." };
  const b = body as Record<string, unknown>;
  const command = b.command as PipelineCommand;
  if (!PIPELINE_COMMANDS.includes(command)) return { ok: false, error: "Comando desconocido." };
  if (typeof b.match !== "string" || !SAFE.test(b.match)) return { ok: false, error: "Partido no válido." };
  const out: PipelineArgs = { command, match: b.match };
  if (b.video !== undefined && b.video !== null && b.video !== "") {
    if (typeof b.video !== "string" || !/^v\d+$/.test(b.video)) return { ok: false, error: "Video no válido." };
    out.video = b.video;
  }
  for (const k of ["quick", "plan", "resume", "force"] as const) {
    const v = b[k];
    if (v === undefined || v === null || v === false) continue;
    if (v !== true) return { ok: false, error: "Valor no válido." };
    out[k] = true;
  }
  if (out.quick && command !== "tracking") return { ok: false, error: "La prueba rápida es solo del tracking." };
  if (out.quick && out.force) return { ok: false, error: "La prueba rápida no se combina con «rehacer»." };
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  if (b.quickS !== undefined && b.quickS !== null) {
    if (!out.quick || !num(b.quickS, QUICK_S_LIMITS[0], QUICK_S_LIMITS[1])) return { ok: false, error: `Segundos de la prueba: entre ${QUICK_S_LIMITS[0]} y ${QUICK_S_LIMITS[1]}.` };
    out.quickS = b.quickS as number;
  }
  if (b.bandMarginM !== undefined && b.bandMarginM !== null) {
    if (command !== "tracking" || !num(b.bandMarginM, 0, 15)) return { ok: false, error: "Margen alrededor de la cancha: de 0 a 15 m (solo tracking)." };
    out.bandMarginM = b.bandMarginM as number;
  }
  if (b.model !== undefined && b.model !== null && b.model !== "") {
    if (command !== "fill-ball" || typeof b.model !== "string" || !MODEL_FILE.test(b.model)) return { ok: false, error: "Modelo de balón no válido (weights/ball_model*.pt)." };
    out.model = b.model;
  }
  if (b.accept !== undefined && b.accept !== null) {
    if (command !== "fill-ball" || !num(b.accept, 0.8, 0.99)) return { ok: false, error: "Probabilidad de aceptación: entre 0,80 y 0,99 (solo balón)." };
    out.accept = b.accept as number;
  }
  if (b.unnamedCost !== undefined && b.unnamedCost !== null) {
    if (command !== "fill-ball" || !num(b.unnamedCost, SEG_LIMITS.unnamedCost[0], SEG_LIMITS.unnamedCost[1])) return { ok: false, error: `Costo de dejar sin nombre: entre ${SEG_LIMITS.unnamedCost[0]} y ${SEG_LIMITS.unnamedCost[1]} (solo relleno).` };
    out.unnamedCost = b.unnamedCost as number;
  }
  if (b.seg !== undefined && b.seg !== null) {
    if (command !== "fill-ball" || typeof b.seg !== "object" || Array.isArray(b.seg)) return { ok: false, error: "Los umbrales del relleno son solo del relleno." };
    const o = b.seg as Record<string, unknown>;
    const seg: SegPolicyArgs = {};
    for (const k of Object.keys(o)) {
      if (o[k] === undefined) continue;
      if (k === "rejectClose") {
        if (typeof o[k] !== "boolean") return { ok: false, error: "Abstención por empate: sí o no." };
        seg.rejectClose = o[k] as boolean;
      } else if (k === "maxCost" || k === "minEntryP" || k === "internalP") {
        if (!num(o[k], SEG_LIMITS[k][0], SEG_LIMITS[k][1])) return { ok: false, error: `Umbral del relleno fuera de rango (${SEG_LIMITS[k][0]} a ${SEG_LIMITS[k][1]}).` };
        seg[k] = o[k] as number;
      } else return { ok: false, error: "Umbral del relleno desconocido." };
    }
    if (Object.keys(seg).length) out.seg = seg;
  }
  return { ok: true, args: out };
}

export function pipelineArgv(a: PipelineArgs): string[] {
  const argv = ["-m", "sportsan.tracking.pipeline", a.command, "--match", a.match];
  if (a.video) argv.push("--video", a.video);
  if (a.plan) argv.push("--plan");
  if (a.resume) argv.push("--resume");
  if (a.force) argv.push("--force");
  if (a.command === "tracking") {
    if (a.quick) argv.push("--quick");
    if (a.quick && a.quickS !== undefined) argv.push("--quick-s", String(a.quickS));
    if (a.bandMarginM !== undefined) argv.push("--band-margin", String(a.bandMarginM));
  } else {
    if (a.model) argv.push("--model", a.model);
    if (a.accept !== undefined) argv.push("--accept", String(a.accept));
    if (a.unnamedCost !== undefined) argv.push("--unnamed-cost", String(a.unnamedCost));
    if (a.seg?.maxCost !== undefined) argv.push("--seg-max-cost", String(a.seg.maxCost));
    if (a.seg?.minEntryP !== undefined) argv.push("--seg-min-entry-p", String(a.seg.minEntryP));
    if (a.seg?.internalP !== undefined) argv.push("--seg-internal-p", String(a.seg.internalP));
    if (a.seg?.rejectClose !== undefined) argv.push("--seg-reject-close", a.seg.rejectClose ? "yes" : "no");
  }
  return argv;
}

// Files of a command in tracking/revision/ (state and progress written by Python; output kept by the app's server).
export function pipelinePaths(match: string, command: PipelineCommand) {
  const dir = `matches/${match}/tracking/revision`;
  return { dir, state: `${dir}/pipeline_${command}.json`, progress: `${dir}/progreso_pipeline_${command}.log`, output: `${dir}/run_pipeline_${command}.log`, quick: `${dir}/quick` };
}

export interface PipelineState {
  state: RunState;
  stage: string;
  video: string | null;
  part: string | null;
  pct: number;
  eta_s: number | null;
  started: number | null;
  ended: number | null;
  pid: number | null;
  message: string;
}
export interface PipelineView extends PipelineState {
  // An error or an interrupted run can go on with --resume.
  resumable: boolean;
  // The state file says «running» but nobody is: the app restarted or the process was killed.
  stale: boolean;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// pipeline_<command>.json as text to a state, or null when it is not one.
export function parsePipelineState(text: string | null | undefined): PipelineState | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    if (!d || typeof d !== "object" || !["idle", "running", "done", "error"].includes(d.state as string)) return null;
    return {
      state: d.state as RunState,
      stage: typeof d.stage === "string" ? d.stage : "",
      video: typeof d.video === "string" ? d.video : null,
      part: typeof d.part === "string" ? d.part : null,
      pct: Math.min(100, Math.max(0, finite(d.pct) ?? 0)),
      eta_s: finite(d.eta_s),
      started: finite(d.started),
      ended: finite(d.ended),
      pid: finite(d.pid),
      message: typeof d.message === "string" ? d.message : "",
    };
  } catch {
    return null;
  }
}

// What the panel shows. `alive`: whether the pid of a «running» state is a live process.
export function pipelineView(s: PipelineState | null, alive: boolean): PipelineView {
  const none: PipelineState = { state: "idle", stage: "", video: null, part: null, pct: 0, eta_s: null, started: null, ended: null, pid: null, message: "" };
  const st = s ?? none;
  if (st.state === "running" && !alive) {
    return { ...st, state: "error", eta_s: null, message: "El proceso se detuvo sin terminar (¿se reinició la app o se cerró?). Lo hecho se conserva: puedes reanudar.", resumable: true, stale: true };
  }
  return { ...st, resumable: st.state === "error", stale: false };
}

const STAGES: Record<string, string> = {
  quick_process: "Prueba: detección y calibración",
  quick_check: "Prueba: verificando la calibración",
  quick_suggest: "Prueba: uniones sugeridas",
  quick_report: "Prueba: armando el informe",
  propagate: "Propagando las anclas",
  library: "Biblioteca de calibración",
  process: "Detección y posiciones",
  suggest: "Uniones sugeridas",
  fill: "Relleno de identidades",
  ball: "Balón automático",
};
export const stageName = (stage: string) => STAGES[stage] ?? stage;
// The state left by a quick test (its stages are named quick_*).
export const isQuickStage = (stage: string) => stage.startsWith("quick_");

// A short message in Spanish for a pipeline that ended without writing its own final state (precondition, crash).
// Exit codes: 0 well, 1 a stage failed, 2 precondition or usage, 3 finished but skipped stages, 130 interrupted.
export function pipelineFailMessage(output: string, code: number | null | undefined): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pre = lines.filter((l) => /^Precondici/.test(l) || /^No hay nada que correr/.test(l)).slice(0, 2);
  if (code === 2 && pre.length) return pre.join(" ");
  if (/ModuleNotFoundError|No module named/.test(output)) return "Falta instalar algo de Python en .venv (pip install -e \".[dev]\").";
  if (code === 130) return "Detenido. Lo hecho se conserva: puedes reanudar.";
  if (code === 3) return "Terminó, pero omitió etapas (partes protegidas o sin requisitos). Revisa el registro.";
  if (code === 2) return "No se puede correr todavía: falta algún requisito. Revisa el registro.";
  if (code == null) return "No se pudo ejecutar Python (¿existe .venv/Scripts/python.exe?).";
  return `Python terminó con error (código ${code}). Revisa el registro.`;
}
