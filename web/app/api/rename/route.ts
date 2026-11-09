import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Renames a match folder from the app (python -m sportsan.ingest.rename_match): the folder, match_id inside its files,
// the file names that carry it and matches/videos.csv. Only on this computer, like app/api/run; both names are checked
// against their patterns, so nothing typed reaches the command line as is.
//
//   POST /api/rename   {from, to, dryRun?} -> {ok, lines}

export const dynamic = "force-dynamic";

const ROOT = path.resolve(process.env.SPORTSAN_ROOT ?? path.join(process.cwd(), ".."));
const enabled = () => process.env.NODE_ENV !== "production" || process.env.SPORTSAN_LOCAL === "1";
const FOLDER = /^\d{4}_\d{2}_\d{2}_[a-z0-9]+(?:_[a-z0-9]+)*_vs_[a-z0-9]+(?:_[a-z0-9]+)*$/;

const python = () => {
  for (const p of [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")]) if (existsSync(p)) return p;
  return "python";
};

export async function POST(req: Request) {
  if (!enabled()) return new Response("No disponible", { status: 404 });
  const body = (await req.json().catch(() => null)) as { from?: string; to?: string; dryRun?: boolean } | null;
  const from = body?.from ?? "";
  const to = body?.to ?? "";
  if (!/^[\w.-]+$/.test(from) || !FOLDER.test(to)) return Response.json({ ok: false, lines: ["Nombre no válido."] }, { status: 400 });
  const args = ["-m", "sportsan.ingest.rename_match", from, to, ...(body?.dryRun ? ["--dry-run"] : [])];
  const lines: string[] = [];
  const code = await new Promise<number | null>((resolve) => {
    const proc = spawn(python(), args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, windowsHide: true });
    const add = (b: Buffer) => lines.push(...b.toString("utf8").split(/\r?\n/).filter((l) => l.trim()));
    proc.stdout.on("data", add);
    proc.stderr.on("data", add);
    proc.on("close", resolve);
    proc.on("error", (e) => {
      lines.push(`No se pudo ejecutar Python: ${e.message}`);
      resolve(null);
    });
  });
  return Response.json({ ok: code === 0, lines });
}
