import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetDirs, resettableFile, runArgv, runPaths, runStatus, validateRunArgs, type RunRecord, type RunTask } from "@/lib/runTask";

// The anchors mode of the correction table runs sportsan.tracking.anchors (suggest / fill) from here, only on this
// computer: requests from another host are refused. The arguments pass a strict whitelist (lib/runTask.ts).
// task "refine" runs sportsan.tracking.refine on the part (feet + smoothed calibration, in place with a backup); it
// shares the one-run-per-part lock, so it never runs while a suggest/fill of the same part is going.
//
//   POST /api/run/anchors                      {task, match, part, perMin, variant} -> {id}; one run per part at a time
//   GET  /api/run/anchors?match=&part=&task=&variant=  {state, phase, done, total, pct, eta_s, message}
//
// The state survives a restart of the app: run_<task>_<part>.json in tracking/revision/, next to the progress log
// written by Python and run_<task>_<part>.log with its whole output (the technical detail, to open by hand).

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const local = (req: Request) => enabled() && LOCAL_HOST.test(req.headers.get("host") ?? "") && LOCAL_HOST.test(new URL(req.url).host);
const refuse = () => new Response("Solo disponible en esta computadora", { status: 403 });

const g = globalThis as unknown as { __sportsanAnchorRuns?: Set<string> };
const live = (g.__sportsanAnchorRuns ??= new Set<string>());

const abs = (rel: string) => path.join(ROOT, ...rel.split("/"));
const readText = (rel: string) => readFile(abs(rel), "utf8").catch(() => "");
async function readRecord(rel: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await readFile(abs(rel), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}
const pidAlive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function GET(req: Request) {
  if (!local(req)) return refuse();
  const q = new URL(req.url).searchParams;
  const v = validateRunArgs({ task: q.get("task"), match: q.get("match"), part: q.get("part"), variant: q.get("variant") });
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const { match, part, task, variant } = v.args;
  const p = runPaths(match, task, part, variant);
  const record = await readRecord(p.record);
  const alive = live.has(`${match}|${part}`) || pidAlive(record?.pid);
  const status = runStatus(record, (await readText(p.progress)) || (variant ? await readText(p.progressAlt) : ""), await readText(p.output), alive);
  return Response.json({ ...status, log: record && record.state !== "running" ? p.output : null });
}

export async function POST(req: Request) {
  if (!local(req)) return refuse();
  const v = validateRunArgs(await req.json().catch(() => null));
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const a = v.args;
  if (!existsSync(abs(`matches/${a.match}`))) return Response.json({ error: "No existe la carpeta de ese partido." }, { status: 404 });
  const key = `${a.match}|${a.part}${a.variant ? `|${a.variant}` : ""}`;
  if (live.has(key)) return Response.json({ error: "Ya hay un proceso de anclas en curso para esta parte." }, { status: 409 });
  const py = abs(".venv/Scripts/python.exe");
  if (!existsSync(py)) return Response.json({ error: "No se encontró .venv/Scripts/python.exe en la raíz del repositorio." }, { status: 500 });

  const p = runPaths(a.match, a.task as RunTask, a.part, a.variant);
  await mkdir(path.dirname(abs(p.record)), { recursive: true });
  // A fresh progress log: the one of a previous run must not show as this one's progress.
  await writeFile(abs(p.progress), "", "utf8");
  const out = createWriteStream(abs(p.output));
  out.write(`$ python ${runArgv(a).join(" ")}\n`);
  const started = Date.now();
  // Writes of the record one after the other (the end of a run never gets overwritten by its start).
  let chain: Promise<unknown> = Promise.resolve();
  const save = (r: RunRecord) => (chain = chain.then(() => writeFile(abs(p.record), JSON.stringify(r), "utf8").catch(() => undefined)));

  live.add(key);
  await save({ state: "running", started });
  const proc = spawn(py, runArgv(a), {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
    windowsHide: true,
  });
  proc.stdout?.pipe(out, { end: false });
  proc.stderr?.pipe(out, { end: false });
  let finished = false;
  const finish = (code: number | null, note?: string) => {
    if (finished) return;
    finished = true;
    live.delete(key);
    if (note) out.write(`\n${note}\n`);
    out.end();
    void save({ state: code === 0 ? "done" : "error", pid: proc.pid, started, ended: Date.now(), code });
  };
  proc.on("close", (code) => finish(code));
  proc.on("error", (err) => finish(null, `No se pudo ejecutar Python (python.exe): ${err.message}`));
  if (!finished) void save({ state: "running", pid: proc.pid, started });
  return Response.json({ id: `${a.task}-${key}-${started.toString(36)}` });
}

// «Empezar de cero esta parte»: DELETE {match, part, dry} lists (dry) or deletes only what resettableFile allows
// (anchors/links of the part in tracking/auto, its fill logs in tracking/revision). Refused while a run of the part goes.
export async function DELETE(req: Request) {
  if (!local(req)) return refuse();
  const b = (await req.json().catch(() => null)) as { match?: unknown; part?: unknown; dry?: unknown } | null;
  const v = validateRunArgs({ task: "fill", match: b?.match, part: b?.part });
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const { match, part } = v.args;
  if (live.has(`${match}|${part}`)) return Response.json({ error: "Hay un proceso de anclas en curso para esta parte." }, { status: 409 });
  const dirs = resetDirs(match);
  const files: { path: string; bytes: number }[] = [];
  for (const d of ["auto", "revision"] as const) {
    const names = await readdir(abs(dirs[d])).catch(() => [] as string[]);
    for (const n of names) {
      if (!resettableFile(d, part, n)) continue;
      const rel = `${dirs[d]}/${n}`;
      const st = await stat(abs(rel)).catch(() => null);
      if (st?.isFile()) files.push({ path: rel, bytes: st.size });
    }
  }
  if (b?.dry === true) return Response.json({ files });
  const failed: string[] = [];
  for (const f of files) await unlink(abs(f.path)).catch(() => failed.push(f.path));
  return Response.json({ deleted: files.filter((f) => !failed.includes(f.path)), failed });
}
