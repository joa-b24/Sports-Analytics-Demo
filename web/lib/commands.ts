// Los comandos sueltos de Python (propagar, biblioteca, detección, process, overnight) como catálogo: qué módulo corre cada uno,
// qué parámetros acepta y cómo se valida cada uno. La app (Configuración del partido › Procesos) los muestra con una casilla por
// parámetro («usar este») y la ruta app/api/run/command arma la línea con ESTA misma lista: nada escrito por la usuaria llega a la
// línea de comandos si no pasó por aquí. Funciones puras, sin leer archivos.

export type ParamKind = "bool" | "number" | "time" | "text" | "file";

export interface CommandParam {
  id: string;
  flag: string; // --flag de Python
  label: string;
  help: string;
  kind: ParamKind;
  // number: límites y valor sugerido (el que Python usa por defecto, para que la casilla marcada ya tenga un valor).
  min?: number;
  max?: number;
  def?: string;
  // file: nombre de un archivo de tracking/ del partido (sin carpetas); `pattern` dice cuáles valen.
  pattern?: RegExp;
  // La línea no corre sin este parámetro.
  required?: boolean;
  // text: valores permitidos (si no, patrón libre y corto).
  oneOf?: string[];
}

export interface CommandDef {
  id: string;
  title: string;
  lead: string;
  module: string;
  sub?: string; // subcomando de argparse (library build…)
  // Qué lleva siempre: --match del partido, --video del video elegido.
  match: boolean;
  video: boolean;
  params: CommandParam[];
}

const FILE_NAME = /^[\w.-]+\.(json|npz)$/;
const TIME = /^\d{1,2}:\d{2}:\d{2}$/;

