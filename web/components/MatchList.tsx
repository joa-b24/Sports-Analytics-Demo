"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DemoBadge, PageHeader, btnPrimary, input } from "@/components/Shell";
import { parseYouTubeId } from "@/lib/format";
import { mutate, uid, useStore } from "@/lib/store";
import { EMPTY_REPORT, type MatchKind } from "@/lib/types";

const COPY: Record<MatchKind, { title: string; subtitle: string; focus: string; other: string; empty: string }> = {
  rival: {
    title: "Rivales · análisis previo",
    subtitle: "Partidos de equipos contra los que vamos a jugar. El «equipo analizado» es el rival que estudiamos.",
    focus: "Rival que analizamos",
    other: "Su contrario en ese partido",
    empty: "Aún no hay partidos de rivales.",
  },
  own: {
    title: "Nuestros partidos · post-partido",
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
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-3">
          {list.length === 0 && (
            <Card>
              <p className="text-sm text-slate-600">
                {c.empty} Crea uno con el formulario, o carga los datos de ejemplo desde{" "}
                <Link href="/datos" className="text-blue-700 underline">
                  Datos
                </Link>
                .
              </p>
            </Card>
          )}
          {list.map((m) => (
            <Link
              key={m.match_id}
              href={`/partido?id=${m.match_id}`}
              className="block rounded-lg border border-slate-200 bg-white p-4 transition-colors hover:border-slate-400"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-slate-900">{m.name}</span>
                {m.is_demo && <DemoBadge />}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {m.date || "Sin fecha"} · {events.filter((e) => e.match_id === m.match_id).length} eventos ·{" "}
                {plays.filter((p) => p.match_id === m.match_id).length} jugadas · {m.youtube_id ? "video de YouTube conectado" : "sin video de YouTube"}
              </div>
            </Link>
          ))}
        </div>

        <Card title="Nuevo partido">
          <div className="space-y-2">
            <input className={`${input} w-full`} placeholder={c.focus} value={focus} onChange={(e) => setFocus(e.target.value)} />
            <input className={`${input} w-full`} placeholder={c.other} value={other} onChange={(e) => setOther(e.target.value)} />
            <input className={`${input} w-full`} type="date" aria-label="Fecha del partido" value={date} onChange={(e) => setDate(e.target.value)} />
            <input className={`${input} w-full`} placeholder="Enlace de YouTube (opcional)" value={yt} onChange={(e) => setYt(e.target.value)} />
            {yt.trim() !== "" && (
              <p className={`text-xs ${ytId ? "text-slate-500" : "text-red-700"}`}>
                {ytId ? `Video detectado: ${ytId}` : "No reconozco ese enlace. Pega la URL completa del video."}
              </p>
            )}
            <button type="button" className={`${btnPrimary} w-full`} disabled={!focus.trim()} onClick={create}>
              Crear partido
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}
