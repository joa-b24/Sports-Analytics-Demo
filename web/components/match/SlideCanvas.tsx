"use client";

import { SLIDE_COLOR_VAR, type Slide, type SlideItem } from "@/lib/deck";

// The drawing surface of a slide: 16:9, the chart behind (if it has one) and its pieces over it. The pieces are SVG in a
// 1600 x 900 box that scales with the surface, so a thumbnail, the editor and the full screen show the same thing.
export const SLIDE_W = 1600;
export const SLIDE_H = 900;
const color = (name: string) => SLIDE_COLOR_VAR[name] ?? SLIDE_COLOR_VAR.ink;

export function ItemShape({ it, selected = false, handlers }: { it: SlideItem; selected?: boolean; handlers?: React.SVGProps<SVGGElement> }) {
  const c = color(it.color);
  const x = it.x * SLIDE_W;
  const y = it.y * SLIDE_H;
  const halo = selected ? { filter: "drop-shadow(0 0 6px var(--color-own))" } : undefined;
  if (it.kind === "text") {
    const size = (it.size ?? 0.06) * SLIDE_H;
    return (
      <g {...handlers} style={{ ...halo, cursor: handlers ? "move" : undefined }}>
        <text x={x} y={y + size * 0.85} fontSize={size} fontWeight={700} fill={c} stroke="var(--color-bg)" strokeWidth={size * 0.06} paintOrder="stroke" style={{ whiteSpace: "pre" }}>
          {it.text || "Texto"}
        </text>
      </g>
    );
  }
  if (it.kind === "rect") {
    const w = (it.w ?? 0.1) * SLIDE_W;
    const h = (it.h ?? 0.1) * SLIDE_H;
    return (
      <g {...handlers} style={{ ...halo, cursor: handlers ? "move" : undefined }}>
        <rect x={x} y={y} width={w} height={h} rx={6} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={5} />
      </g>
    );
  }
  if (it.kind === "ellipse") {
    const w = (it.w ?? 0.1) * SLIDE_W;
    const h = (it.h ?? 0.1) * SLIDE_H;
    return (
      <g {...handlers} style={{ ...halo, cursor: handlers ? "move" : undefined }}>
        <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={5} />
      </g>
    );
  }
  const x2 = (it.x2 ?? it.x) * SLIDE_W;
  const y2 = (it.y2 ?? it.y) * SLIDE_H;
  const ang = Math.atan2(y2 - y, x2 - x);
  const head = 34;
  const hx = (d: number) => x2 - head * Math.cos(ang + d);
  const hy = (d: number) => y2 - head * Math.sin(ang + d);
  return (
    <g {...handlers} style={{ ...halo, cursor: handlers ? "move" : undefined }}>
      {/* A wide invisible line makes the arrow easy to grab. */}
      <line x1={x} y1={y} x2={x2} y2={y2} stroke="transparent" strokeWidth={28} />
      <line x1={x} y1={y} x2={x2} y2={y2} stroke={c} strokeWidth={7} strokeLinecap="round" />
      <polygon points={`${x2},${y2} ${hx(0.45)},${hy(0.45)} ${hx(-0.45)},${hy(-0.45)}`} fill={c} />
    </g>
  );
}

export function SlideCanvas({ slide, className = "", children }: { slide: Slide; className?: string; children?: React.ReactNode }) {
  return (
    <div className={`relative aspect-video w-full overflow-hidden bg-surface ${className}`}>
      {slide.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={slide.image} alt={slide.title} className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      )}
      <svg viewBox={`0 0 ${SLIDE_W} ${SLIDE_H}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {(slide.items ?? []).map((it) => (
          <ItemShape key={it.id} it={it} />
        ))}
      </svg>
      {children}
    </div>
  );
}
