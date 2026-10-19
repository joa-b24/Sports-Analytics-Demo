"use client";

import { ballCoverage } from "@/lib/parts";

// Where there is a ball to animate along a stretch of video, as colored stretches (no ticks):
//   green   known positions joined at the review step (marks, the tracker or events no further apart than one step)
//   yellow  a longer straight line between two positions (a long pass or a clearance drawn by hand, or a filled gap)
//   blue    the ball held still (k: a set piece while the taker gets ready)
//   gray    reviewed as out of play or not in sight
//   red     in play and without a ball: marks are missing
// Click to go there.

export interface BallSample {
  frame: number;
  source: string;
  x?: number;
  y?: number;
}

// A line between two positions less than this apart (m) is the ball held still.
const STILL_M = 0.5;

const LEGEND = [
  ["bg-ok", "Unido"],
  ["bg-warn", "Recta"],
  ["bg-accent", "Quieto"],
  ["bg-faint/60", "No se ve / fuera"],
  ["bg-danger", "Faltan marcas"],
] as const;

export function BallStrip({
  points,
  from,
  to,
  frame,
  stride,
  fps,
  onSeek,
  out = [],
  outHalf = 0,
  step,
  links = [],
  legend = true,
  className = "",
}: {
  points: BallSample[];
  from: number;
  to: number;
  frame: number;
  stride: number;
  fps: number;
  onSeek: (frame: number) => void;
  // Moments where the ball is out of play or not in sight (reviewed without a mark), each covering `outHalf` frames
  // to each side: they are not counted as missing.
  out?: number[];
  outHalf?: number;
  // The review step (frames): two positions at most this apart are "joined". Default: one second.
  step?: number;
  // Lines drawn by hand (and holds), from one mark to another.
  links?: { from: number; to: number }[];
  legend?: boolean;
  className?: string;
}) {
  const span = Math.max(1, to - from);
  const pct = (f: number) => Math.min(100, Math.max(0, ((f - from) / span) * 100));
  const inside = points.filter((p) => p.frame >= from && p.frame <= to).sort((a, b) => a.frame - b.frame);
  const known = inside.filter((p) => p.source !== "interpolated");
  const joinGap = (step ?? fps) * 1.5;
  const half = Math.max(stride / 2, (step ?? fps) / 2);

  const merge = (list: [number, number][]) => {
    const res: [number, number][] = [];
    for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
      const last = res[res.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else res.push([a, b]);
    }
    return res;
  };
  const green: [number, number][] = known.map((p) => [p.frame - half, p.frame + half]);
  const yellow: [number, number][] = [];
  const blue: [number, number][] = [];
  known.forEach((p, i) => {
    const n = known[i + 1];
    if (!n) return;
    const link = links.find((l) => l.from <= p.frame && n.frame <= l.to);
    if (link) {
      const still = p.x !== undefined && n.x !== undefined && Math.hypot(p.x - n.x, (p.y ?? 0) - (n.y ?? 0)) < STILL_M;
      (still ? blue : yellow).push([p.frame, n.frame]);
    } else if (n.frame - p.frame <= joinGap) green.push([p.frame, n.frame]);
    // Joined by the automatic fill (a gap longer than one step): an interpolation too.
    else if (inside.some((q) => q.source === "interpolated" && q.frame > p.frame && q.frame < n.frame)) yellow.push([p.frame, n.frame]);
  });
  const outRuns = merge(out.map((f) => [Math.max(from, f - outHalf), Math.min(to, f + outHalf)] as [number, number]).filter(([a, b]) => b > a));
  // The same measure as the status of the part: where the time in play is without a ball.
  const cov = ballCoverage({ marks: inside.map((p) => p.frame), out, from, to, fps, stride, outHalf });

  const band = (runs: [number, number][], cls: string, title: string, k: string) =>
    merge(runs).map(([a, b]) => (
      <span key={`${k}${a}`} className={`absolute inset-y-0 ${cls}`} style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b) - pct(a)}%)` }} title={title} />
    ));
  return (
    <div className={className}>
      {legend && (
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
          {LEGEND.map(([c, t]) => (
            <span key={t} className="inline-flex items-center gap-1">
              <i className={`h-2 w-2 rounded-full ${c}`} />
              {t}
            </span>
          ))}
        </div>
      )}
      <div
        className="relative h-3 cursor-pointer overflow-hidden rounded-full bg-line"
        role="presentation"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(Math.round(from + ((e.clientX - r.left) / r.width) * span));
        }}
      >
        {band(outRuns, "bg-faint/45", "No se ve o fuera de juego", "o")}
        {band(cov.missing, "bg-danger/70", "En juego y sin balón: faltan marcas", "m")}
        {band(green, "bg-ok/80", "Unido entre marcas", "g")}
        {band(yellow, "bg-warn/85", "Recta: pase largo, balón por alto o hueco rellenado", "y")}
        {band(blue, "bg-accent/85", "Balón quieto", "b")}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${pct(frame)}%` }} />
      </div>
    </div>
  );
}
