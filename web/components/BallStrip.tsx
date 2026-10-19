"use client";

import { ballCoverage } from "@/lib/parts";

// Where there is a ball to animate along a stretch of video: a band where its position is known (marked by hand,
// from a tagged event, or drawn straight between two of them), ticks at the marks and the playhead. Click to go there.

export interface BallSample {
  frame: number;
  source: string;
}

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
  className?: string;
}) {
  const span = Math.max(1, to - from);
  const pct = (f: number) => Math.min(100, Math.max(0, ((f - from) / span) * 100));
  const inside = points.filter((p) => p.frame >= from && p.frame <= to).sort((a, b) => a.frame - b.frame);
  // Runs of consecutive processed frames with a ball.
  const runs: [number, number][] = [];
  for (const p of inside) {
    const last = runs[runs.length - 1];
    if (last && p.frame - last[1] <= stride * 1.5) last[1] = p.frame;
    else runs.push([p.frame, p.frame]);
  }
  const outRuns: [number, number][] = [];
  for (const f of [...out].sort((x, y) => x - y)) {
    const a = Math.max(from, f - outHalf);
    const b = Math.min(to, f + outHalf);
    if (b <= a) continue;
    const last = outRuns[outRuns.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else outRuns.push([a, b]);
  }
  // The same measure as the status of the part: share of the time in play with a ball, and where it is missing.
  const cov = ballCoverage({ marks: inside.map((p) => p.frame), out, from, to, fps, stride, outHalf });
  const marks = inside.filter((p) => p.source !== "interpolated");
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between text-[11px] text-muted">
        <span className="text-ink-2">Balón</span>
        <span className="tc text-faint">
          con balón {Math.round(100 * cov.share)} % del juego{outRuns.length > 0 ? " (sin contar lo marcado como fuera)" : ""}
          {cov.missing.length > 0 && <span className="text-danger"> · faltan {cov.missing.length} tramo(s)</span>} ·{" "}
          {marks.filter((p) => p.source === "manual").length} marca(s) tuyas
          {marks.some((p) => p.source === "auto") && ` · ${marks.filter((p) => p.source === "auto").length} del tracker`}
          {marks.some((p) => p.source === "event") && ` · ${marks.filter((p) => p.source === "event").length} de eventos`}
        </span>
      </div>
      <div
        className="relative h-3 cursor-pointer overflow-hidden rounded-full bg-surface"
        role="presentation"
        title="Dónde hay balón para animar: banda = posición conocida o trazada entre dos marcas; rayas = marcas (clara: a mano, azul: del tracker de balón, ámbar: de un evento); rojo = en juego sin balón; gris = fuera o no se ve. Clic para ir."
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(Math.round(from + ((e.clientX - r.left) / r.width) * span));
        }}
      >
        {outRuns.map(([a, b]) => (
          <span key={`o${a}`} className="absolute inset-y-0 bg-faint/25" style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` }} title="Fuera de juego o no se ve" />
        ))}
        {cov.missing.map(([a, b]) => (
          <span key={`m${a}`} className="absolute inset-y-0 bg-danger/35" style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b) - pct(a)}%)` }} title="En juego y sin balón: faltan marcas" />
        ))}
        {runs.map(([a, b]) => (
          <span key={a} className="absolute inset-y-0.5 rounded-full bg-warn/45" style={{ left: `${pct(a)}%`, width: `max(2px, ${pct(b + stride) - pct(a)}%)` }} />
        ))}
        {marks.map((p) => (
          <span key={p.frame} className={`absolute inset-y-0 w-px ${p.source === "manual" ? "bg-ink" : p.source === "auto" ? "bg-accent-300" : "bg-warn"}`} style={{ left: `${pct(p.frame)}%` }} />
        ))}
        <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${pct(frame)}%` }} />
      </div>
    </div>
  );
}
