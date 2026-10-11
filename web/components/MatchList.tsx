"use client";

import { ArrowRight, Plus, YoutubeLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Reveal } from "@/components/motion";
import { Card, DemoBadge, PageHeader, btnPrimary, input } from "@/components/Shell";
import { parseYouTubeId } from "@/lib/format";
import { mutate, uid, useStore } from "@/lib/store";
import { EMPTY_REPORT, type MatchKind } from "@/lib/types";

const COPY: Record<MatchKind, { eyebrow: string; title: string; subtitle: string; focus: string; other: string; empty: string }> = {
  rival: {
    eyebrow: "Análisis táctico · previo al partido",
    title: "Rivales",
    subtitle: "Partidos de equipos contra los que vamos a jugar. El «equipo analizado» es el rival que estudiamos.",
    focus: "Rival que analizamos",
    other: "Su contrario en ese partido",
    empty: "Aún no hay partidos de rivales.",
  },
  own: {
    eyebrow: "Análisis post-partido",
    title: "Nuestros partidos",
    subtitle: "Partidos de nuestro equipo. El «equipo analizado» somos nosotras.",
    focus: "Nuestro equipo",
    other: "Rival",
    empty: "Aún no hay partidos propios.",
  },
};

export function MatchList({ kind }: { kind: MatchKind }) {
  const { matches, events, plays } = useStore();
  const c = COPY[kind];
  const [focus, setFocus] = useState("");
  const [other, setOther] = useState("");
  const [date, setDate] = useState("");
  const [yt, setYt] = useState("");
  const list = matches.filter((m) => m.kind === kind);
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
  };

  return (
    <>
      <PageHeader eyebrow={c.eyebrow} title={c.title} subtitle={c.subtitle} />
      <div className="grid gap-8 lg:grid-cols-[1fr_21rem]">
        <div>
          {list.length === 0 && (
            <Card>
              <p className="text-sm text-muted">
                {c.empty} Crea uno con el formulario, o carga los datos de ejemplo desde{" "}
                <Link href="/datos" className="link">
                  Carga de datos
                </Link>
                .
              </p>
            </Card>
          )}
          <ul className="space-y-3">
            {list.map((m, n) => {
              const nEvents = events.filter((e) => e.match_id === m.match_id).length;
              const nPlays = plays.filter((p) => p.match_id === m.match_id).length;
              return (
                <Reveal as="li" key={m.match_id} delay={Math.min(n, 6) * 60}>
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
                </Reveal>
              );
            })}
          </ul>
        </div>

        <Card title="Nuevo partido" delay={120} className="self-start lg:sticky lg:top-6">
          <div className="space-y-3">
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
        </Card>
      </div>
    </>
  );
}
