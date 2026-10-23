"use client";

import { CaretLeft, CaretRight, Pause, Play } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/Modal";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { isTyping } from "@/lib/format";
import { listLocal, localVideo, readLocal, writeLocal } from "@/lib/local";

// TEMPORARY (2026-10-21): review of the feet correction (src/sportsan/tracking/feet.py) before turning it on in process.
// Not in the menu. Reads matches/<folder>/tracking/revision/pies/casos.json (python -m sportsan.tracking.feet_review)
// and saves respuestas.json next to it. Which kind each case is (clean stretch or dancing box) is not shown.

type Case = {
  id: number;
  video_id: string;
  t: number;
  name: string | null;
  boxes: [number, number, number, number, number][]; // [s from t, x1, y1, x2, y2]
  feet_new: [number, number, number][]; // [s from t, x, y] proposed feet, video pixels
};
type Answer = { answer?: string; note?: string };
const OPTIONS: { id: string; title: string; hint: string }[] = [
  { id: "mejor", title: "Mejor la verde", hint: "La marca verde está más en sus pies" },
  { id: "igual", title: "Igual", hint: "Las dos están bien, o las dos mal" },
  { id: "peor", title: "Peor la verde", hint: "La roja (la original) estaba mejor" },
  { id: "nose", title: "No se ve", hint: "Cuéntalo en la nota" },
];
const LOOP_S = 2;

