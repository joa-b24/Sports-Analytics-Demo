"use client";

import {
  ArrowLeft,
  ChartLineUp,
  ClipboardText,
  FastForward,
  FilmStrip,
  FolderOpen,
  Play,
  Plus,
  Rewind,
  Scissors,
  SkipBack,
  SkipForward,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { AnalysisTab } from "@/components/match/AnalysisTab";
import { PlaysTab } from "@/components/match/PlaysTab";
import { ReportTab } from "@/components/match/ReportTab";
import { SegmentsTab } from "@/components/match/SegmentsTab";
import { TagTab } from "@/components/match/TagTab";
import { Card, DemoBadge, btn, btnPrimary, input } from "@/components/Shell";
import { SpeedControl } from "@/components/SpeedControl";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT, parseYouTubeId } from "@/lib/format";
import { segmentsFromMarks, type Segment } from "@/lib/segments";
import { mutate, useHydrated, useStore } from "@/lib/store";
import type { Match, MatchVideo } from "@/lib/types";
import { matchTimeline, matchVideos, nextVideo, videoOf } from "@/lib/videos";

// In working order: first say which parts of the video are play, then tag on top of that.
const TABS = [
  { id: "segments", label: "Tramos", icon: Scissors },
  { id: "tag", label: "Video y etiquetado", icon: VideoCamera },
  { id: "plays", label: "Jugadas y animación", icon: FilmStrip },
  { id: "analysis", label: "Análisis", icon: ChartLineUp },
  { id: "report", label: "Informe", icon: ClipboardText },
] as const;
type TabId = (typeof TABS)[number]["id"];

// Object URLs of local video files, per match and video. They only live for this browser session.
const fileUrls = new Map<string, string>();

