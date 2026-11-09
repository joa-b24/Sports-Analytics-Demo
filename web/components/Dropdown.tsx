"use client";

import { useEffect, useRef, useState } from "react";

// A button that opens a panel under it (a menu, a small form). Closes with a click anywhere outside it, with Esc, or
// with close() from inside (an item that does something).
export function Dropdown({
  trigger,
  label,
  children,
  triggerClass = "btn",
  panelClass = "w-60",
}: {
  trigger: React.ReactNode;
  label: string;
  children: (close: () => void) => React.ReactNode;
  triggerClass?: string;
  panelClass?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // A list drawn over the page by a control inside the panel (Select, PlayerPicker) is part of the panel.
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-popover]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the menu only, not what is selected behind it.
      e.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <details ref={ref} className="dropdown relative" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`${triggerClass} cursor-pointer list-none`} aria-label={label} title={label}>
        {trigger}
      </summary>
      <div className={`dropdown-panel absolute right-0 z-40 mt-2 rounded-xl bg-raised shadow-[0_0_0_1px_var(--color-line),0_24px_48px_-16px_rgba(0,0,0,.7)] ${panelClass}`}>
        {children(close)}
      </div>
    </details>
  );
}

// One entry of a menu: icon, text and, optionally, its key.
export function MenuItem({ icon, children, hint, onClick, tone = "default" }: { icon?: React.ReactNode; children: React.ReactNode; hint?: string; onClick: () => void; tone?: "default" | "danger" }) {
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        tone === "danger" ? "text-ink-2 hover:bg-danger/15 hover:text-danger" : "text-ink-2 hover:bg-line-strong hover:text-ink"
      }`}
      onClick={onClick}
    >
      <span className="grid w-4 shrink-0 place-items-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {hint && <kbd className="kbd">{hint}</kbd>}
    </button>
  );
}
