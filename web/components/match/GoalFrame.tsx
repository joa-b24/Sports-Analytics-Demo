"use client";

import { useRef } from "react";
import { GOAL } from "@/lib/types";

// The goal seen from the front, from where the shot is taken: y in meters from the left post, z the height.
// A margin around it takes shots that went wide or over.
const SIDE = 2.5;
const TOP = 1.6;

export interface GoalMark {
  id: string;
  y: number;
  z: number;
  color: string;
  // The one being edited: drawn bigger, with a ring.
  current?: boolean;
  title?: string;
}

export function GoalFrame({ marks, onPick, className = "" }: { marks: GoalMark[]; onPick?: (y: number, z: number) => void; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const W = GOAL.width;
  const H = GOAL.height;
  // SVG y grows downwards: z = H - svgY.
  const pick = (e: React.PointerEvent) => {
    const svg = ref.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm || !onPick) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    onPick(Math.round(Math.min(W + SIDE, Math.max(-SIDE, p.x)) * 100) / 100, Math.round(Math.min(H + TOP, Math.max(0, H - p.y)) * 100) / 100);
  };
  const thirds = [W / 3, (2 * W) / 3];
  return (
    <svg
      ref={ref}
      viewBox={`${-SIDE} ${-TOP} ${W + 2 * SIDE} ${H + TOP + 0.35}`}
      className={`w-full select-none ${onPick ? "cursor-crosshair" : ""} ${className}`}
      onPointerDown={pick}
      role={onPick ? "img" : undefined}
      aria-label="Portería vista de frente"
    >
      <rect x={-SIDE} y={-TOP} width={W + 2 * SIDE} height={H + TOP} fill="var(--color-bg)" opacity={0.5} />
      <line x1={-SIDE} y1={H} x2={W + SIDE} y2={H} stroke="var(--pitch-line)" strokeWidth={0.04} />
      {/* Net: thirds of the goal, to read "left / centre / right" and "low / high" at a glance. */}
      {thirds.map((y) => (
        <line key={y} x1={y} y1={0} x2={y} y2={H} stroke="var(--color-line)" strokeWidth={0.02} strokeDasharray="0.08 0.08" />
      ))}
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--color-line)" strokeWidth={0.02} strokeDasharray="0.08 0.08" />
      <path d={`M0 ${H} V0 H${W} V${H}`} fill="none" stroke="var(--pitch-line)" strokeWidth={0.12} strokeLinejoin="round" />
      {marks.map((m) => (
        <g key={m.id}>
          {m.title && <title>{m.title}</title>}
          {m.current && <circle cx={m.y} cy={H - m.z} r={0.3} fill="none" stroke="#ffffff" strokeWidth={0.05} />}
          <circle cx={m.y} cy={H - m.z} r={m.current ? 0.17 : 0.12} fill={m.color} opacity={m.current ? 1 : 0.55} />
        </g>
      ))}
      <text x={0} y={H + 0.3} fontSize={0.2} fill="var(--color-faint)">
        poste izquierdo
      </text>
      <text x={W} y={H + 0.3} fontSize={0.2} fill="var(--color-faint)" textAnchor="end">
        poste derecho
      </text>
    </svg>
  );
}
