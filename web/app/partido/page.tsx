"use client";

import { ShootoutPanel } from "@/components/match/Shootout";
import { FolderTools, useYamlSync } from "@/components/match/FolderSync";
import { SaveStatus } from "@/components/match/SaveStatus";
import {
  CalendarBlank,
  CheckCircle,
  Folder,
  MapPin,
  Trash,
  WarningCircle,
  GearSix,
  FastForward,
  FilmStrip,
  Flask,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Rewind,
  SkipBack,
  SlidersHorizontal,
  SkipForward,
  YoutubeLogo,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ClipEditor } from "@/components/clip/ClipEditor";
import { AnalysisTab } from "@/components/match/AnalysisTab";
import { PlaysTab } from "@/components/match/PlaysTab";
import { TechPanel } from "@/components/match/TechPanel";
import { Modal } from "@/components/Modal";
import { techChanged } from "@/lib/tech";
import { MODES, MatchHeader, isMode, mainOf, modeOf, type TabId } from "@/components/match/MatchHeader";
import { BoardsWorkspace } from "@/components/board/BoardsWorkspace";
import { ReportTab } from "@/components/match/ReportTab";
import { SegmentsTab } from "@/components/match/SegmentsTab";
import { TagTab } from "@/components/match/TagTab";
import { Card, DemoBadge, btn, btnPrimary, input } from "@/components/Shell";
import { Dropdown } from "@/components/Dropdown";
import { Select } from "@/components/Select";
import { EdgeReveal, useFocusMode } from "@/components/FocusMode";
import { Calibration } from "@/components/workspace/Calibration";
import { Correction } from "@/components/workspace/Correction";
import { SpeedControl } from "@/components/SpeedControl";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT, isTyping, parseYouTubeId } from "@/lib/format";
import { FOLDER_RULE, isFolderName, localVideo, readFolderFiles } from "@/lib/local";
import { matchSteps, type FolderFiles } from "@/lib/steps";
import { segmentsFromMarks, skipTarget, type Segment } from "@/lib/segments";
import { mutate, setPref, useHydrated, usePref, useStore } from "@/lib/store";
import { allVenues } from "@/lib/venue";
import type { Match, MatchVideo } from "@/lib/types";
import { matchTimeline, matchVideos, nextVideo, videoOf } from "@/lib/videos";

