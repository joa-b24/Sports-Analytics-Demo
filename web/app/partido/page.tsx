"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { AnalysisTab } from "@/components/match/AnalysisTab";
import { PlaysTab } from "@/components/match/PlaysTab";
import { ReportTab } from "@/components/match/ReportTab";
import { TagTab } from "@/components/match/TagTab";
import { Card, DemoBadge, btn, input } from "@/components/Shell";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { parseYouTubeId } from "@/lib/format";
import { mutate, useHydrated, useStore } from "@/lib/store";
import type { Match } from "@/lib/types";

const TABS = [
  { id: "tag", label: "Video y etiquetado" },
  { id: "plays", label: "Jugadas y animación" },
  { id: "analysis", label: "Análisis" },
  { id: "report", label: "Informe" },
] as const;
type TabId = (typeof TABS)[number]["id"];

// Object URLs of local video files, per match. They only live for this browser session.
const fileUrls = new Map<string, string>();

function MatchPage() {
  const id = useSearchParams().get("id");
  const state = useStore();
  const hydrated = useHydrated();
  const [tab, setTab] = useState<TabId>("tag");
  const [time, setTime] = useState(0);
  const [, bump] = useState(0);
  const [ytDraft, setYtDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);
  const stopAt = useRef<number | null>(null);

  const match = state.matches.find((m) => m.match_id === id);
  if (!hydrated) return null;
  if (!match) {
    return (
      <Card>
        <p className="text-sm text-slate-600">
          No encuentro ese partido en este navegador.{" "}
          <Link href="/rivales" className="text-blue-700 underline">
            Volver a la lista
          </Link>
        </p>
      </Card>
    );
  }

  const events = state.events.filter((e) => e.match_id === match.match_id).sort((a, b) => a.t_video - b.t_video);
  const plays = state.plays.filter((p) => p.match_id === match.match_id).sort((a, b) => a.t_start - b.t_start);
  const patch = (p: Partial<Match>) =>
    mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, ...p } : m)) }));
  const withVideo = tab === "tag" || tab === "plays";
  const ytInput = ytDraft ?? match.youtube_id;

  const onTime = (t: number) => {
    if (stopAt.current !== null && t >= stopAt.current) {
      stopAt.current = null;
      playerRef.current?.pause();
    }
    setTime((prev) => (Math.abs(prev - t) > 0.04 ? t : prev));
  };
  const playClip = (t0: number, t1: number) => {
    stopAt.current = t1;
    playerRef.current?.seek(t0, true);
  };

  return (
    <div>
      <div className="mb-4 print:hidden">
        <Link href={match.kind === "rival" ? "/rivales" : "/partidos"} className="text-xs text-slate-500 underline">
          ← {match.kind === "rival" ? "Rivales" : "Nuestros partidos"}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent text-2xl font-semibold tracking-tight text-slate-900 hover:border-slate-300 focus:border-slate-300 focus:bg-white"
            value={match.name}
            aria-label="Nombre del partido"
            onChange={(e) => patch({ name: e.target.value })}
          />
          {match.is_demo && <DemoBadge />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <label className="flex items-center gap-1">
            Equipo analizado
            <input className={`${input} w-32`} value={match.focus_team} onChange={(e) => patch({ focus_team: e.target.value })} />
          </label>
          <label className="flex items-center gap-1">
            Contrario
            <input className={`${input} w-32`} value={match.other_team} onChange={(e) => patch({ other_team: e.target.value })} />
          </label>
          <label className="flex items-center gap-1">
            Fecha
            <input className={input} type="date" value={match.date} onChange={(e) => patch({ date: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
              tab === t.id ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={withVideo ? "grid gap-4 xl:grid-cols-2" : ""}>
        {/* The player stays mounted on every tab so the video keeps its position. */}
        <div className={withVideo ? "space-y-2 xl:sticky xl:top-4 xl:self-start" : "hidden"}>
          <VideoPlayer ref={playerRef} youtubeId={match.youtube_id || undefined} fileUrl={fileUrls.get(match.match_id)} onTime={onTime} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <input
              className={`${input} min-w-0 flex-1`}
              placeholder="Pega aquí el enlace de YouTube del partido"
              value={ytInput}
              onChange={(e) => {
                setYtDraft(e.target.value);
                const parsed = parseYouTubeId(e.target.value);
                if (parsed || e.target.value.trim() === "") patch({ youtube_id: parsed });
              }}
            />
            <label className={`${btn} cursor-pointer`}>
              Abrir archivo local
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const old = fileUrls.get(match.match_id);
                  if (old) URL.revokeObjectURL(old);
                  fileUrls.set(match.match_id, URL.createObjectURL(f));
                  bump((n) => n + 1);
                }}
              />
            </label>
            {fileUrls.has(match.match_id) && (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  URL.revokeObjectURL(fileUrls.get(match.match_id) as string);
                  fileUrls.delete(match.match_id);
                  bump((n) => n + 1);
                }}
              >
                quitar archivo
              </button>
            )}
          </div>
          {ytDraft !== null && ytDraft.trim() !== "" && !parseYouTubeId(ytDraft) && (
            <p className="text-xs text-red-700">No reconozco ese enlace. Pega la URL completa del video de YouTube.</p>
          )}
          <p className="text-xs text-slate-500">
            El archivo local debe ser el video original completo (sin recortar), para que los tiempos coincidan con YouTube. No se sube a
            ningún lado.
          </p>
        </div>

        <div className="min-w-0">
          {tab === "tag" && <TagTab match={match} events={events} time={time} playerRef={playerRef} />}
          {tab === "plays" && <PlaysTab match={match} plays={plays} time={time} playerRef={playerRef} playClip={playClip} />}
          {tab === "analysis" && <AnalysisTab match={match} events={events} />}
          {tab === "report" && <ReportTab match={match} events={events} plays={plays} />}
        </div>
      </div>

      <div className="mt-8 text-xs text-slate-500 print:hidden">
        {confirmDelete ? (
          <span>
            ¿Borrar este partido con sus {events.length} eventos y {plays.length} jugadas?{" "}
            <button
              type="button"
              className="font-medium text-red-700 underline"
              onClick={() =>
                mutate((s) => ({
                  ...s,
                  matches: s.matches.filter((m) => m.match_id !== match.match_id),
                  events: s.events.filter((e) => e.match_id !== match.match_id),
                  plays: s.plays.filter((p) => p.match_id !== match.match_id),
                }))
              }
            >
              Sí, borrar
            </button>{" "}
            <button type="button" className="underline" onClick={() => setConfirmDelete(false)}>
              cancelar
            </button>
          </span>
        ) : (
          <button type="button" className="underline" onClick={() => setConfirmDelete(true)}>
            Borrar partido
          </button>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <MatchPage />
    </Suspense>
  );
}
