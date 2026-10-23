"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/Modal";
import { Pitch } from "@/components/Pitch";
import { isTyping } from "@/lib/format";
import { ACCEL_SLACK_MS2, TEAM_S0_MS, applyFix, profile, smoothPath, verdict, type Fix, type ProfilePoint, type Verdict } from "@/lib/jumpReview";
import { CaretLeft, CaretRight, ImageSquare, Pause, Play, PlayCircle } from "@phosphor-icons/react";
import { Card, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { listLocal, localUrl, localVideo, readLocal, writeLocal } from "@/lib/local";
import { useStore } from "@/lib/store";

// TEMPORARY (2026-10-21): review of impossible jumps to find their patterns before removing them automatically
// (docs/propuesta_union_tracks.md). Not in the menu. Reads matches/<folder>/tracking/revision/saltos/casos.json, written
// by `python -m sportsan.tracking.jumps_review`, and saves the answers next to it (respuestas.json). The pattern the rule
// proposes is in the file but not shown, so the answer is not biased.

type Case = {
  id: number;
  part: string;
  video_id: string;
  t: number;
  name: string | null;
  meters: number;
  speed: number;
  image: string;
  path: [number, number, number][]; // [s from the jump, x m, y m]
  boxes?: [number, number, number, number, number][]; // [s from the jump, x1, y1, x2, y2] in video pixels
};
type Sample = { image?: { w: number; h: number }; venue: { length_m: number; width_m: number }; cases: Case[] };
type Answer = { answer?: string; note?: string; bad_from?: number; bad_to?: number };

// The answer, about the jump at 0 (the one marked «este» on the chart). Keys 1-5.
const OPTIONS: { id: string; title: string; hint: string }[] = [
  { id: "pico", title: "Pico aislado", hint: "Unos cuadros de ruido o de otra persona, y vuelve" },
  { id: "antes", title: "Lo malo era antes", hint: "Las posiciones de antes del salto eran de otra" },
  { id: "prolongado", title: "Cambio que dura", hint: "Pasa a otra persona y no vuelve" },
  { id: "camara", title: "Es ella", hint: "Misma jugadora: salto de cámara o calibración" },
  { id: "otro", title: "No se ve / otro", hint: "Cuéntalo en la nota" },
];

export default function Page() {
  const { matches } = useStore();
  const [folder, setFolder] = useState<string | null>(null);
  const [data, setData] = useState<Sample | null>(null);
  const [idx, setIdx] = useState(0);
  // The video of each video_id is looked up once; the cards show the video unless the frames are asked for.
  const [videos, setVideos] = useState<Record<string, string | null>>({});
  const [frames, setFrames] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [status, setStatus] = useState<string>("Buscando la muestra…");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const dirs = ((await listLocal("matches")) ?? []).filter((f) => f.dir).map((f) => f.name);
      for (const d of dirs) {
        const text = await readLocal(`matches/${d}/tracking/revision/saltos/casos.json`);
        if (!text || !live) continue;
        const saved = await readLocal(`matches/${d}/tracking/revision/saltos/respuestas.json`);
        const sample: Sample = JSON.parse(text);
        const ans: Record<string, Answer> = saved ? JSON.parse(saved) : {};
        setFolder(d);
        setData(sample);
        setAnswers(ans);
        // Start at the first case without an answer.
        setIdx(Math.max(0, sample.cases.findIndex((c) => !ans[c.id]?.answer)));
        setStatus("");
        return;
      }
      if (live) setStatus("No hay muestra. En la terminal: python -m sportsan.tracking.jumps_review --match <id>");
    })();
    return () => {
      live = false;
    };
  }, []);

  const c = data?.cases[idx] ?? null;
  // Look up the video of the case shown.
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
      const ok = await writeLocal(`matches/${folder}/tracking/revision/saltos/respuestas.json`, JSON.stringify(next, null, 1));
      setStatus(ok ? "Guardado" : "No se pudo guardar en la carpeta (¿la app corre en esta computadora?)");
    }, 500);
  };
  const set = (id: number, p: Answer) => save({ ...answers, [id]: { ...answers[id], ...p } });
  const n = data?.cases.length ?? 0;
  const go = (i: number) => setIdx(Math.max(0, Math.min(n - 1, i)));

  // 1-5 answer, ← → change case (not while writing the note).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!c || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = Number(e.key);
      if (k >= 1 && k <= OPTIONS.length) {
        set(c.id, { answer: OPTIONS[k - 1].id });
        e.preventDefault();
      } else if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const match = matches.find((m) => m.folder === folder);
  const done = data ? data.cases.filter((x) => answers[x.id]?.answer).length : 0;
  // With the answers so far: how many of the answered cases fit the physical limits once corrected and smoothed.
  const tally = useMemo(() => {
    if (!data) return null;
    const t = { n: 0, ok: 0, speed: 0, starts: 0, okBefore: 0 };
    for (const x of data.cases) {
      const ans = answers[x.id];
      if (!ans?.answer) continue;
      const r = caseAfter(x, data.venue, ans);
      t.n++;
      t.ok += r.after.ok ? 1 : 0;
      t.speed += r.after.over_speed ? 1 : 0;
      t.starts += r.after.impossible_starts + r.after.hard_stops > 0 ? 1 : 0;
      t.okBefore += r.before.ok ? 1 : 0;
    }
    return t;
  }, [data, answers]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <PageHeader title="Revisión de saltos" />
      <p className="max-w-[90ch] text-sm text-muted">
        Sección temporal. Cada caso es un salto imposible (más de 3 m a más de 9 m/s entre dos posiciones seguidas): responde por el del 0 (marcado
        «este» en la gráfica) y deja en la nota lo que veas de los demás. Las respuestas se guardan solas en la carpeta del partido. Teclas: 1–5 responde,
        ← → cambia de caso.
      </p>
      {data && c ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Caso anterior (←)" disabled={idx === 0} onClick={() => go(idx - 1)}>
              <CaretLeft size={16} />
            </IconButton>
            <span className="tc text-sm text-ink">
              Caso {idx + 1} <span className="text-faint">de {n}</span>
            </span>
            <IconButton label="Caso siguiente (→)" disabled={idx >= n - 1} onClick={() => go(idx + 1)}>
              <CaretRight size={16} />
            </IconButton>
            {/* Progress: one dot per case, filled when answered. */}
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Casos">
              {data.cases.map((x, i) => (
                <button
                  key={x.id}
                  type="button"
                  title={`Caso ${i + 1}${answers[x.id]?.answer ? " · respondido" : ""}`}
                  aria-label={`Ir al caso ${i + 1}`}
                  aria-current={i === idx}
                  onClick={() => go(i)}
                  className={`h-3 w-3 rounded-full transition-colors ${i === idx ? "ring-2 ring-ink ring-offset-2 ring-offset-bg" : ""} ${
                    answers[x.id]?.answer ? "bg-accent" : "bg-line-strong hover:bg-muted"
                  }`}
                />
              ))}
            </div>
            <span className="ml-auto text-sm text-muted">
              {done} de {n} respondidos{status && <span className="text-faint"> · {status}</span>}
            </span>
          </div>
          {tally && tally.n > 0 && (
            <p className="rounded-lg bg-surface px-3 py-2 text-sm text-ink-2">
              Con tus respuestas, después de corregir y suavizar: <strong className="text-ink">{tally.ok} de {tally.n}</strong> quedan dentro de los límites
              físicos (sin corregir, solo suavizando: {tally.okBefore}). Pasan de {(TEAM_S0_MS * 3.6).toFixed(1)} km/h: {tally.speed}. Con arranque o frenada
              imposible: {tally.starts}.
            </p>
          )}
          <CaseCard
            key={c.id}
            c={c}
            venue={data.venue}
            image={data.image ?? { w: 1920, h: 1080 }}
            folder={folder as string}
            matchId={match?.match_id}
            a={answers[c.id] ?? {}}
            onChange={(p) => set(c.id, p)}
            frames={frames}
            onFrames={() => setFrames((v) => !v)}
            videoUrl={videos[c.video_id]}
            onNext={idx < n - 1 ? () => go(idx + 1) : undefined}
          />
        </>
      ) : (
        <p className="text-sm text-faint">{status}</p>
      )}
    </div>
  );
}

