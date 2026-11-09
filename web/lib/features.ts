// Sections hidden for the first delivery to the coaching staff (match analysis only): Jugadoras, Sesiones and
// Calendario are not redesigned and there is no training data yet. Their pages stay in the code; with this off they
// leave the menu, the home page and Datos, and their routes redirect to the match list (next.config.ts).
// The roster lives in Configuración › Plantilla, since tagging and tracking use it.
export const TEAM_SECTIONS = false;

export const TEAM_ROUTES = ["/jugadoras", "/entrenamientos", "/planificacion"];
