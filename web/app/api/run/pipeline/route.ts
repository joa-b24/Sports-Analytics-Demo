import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePipelineState, pipelineArgv, pipelineFailMessage, pipelinePaths, pipelineView, validatePipelineArgs, type PipelineCommand } from "@/lib/runTask";

// «Procesos del partido» launches the two general commands of sportsan.tracking.pipeline from here, only on this
// computer: requests from another host are refused. Arguments pass a strict whitelist (lib/runTask.ts).
//   POST   /api/run/pipeline   {command, match, video?, quick?, plan?, resume?, force?, ...} -> {id} (or {text} with plan)
//   GET    /api/run/pipeline?match=&command=   {view, log}   the state Python wrote, with «running» checked against its pid
//   DELETE /api/run/pipeline?match=&command=   stops the process of the state file
//
// Python keeps pipeline_<command>.json and its progress log; the process is detached and writes its output to a file,
// so it survives a restart of this server and a reload of the page (the panel finds it again by reading the state).

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const local = (req: Request) => enabled() && LOCAL_HOST.test(req.headers.get("host") ?? "") && LOCAL_HOST.test(new URL(req.url).host);
const refuse = () => new Response("Solo disponible en esta computadora", { status: 403 });
const abs = (rel: string) => path.join(ROOT, ...rel.split("/"));
const readText = (rel: string) => readFile(abs(rel), "utf8").catch(() => "");
const pidAlive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const python = () => [abs(".venv/Scripts/python.exe"), abs(".venv/bin/python")].find((p) => existsSync(p)) ?? null;
const SAFE = /^[A-Za-z0-9_-]{1,120}$/;

function killTree(pid: number) {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid);
}

export async function GET(req: Request) {
  if (!local(req)) return refuse();
  const q = new URL(req.url).searchParams;
  const command = q.get("command") as PipelineCommand | null;
  const match = q.get("match") ?? "";
  if ((command !== "tracking" && command !== "fill-ball") || !SAFE.test(match)) return Response.json({ error: "Petición no válida." }, { status: 400 });
  const p = pipelinePaths(match, command);
  const st = parsePipelineState(await readText(p.state));
  const view = pipelineView(st, pidAlive(st?.pid ?? null));
  const log = view.state === "error" || view.state === "done" ? (await readText(p.output)).split(/\r?\n/).filter((l) => l.trim()).slice(-30) : [];
  return Response.json({ view, log });
}

export async function POST(req: Request) {
  if (!local(req)) return refuse();
  const v = validatePipelineArgs(await req.json().catch(() => null));
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const a = v.args;
  if (!existsSync(abs(`matches/${a.match}`))) return Response.json({ error: "No existe la carpeta de ese partido." }, { status: 404 });
  const py = python();
  if (!py) return Response.json({ error: "No se encontró .venv/Scripts/python.exe en la raíz del repositorio." }, { status: 500 });
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };

  // «Ver plan»: short, it writes nothing; the answer is its text.
  if (a.plan) {
    const r = spawnSync(py, pipelineArgv(a), { cwd: ROOT, env, encoding: "utf8", timeout: 90_000, windowsHide: true });
    const text = `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    return Response.json({ code: r.status, text: text || pipelineFailMessage("", r.status) });
  }

  const p = pipelinePaths(a.match, a.command);
  const before = parsePipelineState(await readText(p.state));
  if (before?.state === "running" && pidAlive(before.pid)) return Response.json({ error: "Ya hay uno corriendo para este partido." }, { status: 409 });
  await mkdir(abs(p.dir), { recursive: true });
  const fd = openSync(abs(p.output), "w");
  writeSync(fd, `$ python ${pipelineArgv(a).join(" ")}\n`);
  const started = Date.now() / 1000;
  const proc = spawn(py, pipelineArgv(a), { cwd: ROOT, env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  proc.unref();
  const pid = proc.pid ?? null;
  // The first state, so the panel does not show the previous run until Python writes its own (it keeps the same pid).
  const first = { state: "running", stage: "", video: a.video ?? null, part: null, pct: 0, eta_s: null, started, message: "Arrancando…", pid, command: a.command };
  await writeFile(abs(p.state), JSON.stringify(first), "utf8");
  // Python normally writes its final state. If it died before (a precondition, a crash), say why instead of leaving «running».
  proc.on("exit", (code) => {
    void (async () => {
      const cur = parsePipelineState(await readText(p.state));
      if (!cur || cur.state !== "running" || cur.pid !== pid) return;
      const message = pipelineFailMessage(await readText(p.output), code);
      await writeFile(abs(p.state), JSON.stringify({ ...cur, state: code === 0 ? "done" : "error", ended: Date.now() / 1000, eta_s: null, message }), "utf8");
    })();
  });
  proc.on("error", async (err) => {
    await writeFile(abs(p.state), JSON.stringify({ ...first, state: "error", ended: Date.now() / 1000, message: `No se pudo ejecutar Python: ${err.message}` }), "utf8").catch(() => undefined);
  });
  return Response.json({ id: `pipeline-${a.command}-${a.match}-${Math.round(started)}` });
}

export async function DELETE(req: Request) {
  if (!local(req)) return refuse();
  const q = new URL(req.url).searchParams;
  const command = q.get("command") as PipelineCommand | null;
  const match = q.get("match") ?? "";
  if ((command !== "tracking" && command !== "fill-ball") || !SAFE.test(match)) return Response.json({ error: "Petición no válida." }, { status: 400 });
  const p = pipelinePaths(match, command);
  const st = parsePipelineState(await readText(p.state));
  if (!st || st.state !== "running" || !st.pid || !pidAlive(st.pid)) return Response.json({ error: "No hay nada corriendo." }, { status: 404 });
  killTree(st.pid);
  // A killed process cannot write its last state: it is written here.
  await writeFile(abs(p.state), JSON.stringify({ ...st, state: "error", eta_s: null, ended: Date.now() / 1000, message: "Detenido por ti. Lo hecho se conserva: puedes reanudar." }), "utf8");
  return Response.json({ ok: true });
}
