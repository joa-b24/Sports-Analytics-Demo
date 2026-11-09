import { NextResponse, type NextRequest } from "next/server";

// Acceso remoto temporal (túnel). Solo actúa con SPORTSAN_REMOTE=1: en la laptop de siempre no hace nada.
// Con el túnel encendido TODO (páginas, video y /api/local) pide la contraseña de SPORTSAN_REMOTE_KEY; las rutas que
// ejecutan programas o tocan carpetas enteras (/api/run, /api/unzip, /api/rename) se cierran por completo.
// La contraseña viaja una vez por POST a /acceso; después, una cookie HttpOnly con un sello derivado de ella.

const COOKIE = "sportsan_acceso";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const SESSION_S = 12 * 3600;
const CLOSED = [/^\/api\/run(\/|$)/, /^\/api\/unzip(\/|$)/, /^\/api\/rename(\/|$)/];

// Intentos fallidos por origen (en memoria del servidor; se reinicia al apagarlo).
const fails = new Map<string, { n: number; until: number }>();

async function seal(key: string): Promise<string> {
  const data = new TextEncoder().encode(`sportsan-acceso:${key}`);
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const page = (msg = "") =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0f;color:#e8e9ec;font:16px system-ui,sans-serif}form{width:min(92vw,22rem);display:grid;gap:12px}
input,button{font:inherit;padding:14px;border-radius:12px;border:1px solid #333;background:#15171c;color:inherit}button{background:#2f5bea;border-color:#2f5bea;font-weight:600}p{margin:0;color:#f87171;min-height:1.2em}</style></head>
<body><form method="post" action="/acceso"><h1 style="margin:0;font-size:1.2rem">Sports Analytics</h1><input type="password" name="k" placeholder="Contraseña" autocomplete="current-password" autofocus required><button>Entrar</button><p>${msg}</p></form></body></html>`,
    { status: msg ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

export async function proxy(req: NextRequest) {
  const key = process.env.SPORTSAN_REMOTE_KEY;
  if (process.env.SPORTSAN_REMOTE !== "1") return NextResponse.next();
  if (!key || key.length < 12) return new Response("Acceso remoto mal configurado", { status: 503 });
  const { pathname } = req.nextUrl;
  const who = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "?";

  if (pathname === "/acceso" && req.method === "POST") {
    const f = fails.get(who);
    if (f && f.until > Date.now()) return page("Demasiados intentos. Espera unos minutos.");
    const given = String((await req.formData()).get("k") ?? "");
    if (!same(await seal(given), await seal(key))) {
      const n = (f && f.until > Date.now() - LOCK_MS ? f.n : 0) + 1;
      fails.set(who, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return page("Contraseña incorrecta.");
    }
    fails.delete(who);
    // Detrás del túnel req.url dice localhost: el destino se arma con el host y el protocolo que llegaron.
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
    const res = NextResponse.redirect(`${req.headers.get("x-forwarded-proto") ?? "http"}://${host}/`, 303);
    res.cookies.set(COOKIE, await seal(key), { httpOnly: true, sameSite: "strict", secure: req.headers.get("x-forwarded-proto") === "https", maxAge: SESSION_S, path: "/" });
    return res;
  }

  const ok = (req.cookies.get(COOKIE)?.value ?? "").length > 0 && same(req.cookies.get(COOKIE)?.value ?? "", await seal(key));
  if (!ok) {
    if (pathname.startsWith("/api/")) return new Response("No autorizado", { status: 401 });
    return page();
  }
  if (CLOSED.some((r) => r.test(pathname))) return new Response("No disponible en acceso remoto", { status: 404 });
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