function MatchPage() {
  const id = useSearchParams().get("id");
  const state = useStore();
  const hydrated = useHydrated();
  const [tab, setTab] = useState<TabId>("tag");
  const [time, setTime] = useState(0);
  const [, bump] = useState(0);
  const [videoSel, setVideoSel] = useState("");
  const [ytDraft, setYtDraft] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Where the tagging tab puts its events table: under the video, where there is room for it.
  const [tableSlot, setTableSlot] = useState<HTMLDivElement | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const stopAt = useRef<number | null>(null);

  const match = state.matches.find((m) => m.match_id === id);
  if (!hydrated) return null;
  if (!match) {
    return (
      <Card>
        <p className="text-sm text-muted">
          No encuentro ese partido en este navegador.{" "}
          <Link href="/rivales" className="link">
            Volver a la lista
          </Link>
        </p>
      </Card>
    );
  }

  const videos = matchVideos(match);
  const video = videos.find((v) => v.video_id === videoSel) ?? videos[0];
  const videoIndex = videos.indexOf(video);
  const fileKey = `${match.match_id}|${video.video_id}`;

  const allEvents = state.events.filter((e) => e.match_id === match.match_id);
  const allPlays = state.plays.filter((p) => p.match_id === match.match_id);
  const allMarks = state.segments.filter((g) => g.match_id === match.match_id);
  // The working tabs show one video at a time; analysis and report see the whole match.
  const events = allEvents.filter((e) => videoOf(e) === video.video_id).sort((a, b) => a.t_video - b.t_video);
  const plays = allPlays.filter((p) => videoOf(p) === video.video_id).sort((a, b) => a.t_start - b.t_start);
  const marks = allMarks.filter((g) => videoOf(g) === video.video_id);
  const segmentsByVideo: Record<string, Segment[]> = Object.fromEntries(
    videos.map((v) => [v.video_id, segmentsFromMarks(allMarks.filter((g) => videoOf(g) === v.video_id))]),
  );
  const segments = segmentsByVideo[video.video_id];
  const timeline = matchTimeline(videos, allEvents, segmentsByVideo);
  const originalTime = new Map(allEvents.map((e) => [e.event_id, e]));
  const videoLabel = (vid: string) => videos.find((v) => v.video_id === vid)?.label ?? vid;

  const patch = (p: Partial<Match>) =>
    mutate((s) => ({ ...s, matches: s.matches.map((m) => (m.match_id === match.match_id ? { ...m, ...p } : m)) }));
  // The first link is mirrored in match.youtube_id, which the match lists read.
  const setVideos = (next: MatchVideo[]) => patch({ videos: next, youtube_id: next[0]?.youtube_id ?? "" });
  const patchVideo = (p: Partial<MatchVideo>) => setVideos(videos.map((v) => (v.video_id === video.video_id ? { ...v, ...p } : v)));
  const usedBy = (vid: string) =>
    allEvents.filter((e) => videoOf(e) === vid).length + allPlays.filter((x) => videoOf(x) === vid).length + allMarks.filter((g) => videoOf(g) === vid).length;
  const pickVideo = (vid: string) => {
    setVideoSel(vid);
    setYtDraft(null);
    setTime(0);
    setRate(1);
  };
  const changeRate = (r: number) => {
    setRate(r);
    playerRef.current?.setRate(r);
  };
  const jump = (seconds: number) => playerRef.current?.seek(Math.max(0, (playerRef.current?.getTime() ?? 0) + seconds));

  const withVideo = tab === "tag" || tab === "plays" || tab === "segments";
  const ytInput = ytDraft ?? video.youtube_id;

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
      <div className="mb-5 print:hidden">
        <Link
          href={match.kind === "rival" ? "/rivales" : "/partidos"}
          className="enter inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-accent-200"
        >
          <ArrowLeft size={13} />
          {match.kind === "rival" ? "Rivales" : "Nuestros partidos"}
        </Link>
        <div className="eyebrow enter mt-3" style={{ "--d": "40ms" } as React.CSSProperties}>
          {match.kind === "rival" ? "Análisis táctico · rival" : "Análisis post-partido"}
        </div>
        <div className="enter mt-1 flex flex-wrap items-center gap-3" style={{ "--d": "90ms" } as React.CSSProperties}>
          <input
            className="-ml-2 min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 font-display text-3xl leading-tight text-ink transition-colors hover:border-line focus:border-accent focus:bg-surface focus:outline-none md:text-4xl"
            value={match.name}
            aria-label="Nombre del partido"
            onChange={(e) => patch({ name: e.target.value })}
          />
          {match.is_demo && <DemoBadge />}
        </div>
        {/* Match details stay folded: they are set once, and the height goes to the video. */}
        <div className="enter mt-2 flex flex-wrap items-start gap-x-6 gap-y-2 text-[11px] text-faint" style={{ "--d": "140ms" } as React.CSSProperties}>
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer text-xs text-muted transition-colors hover:text-accent-200">
              {match.focus_team} <span className="text-faint">vs</span> {match.other_team} · <span className="tc">{match.date || "sin fecha"}</span> ·{" "}
              <span className="link">editar datos</span>
            </summary>
            <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
              <label className="flex flex-col gap-1">
                Equipo analizado
                <input className={`${input} w-40`} value={match.focus_team} onChange={(e) => patch({ focus_team: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                Contrario
                <input className={`${input} w-40`} value={match.other_team} onChange={(e) => patch({ other_team: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1">
                Fecha
                <input className={input} type="date" value={match.date} onChange={(e) => patch({ date: e.target.value })} />
              </label>
            </div>
          </details>
          <span className="flex items-baseline gap-5 text-xs">
            <span>
              <span className="num mr-1.5 text-2xl text-ink">{allEvents.length}</span>eventos
            </span>
            <span>
              <span className="num mr-1.5 text-2xl text-ink-2">{allPlays.length}</span>jugadas
            </span>
          </span>
        </div>
      </div>

      <div className="enter mb-5 overflow-x-auto pb-1 print:hidden" style={{ "--d": "190ms" } as React.CSSProperties}>
        <div className="seg" role="group" aria-label="Sección del partido">
          {TABS.map((t) => {
            const I = t.icon;
            return (
              <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)} className="seg-opt inline-flex items-center gap-1.5">
                <I size={15} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* The video takes the room; the working panel keeps a fixed, narrower width (wider for the pitch animation). */}
      <div
        className={
          !withVideo
            ? ""
            : tab === "plays"
              ? "grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
              : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]"
        }
      >
        {/* The player stays mounted on every tab so the video keeps its position. */}
        <div className={withVideo ? "space-y-3 xl:sticky xl:top-4 xl:self-start" : "hidden"}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="seg" role="group" aria-label="Video del partido">
              {videos.map((v) => (
                <button key={v.video_id} type="button" aria-pressed={v.video_id === video.video_id} onClick={() => pickVideo(v.video_id)} className="seg-opt">
                  <span className="tc mr-1.5 opacity-70">{v.video_id}</span>
                  {v.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              title="Un partido puede venir en varios videos, por ejemplo uno por tiempo"
              onClick={() => {
                const v = nextVideo(videos);
                setVideos([...videos, v]);
                pickVideo(v.video_id);
              }}
            >
              <Plus size={14} />
              Añadir video
            </button>
            {videos.length > 1 && (
              <span className="ml-auto flex items-center gap-2 text-[11px] text-faint">
                <input className={`${input} w-32`} aria-label="Nombre de este video" value={video.label} onChange={(e) => patchVideo({ label: e.target.value })} />
                {videoIndex > 0 && usedBy(video.video_id) === 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 transition-colors hover:text-danger"
                    title="Solo se puede quitar un video sin eventos, jugadas ni tramos"
                    onClick={() => {
                      setVideos(videos.filter((v) => v.video_id !== video.video_id));
                      pickVideo(videos[0].video_id);
                    }}
                  >
                    <X size={12} />
                    quitar
                  </button>
                )}
              </span>
            )}
          </div>

          {/* The width is capped by the height of the window, so the video and its controls always fit on screen. */}
          <div className="mx-auto w-full xl:max-w-[calc((100vh-15rem)*16/9)]">
            <VideoPlayer key={video.video_id} ref={playerRef} youtubeId={video.youtube_id || undefined} fileUrl={fileUrls.get(fileKey)} onTime={onTime} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−5 s" aria-label="Retroceder 5 segundos" onClick={() => jump(-5)}>
              <Rewind size={16} />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 s" aria-label="Retroceder 1 segundo" onClick={() => jump(-1)}>
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className={`${btnPrimary} h-10 w-10 !p-0`}
              title="Reproducir / pausar"
              aria-label="Reproducir o pausar"
              onClick={() => playerRef.current?.toggle()}
            >
              <Play size={16} weight="fill" />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s" aria-label="Avanzar 1 segundo" onClick={() => jump(1)}>
              <SkipForward size={16} />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+5 s" aria-label="Avanzar 5 segundos" onClick={() => jump(5)}>
              <FastForward size={16} />
            </button>
            <span className="tag tc ml-1">{fmtT(time)}</span>
            <span className="ml-auto">
              {/* YouTube only plays at multiples of 0.25; a local file takes any speed. */}
              <SpeedControl rate={rate} onChange={changeRate} step={fileUrls.has(fileKey) ? 0.05 : 0.25} min={fileUrls.has(fileKey) ? 0.1 : 0.25} />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <input
              className={`${input} min-w-0 flex-1`}
              placeholder={`Pega aquí el enlace de YouTube de ${video.label.toLowerCase()}`}
              value={ytInput}
              onChange={(e) => {
                setYtDraft(e.target.value);
                const parsed = parseYouTubeId(e.target.value);
                if (parsed || e.target.value.trim() === "") patchVideo({ youtube_id: parsed });
              }}
            />
            <label className={`${btn} relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400`}>
              <FolderOpen size={15} />
              Abrir archivo local
              <input
                type="file"
                accept="video/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const old = fileUrls.get(fileKey);
                  if (old) URL.revokeObjectURL(old);
                  fileUrls.set(fileKey, URL.createObjectURL(f));
                  bump((n) => n + 1);
                }}
              />
            </label>
            {fileUrls.has(fileKey) && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  URL.revokeObjectURL(fileUrls.get(fileKey) as string);
                  fileUrls.delete(fileKey);
                  bump((n) => n + 1);
                }}
              >
                quitar archivo
              </button>
            )}
          </div>
          {ytDraft !== null && ytDraft.trim() !== "" && !parseYouTubeId(ytDraft) && (
            <p className="text-xs text-danger">No reconozco ese enlace. Pega la URL completa del video de YouTube.</p>
          )}
          <p className="text-xs text-faint">
            El archivo local debe ser el video original completo (sin recortar), para que los tiempos coincidan con YouTube. No se sube a
            ningún lado.
            {videos.length > 1 && " Cada video tiene sus propios tiempos, tramos, eventos y jugadas; Análisis e Informe los juntan."}
          </p>
        </div>

        <div className="min-w-0">
          {tab === "tag" && (
            <TagTab
              key={video.video_id}
              match={match}
              videoId={video.video_id}
              defaultPeriod={videoIndex === 0 ? 1 : 2}
              events={events}
              segments={segments}
              time={time}
              playerRef={playerRef}
              tableSlot={tableSlot}
            />
          )}
          {tab === "segments" && (
            <SegmentsTab
              match={match}
              videoId={video.video_id}
              marks={marks}
              videoIds={videos.map((v) => v.video_id)}
              segmentsByVideo={segmentsByVideo}
              time={time}
              playerRef={playerRef}
            />
          )}
          {tab === "plays" && (
            <PlaysTab key={video.video_id} match={match} videoId={video.video_id} plays={plays} time={time} playerRef={playerRef} playClip={playClip} />
          )}
          {tab === "analysis" && (
            <AnalysisTab
              match={match}
              events={timeline.events}
              segments={timeline.segments}
              // On the joined axis the times are no longer video times: tooltips show the original ones.
              timeLabel={
                videos.length > 1
                  ? (e) => {
                      const o = originalTime.get(e.event_id);
                      return o ? `${videoLabel(videoOf(o))} ${fmtT(o.t_video)}` : fmtT(e.t_video);
                    }
                  : undefined
              }
            />
          )}
          {tab === "report" && <ReportTab match={match} events={allEvents} plays={[...allPlays].sort((a, b) => videos.findIndex((v) => v.video_id === videoOf(a)) - videos.findIndex((v) => v.video_id === videoOf(b)) || a.t_start - b.t_start)} />}
        </div>
      </div>

      {/* Full width, under both columns: the events table of the tagging tab is drawn here. */}
      <div ref={setTableSlot} className={tab === "tag" ? "mt-6" : "hidden"} />

      <div className="mt-12 text-xs text-faint print:hidden">
        {confirmDelete ? (
          <span>
            ¿Borrar este partido con sus {allEvents.length} eventos y {allPlays.length} jugadas?{" "}
            <button
              type="button"
              className="font-medium text-danger underline"
              onClick={() =>
                mutate((s) => ({
                  ...s,
                  matches: s.matches.filter((m) => m.match_id !== match.match_id),
                  events: s.events.filter((e) => e.match_id !== match.match_id),
                  plays: s.plays.filter((p) => p.match_id !== match.match_id),
                  segments: s.segments.filter((g) => g.match_id !== match.match_id),
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
