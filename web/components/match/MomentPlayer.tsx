"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SpeedControl } from "@/components/SpeedControl";
import { VideoPlayer, type PlayerHandle } from "@/components/VideoPlayer";
import { fmtT } from "@/lib/format";
import { localVideo } from "@/lib/local";
import { momentHref, momentStart, type Moment } from "@/lib/moments";
import { loopSeek, loopWindow } from "@/lib/playgroundPossession";
import { setPref, usePref } from "@/lib/store";
import type { Match } from "@/lib/types";
import { matchVideos } from "@/lib/videos";

// A player under a panel that plays one moment of the match: the panel calls show(moment) when something in it is
// clicked (a shot, a goal, a loss), and renders `panel` below its content. It works with several videos per match
// (each moment says its video_id) and with YouTube or a local file, like the video of the match page.
// With `moment.t_end` the panel also offers a loop over [t, t_end] (margin before and after, speed); `bare` leaves out the
// header and the frame so that a resizable column can hold the player.
export function useMomentPlayer(match: Match, opts: { bare?: boolean } = {}): { show: (m: Moment) => void; active: Moment | null; panel: ReactNode } {
  const [moment, setMoment] = useState<Moment | null>(null);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const panel = moment ? (
    <MomentPanel match={match} moment={moment} onClose={() => setMoment(null)} loop={loop} onLoop={setLoop} rate={rate} onRate={setRate} bare={opts.bare} />
  ) : null;
  return { show: setMoment, active: moment, panel };
}

const MARGIN_KEY = "playground:loopMargin";

// Local files already looked up in this session, by folder and video.
const urlCache = new Map<string, string | null>();

function MomentPanel({
  match, moment, onClose, loop, onLoop, rate, onRate, bare,
}: {
  match: Match;
  moment: Moment;
  onClose: () => void;
  loop: boolean;
  onLoop: (v: boolean) => void;
  rate: number;
  onRate: (r: number) => void;
  bare?: boolean;
}) {
  const margin = Number(usePref(MARGIN_KEY, "1")) || 0;
  const stretch = moment.t_end !== undefined && moment.t_end > moment.t ? moment.t_end : null;
  const video = matchVideos(match).find((v) => v.video_id === moment.video_id);
  const folder = match.folder;
  const key = `${folder}|${moment.video_id}`;
  const [file, setFile] = useState<{ key: string; url: string | null } | null>(() => (urlCache.has(key) ? { key, url: urlCache.get(key) ?? null } : null));
  useEffect(() => {
    if (!folder || urlCache.has(key)) return;
    let live = true;
    void localVideo(folder, moment.video_id).then((url) => {
      urlCache.set(key, url);
      if (live) setFile({ key, url });
    });
    return () => {
      live = false;
    };
  }, [folder, key, moment.video_id]);
  const lookedUp = !folder || urlCache.has(key);
  const url = urlCache.get(key) ?? (file?.key === key ? file.url : null);
  const youtubeId = video?.youtube_id || undefined;
  // The local file wins; YouTube only once the folder has been looked at, so that it is not loaded for nothing.
  const source = url ? "file" : lookedUp && youtubeId ? "youtube" : null;

  // Goes to the moment once the player knows the video (YouTube loads late): tries for a few seconds.
  const player = useRef<PlayerHandle>(null);
  useEffect(() => {
    if (!source) return;
    let tries = 0;
    const id = setInterval(() => {
      const h = player.current;
      if (h && h.getDuration() > 0) {
        const win = loop && stretch !== null ? loopWindow(moment.t, stretch, margin, h.getDuration()) : null;
        h.seek(win ? win.start : momentStart(moment.t), true);
        h.setRate(source === "youtube" ? Math.round(rate * 4) / 4 || 0.25 : rate);
        clearInterval(id);
      } else if (++tries > 60) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- going to a moment must not restart when the loop or the speed change
  }, [source, url, moment.video_id, moment.t]);

  // The speed chosen applies at once, whatever the backend.
  useEffect(() => {
    player.current?.setRate(source === "youtube" ? Math.round(rate * 4) / 4 || 0.25 : rate);
  }, [rate, source]);

  // The loop: back to the start of [t - margin, t_end + margin] when the end is reached; turning it on goes there.
  const loopRef = useRef({ loop, stretch, margin, t: moment.t });
  useEffect(() => {
    loopRef.current = { loop, stretch, margin, t: moment.t };
  });
  useEffect(() => {
    if (!source || !loop || stretch === null) return;
    const first = player.current;
    if (first && first.getDuration() > 0) {
      const w = loopWindow(moment.t, stretch, margin, first.getDuration());
      if (w) first.seek(w.start, true);
    }
    const id = setInterval(() => {
      const h = player.current;
      const c = loopRef.current;
      if (!h || !c.loop || c.stretch === null || h.getDuration() <= 0) return;
      const w = loopWindow(c.t, c.stretch, c.margin, h.getDuration());
      const back = w ? loopSeek(h.getTime(), w) : null;
      if (back !== null) h.seek(back, true);
    }, 120);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restarts only when the loop is turned on or the stretch changes
  }, [source, loop, stretch, moment.t, moment.video_id]);

  const where = `${matchVideos(match).length > 1 ? `${video?.label ?? moment.video_id} · ` : ""}${fmtT(moment.t)}`;
  const loopBar = stretch !== null && (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={loop} onChange={(e) => onLoop(e.target.checked)} />
        Bucle
      </label>
      <label className="flex items-center gap-1.5" title="Segundos antes y después del intervalo">
        Margen
        <input
          type="number"
          className="input tc w-16"
          min={0}
          max={5}
          step={0.5}
          value={margin}
          aria-label="Margen del bucle en segundos"
          onChange={(e) => setPref(MARGIN_KEY, String(Math.min(5, Math.max(0, Number(e.target.value) || 0))))}
        />
        s
      </label>
      <SpeedControl rate={rate} onChange={onRate} step={0.25} min={0.25} max={2} />
    </div>
  );
  return (
    <div className={bare ? "" : "mt-4 border-t border-line-soft pt-3"} role="region" aria-label="Reproductor del momento" aria-live="polite">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm text-ink">{moment.label}</span>
        <span className="tc text-xs text-faint">{where}</span>
        <span className="flex-1" />
        <Link className="link text-xs" href={momentHref(match.match_id, moment)}>
          Abrir en el partido
        </Link>
        <button type="button" className="btn btn-ghost text-xs" onClick={onClose}>
          Cerrar
        </button>
      </div>
      {loopBar}
      {source ? (
        <div className={bare ? "" : "mx-auto max-w-2xl"}>
          <VideoPlayer key={`${moment.video_id}|${source}`} ref={player} fileUrl={url ?? undefined} youtubeId={url ? undefined : youtubeId} />
        </div>
      ) : !lookedUp ? (
        <p className="text-sm text-faint">Buscando el video…</p>
      ) : (
        <p className="text-sm text-pretty text-muted">
          El video de este momento no está conectado: ni enlace de YouTube ni archivo en la carpeta del partido. Conéctalo en el partido (
          {video?.label ?? moment.video_id}) para verlo aquí.
        </p>
      )}
    </div>
  );
}