export const COMMANDS: CommandDef[] = [
  {
    id: "propagate",
    title: "Propagar las anclas",
    lead: "Lleva la calibración de las anclas exportadas a los cuadros intermedios. Escribe calib_….json en tracking/: ábrelo en Calibración › Verificar.",
    module: "sportsan.tracking.propagate",
    match: true,
    video: true,
    params: [
      { id: "anchors", flag: "--anchors", label: "Archivo de anclas", help: "El anchors_….json exportado desde Calibración (en tracking/).", kind: "file", pattern: /^anchors_[\w.-]+\.json$/, required: true },
      { id: "start", flag: "--start", label: "Inicio", help: "Hora del video (H:MM:SS). Sin él, desde la primera ancla.", kind: "time" },
      { id: "end", flag: "--end", label: "Fin", help: "Hora del video (H:MM:SS). Sin él, hasta la última ancla.", kind: "time" },
      { id: "workWidth", flag: "--work-width", label: "Ancho de trabajo (px)", help: "Ancho al que se reduce el video para estimar el movimiento.", kind: "number", min: 320, max: 1920, def: "960" },
      { id: "noDirect", flag: "--no-direct", label: "Solo flujo óptico", help: "Sin emparejar directo con las anclas: más rápido, deriva más.", kind: "bool" },
    ],
  },
  {
    id: "library-build",
    title: "Biblioteca: construir",
    lead: "Arma la biblioteca de referencias del video, desde un barrido calibrado o directo de las anclas. Sirve para ubicar el resto del video mientras la cámara no cambie de sitio.",
    module: "sportsan.tracking.library",
    sub: "build",
    match: true,
    video: true,
    params: [
      { id: "anchors", flag: "--anchors", label: "Desde anclas", help: "anchors_….json: cada ancla buena es una referencia, sin propagar.", kind: "file", pattern: /^anchors_[\w.-]+\.json$/ },
      { id: "track", flag: "--track", label: "Desde un barrido", help: "calib_….json escrito por «Propagar las anclas». Usa este o el de anclas.", kind: "file", pattern: /^calib_[\w.-]+\.json$/ },
      { id: "minPoints", flag: "--min-points", label: "Puntos mínimos por ancla", help: "Con «Desde anclas»: puntos que debe tener un ancla para ser referencia.", kind: "number", min: 4, max: 40, def: "6" },
      { id: "minShift", flag: "--min-shift-px", label: "Movimiento entre referencias (px)", help: "Movimiento de imagen entre referencias consecutivas.", kind: "number", min: 10, max: 1000, def: "150" },
    ],
  },
  {
    id: "library-borrow",
    title: "Biblioteca: usar la de otro video",
    lead: "Copia la biblioteca de otro video del MISMO partido a éste, reescalada a su tamaño (por ejemplo de 1080p a 720p). Solo sirve si es la misma cancha y la cámara se parece; no se hizo con este video, así que PRUÉBALA antes de procesar (Biblioteca: revisar, con «Biblioteca a usar») y mira los calib_ en Calibración › Verificar. No pisa una biblioteca que ya exista, salvo con --force.",
    module: "sportsan.tracking.library",
    sub: "borrow",
    match: true,
    video: true,
    params: [
      { id: "fromVideo", flag: "--from-video", label: "Tomarla del video", help: "El video que tiene la biblioteca (por ejemplo v2). El de arriba es el que la recibe.", kind: "text", def: "v2", required: true },
      { id: "force", flag: "--force", label: "Reemplazar la que ya tiene (--force)", help: "Solo si de verdad quieres cambiar su biblioteca.", kind: "bool" },
    ],
  },
  {
    id: "library-locate",
    title: "Biblioteca: ubicar un tramo",
    lead: "Calibra una jugada cualquiera con la biblioteca, sin anclas a mano.",
    module: "sportsan.tracking.library",
    sub: "locate",
    match: true,
    video: true,
    params: [
      { id: "library", flag: "--library", label: "Biblioteca a usar", help: "Por defecto la del video. Elige una prestada (library_<video>.npz) para probarla.", kind: "file", pattern: /^library_[\w.-]+\.npz$/ },
      { id: "start", flag: "--start", label: "Inicio", help: "Hora del video (H:MM:SS).", kind: "time", required: true },
      { id: "end", flag: "--end", label: "Fin", help: "Hora del video (H:MM:SS).", kind: "time", required: true },
      { id: "every", flag: "--every", label: "Segundos entre anclas", help: "Cada cuántos segundos se ubica una ancla automática.", kind: "number", min: 0.1, max: 30, def: "1" },
      { id: "maxError", flag: "--max-error", label: "Error máximo (m)", help: "Metros a partir de los que se descarta un ancla automática.", kind: "number", min: 0.1, max: 20, def: "" },
    ],
  },
  {
    id: "library-check",
    title: "Biblioteca: revisar antes de procesar",
    lead: "Calibra varios tramos repartidos por el partido y deja una tabla y sus calib_ en tracking/revision/ para mirarlos en Calibración › Verificar.",
    module: "sportsan.tracking.library",
    sub: "check",
    match: true,
    video: true,
    params: [
      { id: "library", flag: "--library", label: "Biblioteca a usar", help: "Por defecto la del video. Elige una prestada (library_<video>.npz) para probarla.", kind: "file", pattern: /^library_[\w.-]+\.npz$/ },
      { id: "samples", flag: "--samples", label: "Tramos", help: "Cuántos tramos revisar.", kind: "number", min: 1, max: 60, def: "8" },
      { id: "seconds", flag: "--seconds", label: "Segundos por tramo", help: "Duración de cada tramo.", kind: "number", min: 1, max: 120, def: "10" },
      { id: "every", flag: "--every", label: "Segundos entre anclas", help: "Cada cuántos segundos se ubica una ancla automática.", kind: "number", min: 0.1, max: 30, def: "1" },
    ],
  },
  {
    id: "process",
    title: "Detección y posiciones (process)",
    lead: "Une la detección con la biblioteca y da la posición en la cancha; reanudable por partes. Sin rango usa los tramos de juego de segments.csv.",
    module: "sportsan.tracking.process",
    match: true,
    video: true,
    params: [
      { id: "library", flag: "--library", label: "Biblioteca a usar", help: "Por defecto la del video. Elige una prestada (library_<video>.npz) para probarla.", kind: "file", pattern: /^library_[\w.-]+\.npz$/ },
      { id: "benchmark", flag: "--benchmark", label: "Solo medir (--benchmark)", help: "No procesa: mide la velocidad y estima el tiempo total.", kind: "bool" },
      { id: "test", flag: "--test", label: "Prueba corta (--test)", help: "Procesa solo una muestra en una carpeta aparte, sin tocar lo hecho.", kind: "bool" },
      { id: "force", flag: "--force", label: "Rehacer lo hecho (--force)", help: "Vuelve a procesar las partes que ya existen.", kind: "bool" },
      { id: "start", flag: "--start", label: "Inicio", help: "Hora del video (H:MM:SS).", kind: "time" },
      { id: "end", flag: "--end", label: "Fin", help: "Hora del video (H:MM:SS).", kind: "time" },
      { id: "stride", flag: "--stride", label: "1 de cada N cuadros", help: "Por defecto, el analysis_stride de match.yaml.", kind: "number", min: 1, max: 30, def: "3" },
      { id: "conf", flag: "--conf", label: "Confianza mínima", help: "Confianza mínima de una caja.", kind: "number", min: 0.01, max: 0.95, def: "0.2" },
      { id: "bandMargin", flag: "--band-margin", label: "Margen de la franja (m)", help: "Con franja automática: metros alrededor de la cancha que se le dan al detector.", kind: "number", min: 0, max: 15, def: "" },
      { id: "tiles", flag: "--tiles", label: "Trozos a lo ancho", help: "Para cámara amplia: en cuántos trozos se parte la imagen.", kind: "number", min: 1, max: 6, def: "1" },
      { id: "workers", flag: "--workers", label: "Partes a la vez", help: "Más de uno usa más procesador y memoria.", kind: "number", min: 1, max: 4, def: "1" },
    ],
  },
  {
    id: "detect",
    title: "Solo detección (detect)",
    lead: "Cajas y seguimiento en píxeles, sin biblioteca. Útil para medir velocidad o probar un modelo.",
    module: "sportsan.tracking.detect",
    match: true,
    video: true,
    params: [
      { id: "benchmark", flag: "--benchmark", label: "Solo medir (--benchmark)", help: "No procesa: mide la velocidad y estima el tiempo total.", kind: "bool" },
      { id: "force", flag: "--force", label: "Rehacer lo hecho (--force)", help: "Vuelve a procesar las partes que ya existen.", kind: "bool" },
      { id: "start", flag: "--start", label: "Inicio", help: "Hora del video (H:MM:SS).", kind: "time" },
      { id: "end", flag: "--end", label: "Fin", help: "Hora del video (H:MM:SS).", kind: "time" },
      { id: "chunk", flag: "--chunk", label: "Segundos por parte", help: "Duración de cada parte.", kind: "number", min: 5, max: 600, def: "60" },
      { id: "stride", flag: "--stride", label: "1 de cada N cuadros", help: "Por defecto, el analysis_stride de match.yaml.", kind: "number", min: 1, max: 30, def: "3" },
      { id: "conf", flag: "--conf", label: "Confianza mínima", help: "Confianza mínima de una caja.", kind: "number", min: 0.01, max: 0.95, def: "0.2" },
    ],
  },
  {
    id: "overnight",
    title: "Todo de una vez, de noche (overnight)",
    lead: "Propagación, biblioteca y process de todos los videos del partido a los que les falten. Sin video: corre todos.",
    module: "sportsan.tracking.overnight",
    match: true,
    video: false,
    params: [
      { id: "plan", flag: "--plan", label: "Solo el plan (--plan)", help: "Dice qué haría y cuánto tardaría, sin correr nada.", kind: "bool" },
      { id: "jobs", flag: "--jobs", label: "Videos a la vez", help: "1 = en serie, como siempre; se recorta a un tope seguro.", kind: "number", min: 1, max: 4, def: "1" },
      { id: "workers", flag: "--workers", label: "Partes a la vez por video", help: "1 = como siempre; se recorta a un tope seguro.", kind: "number", min: 1, max: 4, def: "1" },
    ],
  },
];

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id) ?? null;

