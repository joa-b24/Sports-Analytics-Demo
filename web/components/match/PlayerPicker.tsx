"use client";

import { Crosshair, MagnifyingGlass, User, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Someone to suggest: from the squad (with her number), a name already used in this match, or someone the tracking
// puts near the ball at that moment (with the distance).
export interface PlayerChoice {
  player_id: string;
  number?: number | null;
  color?: string;
  // Metres from the ball, for the ones suggested by the tracking.
  near_m?: number;
}

// One field for a player: type a name or a number and pick from the list. In the review it also shows who the
// tracking puts near the ball, and a button to pick her by clicking her on the video.
export function PlayerPicker({
  value,
  onChange,
  choices,
  near = [],
  picking,
  onPickVideo,
  variant = "field",
  placeholder = "Jugadora",
  label = "Jugadora",
  search = false,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: PlayerChoice[];
  near?: PlayerChoice[];
  // Clicking on the video picks her (only when the part has tracking).
  picking?: boolean;
  onPickVideo?: () => void;
  variant?: "field" | "cell";
  placeholder?: string;
  label?: string;
  // A search box (filters) rather than a value.
  search?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; w: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const list = choices
    .filter((c) => !q || c.player_id.toLowerCase().includes(q) || (c.number != null && String(c.number) === q))
    .filter((c) => c.player_id !== value)
    .slice(0, 12);

  const place = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4, w: Math.max(200, r.width) });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !inputRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (list.length) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
    } else if (e.key === "Enter" && open && list[hi]) {
      // The review uses Enter for «next»: here it picks, and a second Enter goes on.
      e.preventDefault();
      e.stopPropagation();
      choose(list[hi].player_id);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const cell = variant === "cell";
  return (
    <div className={cell ? "min-w-0" : "space-y-2"}>
      <div className="relative flex items-center gap-1.5">
        <span className="pointer-events-none absolute left-2 text-faint">{search ? <MagnifyingGlass size={13} /> : !cell && <User size={13} />}</span>
        <input
          ref={inputRef}
          className={
            cell
              ? "w-28 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-line focus:border-accent focus:outline-none"
              : `h-9 w-full min-w-0 rounded-lg bg-bg/60 pr-7 text-sm shadow-[inset_0_0_0_1px_var(--color-line)] placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--color-accent)] focus:outline-none ${
                  search || !cell ? "pl-7" : "pl-2.5"
                }`
          }
          placeholder={cell ? "–" : placeholder}
          aria-label={label}
          value={value}
          onFocus={() => {
            setHi(0);
            setOpen(true);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setHi(0);
            setOpen(true);
          }}
          onKeyDown={onKey}
        />
        {!cell && value && (
          <button type="button" className="absolute right-2 text-faint hover:text-ink" aria-label="Borrar" onClick={() => onChange("")}>
            <X size={12} />
          </button>
        )}
        {onPickVideo && (
          <button
            type="button"
            aria-pressed={picking}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors ${picking ? "bg-own text-[var(--on-own)]" : "bg-bg/60 text-muted hover:text-ink"} shadow-[inset_0_0_0_1px_var(--color-line)]`}
            title={picking ? "Clic en ella sobre el video · Esc cancela" : "Elegirla con un clic sobre el video (V)"}
            aria-label="Elegir en el video"
            onClick={onPickVideo}
          >
            <Crosshair size={15} />
          </button>
        )}
      </div>
      {near.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Cerca del balón</span>
          {near.map((c) => (
            <button
              key={c.player_id}
              type="button"
              aria-pressed={c.player_id === value}
              onClick={() => onChange(c.player_id)}
              className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1.5 text-xs transition-colors ${
                c.player_id === value ? "bg-accent/25 text-accent-100" : "bg-bg/60 text-ink-2 hover:bg-raised"
              }`}
            >
              <i className="h-2 w-2 rounded-full" style={{ background: c.color }} />
              {c.player_id}
              {c.near_m !== undefined && <span className="tc text-[10px] text-faint">{c.near_m.toFixed(0)} m</span>}
            </button>
          ))}
        </div>
      )}
      {open &&
        pos &&
        list.length > 0 &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            data-popover
            className="enter fixed z-[70] max-h-64 overflow-y-auto rounded-xl bg-raised p-1 text-sm shadow-[0_0_0_1px_var(--color-line),0_24px_48px_-16px_rgba(0,0,0,.7)]"
            style={{ left: pos.left, top: pos.top, width: pos.w }}
          >
            {list.map((c, i) => (
              <button
                key={c.player_id}
                type="button"
                role="option"
                aria-selected={i === hi}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c.player_id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === hi ? "bg-line-strong text-ink" : "text-ink-2"}`}
              >
                <span className="tc w-6 shrink-0 text-right text-xs text-faint">{c.number != null ? c.number : ""}</span>
                <span className="min-w-0 flex-1 truncate">{c.player_id}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
