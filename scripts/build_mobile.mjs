#!/usr/bin/env node
// Construye la app para celular / tablet (PWA instalable): una copia estática de web/ sin servidor.
//
//   node scripts/build_mobile.mjs            Captura reducida a Eventos (más Estudio, Análisis, Datos y Configuración)
//   node scripts/build_mobile.mjs --full     además muestra Calibración, Tramos, Tracking y Balón (sin botones de correr)
//
// Resultado: web/dist-mobile/  (HTML, JS y ícono listos para subir a cualquier hosting estático con HTTPS).
// Cómo funciona: copia web/ a web/.mobile-build/ SIN app/api ni proxy.ts (no hay servidor), con un next.config de
// exportación estática, y compila ahí con NEXT_PUBLIC_MOBILE=1. web/ no se toca. Ver docs/plan_movil_y_analisis.md.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web");
const tmp = path.join(web, ".mobile-build");
const out = path.join(web, "dist-mobile");
const full = process.argv.includes("--full");

const SKIP = new Set(["node_modules", ".next", ".mobile-build", "dist-mobile", "out", "app/api", "proxy.ts", "next.config.ts", "next-env.d.ts", "tsconfig.tsbuildinfo"]);
const rel = (p) => path.relative(web, p).split(path.sep).join("/");

// The copy holds a junction to web/node_modules: it is removed ON ITS OWN first, so that deleting the copy can never
// follow the link and empty the real node_modules.
function cleanTmp() {
  try {
    rmdirSync(path.join(tmp, "node_modules"));
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
}
cleanTmp();
mkdirSync(tmp, { recursive: true });
for (const name of readdirSync(web)) {
  if (SKIP.has(name)) continue;
  cpSync(path.join(web, name), path.join(tmp, name), { recursive: true, filter: (src) => !SKIP.has(rel(src)) });
}
writeFileSync(
  path.join(tmp, "next.config.ts"),
  `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = { output: "export", images: { unoptimized: true } };\nexport default nextConfig;\n`,
);
// Same dependencies, not copied.
symlinkSync(path.join(web, "node_modules"), path.join(tmp, "node_modules"), "junction");

console.log(`Compilando la app móvil${full ? " (completa)" : ""}...`);
const r = spawnSync("npm", ["run", "build"], {
  cwd: tmp,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NEXT_PUBLIC_MOBILE: "1", ...(full ? { NEXT_PUBLIC_MOBILE_FULL: "1" } : {}) },
});
if (r.status !== 0 || !existsSync(path.join(tmp, "out"))) {
  console.error("La compilación falló: no se generó web/dist-mobile.");
  process.exit(r.status || 1);
}
rmSync(out, { recursive: true, force: true });
cpSync(path.join(tmp, "out"), out, { recursive: true });
// Vercel: /partido -> partido.html (Netlify and Cloudflare Pages already do it).
writeFileSync(path.join(out, "vercel.json"), JSON.stringify({ cleanUrls: true }, null, 2) + "\n");
cleanTmp();
console.log(`Listo: ${out}`);
