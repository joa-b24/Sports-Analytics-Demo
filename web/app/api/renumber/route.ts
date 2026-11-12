import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { mapText, validMap } from "@/lib/renumber";

// «Renumerar videos» del engrane del partido: corre sportsan.ingest.renumber_videos sobre la carpeta de un partido, solo en esta
// computadora. Carpeta y mapa pasan por validaciones estrictas (nada escrito llega a la línea de comandos tal cual).
//   POST /api/renumber   {folder, map: {v1: "v2", ...}, dryRun?} -> {ok, text}
export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const local = (req: Request) => enabled() && LOCAL_HOST.test(req.headers.get("host") ?? "") && LOCAL_HOST.test(new URL(req.url).host);
const python = () => [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")].find((p) => existsSync(p));

export async function POST(req: Request) {
  if (!local(req)) return new Response("Solo disponible en esta computadora", { status: 403 });
  const body = (await req.json().catch(() => null)) as { folder?: unknown; map?: unknown; dryRun?: unknown } | null;
  const folder = typeof body?.folder === "string" ? body.folder : "";
  const raw = body?.map && typeof body.map === "object" ? (body.map as Record<string, unknown>) : {};
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") map[k] = v;
  if (!/^[\w.-]+$/.test(folder) || !existsSync(path.join(ROOT, "matches", folder))) return Response.json({ ok: false, text: "No existe la carpeta de ese partido." }, { status: 404 });
  if (!validMap(map, [])) return Response.json({ ok: false, text: "El mapa de videos no es válido." }, { status: 400 });
  const py = python();
  if (!py) return Response.json({ ok: false, text: "No se encontró .venv/Scripts/python.exe en la raíz del repositorio." }, { status: 500 });
  const args = ["-m", "sportsan.ingest.renumber_videos", folder, "--map", mapText(map), ...(body?.dryRun ? ["--dry-run"] : [])];
  const r = spawnSync(py, args, { cwd: ROOT, encoding: "utf8", timeout: 600_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  const text = `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  return Response.json({ ok: r.status === 0, text: text || (r.status === 0 ? "Listo." : "Falló sin mensaje.") });
}
