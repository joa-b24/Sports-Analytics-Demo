// Colours of the drawings in Estudio (clips and board). A drawing stores the NAME of a slot of the palette ("accent",
// "warn"...) or, for a free pick, a hex "#rrggbb"; each view turns it into a value here, so a drawing never stores a
// token. The analyst can change the colour of any slot (kept in a preference outside the backup, with a reset). Pure
// functions: no storage, no React.

export interface PaletteSlot {
  id: string;
  label: string;
  // CSS value of the default: always a token of globals.css (or a mix of tokens), never a literal colour.
  css: string;
}

export const PALETTE_SLOTS: PaletteSlot[] = [
  { id: "accent", label: "Azul", css: "var(--color-accent-300)" },
  { id: "warn", label: "Ámbar", css: "var(--color-warn)" },
  { id: "danger", label: "Rojo", css: "var(--color-danger)" },
  { id: "ok", label: "Verde", css: "var(--color-ok)" },
  { id: "ink", label: "Blanco", css: "var(--color-ink)" },
  { id: "own", label: "Equipo propio", css: "var(--color-own)" },
  { id: "opp", label: "Rival", css: "var(--color-opp)" },
  { id: "violet", label: "Violeta", css: "color-mix(in srgb, var(--color-accent-400) 55%, var(--color-danger))" },
  { id: "teal", label: "Turquesa", css: "color-mix(in srgb, var(--color-accent-400) 45%, var(--color-ok))" },
  { id: "orange", label: "Naranja", css: "color-mix(in srgb, var(--color-warn) 60%, var(--color-danger))" },
];
export const PALETTE_IDS = PALETTE_SLOTS.map((s) => s.id);
export const PALETTE_PREF = "studio:palette";

export type PaletteOverrides = Record<string, string>;

export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

// Overrides read from a stored text: only known slots with a valid hex survive; anything else is dropped.
export function parsePalette(text: string | null | undefined): PaletteOverrides {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const out: PaletteOverrides = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (PALETTE_IDS.includes(k) && isHex(v)) out[k] = v.toLowerCase();
    return out;
  } catch {
    return {};
  }
}
export const serializePalette = (o: PaletteOverrides) => JSON.stringify(o);

// CSS value of a drawing colour: a hex as it is, a slot by the user's override or its default, unknown names -> accent.
export function colorValue(name: string | undefined, overrides: PaletteOverrides = {}): string {
  if (isHex(name)) return name;
  const slot = PALETTE_SLOTS.find((s) => s.id === name) ?? PALETTE_SLOTS[0];
  return overrides[slot.id] ?? slot.css;
}

export function colorLabel(name: string | undefined): string {
  if (isHex(name)) return `Libre ${name}`;
  return PALETTE_SLOTS.find((s) => s.id === name)?.label ?? PALETTE_SLOTS[0].label;
}

// The palette after changing one slot (a null hex restores its default).
export function withOverride(o: PaletteOverrides, id: string, hex: string | null): PaletteOverrides {
  if (!PALETTE_IDS.includes(id)) return o;
  const next = { ...o };
  if (hex !== null && isHex(hex)) next[id] = hex.toLowerCase();
  else delete next[id];
  return next;
}
