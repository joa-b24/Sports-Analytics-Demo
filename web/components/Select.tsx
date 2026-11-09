"use client";

import { CaretDown, Check } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A drop-down that looks like the rest of the app instead of the browser's: a compact button with the value, and a
// list under it (drawn over everything, so a table that scrolls sideways does not cut it). One value, or several with
// `multi`. Arrows move, Enter picks, Esc closes; typing a letter jumps to the first option that starts with it.

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  // A dot of this colour before the label (a team, a kind).
  color?: string;
  // A key shown at the right (the shortcut that does the same).
  hint?: string;
  // Starts a group: a small title over this option.
  group?: string;
}

type Common<T extends string> = {
  options: SelectOption<T>[];
  label: string;
  // What the button says when nothing is chosen.
  placeholder?: string;
  // "chip": borderless, for a table cell; "field": like an input.
  variant?: "chip" | "field";
  className?: string;
  // An empty choice at the top ("—"), to clear the value.
  clearable?: boolean;
  // Text on the button instead of the chosen label (e.g. "Tipos · 3").
  display?: React.ReactNode;
  align?: "left" | "right";
};

type Single<T extends string> = Common<T> & { multi?: false; value: T | null; onChange: (v: T | null) => void };
type Multi<T extends string> = Common<T> & { multi: true; value: T[]; onChange: (v: T[]) => void };

export function Select<T extends string>(props: Single<T> | Multi<T>) {
  const { options, label, placeholder = "—", variant = "chip", className = "", clearable = false, display, align = "left" } = props;
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minW: number; up: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const items: { value: T | null; label: string; color?: string; hint?: string; group?: string }[] = [
    ...(clearable && !props.multi ? [{ value: null, label: "—" }] : []),
    ...options,
  ];
  const isOn = (v: T | null) => (props.multi ? v !== null && props.value.includes(v) : props.value === v);
  const chosen = props.multi ? null : (options.find((o) => o.value === props.value) ?? null);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 280 > window.innerHeight && r.top > 280;
    setPos({ left: align === "right" ? r.right : r.left, top: up ? r.top - 4 : r.bottom + 4, minW: r.width, up });
  };
  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    panelRef.current?.querySelector<HTMLElement>("[data-hi]")?.scrollIntoView({ block: "nearest" });
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (v: T | null) => {
    if (props.multi) {
      if (v === null) return;
      props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    } else {
      props.onChange(v);
      setOpen(false);
      btnRef.current?.focus();
    }
  };
  const openAt = () => {
    const i = items.findIndex((o) => isOn(o.value));
    setHi(Math.max(0, i));
    setOpen(true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    // Inside the list the keys are the list's, not the page's shortcuts.
    e.stopPropagation();
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openAt();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") return setOpen(false);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(items[hi]?.value ?? null);
    } else if (e.key.length === 1) {
      const i = items.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setHi(i);
    }
  };

  const base =
    variant === "field"
      ? "h-9 rounded-lg bg-bg/60 px-3 text-sm shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
      : "rounded-md px-2 py-0.5 text-xs hover:bg-raised";
  const empty = props.multi ? props.value.length === 0 : props.value === null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent-400 ${base} ${
          open ? "bg-raised" : ""
        } ${empty && !display ? "text-faint" : "text-ink-2"} ${className}`}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={onKey}
      >
        {chosen?.color && <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: chosen.color }} />}
        <span className="min-w-0 truncate">{display ?? chosen?.label ?? placeholder}</span>
        <CaretDown size={10} className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            data-popover
            aria-label={label}
            aria-multiselectable={props.multi || undefined}
            tabIndex={-1}
            onKeyDown={onKey}
            className="enter fixed z-[70] max-h-72 overflow-y-auto rounded-xl bg-raised p-1 text-sm shadow-[0_0_0_1px_var(--color-line),0_24px_48px_-16px_rgba(0,0,0,.7)]"
            style={{
              left: align === "right" ? undefined : pos.left,
              right: align === "right" ? window.innerWidth - pos.left : undefined,
              top: pos.up ? undefined : pos.top,
              bottom: pos.up ? window.innerHeight - pos.top : undefined,
              minWidth: Math.max(160, pos.minW),
            }}
          >
            {items.map((o, i) => (
              <div key={o.value ?? "_none"}>
                {o.group && <div className="cond px-2.5 pt-2 pb-1 text-[10px] font-bold tracking-wide text-faint uppercase">{o.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={isOn(o.value)}
                  data-hi={i === hi ? "" : undefined}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o.value)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${i === hi ? "bg-line-strong text-ink" : "text-ink-2"}`}
                >
                  <span className="grid w-3.5 shrink-0 place-items-center text-accent-300">{isOn(o.value) && <Check size={12} weight="bold" />}</span>
                  {o.color && <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.color }} />}
                  <span className={`min-w-0 flex-1 truncate ${o.value === null ? "text-faint" : ""}`}>{o.label}</span>
                  {o.hint && <kbd className="kbd uppercase">{o.hint}</kbd>}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
