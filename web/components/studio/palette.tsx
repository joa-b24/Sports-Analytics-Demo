"use client";

import { ArrowCounterClockwise, Palette } from "@phosphor-icons/react";
import { setPref, usePref } from "@/lib/store";
import { PALETTE_PREF, PALETTE_SLOTS, colorLabel, colorValue, isHex, parsePalette, serializePalette, withOverride, type PaletteOverrides } from "@/lib/palette";

// The analyst's palette (changes to the predefined colours), kept in a preference outside the backup.
export function usePalette(): PaletteOverrides {
  const raw = usePref(PALETTE_PREF, "");
  return parsePalette(raw);
}

// css value of a drawing colour by the analyst's palette.
export function useDrawColor(): (name: string | undefined) => string {
  const o = usePalette();
  return (name) => colorValue(name, o);
}

export const setPaletteSlot = (o: PaletteOverrides, id: string, hex: string | null) => setPref(PALETTE_PREF, serializePalette(withOverride(o, id, hex)));
export const resetPalette = () => setPref(PALETTE_PREF, "");

// Hex of a CSS colour (a token or a mix) as the browser paints it, to seed a colour picker; no literal colour in code.
function cssToHex(css: string): string {
  if (typeof document === "undefined") return "#000000";
  const el = document.createElement("span");
  el.style.color = css;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  // A mix comes back as color(srgb r g b) with 0..1 channels; everything else as rgb(r, g, b).
  const scale = c.startsWith("color(") ? 255 : 1;
  const rgb = (c.match(/\d*\.?\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]).map((v) => v * scale);
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// Colour dots: every slot of the palette plus a free picker. `value` is a slot name or a free hex.
export function PaletteDots({ value, onChange, size = 20, name = "Color" }: { value: string; onChange: (c: string) => void; size?: number; name?: string }) {
  const dc = useDrawColor();
  const free = isHex(value);
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap items-center gap-1.5">
      {PALETTE_SLOTS.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={value === s.id}
          aria-label={s.label}
          title={s.label}
          onClick={(e) => {
            e.stopPropagation();
            onChange(s.id);
          }}
          className={`shrink-0 rounded-full transition-transform duration-150 ${value === s.id ? "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-surface" : "hover:scale-110"}`}
          style={{ background: dc(s.id), width: size, height: size }}
        />
      ))}
      <label
        title="Color libre"
        className={`relative grid shrink-0 cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-line-strong text-muted transition-transform hover:scale-110 ${free ? "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`}
        style={{ width: size, height: size, background: free ? value : undefined }}
      >
        {!free && <Palette size={size * 0.6} aria-hidden />}
        <span className="sr-only">Color libre</span>
        <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={free ? value : cssToHex(dc(PALETTE_SLOTS[0].id))} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label="Color libre" />
      </label>
    </div>
  );
}

// Edits the predefined colours: each slot has a picker; «Restablecer» returns them all to the app's tokens.
export function PaletteEditor() {
  const o = usePalette();
  const dc = useDrawColor();
  const changed = Object.keys(o).length > 0;
  return (
    <div className="space-y-2 text-xs">
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {PALETTE_SLOTS.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <label className="relative h-5 w-5 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-line-strong" style={{ background: dc(s.id) }}>
              <input
                type="color"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                value={o[s.id] ?? cssToHex(s.css)}
                aria-label={`Cambiar el color ${s.label}`}
                onChange={(e) => setPaletteSlot(o, s.id, e.target.value)}
              />
            </label>
            <span className="min-w-0 flex-1 truncate text-ink-2">{colorLabel(s.id)}</span>
            {o[s.id] && (
              <button type="button" className="text-faint hover:text-ink" aria-label={`Restablecer ${s.label}`} title="Volver al color de la app" onClick={() => setPaletteSlot(o, s.id, null)}>
                <ArrowCounterClockwise size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn !px-2.5 !py-1 text-xs" disabled={!changed} onClick={resetPalette}>
        <ArrowCounterClockwise size={13} />
        Restablecer la paleta
      </button>
      <p className="m-0 text-faint">Los cambios valen para todos los clips y pizarras de este navegador y no entran al respaldo.</p>
    </div>
  );
}
