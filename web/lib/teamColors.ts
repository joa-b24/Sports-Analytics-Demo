// Colors a team can take in the app (own = the analysed team, opp = its opponent). They are interface choices, not
// shirt colors: a team keeps its color whatever it wears that day. `on` is the text drawn over a fill of that color.
export const TEAM_COLORS = [
  { id: "azul", label: "Azul rey", value: "#3a66ff", on: "#ffffff" },
  { id: "celeste", label: "Celeste", value: "#4cc2ff", on: "#04121c" },
  { id: "verde", label: "Verde", value: "#3fc07a", on: "#03140a" },
  { id: "menta", label: "Menta", value: "#2ee6c5", on: "#03130f" },
  { id: "amarillo", label: "Amarillo", value: "#f5c518", on: "#151100" },
  { id: "naranja", label: "Naranja", value: "#ff9a4d", on: "#1a0d00" },
  { id: "bermellon", label: "Bermellón", value: "#ff5a36", on: "#1d0700" },
  { id: "rosa", label: "Rosa", value: "#ff6fae", on: "#1c0410" },
  { id: "blanco", label: "Blanco", value: "#f2f2f0", on: "#0c0c0d" },
  { id: "gris", label: "Gris", value: "#9aa3ad", on: "#0c0c0d" },
] as const;

export const DEFAULT_OWN = "azul";
export const DEFAULT_OPP = "naranja";

export const teamColor = (id: string, fallback: string) =>
  TEAM_COLORS.find((c) => c.id === id) ?? (TEAM_COLORS.find((c) => c.id === fallback) as (typeof TEAM_COLORS)[number]);

// Runs before the page paints, so a light theme or other colors do not flash dark/blue first. Kept tiny and
// self-contained: it only reads the preferences saved by setPref.
export const THEME_BOOT = `(function(){try{var p=JSON.parse(localStorage.getItem("sportsan:ui")||"{}");var c=${JSON.stringify(
  Object.fromEntries(TEAM_COLORS.map((c) => [c.id, [c.value, c.on]])),
)};var r=document.documentElement;if(p.theme==="light")r.dataset.theme="light";var o=c[p.ownColor||"${DEFAULT_OWN}"],x=c[p.oppColor||"${DEFAULT_OPP}"];if(o){r.style.setProperty("--color-own",o[0]);r.style.setProperty("--on-own",o[1]);}if(x){r.style.setProperty("--color-opp",x[0]);r.style.setProperty("--on-opp",x[1]);}}catch(e){}})();`;
