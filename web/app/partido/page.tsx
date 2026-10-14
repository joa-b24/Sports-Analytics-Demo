"use client";

import {
  ArrowLeft,
  ChartLineUp,
  ClipboardText,
  Crosshair,
  PersonSimpleRun,
  FastForward,
  FilmStrip,
  FolderOpen,
  Pause,
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
import { Suspense, useEffect, useRef, useState } from "react";
import { AnalysisTab } from "@/components/match/AnalysisTab";
import { PlaysTab } from "@/components/match/PlaysTab";
import { ReportTab } from "@/components/match/ReportTab";
import { SegmentsTab } from "@/components/match/SegmentsTab";
import { TagTab } from "@/components/match/TagTab";
import { Card, DemoBadge, btn, btnPrimary, input } from "@/components/Shell";
import { Calibration } from "@/components/workspace/Calibration";
import { Correction } from "@/components/workspace/Correction";
import { SpeedControl } from "@/components/SpeedControl";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT, parseYouTubeId } from "@/lib/format";
import { FOLDER_RULE, isFolderName, listLocal, localVideo } from "@/lib/local";
import { matchSteps, type FolderFiles, type StepState } from "@/lib/steps";
import { segmentsFromMarks, skipTarget, type Segment } from "@/lib/segments";
import { mutate, setPref, useHydrated, usePref, useStore } from "@/lib/store";
import type { Match, MatchVideo } from "@/lib/types";
import { matchTimeline, matchVideos, nextVideo, videoOf } from "@/lib/videos";

