"use client";

import { ArrowRight, Plus, Trash, X, YoutubeLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Reveal } from "@/components/motion";
import { DemoBadge, PageHeader, btn, btnPrimary, input } from "@/components/Shell";
import { parseYouTubeId } from "@/lib/format";
import { mutate, uid, useStore } from "@/lib/store";
import { EMPTY_REPORT, type Match, type MatchKind } from "@/lib/types";

const COPY: Record<MatchKind, { title: string; subtitle: string; focus: string; other: string; empty: string }> = {
  own: {
    title: "Nuestros partidos",
    subtitle: "Análisis post-partido. El «equipo analizado» somos nosotras.",
    focus: "Nuestro equipo",
    other: "Rival",
    empty: "Aún no hay partidos propios.",
  },
  rival: {
    title: "Rivales",
    subtitle: "Partidos de equipos contra los que vamos a jugar. El «equipo analizado» es el rival que estudiamos.",
    focus: "Rival que analizamos",
    other: "Su contrario en ese partido",
    empty: "Aún no hay partidos de rivales.",
  },
  reference: {
    title: "Videos de referencia",
    subtitle: "Otros partidos o jugadas que vale la pena estudiar (un estilo de juego, una idea del cuerpo técnico).",
    focus: "Equipo que analizamos",
    other: "Su contrario",
    empty: "Aún no hay videos de referencia.",
  },
};
const ORDER: MatchKind[] = ["own", "rival", "reference"];