function CaseCard({
  c,
  venue,
  image,
  folder,
  matchId,
  a,
  onChange,
  frames,
  onFrames,
  videoUrl,
  onNext,
}: {
  c: Case;
  venue: { length_m: number; width_m: number };
  image: { w: number; h: number };
  folder: string;
  matchId?: string;
  a: Answer;
  onChange: (p: Answer) => void;
  frames: boolean;
  onFrames: () => void;
  videoUrl: string | null | undefined;
  onNext?: () => void;
}) {
  // Moment of the video (s from the jump) while the player is on: a line on the speed chart and a dot on the pitch.
  const [nowState, setNow] = useState<number | null>(null);
  const now = frames ? null : nowState;
  const mm = `${Math.floor(c.t / 60)}:${(c.t % 60).toFixed(1).padStart(4, "0")}`;
  // The wrong stretch marked in the player: how many positions of hers fall in it (one every 0.1 s).
  const bad =
    a.bad_from !== undefined && a.bad_to !== undefined
      ? (() => {
          const [lo, hi] = a.bad_from <= a.bad_to ? [a.bad_from, a.bad_to] : [a.bad_to, a.bad_from];
          return { lo, hi, n: (c.boxes ?? []).filter((b) => b[0] >= lo - 0.02 && b[0] <= hi + 0.02).length };
        })()
      : null;
  const fmtRel = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} s`;
  return (
    <Card
      title={`Caso ${c.id}`}
      note={
        <span>
          {c.video_id} · {mm} · {c.name ?? "sin nombre"} · {c.meters} m a {c.speed} m/s
          {matchId && (
            <>
              {" · "}
              <Link className="link" href={`/partido?id=${matchId}&video=${c.video_id}&t=${Math.max(0, c.t - 2).toFixed(1)}`} target="_blank">
                ver en el partido
              </Link>
            </>
          )}
        </span>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-2">
          {!frames ? (
            videoUrl === undefined ? (
              <p className="text-sm text-faint">Buscando el video…</p>
            ) : videoUrl === null ? (
              <p className="text-sm text-faint">No está el video {c.video_id} en la carpeta del partido.</p>
            ) : (
              <JumpPlayer c={c} url={videoUrl} image={image} onTime={setNow} onMark={(k, t) => onChange(k === "from" ? { bad_from: t } : { bad_to: t })} />
            )
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={localUrl(`matches/${folder}/tracking/revision/saltos/${c.image}`)} alt={`Cuadros del caso ${c.id}`} className="w-full rounded-lg" />
          )}
          <button type="button" className={btn} onClick={onFrames}>
            {frames ? <PlayCircle size={15} /> : <ImageSquare size={15} />}
            {frames ? "Ver el video" : "Ver los 6 cuadros"}
          </button>
        </div>
        <div className="space-y-3">
          <SpeedChart path={c.path} now={now} bad={bad} />
          <PathOnPitch path={c.path} venue={venue} now={now} />
          <AfterFix c={c} venue={venue} a={a} now={now} />
        </div>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <div className="mb-2 text-sm font-medium text-ink">¿Qué pasó en el salto del 0?</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="radiogroup" aria-label="Qué pasó en el salto">
            {OPTIONS.map((o, i) => {
              const on = a.answer === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange({ answer: o.id })}
                  className={`flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-accent bg-accent-900 text-ink" : "border-line bg-raised text-ink-2 hover:border-line-strong"
                  }`}
                >
                  <span className="flex w-full items-center gap-2">
                    <kbd className="kbd">{i + 1}</kbd>
                    <span className="text-sm font-semibold">{o.title}</span>
                  </span>
                  <span className="text-xs text-muted">{o.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium text-ink">Lo malo</div>
          <p className="text-xs text-muted">
            {bad
              ? `De ${fmtRel(bad.lo)} a ${fmtRel(bad.hi)}: ${bad.n} ${bad.n === 1 ? "posición" : "posiciones"} (${(bad.hi - bad.lo).toFixed(1)} s).`
              : a.bad_from !== undefined
                ? `Empieza en ${fmtRel(a.bad_from)}; falta dónde termina.`
                : "Opcional: en el video, «Empieza aquí» y «Termina aquí» donde la caja está sobre otra persona o fuera de ella."}
            {(a.bad_from !== undefined || a.bad_to !== undefined) && (
              <button type="button" className="link ml-2" onClick={() => onChange({ bad_from: undefined, bad_to: undefined })}>
                borrar
              </button>
            )}
          </p>
          <textarea
            className={`${input} min-h-20 w-full resize-y text-sm`}
            rows={3}
            placeholder="Nota (opcional): los demás saltos, qué se ve…"
            value={a.note ?? ""}
            onChange={(e) => {
              onChange({ note: e.target.value });
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
          />
          {onNext && (
            <button type="button" className={`${btnPrimary} w-full justify-center`} onClick={onNext}>
              Siguiente caso
              <CaretRight size={14} />
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

// The video around the jump, in a loop from LOOP_S before to LOOP_S after, with her box on top: blue before the jump,
// orange after. Frame by frame and slow motion, to see which frames are wrong.
const LOOP_S = 2;
const RATES = [0.25, 0.5, 1];
// One position of the tracking every POS_S (stride 3 at 30 fps): the steps of the player move one position.
const POS_S = 0.1;
function JumpPlayer({
  c,
  url,
  image,
  onTime,
  onMark,
}: {
  c: Case;
  url: string;
  image: { w: number; h: number };
  onTime: (rel: number) => void;
  onMark: (k: "from" | "to", rel: number) => void;
}) {
  const ref = useRef<PlayerHandle>(null);
  const [rel, setRelState] = useState(-LOOP_S);
  const onTimeRef = useRef(onTime);
  useEffect(() => {
    onTimeRef.current = onTime;
  });
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.5);
  // Start 2 s before once the player can seek, then follow the time and loop.
  useEffect(() => {
    let raf = 0;
    let started = false;
    const tick = () => {
      const p = ref.current;
      if (p) {
        if (!started && p.getDuration() > 0) {
          started = true;
          p.setRate(0.5);
          // Paused: the browser blocks playing before a click on the page.
          p.seek(c.t - LOOP_S);
        }
        const r = p.getTime() - c.t;
        if (started && r > LOOP_S) p.seek(c.t - LOOP_S);
        setRelState(r);
        onTimeRef.current(r);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [c.t]);
  const box = useMemo(() => {
    let best: [number, number, number, number, number] | null = null;
    for (const b of c.boxes ?? []) if (!best || Math.abs(b[0] - rel) < Math.abs(best[0] - rel)) best = b;
    return best && Math.abs(best[0] - rel) <= 0.12 ? best : null;
  }, [c.boxes, rel]);
  // To the previous or next position of hers (or one POS_S when she has none around).
  const step = (dir: 1 | -1) => {
    const p = ref.current;
    if (!p) return;
    p.pause();
    const r = p.getTime() - c.t;
    const ts = (c.boxes ?? []).map((b) => b[0]);
    const next = dir > 0 ? ts.find((t) => t > r + 0.01) : [...ts].reverse().find((t) => t < r - 0.01);
    p.seek(c.t + (next ?? r + dir * POS_S));
  };
  const mark = (k: "from" | "to") => onMark(k, Math.round((box ? box[0] : rel) * 100) / 100);
  return (
    <div className="space-y-2">
      <div className="relative w-full overflow-hidden rounded-lg bg-black">
        <VideoPlayer ref={ref} fileUrl={url} onPlayState={setPlaying} />
        <svg viewBox={`0 0 ${image.w} ${image.h}`} preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 h-full w-full">
          {box && (
            <rect
              x={box[1]}
              y={box[2]}
              width={box[3] - box[1]}
              height={box[4] - box[2]}
              fill="none"
              stroke={box[0] < 0 ? "var(--color-own)" : "var(--color-opp)"}
              strokeWidth={4}
            />
          )}
          {Math.abs(rel) < 0.2 && (
            <text x={24} y={56} fontSize={40} fontWeight={700} fill="#fff" stroke="#000" strokeWidth={6} paintOrder="stroke">
              salto
            </text>
          )}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${btnPrimary} h-9 w-9 !p-0`}
          aria-label={playing ? "Pausar" : "Reproducir"}
          onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}
        >
          {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
        </button>
        <button type="button" className={btn} aria-label="Posición anterior (0.1 s)" title="Posición anterior (0.1 s)" onClick={() => step(-1)}>
          <CaretLeft size={14} />
        </button>
        <button type="button" className={btn} aria-label="Posición siguiente (0.1 s)" title="Posición siguiente (0.1 s)" onClick={() => step(1)}>
          <CaretRight size={14} />
        </button>
        <button type="button" className={btn} onClick={() => mark("from")} title="Primera posición mala (la de este momento)">
          Lo malo empieza aquí
        </button>
        <button type="button" className={btn} onClick={() => mark("to")} title="Última posición mala (la de este momento)">
          Termina aquí
        </button>
        <button type="button" className={btn} onClick={() => ref.current?.seek(c.t - 0.5)}>
          Ir al salto
        </button>
        <div className="seg" role="group" aria-label="Velocidad">
          {RATES.map((r) => (
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
        <span className="tc ml-auto text-sm text-ink">
          {rel >= 0 ? "+" : "−"}
          {Math.abs(rel).toFixed(2)} s
        </span>
      </div>
      <p className="text-xs text-faint">
        Bucle de 2 s antes a 2 s después. Caja azul: antes del salto; naranja: después. Sin caja: ese momento no tiene posición suya. ‹ › van de una
        posición a la siguiente (una cada 0.1 s, cada 3 cuadros del video).
      </p>
    </div>
  );
}

// The case with the answer applied (lib/jumpReview.ts), and with nothing applied, both through the export smoothing.
function caseAfter(c: Case, venue: { length_m: number; width_m: number }, a: Answer): { after: Verdict; before: Verdict; prof: ProfilePoint[]; removed: number } {
  const fixed = applyFix(c.path, a.answer as Fix | undefined, { from: a.bad_from, to: a.bad_to });
  const prof = profile(smoothPath(fixed, venue));
  return { after: verdict(prof), before: verdict(profile(smoothPath(c.path, venue))), prof, removed: c.path.length - fixed.length };
}

// Speed over 1 s windows after the correction and the smoothing, against the team limits; impossible starts in red.
function AfterFix({ c, venue, a, now }: { c: Case; venue: { length_m: number; width_m: number }; a: Answer; now: number | null }) {
  const r = useMemo(() => caseAfter(c, venue, a), [c, venue, a]);
  const W = 352;
  const H = 96;
  const vmax = Math.max(TEAM_S0_MS + 1, ...r.prof.map((p) => p.v));
  const x = (t: number) => ((t + 3) / 6) * W;
  const y = (v: number) => H - 12 - (v / vmax) * (H - 22);
  const bad = (p: ProfilePoint) => p.a !== null && p.limit !== null && (p.a > p.limit + ACCEL_SLACK_MS2 || p.a < -8);
  const v = r.after;
  return (
    <div className="rounded-lg bg-raised p-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-medium text-ink">Después de corregir y suavizar</span>
        <span className={`ml-auto rounded-md px-1.5 py-0.5 font-semibold ${!a.answer ? "text-faint" : v.ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>
          {!a.answer ? "sin respuesta" : v.ok ? "dentro de los límites" : v.over_speed ? "velocidad imposible" : "arranque imposible"}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Velocidad después de corregir">
        <line x1={0} x2={W} y1={y(TEAM_S0_MS)} y2={y(TEAM_S0_MS)} stroke="var(--color-danger)" strokeDasharray="4 3" strokeWidth={1} />
        <text x={4} y={y(TEAM_S0_MS) - 3} fontSize={9} fill="var(--color-danger)">
          {(TEAM_S0_MS * 3.6).toFixed(1)} km/h
        </text>
        <line x1={x(0)} x2={x(0)} y1={2} y2={H - 12} stroke="var(--color-faint)" strokeWidth={1} />
        {now !== null && now >= -3 && now <= 3 && <line x1={x(now)} x2={x(now)} y1={2} y2={H - 12} stroke="var(--color-ink)" strokeWidth={1.5} />}
        <polyline points={r.prof.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")} fill="none" stroke="var(--color-ok)" strokeWidth={1.5} />
        {r.prof.filter(bad).map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={3} fill="var(--color-danger)" />
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-faint">
        Velocidad en ventanas de 1 s. Máx. {v.top_kmh ?? "—"} km/h · arranques imposibles {v.impossible_starts} · frenadas imposibles {v.hard_stops}
        {r.removed > 0 && ` · ${r.removed} posiciones quitadas por tu respuesta`}. Sin corregir: {r.before.ok ? "dentro" : "fuera"} de los límites.
      </p>
    </div>
  );
}

// Speed (m/s) between consecutive positions, from 3 s before to 3 s after the jump; the 9 m/s line is the jump rule.
function SpeedChart({ path, now, bad }: { path: [number, number, number][]; now: number | null; bad?: { lo: number; hi: number } | null }) {
  // Each point at the moment she shows up in the new position (so the jump under review sits at 0). A point is a jump,
  // as in the correction table, only when she also moves more than 3 m: above 9 m/s with less is box noise.
  const pts = useMemo(() => {
    const out: [number, number, boolean][] = [];
    for (let i = 1; i < path.length; i++) {
      const dt = path[i][0] - path[i - 1][0];
      if (dt <= 0 || dt > 1) continue;
      const d = Math.hypot(path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
      out.push([path[i][0], d / dt, d > 3 && d / dt > 9]);
    }
    return out;
  }, [path]);
  const W = 352;
  const H = 120;
  const vmax = Math.max(12, ...pts.map((p) => p[1]));
  const x = (t: number) => ((t + 3) / 6) * W;
  const y = (v: number) => H - 14 - (v / vmax) * (H - 24);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg bg-raised" role="img" aria-label="Velocidad alrededor del salto">
      {bad && <rect x={x(Math.max(-3, bad.lo - 0.05))} y={4} width={Math.max(2, x(Math.min(3, bad.hi + 0.05)) - x(Math.max(-3, bad.lo - 0.05)))} height={H - 18} fill="var(--color-warn)" opacity={0.18} />}
      <line x1={0} x2={W} y1={y(9)} y2={y(9)} stroke="var(--color-danger)" strokeDasharray="4 3" strokeWidth={1} />
      <text x={4} y={y(9) - 3} fontSize={9} fill="var(--color-danger)">
        9 m/s
      </text>
      <line x1={x(0)} x2={x(0)} y1={4} y2={H - 14} stroke="var(--color-faint)" strokeWidth={1} />
      <polyline points={pts.map(([t, v]) => `${x(t)},${y(v)}`).join(" ")} fill="none" stroke="var(--color-accent-400)" strokeWidth={1.5} />
      {pts.map(([t, v, jump], i) =>
        jump ? (
          <g key={i}>
            <circle cx={x(t)} cy={y(v)} r={3.2} fill="var(--color-danger)" />
            {Math.abs(t) < 0.02 && (
              <>
                <circle cx={x(t)} cy={y(v)} r={6} fill="none" stroke="var(--color-danger)" strokeWidth={1.2} />
                <text x={x(t) + 8} y={Math.max(10, y(v) + 3)} fontSize={9} fill="var(--color-danger)">
                  este
                </text>
              </>
            )}
          </g>
        ) : (
          <circle key={i} cx={x(t)} cy={y(v)} r={1.5} fill="var(--color-accent-400)" />
        ),
      )}
      {now !== null && now >= -3 && now <= 3 && <line x1={x(now)} x2={x(now)} y1={4} y2={H - 14} stroke="var(--color-ink)" strokeWidth={1.5} />}
      {[-3, -2, -1, 0, 1, 2, 3].map((t) => (
        <text key={t} x={x(t)} y={H - 3} fontSize={9} textAnchor="middle" fill="var(--color-faint)">
          {t > 0 ? `+${t}` : t} s
        </text>
      ))}
    </svg>
  );
}

// A window of the pitch around the path (at least 30 x 20 m), so a few meters can be seen.
function box(pts: [number, number][]): string {
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 52.5;
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 34;
  const w = Math.max(30, (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) + 10);
  const h = Math.max(w * (2 / 3), (ys.length ? Math.max(...ys) - Math.min(...ys) : 0) + 10);
  return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
}

// The positions on the pitch: before the jump in blue, after in orange.
function PathOnPitch({ path, venue, now }: { path: [number, number, number][]; venue: { length_m: number; width_m: number }; now: number | null }) {
  const p = path.map(([t, xm, ym]) => [t, (xm * 105) / venue.length_m, (ym * 68) / venue.width_m] as const);
  // Where she is at the moment of the video: the nearest position (none if there is no position within 0.15 s).
  const here = now === null ? null : p.reduce<(typeof p)[number] | null>((best, q) => (!best || Math.abs(q[0] - now) < Math.abs(best[0] - now) ? q : best), null);
  const shown = here && now !== null && Math.abs(here[0] - now) <= 0.15 ? here : null;
  const before = p.filter((q) => q[0] < 0);
  const after = p.filter((q) => q[0] >= 0);
  return (
    <Pitch showDirection={false} className="rounded-lg bg-raised" viewBox={box(p.map((q) => [q[1], q[2]]))}>
      <polyline points={before.map((q) => `${q[1]},${q[2]}`).join(" ")} fill="none" stroke="var(--color-own)" strokeWidth={0.5} />
      <polyline points={after.map((q) => `${q[1]},${q[2]}`).join(" ")} fill="none" stroke="var(--color-opp)" strokeWidth={0.5} />
      {before.length > 0 && <circle cx={before[before.length - 1][1]} cy={before[before.length - 1][2]} r={0.9} fill="var(--color-own)" />}
      {after.length > 0 && <circle cx={after[0][1]} cy={after[0][2]} r={0.9} fill="var(--color-opp)" />}
      {shown && <circle cx={shown[1]} cy={shown[2]} r={1.1} fill="var(--color-ink)" stroke="var(--color-bg)" strokeWidth={0.4} />}
    </Pitch>
  );
}
