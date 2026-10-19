"use client";

import { SoccerBallIcon } from "@phosphor-icons/react";

// What shows while a part of the tracking (a large file) and its video open: the pitch lines draw themselves and a ball
// bounces over an indeterminate bar. `overlay` puts it over a video that is still loading.
export function LoadingStage({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        overlay
          ? "absolute inset-0 z-10 grid place-items-center bg-black/80"
          : "enter relative grid aspect-video w-full place-items-center overflow-hidden rounded-2xl bg-surface xl:max-h-[calc(100vh-12rem)]"
      }
    >
      <svg viewBox="0 0 105 68" className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.10]" preserveAspectRatio="xMidYMid meet" aria-hidden>
        <g fill="none" stroke="var(--color-ink)" strokeWidth={0.35} className="draw-in">
          <rect x={2} y={2} width={101} height={64} pathLength={1} />
          <line x1={52.5} y1={2} x2={52.5} y2={66} pathLength={1} />
          <circle cx={52.5} cy={34} r={9.15} pathLength={1} />
          <rect x={2} y={13.84} width={16.5} height={40.32} pathLength={1} />
          <rect x={86.5} y={13.84} width={16.5} height={40.32} pathLength={1} />
          <rect x={2} y={24.84} width={5.5} height={18.32} pathLength={1} />
          <rect x={97.5} y={24.84} width={5.5} height={18.32} pathLength={1} />
        </g>
      </svg>
      <div className="relative flex flex-col items-center">
        <div className="relative h-16 w-12">
          <span className="loader-ball absolute inset-x-0 top-0 grid place-items-center text-ink">
            <SoccerBallIcon size={34} weight="fill" />
          </span>
          <span className="loader-shadow absolute bottom-0 left-1/2 h-1.5 w-8 -translate-x-1/2 rounded-full bg-ink/25" />
        </div>
        <div className="cond mt-3 text-sm font-bold tracking-wide text-ink-2 uppercase">{label}</div>
        <div className="mt-3 h-1 w-44 overflow-hidden rounded-full bg-line">
          <span className="loader-bar block h-full w-1/3 rounded-full bg-own" />
        </div>
      </div>
    </div>
  );
}
