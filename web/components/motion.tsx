"use client";

import { useEffect, useRef, useState } from "react";
import { fmtNum } from "@/lib/format";

// Scroll and load animations. The CSS in globals.css keeps `.reveal` blocks hidden until they carry
// [data-in]; this module sets it the first time the block enters the viewport. No state, no re-render.

let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver {
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = "";
          io?.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px" },
    );
  }
  return io;
}

// Ref callback: <div ref={revealRef} className="reveal">.
export function revealRef(el: Element | null) {
  if (!el) return;
  // Without the observer the block would stay hidden: show it straight away.
  if (typeof IntersectionObserver === "undefined") {
    (el as HTMLElement).dataset.in = "";
    return;
  }
  const o = observer();
  o.observe(el);
  return () => o.unobserve(el);
}

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  // Milliseconds; staggers siblings that enter together.
  delay?: number;
  as?: "div" | "section" | "li" | "header";
};

export function Reveal({ children, className = "", delay = 0, as: Tag = "div" }: RevealProps) {
  return (
    <Tag ref={revealRef} className={`reveal ${className}`} style={delay ? ({ "--d": `${delay}ms` } as React.CSSProperties) : undefined}>
      {children}
    </Tag>
  );
}

// Number that counts up to its value when it appears, and from the previous value when it changes.
export function CountUp({ value, digits = 0 }: { value: number; digits?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = from.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? 0 : 750;
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const p = duration === 0 ? 1 : Math.min(1, (now - t0) / duration);
      const v = start + (value - start) * (1 - Math.pow(1 - p, 3));
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{fmtNum(shown, digits)}</>;
}