// In working order: the pitch, which parts of the video are play, the tracking, and then the tagging on top.
// Calibration and tracking are optional: everything after them works with tagged events only.
const TABS = [
  { id: "calibration", label: "Calibración", icon: Crosshair },
  { id: "segments", label: "Tramos", icon: Scissors },
  { id: "tracking", label: "Tracking", icon: PersonSimpleRun },
  { id: "tag", label: "Etiquetado", icon: VideoCamera },
  { id: "plays", label: "Jugadas", icon: FilmStrip },
  { id: "analysis", label: "Análisis", icon: ChartLineUp },
  { id: "report", label: "Informe", icon: ClipboardText },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STATE_STYLE: Record<StepState, { dot: string; label: string }> = {
  done: { dot: "bg-ok", label: "completo" },
  partial: { dot: "bg-warn", label: "a medias" },
  todo: { dot: "border border-line-strong", label: "por hacer" },
  optional: { dot: "border border-dashed border-line-strong", label: "opcional" },
};

// Object URLs of local video files, per match and video. They only live for this browser session.
const fileUrls = new Map<string, string>();

function MatchPage() {
  const id = useSearchParams().get("id");
  const state = useStore();
  const hydrated = useHydrated();
  const [tab, setTab] = useState<TabId>("tag");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [, bump] = useState(0);
  const [videoSel, setVideoSel] = useState("");
  const [ytDraft, setYtDraft] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Where the tagging tab puts its events table: under the video, where there is room for it.
  const [tableSlot, setTableSlot] = useState<HTMLDivElement | null>(null);
  // Over the video and right under its controls: the tagging tab draws its live tags and its timeline there.
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);
  const [belowSlot, setBelowSlot] = useState<HTMLDivElement | null>(null);
  // While tagging, playback jumps over pauses and over what is outside the marked stretches.
  const skipPauses = usePref("skipPauses", "on") === "on";
  // What is in the folder of the match, for the state of each step; read again when the tab changes.
  const [folderFiles, setFolderFiles] = useState<FolderFiles | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const stopAt = useRef<number | null>(null);

  const match = state.matches.find((m) => m.match_id === id);
  const folderForSteps = match?.folder;
  useEffect(() => {
    if (!folderForSteps) return;
    let live = true;
    void listLocal(`matches/${folderForSteps}/tracking`).then((files) => live && setFolderFiles(files ? { tracking: files.map((f) => f.name) } : null));
    return () => {
      live = false;
    };
  }, [folderForSteps, tab]);
  // With a folder, the video of each part of the match is opened from it (any speed, frame by frame).
  const folder = match?.folder;
  const videoNow = match ? (matchVideos(match).find((v) => v.video_id === videoSel) ?? matchVideos(match)[0]).video_id : "";
  useEffect(() => {
    if (!folder || !id || !videoNow || fileUrls.has(`${id}|${videoNow}`)) return;
    let live = true;
    void localVideo(folder, videoNow).then((url) => {
      if (!live || !url) return;
      fileUrls.set(`${id}|${videoNow}`, url);
      bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [folder, id, videoNow]);
  if (!hydrated) return null;
  if (!match) {
    return (
      <Card>
        <p className="text-sm text-muted">
          No encuentro ese partido en este navegador.{" "}
          <Link href="/partidos" className="link">
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
  const steps = matchSteps({
    videoIds: videos.map((v) => v.video_id),
    folder: match.folder,
    venueId: match.venue_id,
    segmentsByVideo,
    events: allEvents,
    plays: allPlays,
    trackEdits: state.trackEdits,
    files: match.folder ? folderFiles : null,
  });
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
    if (tab === "tag" && skipPauses && playing) {
      const to = skipTarget(segments, t);
      if (to !== null && to - t > 0.3) return playerRef.current?.seek(to, true);
    }
    setTime((prev) => (Math.abs(prev - t) > 0.04 ? t : prev));
    const d = playerRef.current?.getDuration() || undefined;
    setDuration((prev) => (prev === d ? prev : d));
  };
  const playClip = (t0: number, t1: number) => {
    stopAt.current = t1;
    playerRef.current?.seek(t0, true);
  };

  return (
    <div>
      <div className="mb-5 print:hidden">
        <Link
          href="/partidos"
          className="enter inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-accent-200"
        >
          <ArrowLeft size={13} />
          Análisis con video
        </Link>
        <div className="eyebrow enter mt-3" style={{ "--d": "40ms" } as React.CSSProperties}>
          {match.kind === "rival" ? "Análisis táctico · rival" : match.kind === "reference" ? "Video de referencia" : "Análisis post-partido"}
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
              <label className="flex flex-col gap-1" title="Nombre de su carpeta en matches/, donde están el video, la calibración y el tracking">
                Carpeta (matches/…)
                <input className={`${input} tc w-64`} placeholder="2026_09_25_up_vs_rival" value={match.folder ?? ""} onChange={(e) => patch({ folder: e.target.value.trim() || undefined })} />
                {match.folder && !isFolderName(match.folder) && (
                  <span className="text-warn">
                    No sigue la convención {FOLDER_RULE}. Se renombra con <code>python -m sportsan.ingest.rename_match {match.folder} &lt;nuevo&gt;</code>
                  </span>
                )}
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

      {/* The tabs are the steps of the analysis, in working order, each with where it stands. */}
      <div className="enter mb-5 overflow-x-auto pb-1 print:hidden" style={{ "--d": "190ms" } as React.CSSProperties}>
        <ol className="flex min-w-max gap-1.5" aria-label="Pasos del análisis del partido">
          {TABS.map((t, n) => {
            const I = t.icon;
            const st = steps[t.id];
            const on = tab === t.id;
            return (
              <li key={t.id} className="flex items-center gap-1.5">
                {n > 0 && <span className="h-px w-3 bg-line" aria-hidden />}
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTab(t.id)}
                  title={`${t.label}: ${STATE_STYLE[st.state].label} · ${st.text}`}
                  className={`flex w-40 flex-col items-start gap-1 rounded-2xl px-3 py-2 text-left transition-colors ${
                    on ? "bg-accent-900 text-accent-100 shadow-[inset_0_0_0_1px_rgba(74,114,255,.55)]" : "bg-surface text-ink-2 hover:bg-raised"
                  }`}
                >
                  <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                    <I size={15} />
                    <span className="truncate">{t.label}</span>
                    <span className={`ml-auto h-2.5 w-2.5 shrink-0 rounded-full ${STATE_STYLE[st.state].dot}`} aria-label={STATE_STYLE[st.state].label} />
                  </span>
                  <span className={`w-full truncate text-[11px] ${on ? "text-accent-200" : "text-faint"}`}>{st.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
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
                <select
                  className={input}
                  aria-label="Tiempo del partido de este video"
                  title="A qué tiempo pertenece este video: un tiempo puede venir en varias partes"
                  value={video.period ?? (videoIndex === 0 ? 1 : 2)}
                  onChange={(e) => patchVideo({ period: Number(e.target.value) as 1 | 2 })}
                >
                  <option value={1}>1.er tiempo</option>
                  <option value={2}>2.º tiempo</option>
                </select>
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
          <div className="relative mx-auto w-full xl:max-w-[calc((100vh-15rem)*16/9)]">
            <div ref={setOverlaySlot} className={tab === "tag" ? "pointer-events-none absolute inset-0 z-10" : "hidden"} />
            <VideoPlayer key={video.video_id} ref={playerRef} youtubeId={video.youtube_id || undefined} fileUrl={fileUrls.get(fileKey)} onTime={onTime} onPlayState={setPlaying} />
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
              title={playing ? "Pausar" : "Reproducir"}
              aria-label={playing ? "Pausar" : "Reproducir"}
              onClick={() => playerRef.current?.toggle()}
            >
              {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s" aria-label="Avanzar 1 segundo" onClick={() => jump(1)}>
              <SkipForward size={16} />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+5 s" aria-label="Avanzar 5 segundos" onClick={() => jump(5)}>
              <FastForward size={16} />
            </button>
            <span className="tag tc ml-1">{fmtT(time)}</span>
            {tab === "tag" && segments.length > 0 && (
              <button
                type="button"
                className={`btn ml-auto ${skipPauses ? "btn-primary" : ""}`}
                aria-pressed={skipPauses}
                title="Al reproducir, salta las pausas y lo que queda fuera de los tramos marcados (previa, final)"
                onClick={() => setPref("skipPauses", skipPauses ? "off" : "on")}
              >
                <SkipForward size={15} />
                Saltar pausas
              </button>
            )}
            <span className={tab === "tag" && segments.length > 0 ? "" : "ml-auto"}>
              {/* YouTube only plays at multiples of 0.25 and up to x2; a local file takes any speed up to x5. */}
              <SpeedControl
                rate={rate}
                onChange={changeRate}
                step={fileUrls.has(fileKey) ? 0.05 : 0.25}
                min={fileUrls.has(fileKey) ? 0.1 : 0.25}
                max={fileUrls.has(fileKey) ? 5 : 2}
              />
            </span>
          </div>
          <div ref={setBelowSlot} className={tab === "tag" ? "" : "hidden"} />
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
                  const old = fileUrls.get(fileKey) as string;
                  if (old.startsWith("blob:")) URL.revokeObjectURL(old);
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
              defaultPeriod={video.period ?? (videoIndex === 0 ? 1 : 2)}
              events={events}
              segments={segments}
              time={time}
              duration={duration}
              playerRef={playerRef}
              playClip={playClip}
              overlaySlot={overlaySlot}
              belowSlot={belowSlot}
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
              videoIds={videos.map((v) => v.video_id)}
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

      {(tab === "calibration" || tab === "tracking") &&
        (!match.folder ? (
          <Card title="Falta la carpeta del partido">
            <p className="text-sm text-pretty text-muted">
              La calibración y el tracking trabajan con los archivos de <code>matches/&lt;carpeta&gt;/</code> (el video, la biblioteca, las
              partes procesadas). Escribe el nombre de la carpeta de este partido:
            </p>
            <input
              className={`${input} tc mt-3 w-72`}
              aria-label="Carpeta del partido"
              placeholder="2026_09_25_up_vs_rival"
              onKeyDown={(e) => {
                const v = (e.target as HTMLInputElement).value.trim();
                if (e.key === "Enter" && v) patch({ folder: v });
              }}
            />
            <p className="mt-2 text-[11px] text-faint">
              Enter para guardar. También se cambia en «editar datos». Convención: {FOLDER_RULE}, en minúsculas y sin acentos.
            </p>
          </Card>
        ) : tab === "calibration" ? (
          <Calibration
            key={`${match.folder}|${video.video_id}`}
            embedded
            folder={match.folder}
            video={video.video_id}
            venue={match.venue_id}
            onVenue={(venue_id) => patch({ venue_id })}
          />
        ) : (
          <Correction key={`${match.folder}|${video.video_id}`} embedded folder={match.folder} video={video.video_id} matchAppId={match.match_id} />
        ))}

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
