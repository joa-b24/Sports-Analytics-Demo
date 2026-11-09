"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { usePref } from "@/lib/store";

// Focus mode: inside a match, the sidebar and the bar of the match leave the screen. Each comes back while the pointer
// is at its edge of the window (the top, the left) or leaves the window through it, and goes again when the pointer
// moves away from it.
export function useFocusMode(): boolean {
  const path = usePathname();
  const on = usePref("focus", "off") === "on";
  return on && path.startsWith("/partido") && !path.startsWith("/partidos");
}

// How close to the edge (px) the pointer brings a hidden bar back, and how far from it (px) it hides it again.
const EDGE_PX = 4;
const AWAY_PX = 32;

export function EdgeReveal({ edge, enabled, children, className = "" }: { edge: "top" | "left"; enabled: boolean; children: React.ReactNode; className?: string }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const atEdge = (e: MouseEvent) => (edge === "top" ? e.clientY <= EDGE_PX : e.clientX <= EDGE_PX);
    const onMove = (e: MouseEvent) => {
      if (atEdge(e)) return setShown(true);
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      if (edge === "top" ? e.clientY > r.bottom + AWAY_PX : e.clientX > r.right + AWAY_PX) setShown(false);
    };
    // Leaving the window through that edge.
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget && atEdge(e)) setShown(true);
    };
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseout", onOut);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
    };
  }, [enabled, edge]);
  if (!enabled) return <>{children}</>;
  return (
    <div
      ref={ref}
      className={`fixed z-50 transition-transform duration-200 ease-out ${
        edge === "top" ? `inset-x-0 top-0 ${shown ? "" : "-translate-y-full"}` : `inset-y-0 left-0 ${shown ? "" : "-translate-x-full"}`
      } ${shown ? "shadow-[0_20px_40px_-12px_rgba(0,0,0,.7)]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}
