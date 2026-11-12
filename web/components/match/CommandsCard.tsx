"use client";

import { Play, Stop, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/Command";
import { COMMANDS, commandArgv, defaultOf, suggestedFile, type CommandChoice, type CommandDef, type CommandParam } from "@/lib/commands";
import { listLocal } from "@/lib/local";
import { setPref, usePref } from "@/lib/store";
import type { Match } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

interface JobView {
  id: string;
  command: string;
  state: "running" | "done" | "failed" | "stopped";
  started: number;
  ended: number | null;
  code: number | null;
  tail: string[];
}

const STATE_TEXT: Record<JobView["state"], string> = { running: "Corriendo…", done: "Terminó bien.", failed: "Terminó con error.", stopped: "Detenido por ti." };

// «Procesos» > Comandos sueltos: the Python commands of the calibration and the tracking (propagate, library, process,
// detect, overnight), each with its parameters as a checkbox («use this one»): an unchecked parameter is not sent, so
// Python keeps its own default. The line that will run is always shown (and can be copied). The catalog is lib/commands.ts.
export function CommandsCard({ match, folder, video: pickedVideo }: { match: Match; folder: string; video: string }) {
  const videoList = useMemo(() => matchVideos(match), [match]);
  const videos = useMemo(() => videoList.map((v) => v.video_id), [videoList]);
  // The video the commands run with: chosen HERE (it used to follow the selector of the panel and the first video was taken
  // without saying so, so a command could run on the wrong one).
  const chosen = usePref(`cmdVideo:${folder}`, "");
  const video = videos.includes(chosen) ? chosen : videos.includes(pickedVideo) ? pickedVideo : (videos[0] ?? "v1");
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const [available, setAvailable] = useState<boolean | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/run/command?match=${encodeURIComponent(folder)}`, { cache: "no-store" });
      if (r.status === 403 || r.status === 404) return setAvailable(false);
      const d = (await r.json()) as { jobs: JobView[] };
      setAvailable(true);
      setJobs(Object.fromEntries(d.jobs.map((j) => [j.command, j])));
    } catch {
      // The server restarting: the next poll finds it again.
    }
  }, [folder]);
  const anyRunning = Object.values(jobs).some((j) => j.state === "running");
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const id = anyRunning ? window.setInterval(() => void refresh(), 2000) : undefined;
    return () => {
      window.clearTimeout(first);
      if (id) window.clearInterval(id);
    };
  }, [refresh, anyRunning]);
  // The json files of tracking/ (anchors and calibrations), for the parameters that take one; read again when a command ends.
  const finished = Object.values(jobs).filter((j) => j.state !== "running").length;
  useEffect(() => {
    let live = true;
    void listLocal(`matches/${folder}/tracking`).then((l) => live && setFiles((l ?? []).filter((e) => !e.dir && e.name.endsWith(".json")).map((e) => e.name)));
    return () => {
      live = false;
    };
  }, [folder, finished]);

  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="proc-cmds">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tc text-xs text-faint">4</span>
        <h3 id="proc-cmds" className="text-[15px] text-ink">
          Comandos sueltos
        </h3>
      </div>
      <p className="mt-1 max-w-3xl text-xs text-pretty text-muted">
        Los comandos de Python de la calibración y el tracking, uno por uno. Marca los parámetros que quieras mandar (por ejemplo <code>--benchmark</code>); los que dejes sin marcar usan el valor por defecto de Python.
      </p>
      <label className="mt-3 flex items-center gap-2 text-xs text-ink">
        Video con el que corren
        <select className="input !py-1" value={video} onChange={(e) => setPref(`cmdVideo:${folder}`, e.target.value)} aria-label="Video con el que corren los comandos">
          {videoList.map((v) => (
            <option key={v.video_id} value={v.video_id}>
              {v.video_id} · {v.label || "sin nombre"}
            </option>
          ))}
        </select>
        <span className="text-faint">Los archivos de anclas y de barrido tienen que ser de este video.</span>
      </label>
      {available === false && <p className="mt-3 text-xs text-muted">Solo se lanzan desde la computadora donde corre la app. Aquí puedes armar la línea y copiarla en una terminal (con .venv activo, en la raíz del repositorio).</p>}
      <div className="mt-3 divide-y divide-line-soft rounded-lg bg-bg/40">
        {COMMANDS.map((c) => (
          <CommandRow key={c.id} def={c} folder={folder} video={video} files={files} job={jobs[c.id]} canRun={available === true} expanded={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={refresh} />
        ))}
      </div>
    </section>
  );
}

function CommandRow({ def, folder, video, files, job, canRun, expanded, onToggle, onChanged }: { def: CommandDef; folder: string; video: string; files: string[]; job: JobView | undefined; canRun: boolean; expanded: boolean; onToggle: () => void; onChanged: () => Promise<void> }) {
  const key = `cmd:${folder}:${def.id}`;
  const saved = usePref(key, "{}");
  const choice = useMemo<CommandChoice>(() => {
    try {
      const o = JSON.parse(saved) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).filter(([, v]) => v === true || typeof v === "string")) as CommandChoice;
    } catch {
      return {};
    }
  }, [saved]);
  const set = (next: CommandChoice) => setPref(key, JSON.stringify(next));
  const toggle = (p: CommandParam, on: boolean) => {
    const next = { ...choice };
    if (!on) delete next[p.id];
    else next[p.id] = p.kind === "bool" ? true : p.kind === "file" ? suggestedFile(p.id, folder, video, files.filter((f) => !p.pattern || p.pattern.test(f))) : defaultOf(p);
    set(next);
  };
  const built = commandArgv(def.id, folder, video, choice);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = job?.state === "running";
  const used = Object.keys(choice).length;
  const tailRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [job?.tail]);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/run/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: def.id, match: folder, video, choice }) });
      if (!r.ok) setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "No se pudo lanzar.");
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!job) return;
    await fetch(`/api/run/command?id=${encodeURIComponent(job.id)}`, { method: "DELETE" });
    await onChanged();
  };

  return (
    <div className="p-3">
      <button type="button" className="flex w-full items-baseline gap-3 text-left" aria-expanded={expanded} onClick={onToggle}>
        <TerminalWindow size={14} className="mt-0.5 shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink">{def.title}</span>
          <span className="block text-xs text-faint">{used > 0 ? `${used} parámetro(s) marcados` : "Sin parámetros marcados"}</span>
        </span>
        {job && <span className={`text-xs ${job.state === "failed" ? "text-danger" : job.state === "running" ? "text-warn" : "text-ok"}`}>{STATE_TEXT[job.state]}</span>}
      </button>
      {expanded && (
        <div className="mt-3 space-y-3 pl-6">
          <p className="max-w-3xl text-xs text-pretty text-muted">{def.lead}</p>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {def.params.map((p) => {
              const on = choice[p.id] !== undefined;
              const val = typeof choice[p.id] === "string" ? (choice[p.id] as string) : "";
              const options = p.kind === "file" ? files.filter((f) => !p.pattern || p.pattern.test(f)) : [];
              return (
                <li key={p.id} className="grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:items-center">
                  <label className="flex items-center gap-2 text-xs text-ink">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(p, e.target.checked)} />
                    {p.label}
                    {p.required && <span className="text-faint">(obligatorio)</span>}
                  </label>
                  <div className="flex min-w-0 items-center gap-2">
                    {p.kind === "bool" ? (
                      <span className="text-[11px] text-faint">{p.help}</span>
                    ) : p.kind === "file" ? (
                      <select className="input !py-1 text-xs" disabled={!on} value={val} onChange={(e) => set({ ...choice, [p.id]: e.target.value })} aria-label={p.label}>
                        {val && !options.includes(val) && <option value={val}>{val}</option>}
                        {options.length === 0 && !val && <option value="">No hay archivos en tracking/</option>}
                        {options.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input tc !w-32 !py-1 text-xs"
                        disabled={!on}
                        value={val}
                        placeholder={p.kind === "time" ? "0:33:20" : p.def === "" ? "automático" : p.def}
                        inputMode={p.kind === "number" ? "decimal" : undefined}
                        aria-label={p.label}
                        onChange={(e) => set({ ...choice, [p.id]: e.target.value })}
                      />
                    )}
                    {p.kind !== "bool" && <span className="hidden text-[11px] text-faint lg:inline">{p.help}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex min-w-0 items-center gap-1 rounded-lg bg-bg/60 py-1 pr-1 pl-3">
            <pre className={`tc m-0 min-w-0 flex-1 overflow-x-auto py-1 text-[11px] ${built.ok ? "text-ink-2" : "text-warn"}`}>{built.ok ? built.shown : built.error}</pre>
            {built.ok && <CopyButton text={built.shown} label="Copiar el comando" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <button type="button" className="btn" onClick={() => void stop()}>
                <Stop size={14} /> Detener
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={!canRun || !built.ok || busy} title={!canRun ? "Solo desde la computadora donde corre la app" : !built.ok ? built.error : undefined} onClick={() => void run()}>
                <Play size={14} /> Ejecutar
              </button>
            )}
            {used > 0 && !running && (
              <button type="button" className="btn btn-ghost text-faint" onClick={() => set({})}>
                Desmarcar todo
              </button>
            )}
            {error && <span className="text-xs text-danger">{error}</span>}
          </div>
          {job && (
            <pre ref={tailRef} className="tc m-0 max-h-48 overflow-auto rounded-lg bg-bg/60 p-2 text-[11px] whitespace-pre-wrap text-ink-2">
              {job.tail.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
