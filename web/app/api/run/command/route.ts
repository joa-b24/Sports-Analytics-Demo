import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { commandArgv, commandById, type CommandChoice } from "@/lib/commands";

// «Procesos» > Comandos: lanza uno de los comandos sueltos de Python del catálogo (lib/commands.ts) con los parámetros que la
// usuaria marcó. Solo en esta computadora; el módulo y cada bandera salen del catálogo y cada valor se valida ahí: nada escrito
// llega a la línea de comandos sin pasar por commandArgv.
//   GET    /api/run/command?match=   los trabajos del partido (el último de cada comando, con el final de su salida)
//   POST   /api/run/command          {command, match, video, choice} -> el trabajo
//   DELETE /api/run/command?id=      lo detiene

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const local = (req: Request) => enabled() && LOCAL_HOST.test(req.headers.get("host") ?? "") && LOCAL_HOST.test(new URL(req.url).host);
const refuse = () => new Response("Solo disponible en esta computadora", { status: 403 });
const MAX_LINES = 300;

interface Job {
  id: string;
  command: string;
  match: string;
  video: string;
  shown: string;
  state: "running" | "done" | "failed" | "stopped";
  started: number;
  ended: number | null;
  code: number | null;
  lines: string[];
  proc: ChildProcess | null;
}

const g = globalThis as unknown as { __sportsanCommandJobs?: Map<string, Job> };
const jobs = (g.__sportsanCommandJobs ??= new Map<string, Job>());

const python = () => [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")].find((p) => existsSync(p)) ?? "python";

const view = (j: Job) => ({ id: j.id, command: j.command, match: j.match, video: j.video, shown: j.shown, state: j.state, started: j.started, ended: j.ended, code: j.code, tail: j.lines.slice(-40) });

export async function GET(req: Request) {
  if (!local(req)) return refuse();
  const match = new URL(req.url).searchParams.get("match") ?? "";
  // The latest of each command of the match.
  const latest = new Map<string, Job>();
  for (const j of jobs.values()) if (j.match === match && (!latest.has(j.command) || latest.get(j.command)!.started < j.started)) latest.set(j.command, j);
  return Response.json({ jobs: [...latest.values()].map(view) });
}

export async function POST(req: Request) {
  if (!local(req)) return refuse();
  const body = (await req.json().catch(() => null)) as { command?: unknown; match?: unknown; video?: unknown; choice?: unknown } | null;
  const id = typeof body?.command === "string" ? body.command : "";
  const match = typeof body?.match === "string" ? body.match : "";
  const video = typeof body?.video === "string" ? body.video : "";
  const raw = body?.choice && typeof body.choice === "object" ? (body.choice as Record<string, unknown>) : {};
  const choice: CommandChoice = {};
  for (const [k, v] of Object.entries(raw)) if (v === true || typeof v === "string") choice[k] = v;
  if (!commandById(id)) return Response.json({ error: "Comando desconocido." }, { status: 400 });
  const built = commandArgv(id, match, video, choice);
  if (!built.ok) return Response.json({ error: built.error }, { status: 400 });
  if (!existsSync(path.join(ROOT, "matches", match))) return Response.json({ error: "No existe la carpeta de ese partido." }, { status: 404 });
  const busy = [...jobs.values()].find((j) => j.state === "running" && j.match === match && j.command === id);
  if (busy) return Response.json({ error: "Ese comando ya está corriendo para este partido." }, { status: 409 });

  const jid = `${id}-${match}-${Date.now().toString(36)}`;
  const job: Job = { id: jid, command: id, match, video, shown: built.shown, state: "running", started: Date.now(), ended: null, code: null, lines: [`$ ${built.shown}`], proc: null };
  const proc = spawn(python(), built.argv, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", TQDM_MININTERVAL: "2" }, windowsHide: true });
  job.proc = proc;
  // Progress bars rewrite their line with \r: each rewrite replaces the last line.
  let partial = "";
  const onData = (chunk: Buffer) => {
    const parts = (partial + chunk.toString("utf8")).split(/(\r\n|\n|\r)/);
    partial = parts.pop() ?? "";
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      const sep = parts[i + 1];
      if (line === undefined || sep === undefined) continue;
      if (sep === "\r" && job.lines.length > 1) job.lines[job.lines.length - 1] = line;
      else if (line.trim()) job.lines.push(line);
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(1, job.lines.length - MAX_LINES);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("close", (code) => {
    if (partial.trim()) job.lines.push(partial);
    job.code = code;
    job.ended = Date.now();
    if (job.state === "running") job.state = code === 0 ? "done" : "failed";
    job.proc = null;
  });
  proc.on("error", (err) => {
    job.lines.push(`No se pudo ejecutar Python: ${err.message}`);
    job.state = "failed";
    job.ended = Date.now();
  });
  jobs.set(jid, job);
  return Response.json(view(job));
}

export async function DELETE(req: Request) {
  if (!local(req)) return refuse();
  const j = jobs.get(new URL(req.url).searchParams.get("id") ?? "");
  if (!j) return Response.json({ error: "No existe." }, { status: 404 });
  if (j.proc && j.state === "running") {
    j.state = "stopped";
    if (process.platform === "win32" && j.proc.pid) spawn("taskkill", ["/pid", String(j.proc.pid), "/T", "/F"], { windowsHide: true });
    else j.proc.kill();
  }
  return Response.json(view(j));
}
