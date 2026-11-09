"use client";

import { COLORS } from "@/components/Pitch";
import { fmtT } from "@/lib/format";
import type { Segment } from "@/lib/segments";
import { EVENT_LABELS, type MatchEvent } from "@/lib/types";

// The whole video on one bar under the player: pauses shaded, one mark per event (colour = team), the playhead.
// A click on a mark goes to that event; a click anywhere else goes to that moment.
export function VideoTimeline({
  events,
  segments,
  time,
  duration,
  selected,
  onSeek,
  onPick,
}: {
  events: MatchEvent[];
  segments: Segment[];
  time: number;
  // Length of the video when known; otherwise the bar ends a little after the last thing it shows.
  duration?: number;
  selected?: string | null;
  onSeek: (t: number) => void;
  onPick?: (e: MatchEvent) => void;
}) {
  const end = Math.max(duration ?? 0, time + 30, ...events.map((e) => e.t_video + 30), ...segments.map((s) => (s.end ?? s.start) + 10), 60);
  const pct = (t: number) => `${(t / end) * 100}%`;
  return (
    <div className="select-none">
      <div
        className="relative h-9 cursor-pointer overflow-hidden rounded-xl bg-bg/70"
        role="presentation"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * end);
        }}
      >
        {segments
          .filter((s) => s.tipo !== "juego")
          .map((s) => (
            <span
              key={s.segment_id}
              title={s.tipo === "pausa" ? "Pausa" : "No medible"}
              className="absolute top-0 bottom-0 bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--color-line)_3px_4px)]"
              style={{ left: pct(s.start), width: pct((s.end ?? end) - s.start) }}
            />
          ))}
        {events.map((e) => (
          <button
            key={e.event_id}
            type="button"
            title={`${EVENT_LABELS[e.type]} · ${fmtT(e.t_video)}`}
            aria-label={`${EVENT_LABELS[e.type]} en ${fmtT(e.t_video)}`}
            onClick={(ev) => {
              ev.stopPropagation();
              if (onPick) onPick(e);
              else onSeek(Math.max(0, e.t_video - 1));
            }}
            className={`absolute top-1.5 bottom-1.5 w-[3px] -translate-x-1/2 rounded-full transition-[top,bottom,width] before:absolute before:-inset-x-1.5 before:-inset-y-1 hover:top-0.5 hover:bottom-0.5 hover:w-[5px] ${
              e.event_id === selected ? "top-0.5 bottom-0.5 w-[5px] outline-2 outline-white" : ""
            }`}
            style={{ left: pct(e.t_video), background: e.team === "own" ? COLORS.own : e.team === "opp" ? COLORS.opp : "var(--color-faint)" }}
          />
        ))}
        <span className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-accent-200" style={{ left: pct(time) }} />
      </div>
      <div className="tc mt-1 flex justify-between text-[10px] text-faint">
        <span>0:00</span>
        <span>{fmtT(end)}</span>
      </div>
    </div>
  );
}