export default function Page() {
  const [folder, setFolder] = useState<string | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [idx, setIdx] = useState(0);
  const [videos, setVideos] = useState<Record<string, string | null>>({});
  const [status, setStatus] = useState("Buscando la muestra…");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const dirs = ((await listLocal("matches")) ?? []).filter((f) => f.dir).map((f) => f.name);
      for (const d of dirs) {
        const text = await readLocal(`matches/${d}/tracking/revision/pies/casos.json`);
        if (!text || !live) continue;
        const saved = await readLocal(`matches/${d}/tracking/revision/pies/respuestas.json`);
        const cs: Case[] = JSON.parse(text).cases;
        const ans: Record<string, Answer> = saved ? JSON.parse(saved) : {};
        setFolder(d);
        setCases(cs);
        setAnswers(ans);
        setIdx(Math.max(0, cs.findIndex((c) => !ans[c.id]?.answer)));
        setStatus("");
        return;
      }
      if (live) setStatus("No hay muestra. En la terminal: python -m sportsan.tracking.feet_review --match <id>");
    })();
    return () => {
      live = false;
    };
  }, []);

  const c = cases[idx] ?? null;
  useEffect(() => {
    if (!folder || !c || c.video_id in videos) return;
    let live = true;
    void localVideo(folder, c.video_id).then((url) => {
      if (live) setVideos((v) => ({ ...v, [c.video_id]: url }));
    });
    return () => {
      live = false;
    };
  }, [folder, c, videos]);

  const save = (next: Record<string, Answer>) => {
    setAnswers(next);
    if (!folder) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const ok = await writeLocal(`matches/${folder}/tracking/revision/pies/respuestas.json`, JSON.stringify(next, null, 1));
      setStatus(ok ? "Guardado" : "No se pudo guardar en la carpeta");
    }, 500);
  };
  const set = (id: number, p: Answer) => save({ ...answers, [id]: { ...answers[id], ...p } });
  const go = (i: number) => setIdx(Math.max(0, Math.min(cases.length - 1, i)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!c || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = Number(e.key);
      if (k >= 1 && k <= OPTIONS.length) set(c.id, { answer: OPTIONS[k - 1].id });
      else if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const done = cases.filter((x) => answers[x.id]?.answer).length;
  const a = c ? (answers[c.id] ?? {}) : {};
  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader title="Revisión de pies" />
      <p className="max-w-[90ch] text-sm text-muted">
        Sección temporal. La posición en la cancha sale de los pies de la caja. Marca roja: los pies de siempre (borde inferior de la caja). Marca verde: los
        pies que propone la corrección. Mira el clip completo (2 s antes y después) y di cuál está mejor. Teclas: 1–4 responde, ← → cambia de caso.
      </p>
      {c ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Caso anterior (←)" disabled={idx === 0} onClick={() => go(idx - 1)}>
              <CaretLeft size={16} />
            </IconButton>
            <span className="tc text-sm text-ink">
              Caso {idx + 1} <span className="text-faint">de {cases.length}</span>
            </span>
            <IconButton label="Caso siguiente (→)" disabled={idx >= cases.length - 1} onClick={() => go(idx + 1)}>
              <CaretRight size={16} />
            </IconButton>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Casos">
              {cases.map((x, i) => (
                <button
                  key={x.id}
                  type="button"
                  aria-label={`Ir al caso ${i + 1}`}
                  aria-current={i === idx}
                  onClick={() => go(i)}
                  className={`h-3 w-3 rounded-full ${i === idx ? "ring-2 ring-ink ring-offset-2 ring-offset-bg" : ""} ${answers[x.id]?.answer ? "bg-accent" : "bg-line-strong hover:bg-muted"}`}
                />
              ))}
            </div>
            <span className="ml-auto text-sm text-muted">
              {done} de {cases.length} respondidos{status && <span className="text-faint"> · {status}</span>}
            </span>
          </div>
          <Card title={`Caso ${c.id}`} note={`${c.video_id} · ${Math.floor(c.t / 60)}:${(c.t % 60).toFixed(1).padStart(4, "0")} · ${c.name ?? "sin nombre"}`}>
            {videos[c.video_id] === undefined ? (
              <p className="text-sm text-faint">Buscando el video…</p>
            ) : videos[c.video_id] === null ? (
              <p className="text-sm text-faint">No está el video {c.video_id} en la carpeta del partido.</p>
            ) : (
              <FeetPlayer key={c.id} c={c} url={videos[c.video_id] as string} />
            )}
            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Qué marca está mejor">
                {OPTIONS.map((o, i) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={a.answer === o.id}
                    onClick={() => set(c.id, { answer: o.id })}
                    className={`flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      a.answer === o.id ? "border-accent bg-accent-900 text-ink" : "border-line bg-raised text-ink-2 hover:border-line-strong"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <kbd className="kbd">{i + 1}</kbd>
                      <span className="text-sm font-semibold">{o.title}</span>
                    </span>
                    <span className="text-xs text-muted">{o.hint}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <textarea
                  className={`${input} min-h-20 w-full resize-y text-sm`}
                  rows={3}
                  placeholder="Nota (opcional)"
                  value={a.note ?? ""}
                  onChange={(e) => {
                    set(c.id, { note: e.target.value });
                    e.target.style.height = "auto";
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                />
                {idx < cases.length - 1 && (
                  <button type="button" className={`${btnPrimary} w-full justify-center`} onClick={() => go(idx + 1)}>
                    Siguiente caso
                    <CaretRight size={14} />
                  </button>
                )}
              </div>
            </div>
          </Card>
        </>
      ) : (
        <p className="text-sm text-faint">{status}</p>
      )}
    </div>
  );
}

// The clip in a loop with her box, the original feet (red) and the proposed ones (green).
function FeetPlayer({ c, url }: { c: Case; url: string }) {
  const ref = useRef<PlayerHandle>(null);
  const [rel, setRel] = useState(-LOOP_S);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.5);
  useEffect(() => {
    let raf = 0;
    let started = false;
    const tick = () => {
      const p = ref.current;
      if (p) {
        if (!started && p.getDuration() > 0) {
          started = true;
          p.setRate(0.5);
          p.seek(c.t - LOOP_S);
        }
        const r = p.getTime() - c.t;
        if (started && r > LOOP_S) p.seek(c.t - LOOP_S);
        setRel(r);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [c.t]);
  const nearest = <T extends number[]>(rows: T[]) => {
    let best: T | null = null;
    for (const r of rows) if (!best || Math.abs(r[0] - rel) < Math.abs(best[0] - rel)) best = r;
    return best && Math.abs(best[0] - rel) <= 0.12 ? best : null;
  };
  const box = useMemo(() => nearest(c.boxes), [c.boxes, rel]); // eslint-disable-line react-hooks/exhaustive-deps
  const foot = useMemo(() => nearest(c.feet_new), [c.feet_new, rel]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (dir: 1 | -1) => {
    const p = ref.current;
    if (!p) return;
    p.pause();
    const r = p.getTime() - c.t;
    const ts = c.boxes.map((b) => b[0]);
    const next = dir > 0 ? ts.find((t) => t > r + 0.01) : [...ts].reverse().find((t) => t < r - 0.01);
    p.seek(c.t + (next ?? r + dir * 0.1));
  };
  return (
    <div className="space-y-2">
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        <VideoPlayer ref={ref} fileUrl={url} onPlayState={setPlaying} />
        <svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 h-full w-full">
          {box && (
            <>
              <rect x={box[1]} y={box[2]} width={box[3] - box[1]} height={box[4] - box[2]} fill="none" stroke="#ffffff" strokeOpacity={0.8} strokeWidth={2} />
              <circle cx={(box[1] + box[3]) / 2} cy={box[4]} r={7} fill="#ff4d4d" stroke="#000" strokeWidth={2} />
            </>
          )}
          {foot && <circle cx={foot[1]} cy={foot[2]} r={7} fill="#3fe08a" stroke="#000" strokeWidth={2} />}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`${btnPrimary} h-9 w-9 !p-0`} aria-label={playing ? "Pausar" : "Reproducir"} onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}>
          {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
        <button type="button" className={btn} aria-label="Posición anterior" onClick={() => step(-1)}>
          <CaretLeft size={14} />
        </button>
        <button type="button" className={btn} aria-label="Posición siguiente" onClick={() => step(1)}>
          <CaretRight size={14} />
        </button>
        <button type="button" className={btn} onClick={() => ref.current?.seek(c.t - 0.3)}>
          Ir al momento
        </button>
        <div className="seg" role="group" aria-label="Velocidad">
          {[0.25, 0.5, 1].map((r) => (
            <button
              key={r}
              type="button"
              className="seg-opt"
              aria-pressed={rate === r}
              onClick={() => {
                setRate(r);
                ref.current?.setRate(r);
              }}
            >
              {r}×
            </button>
          ))}
        </div>
        <span className="flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <i className="h-2.5 w-2.5 rounded-full bg-[#ff4d4d]" /> original
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-2.5 w-2.5 rounded-full bg-[#3fe08a]" /> propuesta
          </span>
        </span>
        <span className="tc ml-auto text-sm text-ink">
          {rel >= 0 ? "+" : "−"}
          {Math.abs(rel).toFixed(2)} s
        </span>
      </div>
    </div>
  );
}
