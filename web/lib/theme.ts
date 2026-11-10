"use client";

import { useEffect } from "react";
import { usePref } from "./store";
import { DEFAULT_BALL, DEFAULT_OPP, DEFAULT_OWN, teamColor } from "./teamColors";

// Applies the theme (dark by default) and the team colors chosen in Configuración to the whole page.
export function useThemeSync() {
  const theme = usePref("theme", "dark");
  const own = usePref("ownColor", DEFAULT_OWN);
  const opp = usePref("oppColor", DEFAULT_OPP);
  const ball = usePref("ballColor", DEFAULT_BALL);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") root.dataset.theme = "light";
    else delete root.dataset.theme;
    const o = teamColor(own, DEFAULT_OWN);
    const r = teamColor(opp, DEFAULT_OPP);
    // On the light (beige) theme the darker «paper» tone of each color is used, so a light color (white, yellow) stays readable.
    const light = theme === "light";
    const b = teamColor(ball, DEFAULT_BALL);
    root.style.setProperty("--color-own", light ? o.paper : o.value);
    root.style.setProperty("--on-own", light ? "#ffffff" : o.on);
    root.style.setProperty("--color-opp", light ? r.paper : r.value);
    root.style.setProperty("--on-opp", light ? "#ffffff" : r.on);
    root.style.setProperty("--color-ball-track", light ? b.paper : b.value);
    root.style.setProperty("--on-ball-track", light ? "#ffffff" : b.on);
    // For the report printed on white paper (globals.css).
    root.style.setProperty("--paper-own", o.paper);
    root.style.setProperty("--paper-opp", r.paper);
  }, [theme, own, opp, ball]);
}
