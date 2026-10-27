// Light copy of a match video for working on it in the app (Anclas, Revisión rápida, Mesa).
//
//   node scripts/make-proxy.mjs <carpeta_del_partido> <video>      e.g. 2026_09_25_tec_ccm_vs_anahuac v1
//
// Writes matches/<carpeta>/video/<video>_proxy.mp4: 720p, a keyframe every 15 frames, no audio, same frames and same
// timestamps as the original (so frame numbers and t_video do not change). The app uses it when it exists
// (Correction.tsx, pref «correction:proxy»). The original is never touched. Needs ffmpeg and ffprobe on the PATH.
// About 5x real time on the laptop (a 45-minute video takes ~8 minutes); progress with % and time left goes to the console.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const [folder, video] = process.argv.slice(2);
if (!folder || !video) {
  console.error("Uso: node scripts/make-proxy.mjs <carpeta_del_partido> <video>");
  process.exit(2);
}
const dir = path.resolve(process.cwd(), "..", "matches", folder, "video");
const src = ["mp4", "mkv", "webm", "mov"].map((e) => path.join(dir, `${video}.${e}`)).find(existsSync);
if (!src) {
  console.error(`No hay video ${video} en ${dir}`);
  process.exit(1);
}
const out = path.join(dir, `${video}_proxy.mp4`);
const tmp = path.join(dir, `${video}_proxy_tmp.mp4`);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", src], { encoding: "utf8" });
const total = Number(probe.stdout);
if (!Number.isFinite(total) || total <= 0) {
  console.error("ffprobe no pudo leer la duración (¿está ffmpeg instalado?).");
  process.exit(1);
}
console.log(`Origen: ${src} (${(total / 60).toFixed(1)} min)\nDestino: ${out}`);
const t0 = Date.now();
const ff = spawn(
  "ffmpeg",
  ["-y", "-v", "error", "-progress", "pipe:1", "-i", src, "-an", "-vf", "scale=1280:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-fps_mode", "passthrough", "-movflags", "+faststart", tmp],
  { stdio: ["ignore", "pipe", "inherit"] },
);
let last = 0;
let buf = "";
ff.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    const m = l.match(/^out_time_us=(\d+)/);
    if (!m) continue;
    const done = Number(m[1]) / 1e6;
    const pct = Math.min(100, (100 * done) / total);
    if (pct - last < 2) continue;
    last = pct;
    const el = (Date.now() - t0) / 1000;
    const eta = pct > 0 ? (el * (100 - pct)) / pct : 0;
    console.log(`${pct.toFixed(0)} %  quedan ~${Math.max(1, Math.round(eta / 60))} min`);
  }
});
ff.on("close", (code) => {
  if (code !== 0) {
    rmSync(tmp, { force: true });
    console.error(`ffmpeg terminó con código ${code}`);
    process.exit(1);
  }
  renameSync(tmp, out);
  console.log(`Listo en ${((Date.now() - t0) / 60000).toFixed(1)} min: ${out}`);
});
