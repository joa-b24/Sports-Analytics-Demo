// Settings of the tracking of a match, read from and written to its match.yaml: the detector line
// (`detector: {model: ..., tiles: 2, band: auto, conf: 0.2}`) and `analysis_stride`. Pure text editing: every other
// line, comment and indentation of the file stays as it is.

export interface TrackingSettings {
  model: string;
  tiles: number;
  band: "auto" | "all";
  conf: number;
  stride: number;
}

// The detectors exported in weights/ (OpenVINO, for the laptop's CPU; Kaggle uses the same one in PyTorch): the small
// one for a close camera, the medium one for a wide camera where the players are 15-40 px tall. The default is the one
// process.py uses without a `detector` line.
export const DETECTORS = [
  { id: "yolo11n_960_openvino_model", label: "Pequeño, 960 px (el más rápido)" },
  { id: "yolo11n_1280_openvino_model", label: "Pequeño, 1280 px (el de siempre)" },
  { id: "yolo11s_1280_openvino_model", label: "Mediano, 1280 px (cámara amplia)" },
] as const;

export const DEFAULT_SETTINGS: TrackingSettings = { model: "yolo11n_1280_openvino_model", tiles: 1, band: "all", conf: 0.2, stride: 3 };

const DETECTOR_LINE = /^detector:\s*\{([^}]*)\}.*$/m;
const STRIDE_LINE = /^analysis_stride:\s*(\d+).*$/m;

export function readSettings(yaml: string | null): TrackingSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (!yaml) return out;
  const m = yaml.match(DETECTOR_LINE);
  if (m) {
    for (const part of m[1].split(",")) {
      const [k, v] = part.split(":").map((x) => x.trim().replace(/^["']|["']$/g, ""));
      if (k === "model" && v) out.model = v;
      else if (k === "tiles" && Number(v) >= 1) out.tiles = Math.round(Number(v));
      else if (k === "band") out.band = v === "auto" ? "auto" : "all";
      else if (k === "conf" && Number(v) > 0 && Number(v) < 1) out.conf = Number(v);
    }
  }
  const s = yaml.match(STRIDE_LINE);
  if (s && Number(s[1]) >= 1) out.stride = Number(s[1]);
  return out;
}

export function detectorLine(s: TrackingSettings): string {
  const parts = [`model: ${s.model}`, `tiles: ${s.tiles}`];
  if (s.band === "auto") parts.push("band: auto");
  parts.push(`conf: ${Number(s.conf.toFixed(2))}`);
  return `detector: {${parts.join(", ")}}`;
}

export function writeSettings(yaml: string, s: TrackingSettings): string {
  let text = DETECTOR_LINE.test(yaml)
    ? yaml.replace(DETECTOR_LINE, detectorLine(s))
    : `${yaml.replace(/\s*$/, "")}\n\n# Detector del tracking (elegido en la app)\n${detectorLine(s)}\n`;
  text = STRIDE_LINE.test(text)
    ? text.replace(STRIDE_LINE, (line) => line.replace(/analysis_stride:\s*\d+/, `analysis_stride: ${s.stride}`))
    : text.replace(/^(match_id:.*)$/m, `$1\nanalysis_stride: ${s.stride}`);
  return text;
}

// What a short test says, in words: whether the detector sees enough people to be worth the whole night.
export interface TestSummary {
  frames: number;
  boxes_median: number;
  on_pitch_median: number;
  calibrated_share: number;
  identities: number;
  ms_per_frame: number;
  estimate_s: number;
  part: string;
  start_s: number;
  end_s: number;
  model: string;
  tiles: number;
  conf: number;
  stride: number;
  created: string;
}

export function testVerdict(t: TestSummary): { tone: "ok" | "warn" | "bad"; text: string } {
  if (t.calibrated_share < 0.5) return { tone: "bad", text: "Menos de la mitad de los cuadros quedó calibrada: revisa la biblioteca de este video antes de procesar." };
  if (t.on_pitch_median < 10)
    return { tone: "bad", text: "Ve muy pocas personas en la cancha. Prueba el detector mediano a 1280 px, 2 cortes a lo ancho y la franja automática." };
  if (t.on_pitch_median < 16) return { tone: "warn", text: "Ve a una parte del equipo. Si la cámara abarca casi toda la cancha, prueba un detector más grande o más cortes." };
  return { tone: "ok", text: "Ve a casi todas las jugadoras en cuadro: se puede procesar." };
}
