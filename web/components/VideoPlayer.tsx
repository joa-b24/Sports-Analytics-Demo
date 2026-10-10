"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { fmtT } from "@/lib/format";

export type PlayerHandle = {
  getTime(): number;
  seek(t: number, play?: boolean): void;
  play(): void;
  pause(): void;
};

type YTPlayer = {
  getCurrentTime(): number;
  seekTo(t: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
};
type YTApi = { Player: new (el: HTMLElement, opts: unknown) => YTPlayer };

declare global {
  interface Window {
    YT?: YTApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytPromise: Promise<YTApi> | null = null;
function loadYT(): Promise<YTApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytPromise) {
    ytPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT as YTApi);
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
  }
  return ytPromise;
}

type Props = {
  ref?: Ref<PlayerHandle>;
  youtubeId?: string;
  fileUrl?: string;
  onTime?: (t: number) => void;
  // Length of the manual clock used when there is no video source.
  virtualMax?: number;
};

// One time source for the whole match page. Three backends, same t_video:
// a local copy of the original video, the YouTube embed, or a manual clock.
export function VideoPlayer({ ref, youtubeId, fileUrl, onTime, virtualMax = 6600 }: Props) {
  const mode = fileUrl ? "file" : youtubeId ? "youtube" : "virtual";
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytHost = useRef<HTMLDivElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const vt = useRef(0);
  const [vtShown, setVtShown] = useState(0);
  const [vPlaying, setVPlaying] = useState(false);
  const modeRef = useRef(mode);
  const onTimeRef = useRef(onTime);
  useEffect(() => {
    modeRef.current = mode;
    onTimeRef.current = onTime;
  });

  const getTime = () => {
    if (modeRef.current === "file") return videoRef.current?.currentTime ?? 0;
    if (modeRef.current === "youtube") return yt.current?.getCurrentTime?.() ?? 0;
    return vt.current;
  };

  useImperativeHandle(ref, () => ({
    getTime,
    seek(t, play) {
      const m = modeRef.current;
      if (m === "file" && videoRef.current) {
        videoRef.current.currentTime = t;
        if (play) void videoRef.current.play();
      } else if (m === "youtube" && yt.current) {
        yt.current.seekTo(t, true);
        if (play) yt.current.playVideo();
      } else if (m === "virtual") {
        vt.current = t;
        setVtShown(t);
        if (play) setVPlaying(true);
      }
    },
    play() {
      const m = modeRef.current;
      if (m === "file") void videoRef.current?.play();
      else if (m === "youtube") yt.current?.playVideo();
      else setVPlaying(true);
    },
    pause() {
      const m = modeRef.current;
      if (m === "file") videoRef.current?.pause();
      else if (m === "youtube") yt.current?.pauseVideo();
      else setVPlaying(false);
    },
  }));

  useEffect(() => {
    if (mode !== "youtube" || !youtubeId || !ytHost.current) return;
    const host = ytHost.current;
    let cancelled = false;
    let player: YTPlayer | null = null;
    // The API replaces the element it is given, so it gets its own node outside React's tree.
    const el = document.createElement("div");
    host.appendChild(el);
    void loadYT().then((YT) => {
      if (cancelled) return;
      player = new YT.Player(el, {
        videoId: youtubeId,
        width: "100%",
        height: "100%",
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            yt.current = player;
          },
        },
      });
    });
    return () => {
      cancelled = true;
      yt.current = null;
      try {
        player?.destroy();
      } catch {
        // Player was never ready.
      }
      host.innerHTML = "";
    };
  }, [mode, youtubeId]);

  useEffect(() => {
    const id = setInterval(() => {
      if (modeRef.current === "virtual" && vPlaying) {
        vt.current = Math.min(virtualMax, vt.current + 0.1);
        setVtShown(vt.current);
      }
      onTimeRef.current?.(getTime());
    }, 100);
    return () => clearInterval(id);
  }, [vPlaying, virtualMax]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-black">
      <div className="aspect-video w-full">
        {mode === "file" && <video ref={videoRef} src={fileUrl} controls className="h-full w-full" />}
        {mode === "youtube" && <div ref={ytHost} className="h-full w-full [&>iframe]:h-full [&>iframe]:w-full" />}
        {mode === "virtual" && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-slate-800 px-6 text-center text-slate-200">
            <div className="text-sm">Sin video conectado. Pega el enlace de YouTube o abre el archivo local arriba.</div>
            <div className="text-xs text-slate-400">Mientras tanto, este reloj manual hace de tiempo del video.</div>
            <div className="font-mono text-2xl tabular-nums">{fmtT(vtShown)}</div>
            <div className="flex w-full max-w-md items-center gap-3">
              <button
                type="button"
                onClick={() => setVPlaying((p) => !p)}
                className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-900"
              >
                {vPlaying ? "Pausa" : "Reproducir"}
              </button>
              <input
                type="range"
                min={0}
                max={virtualMax}
                step={0.5}
                value={vtShown}
                aria-label="Tiempo del video"
                onChange={(e) => {
                  vt.current = Number(e.target.value);
                  setVtShown(vt.current);
                }}
                className="flex-1"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