// Width of the side panel in Tramos (px): it is dragged from its left edge.
const SEG_SIDE_MIN = 300;
const SEG_SIDE_MAX = 640;
const SEG_SIDE_DEFAULT = 416;

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
  const focus = useFocusMode();
  // With events, the match opens on its analysis (what the staff reads); without, on capture. A link to a moment
  // opens the events of that video.
  // The mode comes from the sidebar (?modo=captura|estudio|analisis); inside it the analyst picks the step.
  const modo = params.get("modo");
  // The step picked inside a mode; when the sidebar changes the mode, its main step shows.
  // A link can name the step too (?modo=analisis&paso=report, from Inicio).
  const [picked, setPicked] = useState<TabId | null>(() => {
    const paso = params.get("paso");
    return MODES.flatMap((m) => m.steps.map(([s]) => s as TabId)).find((s) => s === paso) ?? null;
  });
  const setTab = (t: TabId) => setPicked(t);
  // Configuración del partido > Detalles técnicos (a link from the evaluation tools opens it: ?detalles=tecnicos).
  const [techOpen, setTechOpen] = useState(params.get("detalles") === "tecnicos");
  // Without a mode: a link to a moment opens its events; a match with events opens on its analysis (what the staff
  // reads) and one without, on capture.
  const fallback: TabId = linkVideo ? "tag" : isMode(modo) ? mainOf(modo) : state.events.some((e) => e.match_id === id) ? "analysis" : "tag";
  const tab: TabId = picked && (!isMode(modo) || modeOf(picked) === modo) ? picked : fallback;
  // The sidebar's Captura / Estudio / Análisis go to the last match opened.
  useEffect(() => {
    if (id) setPref("currentMatch", id);
  }, [id]);
  // The URL says the mode being shown, so the sidebar marks it.
  const shownMode = modeOf(tab);
  useEffect(() => {
    if (!id || linkVideo || linkEdit || modo === shownMode) return;
    router.replace(`/partido?id=${encodeURIComponent(id)}&modo=${shownMode}`, { scroll: false });
  }, [id, modo, shownMode, linkVideo, linkEdit, router]);
  // Time to go to as soon as the player knows the length of the video (it cannot seek before).
  const pendingSeek = useRef<number | null>(linkVideo && Number.isFinite(linkT) && linkT >= 0 ? linkT : null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [, bump] = useState(0);
  const [videoSel, setVideoSel] = useState(linkVideo ?? "");
  const [ytDraft, setYtDraft] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  // Over the video and right under its controls: the tagging tab draws its live tags and its timeline there.
  const [overlaySlot, setOverlaySlot] = useState<HTMLDivElement | null>(null);
  const [belowSlot, setBelowSlot] = useState<HTMLDivElement | null>(null);
  // While tagging, playback jumps over pauses and over what is outside the marked stretches.
  const skipPauses = usePref("skipPauses", "on") === "on";
  // What is in the folder of the match, for the state of each step; read again when the tab changes.
  const [folderFiles, setFolderFiles] = useState<FolderFiles | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const stopAt = useRef<number | null>(null);
  // Tramos fits the window (no page scroll): the video as large as fits above its controls and timeline, the side
  // panel as wide as dragged and only the list of marks scrolling inside it.
  const fitOn = tab === "segments" || tab === "tag" || tab === "plays";
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitH, setFitH] = useState<number | null>(null);
  const [underEl, setUnderEl] = useState<HTMLDivElement | null>(null);
  const [underH, setUnderH] = useState(0);
  // Jugadas starts wider: its panel holds the pitch animation.
  const sideDefault = tab === "plays" ? 480 : SEG_SIDE_DEFAULT;
  const segSideW = Math.min(SEG_SIDE_MAX, Math.max(SEG_SIDE_MIN, Number(usePref(`${tab}:sideW`, String(sideDefault))) || sideDefault));
  useEffect(() => {
    // Off Tramos the height is not used.
    if (!fitOn) return;
    const measure = () => {
      const el = fitRef.current;
      if (!el || window.innerWidth < 1280) return setFitH(null);
      setFitH(Math.max(420, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 16)));
    };
    const raf = requestAnimationFrame(measure);
    const late = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener("resize", measure);
    };
  }, [fitOn]);
  useEffect(() => {
    if (!underEl) return;
    const ro = new ResizeObserver(([e]) => setUnderH(Math.round(e.contentRect.height)));
    ro.observe(underEl);
    return () => ro.disconnect();
  }, [underEl]);
  // In Jugadas the panel ends where the video and its controls end: both columns share one height.
  const [videoColEl, setVideoColEl] = useState<HTMLDivElement | null>(null);
  const [videoColH, setVideoColH] = useState(0);
  useEffect(() => {
    if (!videoColEl) return;
    const ro = new ResizeObserver(([e]) => setVideoColH(Math.round(e.contentRect.height)));
    ro.observe(videoColEl);
    return () => ro.disconnect();
  }, [videoColEl]);
  const dragSegSide = (e: React.PointerEvent<HTMLElement>) => {
    const x0 = e.clientX;
    const w0 = segSideW;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const key = `${tab}:sideW`;
    const move = (ev: PointerEvent) => setPref(key, String(Math.round(Math.min(SEG_SIDE_MAX, Math.max(SEG_SIDE_MIN, w0 - (ev.clientX - x0))))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const match = state.matches.find((m) => m.match_id === id);
  const folderForSteps = match?.folder;
  useEffect(() => {
    if (!folderForSteps) return;
    let live = true;
    void readFolderFiles(folderForSteps).then((files) => {
      if (live) setFolderFiles(files);
    });
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
  // The match data written into match.yaml by themselves (components/match/FolderSync.tsx).
  const yamlSync = useYamlSync(match, match?.venue_id ? allVenues(state.venues).find((v) => v.venue_id === match.venue_id) : undefined);

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
    boards: (state.boards ?? []).length,
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
      <EdgeReveal edge="top" enabled={focus} className="bg-bg/95 px-4 pt-3 backdrop-blur md:px-8">
      <MatchHeader
        match={match}
        events={allEvents}
        tab={tab}
        onTab={setTab}
        steps={steps}
        status={<SaveStatus match={match} />}
        video={
          videos.length > 1 ? (
            <Select
              variant="field"
              label="Video del partido"
              value={video.video_id}
              onChange={(v) => v && pickVideo(v)}
              options={videos.map((v, i) => {
                // Grouped by half: a title where the half changes (as in the match data, the first video is the 1st).
                const half = (j: number) => videos[j].period ?? (j === 0 ? 1 : 2);
                return { value: v.video_id, label: v.label || v.video_id, hint: v.video_id, group: i === 0 || half(i) !== half(i - 1) ? (half(i) === 1 ? "1.er tiempo" : "2.º tiempo") : undefined };
              })}
              display={
                <span className="inline-flex items-center gap-2">
                  <FilmStrip size={15} className="text-faint" />
                  <span className="max-w-[12rem] truncate text-ink">{video.label || video.video_id}</span>
                  <span className="tc rounded bg-raised px-1.5 text-[10px] text-faint uppercase">{video.video_id}</span>
                </span>
              }
            />
          ) : null
        }
      >
        {match.is_demo && <DemoBadge />}
        <Dropdown label="Datos del partido y del video" trigger={<GearSix size={16} />} panelClass="w-[min(30rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto">
          {(closeMenu) => {
            // One row of the panel: an icon and a short label on the left, the control on the right.
            const row = (icon: React.ReactNode, label: string, control: React.ReactNode, hint?: string) => (
              <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3" title={hint}>
                <span className="flex items-center gap-2 text-faint">
                  {icon}
                  {label}
                </span>
                {control}
              </div>
            );
            const folderOk = match.folder ? isFolderName(match.folder) : null;
            const ytOk = video.youtube_id !== "" && (ytDraft === null || parseYouTubeId(ytDraft) !== null);
            const ytBad = ytDraft !== null && ytDraft.trim() !== "" && !parseYouTubeId(ytDraft);
            const hasFile = fileUrls.has(fileKey);
            const half = video.period ?? (videoIndex === 0 ? 1 : 2);
            return (
              <div className="text-xs text-muted">
                {/* The match: its name as the title, then the two teams face to face. */}
                <section className="p-4">
                  <div className="flex items-start gap-2">
                    <input
                      className="font-display min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 -ml-2 text-xl text-ink hover:bg-bg/60 focus:bg-bg/60 focus:outline-none"
                      aria-label="Nombre del partido"
                      value={match.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <span className="tag">{allEvents.length} eventos</span>
                    <span className="tag">{allPlays.length} jugadas</span>
                    <span className="tag">
                      {videos.length} video{videos.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                    {(
                      [
                        ["focus_team", "Analizado", "bg-own"],
                        ["other_team", "Contrario", "bg-opp"],
                      ] as const
                    ).map(([field, label, dot], n) => (
                      <div key={field} className={`flex min-w-0 items-center gap-2 rounded-xl bg-bg/60 px-3 py-2 ${n === 1 ? "order-3" : ""}`}>
                        <i className={`h-7 w-1 shrink-0 rounded-full ${dot}`} aria-hidden />
                        <label className="min-w-0 flex-1">
                          <span className="block text-[10px] tracking-wide text-faint uppercase">{label}</span>
                          <input
                            className="cond w-full bg-transparent text-sm font-bold text-ink uppercase focus:outline-none"
                            value={match[field]}
                            onChange={(e) => patch({ [field]: e.target.value })}
                          />
                        </label>
                      </div>
                    ))}
                    <span className="cond order-2 text-[11px] font-bold text-faint">VS</span>
                  </div>
                  <div className="mt-4 space-y-2.5">
                    {row(<CalendarBlank size={14} />, "Fecha", <input className={`${input} w-full`} type="date" value={match.date} onChange={(e) => patch({ date: e.target.value })} />)}
                    {row(
                      <MapPin size={14} />,
                      "Sede",
                      <span className="flex min-w-0 gap-1.5">
                        <Select
                          variant="field"
                          label="Sede del partido"
                          className="min-w-0 flex-1 justify-between"
                          clearable
                          placeholder="Sin sede"
                          value={match.venue_id ?? null}
                          onChange={(v) => patch({ venue_id: v ?? undefined })}
                          options={allVenues(state.venues).map((v) => ({ value: v.venue_id, label: `${v.name} · ${v.length_m} × ${v.width_m} m` }))}
                        />
                        <Link
                          href="/configuracion"
                          className="btn h-9 w-9 shrink-0 !p-0"
                          title="Añadir o editar sedes (Configuración › Sedes)"
                          aria-label="Añadir sede"
                          onClick={() => setPref("config:tab", "venues")}
                        >
                          <Plus size={14} />
                        </Link>
                      </span>,
                      "La sede da las medidas y los puntos para calibrar",
                    )}
                    {row(
                      <Folder size={14} />,
                      "Carpeta",
                      <span className="relative flex min-w-0">
                        <input
                          className={`${input} tc w-full pr-8 text-xs`}
                          placeholder="aaaa_mm_dd_local_vs_visita"
                          value={match.folder ?? ""}
                          onChange={(e) => patch({ folder: e.target.value.trim() || undefined })}
                        />
                        {folderOk !== null && (
                          <span className={`absolute top-1/2 right-2.5 -translate-y-1/2 ${folderOk ? "text-ok" : "text-warn"}`} title={folderOk ? "Sigue la convención" : `No sigue la convención ${FOLDER_RULE}`}>
                            {folderOk ? <CheckCircle size={15} weight="fill" /> : <WarningCircle size={15} weight="fill" />}
                          </span>
                        )}
                      </span>,
                      "matches/<carpeta> en el repositorio: ahí viven el video, los tramos y el tracking",
                    )}
                    <FolderTools match={match} sync={yamlSync} />
                  </div>
                </section>

                <ShootoutPanel match={match} events={allEvents} />

                {/* The videos: one pill each (choosing one opens it), then the data of the one open. */}
                <section className="border-t border-line p-4" title="Cada video tiene sus propios tiempos, tramos, eventos y jugadas; Análisis e Informe los juntan">
                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <h3 className="cond mr-1 text-sm font-bold tracking-wide text-ink uppercase">Videos</h3>
                    {videos.map((v) => (
                      <button
                        key={v.video_id}
                        type="button"
                        aria-pressed={v.video_id === video.video_id}
                        onClick={() => pickVideo(v.video_id)}
                        className={`tc rounded-full px-2.5 py-1 text-[11px] uppercase transition-colors ${
                          v.video_id === video.video_id ? "bg-own text-[var(--on-own)]" : "bg-bg/60 text-ink-2 hover:bg-raised"
                        }`}
                      >
                        {v.video_id}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="grid h-6 w-6 place-items-center rounded-full bg-bg/60 text-faint transition-colors hover:bg-raised hover:text-ink"
                      title="Añadir otro video al partido (por ejemplo, uno por tiempo)"
                      aria-label="Añadir otro video al partido"
                      onClick={() => {
                        const v = nextVideo(videos);
                        setVideos([...videos, v]);
                        pickVideo(v.video_id);
                      }}
                    >
                      <Plus size={12} />
                    </button>
                    {videoIndex > 0 && usedBy(video.video_id) === 0 && (
                      <button
                        type="button"
                        className="ml-auto inline-flex items-center gap-1 text-faint transition-colors hover:text-danger"
                        title="Solo se puede quitar un video sin eventos, jugadas ni tramos"
                        onClick={() => {
                          setVideos(videos.filter((v) => v.video_id !== video.video_id));
                          pickVideo(videos[0].video_id);
                        }}
                      >
                        <Trash size={12} />
                        Quitar
                      </button>
                    )}
                  </div>
                  <div className="space-y-2.5">
                    {row(
                      <FilmStrip size={14} />,
                      "Nombre",
                      <span className="flex min-w-0 gap-1.5">
                        <input className={`${input} min-w-0 flex-1`} aria-label="Nombre de este video" placeholder={video.video_id} value={video.label} onChange={(e) => patchVideo({ label: e.target.value })} />
                        <span className="seg shrink-0" role="group" aria-label="Tiempo del partido de este video" title="A qué tiempo pertenece: los eventos de este video lo toman de aquí">
                          {([1, 2] as const).map((p) => (
                            <button key={p} type="button" aria-pressed={half === p} className="seg-opt tc !px-2.5" onClick={() => patchVideo({ period: p })}>
                              {p}T
                            </button>
                          ))}
                        </span>
                      </span>,
                    )}
                    {row(
                      <YoutubeLogo size={14} />,
                      "YouTube",
                      <span className="relative flex min-w-0">
                        <input
                          className={`${input} w-full pr-8`}
                          placeholder="https://youtube.com/…"
                          value={ytInput}
                          onChange={(e) => {
                            setYtDraft(e.target.value);
                            const parsed = parseYouTubeId(e.target.value);
                            if (parsed || e.target.value.trim() === "") patchVideo({ youtube_id: parsed });
                          }}
                        />
                        {(ytOk || ytBad) && (
                          <span className={`absolute top-1/2 right-2.5 -translate-y-1/2 ${ytBad ? "text-danger" : "text-ok"}`} title={ytBad ? "No reconozco ese enlace: pega la URL completa" : "Enlace reconocido"}>
                            {ytBad ? <WarningCircle size={15} weight="fill" /> : <CheckCircle size={15} weight="fill" />}
                          </span>
                        )}
                      </span>,
                    )}
                    {row(
                      <FolderOpen size={14} />,
                      "Archivo",
                      <span className="flex min-w-0 items-center gap-2 rounded-lg bg-bg/60 py-1 pr-1 pl-3">
                        <i className={`h-2 w-2 shrink-0 rounded-full ${hasFile ? "bg-ok" : "bg-line-strong"}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-ink-2">{hasFile ? "Abierto en esta computadora" : "Sin archivo local"}</span>
                        {hasFile && (
                          <button
                            type="button"
                            className="rounded-md px-2 py-1 text-faint transition-colors hover:text-ink"
                            onClick={() => {
                              const old = fileUrls.get(fileKey) as string;
                              if (old.startsWith("blob:")) URL.revokeObjectURL(old);
                              fileUrls.delete(fileKey);
                              bump((n) => n + 1);
                            }}
                          >
                            Quitar
                          </button>
                        )}
                        <label className="btn relative cursor-pointer !px-2.5 !py-1 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-400">
                          {hasFile ? "Cambiar" : "Abrir"}
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
                      </span>,
                      "El video original completo (sin recortar), para que los tiempos coincidan con YouTube. No se sube a ningún lado.",
                    )}
                  </div>
                </section>

                {/* Technical settings and the evaluation tools: out of the steps of the analysis, one click from the gear. */}
                <section className="flex flex-wrap items-center gap-2 border-t border-line p-4">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      closeMenu();
                      setTechOpen(true);
                    }}
                    title="Parámetros con los que se calcula la posesión de este partido (y, con ella, el informe)"
                  >
                    <SlidersHorizontal size={14} />
                    Detalles técnicos
                    {techChanged(match).length > 0 && <span className="tag tag-accent">{techChanged(match).length} cambiados</span>}
                  </button>
                  <Link href={`/partido/playground?id=${encodeURIComponent(match.match_id)}`} className="btn btn-ghost text-faint" title="Comprobar el balón, la posesión, los pases y los eventos detectados">
                    <Flask size={14} />
                    Herramientas de evaluación
                  </Link>
                </section>
              </div>
            );
          }}
        </Dropdown>
      </MatchHeader>
      {techOpen && (
        <Modal title="Detalles técnicos" wide onClose={() => setTechOpen(false)}>
          <TechPanel match={match} />
        </Modal>
      )}
      </EdgeReveal>

      {/* The video takes the room; the working panel keeps a fixed, narrower width (wider for the pitch animation). */}
      <div
        ref={fitRef}
        className={
          !withVideo
            ? ""
            : fitOn
                ? "grid gap-6 xl:-mb-12 xl:grid-cols-[minmax(0,1fr)_var(--side-w)]"
                : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]"
        }
        style={fitOn ? ({ "--side-w": `${segSideW}px` } as React.CSSProperties) : undefined}
      >
        {/* The player stays mounted on every tab so the video keeps its position. */}
        <div ref={setVideoColEl} className={withVideo ? "space-y-3 xl:sticky xl:top-4 xl:self-start" : "hidden"}>
          {/* The width is capped by the height of the window, so the video and its controls always fit on screen. */}
          <div
            className="relative mx-auto w-full xl:max-w-[calc((100vh-15rem)*16/9)]"
            style={fitOn && fitH ? { maxWidth: Math.max(320, Math.floor((fitH - underH - 12) * (16 / 9))) } : undefined}
          >
            <div ref={setOverlaySlot} className={tab === "tag" ? "pointer-events-none absolute inset-0 z-10" : "hidden"} />
            <VideoPlayer key={video.video_id} ref={playerRef} youtubeId={video.youtube_id || undefined} fileUrl={fileUrls.get(fileKey)} onTime={onTime} onPlayState={setPlaying} />
          </div>
          <div ref={setUnderEl} className="space-y-3">
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
          <div ref={setBelowSlot} className={tab === "tag" || tab === "segments" || tab === "plays" ? "" : "hidden"} />
          </div>
        </div>

        <div className={fitOn ? "relative min-h-0 min-w-0" : "min-w-0"} style={fitOn && fitH ? { height: tab === "plays" && videoColH > 0 ? Math.min(fitH, videoColH) : fitH } : undefined}>
          {fitOn && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Ancho del panel (arrastra; doble clic: el de siempre)"
              title="Arrastra para cambiar el ancho del panel · doble clic: el de siempre"
              className="group absolute top-0 -left-4 hidden h-full w-2 cursor-col-resize touch-none xl:block"
              onPointerDown={dragSegSide}
              onDoubleClick={() => setPref(`${tab}:sideW`, String(sideDefault))}
            >
              <span className="mx-auto block h-full w-px rounded-full transition-colors group-hover:bg-line-strong" />
            </div>
          )}
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
              duration={duration}
              playerRef={playerRef}
              belowSlot={belowSlot}
            />
          )}
          {tab === "plays" && (
            <PlaysTab
              key={video.video_id}
              match={match}
              videoId={video.video_id}
              plays={plays}
              time={time}
              duration={duration}
              playerRef={playerRef}
              playClip={playClip}
              belowSlot={belowSlot}
            />
          )}
          {tab === "analysis" && (
            <AnalysisTab
              match={match}
              events={timeline.events}
              segments={timeline.segments}
              videoIds={videos.map((v) => v.video_id)}
              videoEvents={allEvents}
              segmentsByVideo={segmentsByVideo}
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

      {(tab === "calibration" || tab === "tracking" || tab === "ball") &&
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
            {tab === "calibration" ? (
          <Calibration
            key={`${match.folder}|${video.video_id}`}
            embedded
            folder={match.folder}
            video={video.video_id}
            venue={match.venue_id}
            teams={{ own: match.focus_team, opp: match.other_team }}
          />
        ) : (
          <Correction
            key={`${match.folder}|${video.video_id}`}
            embedded
            folder={match.folder}
            video={video.video_id}
            matchAppId={match.match_id}
            step={tab === "ball" ? "ball" : "players"}
          />
            )}
          </>
        ))}

      {tab === "board" && <BoardsWorkspace embedded />}

      {/* Full width, under both columns: the events table of the tagging tab is drawn here. */}

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
