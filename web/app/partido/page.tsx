"use client";

import {
  FastForward,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Rewind,
  SkipBack,
  SkipForward,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ClipEditor } from "@/components/clip/ClipEditor";
import { AnalysisTab } from "@/components/match/AnalysisTab";
import { PlaysTab } from "@/components/match/PlaysTab";
import { MatchHeader, type TabId } from "@/components/match/MatchHeader";
import { ReportTab } from "@/components/match/ReportTab";
import { SegmentsTab } from "@/components/match/SegmentsTab";
import { TagTab } from "@/components/match/TagTab";
import { Card, DemoBadge, btn, btnPrimary, input } from "@/components/Shell";
import { Calibration } from "@/components/workspace/Calibration";
import { Correction } from "@/components/workspace/Correction";
import { SpeedControl } from "@/components/SpeedControl";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT, isTyping, parseYouTubeId } from "@/lib/format";
import { FOLDER_RULE, isFolderName, listLocal, localVideo } from "@/lib/local";
import { matchSteps, type FolderFiles } from "@/lib/steps";
import { segmentsFromMarks, skipTarget, type Segment } from "@/lib/segments";
import { mutate, setPref, useHydrated, usePref, useStore } from "@/lib/store";
import type { Match, MatchVideo } from "@/lib/types";
import { matchTimeline, matchVideos, nextVideo, videoOf } from "@/lib/videos";

// Object URLs of local video files, per match and video. They only live for this browser session.
const fileUrls = new Map<string, string>();

function MatchPage() {
  const params = useSearchParams();
  const id = params.get("id");
  // A link to a moment (the report's «ver»): ?id=..&video=v2&t=754 opens that video in the tagging tab, at that time.
  const linkVideo = params.get("video");
  // A link to an edited clip (the report's «ver» when the moment has one): ?id=..&edit=<edit_id> opens it presenting.
  const linkEdit = params.get("edit");
  const router = useRouter();
  const linkT = Number(params.get("t"));
  const state = useStore();
  const hydrated = useHydrated();
  // With events, the match opens on its analysis (what the staff reads); without, on capture. A link to a moment
  // opens the events of that video.
  const [tabSel, setTab] = useState<TabId | null>(null);
  // Until the analyst picks one: a link to a moment opens its events; otherwise a match with events opens on its
  // analysis (what the staff reads) and one without, on capture. Decided once the data is loaded.
  const tab: TabId = tabSel ?? (linkVideo ? "tag" : state.events.some((e) => e.match_id === id) ? "analysis" : "tag");
  // Time to go to as soon as the player knows the length of the video (it cannot seek before).
  const pendingSeek = useRef<number | null>(linkVideo && Number.isFinite(linkT) && linkT >= 0 ? linkT : null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [, bump] = useState(0);
  const [videoSel, setVideoSel] = useState(linkVideo ?? "");
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
  // Video keys in the tabs with the video: Space plays or pauses, ← → jump 5 s, with Shift 1 s (as the buttons).
  // Not while writing, nor over a drop-down or a slider (their arrows are theirs). Over the YouTube frame the keys go
  // to YouTube, which does the same.
  const videoTab = tab === "tag" || tab === "plays" || tab === "segments";
  useEffect(() => {
    if (!videoTab) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (isTyping(el) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (el?.tagName === "SELECT" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type === "range")) return;
      const p = playerRef.current;
      if (!p) return;
      if (e.key === " ") {
        // Also stops a focused button from being pressed by the same Space.
        e.preventDefault();
        p.toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? 1 : 5) * (e.key === "ArrowLeft" ? -1 : 1);
        p.seek(Math.max(0, p.getTime() + step));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [videoTab]);

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
    if (pendingSeek.current !== null && (playerRef.current?.getDuration() ?? 0) > 0) {
      const to = pendingSeek.current;
      pendingSeek.current = null;
      playerRef.current?.seek(to);
      return;
    }
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

  const presentEdit = linkEdit ? (state.edits ?? []).find((e) => e.edit_id === linkEdit && e.match_id === match.match_id) : undefined;

  return (
    <div>
      {presentEdit && (
        <ClipEditor match={match} edit={presentEdit} startPresenting onClose={() => router.replace(`/partido?id=${encodeURIComponent(match.match_id)}`, { scroll: false })} />
      )}
      <MatchHeader match={match} events={allEvents} tab={tab} onTab={setTab} steps={steps}>
        {match.is_demo && <DemoBadge />}
        <details className="relative">
          <summary className="btn cursor-pointer list-none">Datos del partido</summary>
          <div className="absolute right-0 z-30 mt-2 flex w-80 flex-col gap-2 rounded-lg bg-raised p-4 text-xs text-muted shadow-xl">
            <label className="flex flex-col gap-1">
              Nombre
              <input className={input} value={match.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              Equipo analizado
              <input className={input} value={match.focus_team} onChange={(e) => patch({ focus_team: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              Contrario
              <input className={input} value={match.other_team} onChange={(e) => patch({ other_team: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              Fecha
              <input className={input} type="date" value={match.date} onChange={(e) => patch({ date: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              Carpeta (matches/…)
              <input className={`${input} tc`} placeholder="2026_09_25_up_vs_rival" value={match.folder ?? ""} onChange={(e) => patch({ folder: e.target.value.trim() || undefined })} />
              {match.folder && !isFolderName(match.folder) && (
                <span className="text-warn">
                  No sigue la convención {FOLDER_RULE}. Se renombra con <code>python -m sportsan.ingest.rename_match {match.folder} &lt;nuevo&gt;</code>
                </span>
              )}
            </label>
            <span className="text-faint">
              {allEvents.length} eventos · {allPlays.length} jugadas
            </span>
          </div>
        </details>
      </MatchHeader>

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
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−5 s (←)" aria-label="Retroceder 5 segundos" onClick={() => jump(-5)}>
              <Rewind size={16} />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="−1 s (Mayús + ←)" aria-label="Retroceder 1 segundo" onClick={() => jump(-1)}>
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className={`${btnPrimary} h-10 w-10 !p-0`}
              title={playing ? "Pausar (espacio)" : "Reproducir (espacio)"}
              aria-label={playing ? "Pausar" : "Reproducir"}
              onClick={() => playerRef.current?.toggle()}
            >
              {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+1 s (Mayús + →)" aria-label="Avanzar 1 segundo" onClick={() => jump(1)}>
              <SkipForward size={16} />
            </button>
            <button type="button" className={`${btn} h-9 w-9 !p-0`} title="+5 s (→)" aria-label="Avanzar 5 segundos" onClick={() => jump(5)}>
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
              videoEvents={allEvents}
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
          {tab === "report" && <ReportTab match={match} events={allEvents} plays={allPlays} segmentsByVideo={segmentsByVideo} />}
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
        ) : (
          <>
            {/* Calibration and tracking work on one video at a time: which one, chosen here. */}
            {videos.length > 1 && (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Video</span>
                <div className="seg" role="group" aria-label="Video del partido">
                  {videos.map((v) => (
                    <button key={v.video_id} type="button" aria-pressed={v.video_id === video.video_id} onClick={() => pickVideo(v.video_id)} className="seg-opt">
                      <span className="tc mr-1.5 opacity-70">{v.video_id}</span>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tab === "calibration" ? (
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
            )}
          </>
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
