"use client";

import { Database, Lock, Path, Wrench, type Icon } from "@phosphor-icons/react";
import { revealRef } from "@/components/motion";

// Why something in the design proposal does not work yet. Every restricted element states one of these.
export type LockReason = "data" | "dev" | "tracking";

const REASONS: Record<LockReason, { label: string; icon: Icon }> = {
  data: { label: "Falta de datos", icon: Database },
  dev: { label: "Herramienta en desarrollo", icon: Wrench },
  tracking: { label: "Requiere tracking", icon: Path },
};

export function LockTag({ reason }: { reason: LockReason }) {
  const { label, icon: I } = REASONS[reason];
  return (
    <span className="tag tag-warn">
      <I size={12} />
      {label}
    </span>
  );
}

type Props = {
  reason: LockReason;
  title: string;
  // What is missing, in one or two sentences.
  why: React.ReactNode;
  // What has to happen for it to be enabled.
  need?: React.ReactNode;
  // Skeleton of the future element. It never shows numbers: there is no data behind it.
  children?: React.ReactNode;
  className?: string;
  delay?: number;
};

// A restricted element: visible so the staff knows it is planned, inert so nobody mistakes it for real data.
export function Locked({ reason, title, why, need, children, className = "", delay = 0 }: Props) {
  return (
    <section
      ref={revealRef}
      className={`locked-frame reveal relative overflow-hidden p-5 ${className}`}
      style={delay ? ({ "--d": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-warn-900 text-warn">
          <Lock size={15} weight="fill" />
        </span>
        <h2 className="text-base text-ink-2">{title}</h2>
        <LockTag reason={reason} />
      </div>
      <p className="mt-3 max-w-prose text-[13px] text-pretty text-muted">{why}</p>
      {need && (
        <p className="mt-1.5 max-w-prose text-[13px] text-pretty text-faint">
          <span className="text-ink-2">Para activarlo:</span> {need}
        </p>
      )}
      {children && (
        <div
          aria-hidden
          inert
          className="pointer-events-none mt-5 opacity-45 select-none [mask-image:linear-gradient(to_bottom,black_35%,transparent)]"
        >
          {children}
        </div>
      )}
    </section>
  );
}

// One-line version for a missing piece inside a screen that otherwise works.
export function LockedRow({ reason, title, why }: { reason: LockReason; title: string; why: React.ReactNode }) {
  return (
    <div className="locked-frame flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3">
      <Lock size={14} weight="fill" className="mt-1 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink-2">{title}</span>
          <LockTag reason={reason} />
        </div>
        <p className="mt-1 text-xs text-pretty text-muted">{why}</p>
      </div>
    </div>
  );
}

// Skeleton pieces for the previews.
export function SkBars({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[5rem_1fr] items-center gap-3">
          <span className="sk h-2.5" />
          <span className="sk sk-shimmer h-2.5" style={{ width: `${88 - ((i * 37) % 55)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function SkRadar({ size = 180 }: { size?: number }) {
  const ring = (r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      return `${(120 + r * Math.cos(a)).toFixed(1)},${(120 + r * Math.sin(a)).toFixed(1)}`;
    }).join(" ");
  return (
    <svg viewBox="0 0 240 240" width={size} height={size} className="mx-auto">
      {[30, 55, 80, 105].map((r) => (
        <polygon key={r} points={ring(r)} fill="none" stroke="var(--color-line-strong)" strokeWidth={1} />
      ))}
    </svg>
  );
}

export function SkTiles({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-2 rounded-2xl bg-surface/70 p-3">
          <span className="sk block h-2 w-16" />
          <span className="sk sk-shimmer block h-6 w-12" />
          <span className="sk block h-1 w-full" />
        </div>
      ))}
    </div>
  );
}
