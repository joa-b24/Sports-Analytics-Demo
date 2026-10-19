import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Runs the project's Python jobs from the app when it runs on this computer (npm run dev, or the desktop app): the
// short tracking test, the full processing, sending to Kaggle and bringing its results back. Only these jobs, with a
// match folder and a video id checked against their patterns: nothing typed by the user reaches the command line.
// Deployed on the web this answers 404 and the app shows the commands to copy instead.
//
//   GET    /api/run          {enabled, jobs}
//   GET    /api/run?id=      one job with the tail of its output
//   POST   /api/run          {kind, match, video} -> {id}
//   DELETE /api/run?id=      stops a job

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";

type JobKind = "test" | "process" | "kaggle" | "kaggle_pull";
const ARGS: Record<JobKind, (match: string, video: string) => string[]> = {
  test: (m, v) => ["-m", "sportsan.tracking.process", "--match", m, "--video", v, "--test"],
  process: (m) => ["-m", "sportsan.tracking.overnight", "--match", m],
  kaggle: (m, v) => ["-m", "sportsan.cloud.kaggle", "run", "tracking", "--match", m, "--videos", v, "--no-wait"],
  kaggle_pull: (m) => ["-m", "sportsan.cloud.kaggle", "pull", "--match", m],
};
const MAX_LINES = 400;

interface Job {
  id: string;
  kind: JobKind;
  match: string;
  video: string;
  state: "running" | "done" | "failed" | "stopped";
  started: number;
  ended: number | null;
  code: number | null;
  lines: string[];
  proc: ChildProcess | null;
}

// Kept across requests (and across hot reloads in development).
const g = globalThis as unknown as { __sportsanJobs?: Map<string, Job> };
const jobs = (g.__sportsanJobs ??= new Map<string, Job>());

const python = () => {
  for (const p of [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")]) if (existsSync(p)) return p;
  return "python";
};

const view = (j: Job, tail = 0) => ({
  id: j.id,
  kind: j.kind,
  match: j.match,
  video: j.video,
  state: j.state,
  started: j.started,
  ended: j.ended,
  code: j.code,
  ...(tail ? { tail: j.lines.slice(-tail) } : { last: j.lines[j.lines.length - 1] ?? "" }),
});

const notFound = () => new Response("No disponible", { status: 404 });

export async function GET(req: Request) {
  if (!enabled()) return notFound();
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const j = jobs.get(id);
    return j ? Response.json(view(j, 80)) : notFound();
  }
  return Response.json({ enabled: true, jobs: [...jobs.values()].map((j) => view(j)) });
}

export async function POST(req: Request) {
  if (!enabled()) return notFound();
  const body = (await req.json().catch(() => null)) as { kind?: string; match?: string; video?: string } | null;
  const kind = body?.kind as JobKind | undefined;
  const match = body?.match ?? "";
  const video = body?.video ?? "v1";
  if (!kind || !(kind in ARGS) || !/^[\w.-]+$/.test(match) || !/^v\d+$/.test(video)) return new Response("Trabajo no válido", { status: 400 });
  if (!existsSync(path.join(ROOT, "matches", match))) return new Response("No existe esa carpeta de partido", { status: 404 });
  // One job of each kind per match at a time.
  const busy = [...jobs.values()].find((j) => j.state === "running" && j.match === match && j.kind === kind);
  if (busy) return Response.json(view(busy));

  const id = `${kind}-${match}-${Date.now().toString(36)}`;
  const job: Job = { id, kind, match, video, state: "running", started: Date.now(), ended: null, code: null, lines: [], proc: null };
  const proc = spawn(python(), ARGS[kind](match, video), {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", TQDM_MININTERVAL: "2" },
    windowsHide: true,
  });
  job.proc = proc;
  // Progress bars rewrite their line with \r: each rewrite replaces the last line instead of piling up.
  let partial = "";
  const onData = (chunk: Buffer) => {
    const text = partial + chunk.toString("utf8");
    const parts = text.split(/(\r\n|\n|\r)/);
    partial = parts.pop() ?? "";
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      const sep = parts[i + 1];
      if (line === undefined || sep === undefined) continue;
      if (sep === "\r" && job.lines.length) job.lines[job.lines.length - 1] = line;
      else if (line.trim()) job.lines.push(line);
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
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
  jobs.set(id, job);
  return Response.json(view(job));
}

export async function DELETE(req: Request) {
  if (!enabled()) return notFound();
  const j = jobs.get(new URL(req.url).searchParams.get("id") ?? "");
  if (!j) return notFound();
  if (j.proc && j.state === "running") {
    j.state = "stopped";
    if (process.platform === "win32" && j.proc.pid) spawn("taskkill", ["/pid", String(j.proc.pid), "/T", "/F"], { windowsHide: true });
    else j.proc.kill();
  }
  return Response.json(view(j));
}
