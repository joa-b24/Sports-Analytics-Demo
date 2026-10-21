"use client";

import { useEffect } from "react";
import { usePref } from "./store";
import { DEFAULT_OPP, DEFAULT_OWN, teamColor } from "./teamColors";

// Applies the theme (dark by default) and the team colors chosen in Configuración to the whole page.
export function useThemeSync() {
  const theme = usePref("theme", "dark");
  const own = usePref("ownColor", DEFAULT_OWN);
  const opp = usePref("oppColor", DEFAULT_OPP);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
    const o = teamColor(own, DEFAULT_OWN);
    const r = teamColor(opp, DEFAULT_OPP);
    root.style.setProperty("--color-own", o.value);
    root.style.setProperty("--on-own", o.on);
    root.style.setProperty("--color-opp", r.value);
    root.style.setProperty("--on-opp", r.on);
    // For the report printed on white paper (globals.css).
    root.style.setProperty("--paper-own", o.paper);
    root.style.setProperty("--paper-opp", r.paper);
  }, [theme, own, opp]);
}
