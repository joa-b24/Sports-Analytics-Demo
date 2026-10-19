// Copies the self-contained server that `npm run build` leaves in ../web/.next/standalone (with its static files and
// public/) into ./server, which electron-builder ships as a resource.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");
const standalone = join(web, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("Falta la compilación de la app: en web/, corre `npm run build` primero.");
  process.exit(1);
}
const out = join(here, "server");
rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, { recursive: true });
cpSync(join(web, ".next", "static"), join(out, ".next", "static"), { recursive: true });
if (existsSync(join(web, "public"))) cpSync(join(web, "public"), join(out, "public"), { recursive: true });
console.log("Servidor copiado en desktop/server");