// Lo que la usuaria elige de un comando: qué parámetros usa y con qué valor (bool: true).
export type CommandChoice = Record<string, string | true>;

const SAFE_MATCH = /^[\w.-]+$/;
const SAFE_VIDEO = /^v\d+$/;

// Valida lo elegido y devuelve el argv de Python (sin el ejecutable), o por qué no se puede. `usable` es lo que llega: se ignora
// lo que no está en el catálogo, y un parámetro que no se eligió no se manda (así Python usa su valor por defecto).
export function commandArgv(
  id: string,
  match: string,
  video: string,
  choice: CommandChoice,
): { ok: true; argv: string[]; shown: string } | { ok: false; error: string } {
  const def = commandById(id);
  if (!def) return { ok: false, error: "Comando desconocido." };
  if (!SAFE_MATCH.test(match)) return { ok: false, error: "Carpeta de partido no válida." };
  if (def.video && !SAFE_VIDEO.test(video)) return { ok: false, error: "Elige un video." };
  const argv = ["-m", def.module, ...(def.sub ? [def.sub] : []), ...(def.match ? ["--match", match] : []), ...(def.video ? ["--video", video] : [])];
  for (const p of def.params) {
    const v = choice[p.id];
    if (v === undefined) {
      if (p.required) return { ok: false, error: `Falta «${p.label}».` };
      continue;
    }
    if (p.kind === "bool") {
      argv.push(p.flag);
      continue;
    }
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) {
      if (p.required) return { ok: false, error: `Falta «${p.label}».` };
      continue;
    }
    if (p.kind === "number") {
      const n = Number(text);
      if (!Number.isFinite(n) || (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) return { ok: false, error: `«${p.label}» debe estar entre ${p.min} y ${p.max}.` };
      argv.push(p.flag, String(n));
    } else if (p.kind === "time") {
      if (!TIME.test(text)) return { ok: false, error: `«${p.label}» va como H:MM:SS (por ejemplo 0:33:20).` };
      argv.push(p.flag, text);
    } else if (p.kind === "file") {
      if (!FILE_NAME.test(text) || (p.pattern && !p.pattern.test(text))) return { ok: false, error: `«${p.label}» no es un nombre de archivo válido.` };
      argv.push(p.flag, `matches/${match}/tracking/${text}`);
    } else {
      if (p.oneOf ? !p.oneOf.includes(text) : !/^[\w.,:-]{1,60}$/.test(text)) return { ok: false, error: `«${p.label}» no es válido.` };
      argv.push(p.flag, text);
    }
  }
  // «Library build» necesita una de sus dos fuentes.
  if (id === "library-build" && choice.anchors === undefined && choice.track === undefined) return { ok: false, error: "Elige desde dónde construirla: anclas o un barrido." };
  return { ok: true, argv, shown: `python ${argv.join(" ")}` };
}

// El nombre más probable de cada archivo, para proponerlo al elegir el parámetro.
export function suggestedFile(paramId: string, match: string, video: string, files: string[]): string {
  const want = paramId === "track" ? /^calib_/ : /^anchors_/;
  const mine = files.filter((f) => want.test(f) && f.includes(`_${video}`));
  return (mine.length ? mine : files.filter((f) => want.test(f))).sort().pop() ?? (paramId === "anchors" ? `anchors_${match}_${video}.json` : "");
}

// Valor de un parámetro numérico que Python calcula por sí mismo (def vacío): la casilla no propone ninguno.
export const defaultOf = (p: CommandParam): string => p.def ?? "";
