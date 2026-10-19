"use client";

import type { Icon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { DRAW_COLOR_LABELS, DRAW_COLOR_VAR } from "@/components/board/BoardView";
import { DRAW_COLORS } from "@/lib/annotations";

// The common frame of the two editors of Estudio (drawings over a clip and the board): a bar on top (title and what
// applies to the whole piece), a vertical tool rail beside the canvas, the canvas, one line of controls under it and a
// side panel with tabs. On a wide screen it fills the window: the rail, the canvas column and the panel share one
// height and only the panel scrolls inside.

// Wide screens (Tailwind xl) get the fixed-height layout; narrower ones stack and scroll as a page.
const WIDE = "(min-width: 1280px)";

export function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

// Height that takes an element from where it starts down to the bottom of the window (null on narrow screens).
export function useFillHeight(ref: RefObject<HTMLElement | null>, enabled = true, gap = 16): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const el = ref.current;
      if (!el || !window.matchMedia(WIDE).matches) return setH(null);
      setH(Math.max(460, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - gap)));
    };
    const raf = requestAnimationFrame(measure);
    const late = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener("resize", measure);
    };
  }, [ref, enabled, gap]);
  return enabled ? h : null;
}

// The largest box of the given aspect (width / height) that fits its parent; without a parent height, the full width.
export function FitAspect({ aspect, children }: { aspect: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number | null>(null);
  // Measured before the first paint too, so the content never shows at full width for a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (width: number, height: number) => setW(height < 60 ? null : Math.floor(Math.min(width, height * aspect)));
    const r = el.getBoundingClientRect();
    fit(r.width, r.height);
    const ro = new ResizeObserver(([e]) => fit(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return (
    <div ref={ref} className="grid h-full w-full place-items-center">
      <div className="relative" style={{ width: w ?? "100%" }}>
        {children}
      </div>
    </div>
  );
}

export type RailTool<T extends string> = { id: T; label: string; key?: string; icon: Icon };

// One button of the rail: icon only, its name in a label that slides out on hover or focus.
export function RailButton({
  label,
  icon: I,
  active = false,
  onClick,
  disabled = false,
  tone = "default",
}: {
  label: string;
  icon: Icon;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`group relative grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-[background-color,color] duration-150 disabled:opacity-30 ${
        active ? "bg-accent-900 text-accent-300 ring-1 ring-accent/60" : `text-muted hover:bg-raised ${tone === "danger" ? "hover:text-danger" : "hover:text-ink"}`
      }`}
    >
      <I size={19} weight={active ? "bold" : "regular"} aria-hidden />
      <span className="pointer-events-none absolute top-1/2 left-full z-30 ml-2 hidden -translate-y-1/2 rounded-md bg-ink px-2 py-1 text-xs font-medium whitespace-nowrap text-bg opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 xl:block">
        {label}
      </span>
    </button>
  );
}

// The vertical tool rail: the tools, then the drawing colour and the dashed toggle, then anything else (bottom).
export function ToolRail<T extends string>({
  tools,
  value,
  onChange,
  color,
  onColor,
  dashed,
  onDashed,
  dashedIcon,
  children,
  disabled = false,
}: {
  tools: RailTool<T>[];
  value: T;
  onChange: (t: T) => void;
  color: string;
  onColor: (c: string) => void;
  dashed: boolean;
  onDashed: (d: boolean) => void;
  dashedIcon: Icon;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Herramientas"
      className={`flex flex-row flex-wrap items-center gap-1 rounded-xl bg-surface p-1.5 xl:h-full xl:flex-col xl:flex-nowrap ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      {tools.map((t) => (
        <RailButton key={t.id} label={t.key ? `${t.label} (${t.key})` : t.label} icon={t.icon} active={value === t.id} onClick={() => onChange(t.id)} />
      ))}
      <span className="mx-1 h-6 w-px bg-line xl:mx-0 xl:my-1 xl:h-px xl:w-6" aria-hidden />
      <div role="radiogroup" aria-label="Color del dibujo" className="flex flex-row items-center gap-1.5 px-1 xl:flex-col xl:py-1">
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={DRAW_COLOR_LABELS[c]}
            title={DRAW_COLOR_LABELS[c]}
            onClick={() => onColor(c)}
            className={`h-5 w-5 rounded-full transition-transform duration-150 ${color === c ? "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-surface" : "hover:scale-110"}`}
            style={{ background: DRAW_COLOR_VAR[c] }}
          />
        ))}
      </div>
      <RailButton label={dashed ? "Línea discontinua (activa)" : "Línea discontinua"} icon={dashedIcon} active={dashed} onClick={() => onDashed(!dashed)} />
      {children && <div className="flex flex-row items-center gap-1 xl:mt-auto xl:flex-col">{children}</div>}
    </div>
  );
}

// The side panel: tabs on top, the content scrolling under them.
export function SidePanel<T extends string>({
  tabs,
  value,
  onChange,
  children,
  footer,
}: {
  tabs: [T, string][];
  value: T;
  onChange: (t: T) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-surface">
      <div className="seg m-2 mb-0 flex" role="tablist" aria-label="Panel">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={value === id} className="seg-opt flex-1 text-center" onClick={() => onChange(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">{children}</div>
      {footer && <div className="border-t border-line-soft p-3">{footer}</div>}
    </aside>
  );
}

// Title of a block inside the side panel.
export function PanelTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2">
      <span className="cond text-[12px] font-bold tracking-wide text-muted uppercase">{children}</span>
      {right && <span className="ml-auto flex items-center gap-1">{right}</span>}
    </div>
  );
}

type FrameProps = {
  header?: ReactNode;
  rail?: ReactNode;
  canvas: ReactNode;
  controls?: ReactNode;
  side?: ReactNode;
  // Fixed height (wide screens): the canvas fits the room left by the rest.
  fixed: boolean;
  className?: string;
  style?: React.CSSProperties;
  frameRef?: RefObject<HTMLDivElement | null>;
};

export function StudioFrame({ header, rail, canvas, controls, side, fixed, className = "", style, frameRef }: FrameProps) {
  return (
    <div ref={frameRef} className={`flex flex-col gap-3 ${className}`} style={style}>
      {header && <div className="flex flex-wrap items-center gap-2">{header}</div>}
      <div className={`grid gap-3 ${fixed ? "min-h-0 flex-1" : ""} ${side ? "xl:grid-cols-[auto_minmax(0,1fr)_21rem]" : "xl:grid-cols-[auto_minmax(0,1fr)]"}`}>
        <div className={rail ? "" : "hidden xl:block xl:w-0"}>{rail}</div>
        <div className={`flex min-w-0 flex-col gap-3 ${fixed ? "min-h-0" : ""}`}>
          <div className={`relative overflow-hidden rounded-xl bg-surface p-2 ${fixed ? "min-h-0 flex-1" : ""}`}>
            {fixed ? <div className="absolute inset-2">{canvas}</div> : canvas}
          </div>
          {controls && <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-xl bg-surface px-2 py-1.5">{controls}</div>}
        </div>
        {side}
      </div>
    </div>
  );
}

// Where a frame sits: fixed height (and its style) on wide screens, page flow otherwise.
export type FrameLayout = { fixed: boolean; className?: string; style?: React.CSSProperties; frameRef?: RefObject<HTMLDivElement | null> };
