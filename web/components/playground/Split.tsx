"use client";

import { useRef, useState, type ReactNode } from "react";
import { clampFrac, dragDivider, formatFracs, parseFracs } from "@/lib/playgroundPossession";
import { setPref, usePref } from "@/lib/store";

// Panels side by side (dir "row") or stacked (dir "col") with draggable dividers. The sizes are fractions kept in a
// browser preference (usePref: not part of the backup); an empty or damaged preference goes back to `fallback`.
// Arrow keys on a focused divider move it too; double click restores this group's sizes.
export function Split({ prefKey, fallback, dir = "row", children, className = "" }: { prefKey: string; fallback: number[]; dir?: "row" | "col"; children: ReactNode[]; className?: string }) {
  const stored = usePref(prefKey, "");
  const saved = parseFracs(stored, fallback.length, fallback);
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? saved;
  const box = useRef<HTMLDivElement>(null);
  const horizontal = dir === "row";

  const onDown = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const total = horizontal ? el.clientWidth : el.clientHeight;
    const origin = horizontal ? e.clientX : e.clientY;
    const start = sizes;
    let last = start;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      last = dragDivider(start, i, ((horizontal ? ev.clientX : ev.clientY) - origin) / total);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPref(prefKey, formatFracs(last));
      setLive(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKey = (i: number) => (e: React.KeyboardEvent) => {
    const dec = horizontal ? "ArrowLeft" : "ArrowUp";
    const inc = horizontal ? "ArrowRight" : "ArrowDown";
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    setPref(prefKey, formatFracs(dragDivider(sizes, i, e.key === inc ? 0.02 : -0.02)));
  };

  return (
    <div ref={box} className={`flex min-h-0 min-w-0 ${horizontal ? "flex-row" : "flex-col"} ${className}`}>
      {children.map((c, i) => (
        <div key={i} className="contents">
          <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${clampFrac(sizes[i], 0.05, 0.95)} 1 0` }}>
            {c}
          </div>
          {i < children.length - 1 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              aria-label="Arrastra para cambiar el tamaño de los paneles"
              title="Arrastra para repartir el espacio (doble clic: restablecer)"
              className={`group shrink-0 touch-none ${horizontal ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize"} flex items-center justify-center focus-visible:outline-2`}
              onPointerDown={onDown(i)}
              onKeyDown={onKey(i)}
              onDoubleClick={() => setPref(prefKey, "")}
            >
              <span className={`rounded-full bg-line-strong transition-colors group-hover:bg-accent ${horizontal ? "h-10 w-0.5" : "h-0.5 w-10"}`} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Restores the sizes of several groups at once.
export const resetSplits = (keys: string[]) => keys.forEach((k) => setPref(k, ""));