// Every match with video, in three groups: ours, rivals and reference videos.
export function MatchList() {
  const { matches, events, plays } = useStore();
  const [kind, setKind] = useState<MatchKind>("own");
  // A match about to be deleted, waiting for the confirmation.
  const [toDelete, setToDelete] = useState<Match | null>(null);
  const remove = (id: string) => {
    mutate((s) => ({
      ...s,
      matches: s.matches.filter((m) => m.match_id !== id),
      events: s.events.filter((e) => e.match_id !== id),
      plays: s.plays.filter((p) => p.match_id !== id),
      segments: s.segments.filter((g) => g.match_id !== id),
    }));
    setToDelete(null);
  };
  // The form opens as a dialog over the list.
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAdding(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding]);
  const c = COPY[kind];
  const [focus, setFocus] = useState("");
  const [other, setOther] = useState("");
  const [date, setDate] = useState("");
  const [yt, setYt] = useState("");
  const ytId = parseYouTubeId(yt);

  const create = () => {
    if (!focus.trim()) return;
    mutate((s) => ({
      ...s,
      matches: [
        ...s.matches,
        {
          match_id: uid("m"),
          name: `${focus.trim()} vs ${other.trim() || "?"}`,
          kind,
          date,
          focus_team: focus.trim(),
          other_team: other.trim() || "Contrario",
          youtube_id: ytId,
          report: { ...EMPTY_REPORT },
        },
      ],
    }));
    setFocus("");
    setOther("");
    setDate("");
    setYt("");
    setAdding(false);
  };
  const openNew = (k: MatchKind) => {
    setKind(k);
    setAdding(true);
  };

  return (
    <>
      <PageHeader
        title="Partidos"
      >
        <button type="button" className={btnPrimary} onClick={() => openNew("own")}>
          <Plus size={15} />
          Nuevo video
        </button>
      </PageHeader>
      <div>
        <div className="space-y-10">
          {ORDER.map((k) => {
            const list = matches.filter((m) => m.kind === k);
            return (
              <section key={k}>
                <div className="mb-1 flex items-baseline justify-between gap-4 border-b border-line-soft pb-2">
                  <h2 className="font-display text-2xl text-ink">{COPY[k].title}</h2>
                  <span className="flex items-baseline gap-4">
                    <span className="tc text-xs text-faint">{list.length}</span>
                    <button type="button" className="link text-xs" onClick={() => openNew(k)}>
                      + añadir
                    </button>
                  </span>
                </div>
                {list.length === 0 && <p className="text-sm text-faint">{COPY[k].empty}</p>}
                <ul className="space-y-3">
                  {list.map((m, n) => {
                    const nEvents = events.filter((e) => e.match_id === m.match_id).length;
                    const nPlays = plays.filter((p) => p.match_id === m.match_id).length;
                    return (
                      <Reveal as="li" key={m.match_id} delay={Math.min(n, 6) * 60} className="group/item relative">
                        <Link href={`/partido?id=${m.match_id}`} className="card card-link group flex flex-wrap items-center gap-x-8 gap-y-3">
                          <div className="min-w-0 flex-1 basis-60">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-display text-xl text-ink">{m.name}</span>
                              {m.is_demo && <DemoBadge />}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                              <span className="tc">{m.date || "Sin fecha"}</span>
                              <span className={`tag ${m.youtube_id ? "tag-accent" : "tag-outline"}`}>
                                <YoutubeLogo size={12} />
                                {m.youtube_id ? "Video conectado" : "Sin video de YouTube"}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-end gap-7">
                            <div>
                              <div className="num text-4xl text-ink">{nEvents}</div>
                              <div className="mt-1 text-[11px] text-faint">eventos</div>
                            </div>
                            <div>
                              <div className="num text-4xl text-ink-2">{nPlays}</div>
                              <div className="mt-1 text-[11px] text-faint">jugadas</div>
                            </div>
                            <ArrowRight size={18} className="mb-5 text-faint transition-[transform,color] group-hover:translate-x-1 group-hover:text-accent-300" />
                          </div>
                        </Link>
                        <button
                          type="button"
                          className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-md text-faint opacity-0 transition-[opacity,color,background-color] group-hover/item:opacity-100 hover:bg-danger/15 hover:text-danger focus-visible:opacity-100"
                          aria-label={`Borrar ${m.name}`}
                          title="Borrar el partido"
                          onClick={() => setToDelete(m)}
                        >
                          <Trash size={15} />
                        </button>
                      </Reveal>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

      </div>
      {toDelete && (
        <Modal title="Borrar partido" onClose={() => setToDelete(null)}>
          <p className="text-sm text-pretty text-muted">
            ¿Borrar <strong className="text-ink">{toDelete.name}</strong> con sus {events.filter((e) => e.match_id === toDelete.match_id).length} eventos y{" "}
            {plays.filter((p) => p.match_id === toDelete.match_id).length} jugadas? Solo se borra de este navegador: la carpeta del partido y sus archivos no se
            tocan. No se puede deshacer (salvo con un respaldo de Datos).
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={btn} onClick={() => setToDelete(null)}>
              Cancelar
            </button>
            <button type="button" className="btn !border-danger !bg-danger text-white" onClick={() => remove(toDelete.match_id)}>
              <Trash size={15} />
              Borrar
            </button>
          </div>
        </Modal>
      )}
      {adding && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4 backdrop-blur-sm" role="presentation" onClick={() => setAdding(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Nuevo video"
            className="enter w-full max-w-md rounded-3xl bg-raised p-6 shadow-[0_0_0_1px_var(--color-line-strong),0_30px_60px_-20px_rgba(0,0,0,.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-2xl text-ink">Nuevo video</h2>
              <button type="button" className={`${btn} h-8 w-8 !p-0`} aria-label="Cerrar" onClick={() => setAdding(false)}>
                <X size={14} />
              </button>
            </div>
          <div className="space-y-3">
            <div className="seg w-full" role="group" aria-label="Tipo de video">
              {ORDER.map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className="seg-opt flex-1 text-center text-xs">
                  {k === "own" ? "Nuestro" : k === "rival" ? "Rival" : "Referencia"}
                </button>
              ))}
            </div>
            <label className="block text-xs text-muted">
              {c.focus}
              <input className={`${input} mt-1 w-full`} value={focus} onChange={(e) => setFocus(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">
              {c.other}
              <input className={`${input} mt-1 w-full`} value={other} onChange={(e) => setOther(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">
              Fecha del partido
              <input className={`${input} mt-1 w-full`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="block text-xs text-muted">
              Enlace de YouTube (opcional)
              <input className={`${input} mt-1 w-full`} placeholder="https://" value={yt} onChange={(e) => setYt(e.target.value)} />
            </label>
            {yt.trim() !== "" && (
              <p className={`text-xs ${ytId ? "text-faint" : "text-danger"}`}>
                {ytId ? `Video detectado: ${ytId}` : "No reconozco ese enlace. Pega la URL completa del video."}
              </p>
            )}
            <button type="button" className={`${btnPrimary} w-full`} disabled={!focus.trim()} onClick={create}>
              <Plus size={15} />
              Crear partido
            </button>
          </div>
          </div>
        </div>
      )}
    </>
  );
}
