"""Descarga de Strava las sesiones de una atleta, con el detalle por segundo, sin pedir el archivo de la cuenta.

Uso (desde la raíz del repo, con .venv activado):
    python -m sportsan.ingest.strava_sync auth --client-id 12345 --client-secret abc...   # una sola vez
    python -m sportsan.ingest.strava_sync sync --after 2026-08-01    # la primera vez: desde qué fecha
    python -m sportsan.ingest.strava_sync sync                        # después: solo lo nuevo
    python -m sportsan.ingest.strava_sync sync --sport Soccer Run     # qué deportes llevan detalle (por defecto, Soccer)

Qué escribe, todo en data/strava/ (fuera del repo):
    activities.json    resumen de TODAS las actividades desde la fecha (cualquier deporte: toda carga cuenta)
    <id>.json          una por actividad de los deportes elegidos: resumen completo, vueltas y series por segundo
    sessions.csv       las de los deportes elegidos en el formato que importa la app (Entrenamientos)

Las credenciales quedan en config/strava.local.json (fuera del repo). Solo usa la biblioteca estándar de Python.
Una aplicación nueva de Strava admite a una sola atleta (su dueña) y unas 100 peticiones cada 15 minutos: cada
actividad con detalle cuesta dos. Si se llega al límite el programa se detiene y al volver a correrlo sigue.
"""
from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from ..config import project_root

API = "https://www.strava.com/api/v3"
OAUTH = "https://www.strava.com/oauth"
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/exchange_token"
SCOPE = "read,activity:read_all"
STREAM_KEYS = ("time", "distance", "latlng", "heartrate", "velocity_smooth", "cadence", "altitude", "moving")
DEFAULT_SPORTS = ("Soccer",)
# Columnas de sessions.csv. Las tres primeras son las que la app exige; el resto son métricas numéricas.
SESSION_COLUMNS = ["date", "session_id", "player_id", "football", "duration_min", "moving_min", "distance_m", "hr_avg", "hr_max",
                   "speed_avg_ms", "speed_max_ms", "relative_effort", "rpe"]
# Campos del resumen que se guardan en activities.json.
SUMMARY_FIELDS = ("id", "name", "sport_type", "start_date", "start_date_local", "elapsed_time", "moving_time", "distance",
                  "average_heartrate", "max_heartrate", "average_speed", "max_speed", "total_elevation_gain", "has_heartrate",
                  # "Esfuerzo relativo" de Strava: sale del tiempo en cada zona de frecuencia cardiaca (fórmula no publicada).
                  "suffer_score")


class RateLimited(RuntimeError):
    pass


# ---------------------------------------------------------------- funciones puras

def token_expired(creds: dict, now: float, margin_s: float = 300.0) -> bool:
    """El token de acceso dura 6 horas; se renueva si falta o si le quedan menos de `margin_s`."""
    return not creds.get("access_token") or float(creds.get("expires_at") or 0) - now < margin_s


def wanted(activity: dict, sports: tuple[str, ...] | list[str]) -> bool:
    """¿Esta actividad lleva detalle? Compara sport_type (o type, en actividades antiguas) sin mayúsculas."""
    kind = str(activity.get("sport_type") or activity.get("type") or "").lower()
    return kind in {s.lower() for s in sports}


def summary_of(activity: dict) -> dict:
    out = {k: activity.get(k) for k in SUMMARY_FIELDS}
    out["sport_type"] = activity.get("sport_type") or activity.get("type")
    return out


def session_row(activity: dict, player_id: str, football: bool = True) -> dict:
    """Fila de sessions.csv de una actividad. Lo que Strava no trae queda vacío: no se estima nada."""
    def num(key, scale=1.0, digits=1):
        v = activity.get(key)
        return "" if v is None else round(float(v) * scale, digits)

    return {
        "date": str(activity.get("start_date_local") or "")[:10],
        "session_id": f"strava_{activity['id']}",
        "player_id": player_id,
        # 1 si es una sesión de fútbol; las demás también cuentan para la carga, pero no para las gráficas de fútbol.
        "football": 1 if football else 0,
        "duration_min": num("elapsed_time", 1 / 60),
        "moving_min": num("moving_time", 1 / 60),
        "distance_m": num("distance", 1.0, 0),
        "hr_avg": num("average_heartrate"),
        "hr_max": num("max_heartrate", 1.0, 0),
        "speed_avg_ms": num("average_speed", 1.0, 2),
        "speed_max_ms": num("max_speed", 1.0, 2),
        "relative_effort": num("suffer_score", 1.0, 0),
        # Esfuerzo percibido (1-10) que la atleta anota en Strava; solo viene en el detalle de la actividad.
        "rpe": num("perceived_exertion", 1.0, 0),
    }


def streams_by_type(payload) -> dict:
    """Series de una actividad como {tipo: [valores]}. Strava las devuelve por tipo o como lista, según la petición."""
    if isinstance(payload, dict):
        return {k: v.get("data", []) for k, v in payload.items() if isinstance(v, dict)}
    return {s["type"]: s.get("data", []) for s in payload or [] if isinstance(s, dict) and "type" in s}


def after_epoch(date: str) -> int:
    """'2026-08-01' -> segundos desde 1970 (inicio de ese día, UTC)."""
    return int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def merge_summaries(old: list[dict], new: list[dict]) -> list[dict]:
    """Une dos listas de resúmenes por id (gana el más reciente), de la más antigua a la más nueva."""
    by_id = {a["id"]: dict(a) for a in old}
    for a in new:
        # Lo que solo trae el detalle (esfuerzo relativo) no se pierde si el resumen nuevo no lo tiene.
        by_id[a["id"]] = {**by_id.get(a["id"], {}), **{k: v for k, v in a.items() if v is not None or k not in by_id.get(a["id"], {})}}
    return sorted(by_id.values(), key=lambda a: str(a.get("start_date") or ""))


# ---------------------------------------------------------------- red y archivos

def _request(url: str, data: dict | None = None, token: str | None = None):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise RateLimited("Strava pide esperar (límite de peticiones). Vuelve a correr el comando en 15 minutos.") from e
        detail = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"Strava respondió {e.code} a {url.split('?')[0]}: {detail}") from e


def creds_path() -> Path:
    return project_root() / "config" / "strava.local.json"


def out_dir() -> Path:
    return project_root() / "data" / "strava"


def load_creds() -> dict:
    p = creds_path()
    if not p.exists():
        raise SystemExit("Falta la autorización. Corre primero: python -m sportsan.ingest.strava_sync auth --client-id ... --client-secret ...")
    return json.loads(p.read_text(encoding="utf-8"))


def save_creds(creds: dict) -> None:
    p = creds_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(creds, indent=2), encoding="utf-8")


def access_token(creds: dict) -> str:
    if token_expired(creds, time.time()):
        t = _request(f"{OAUTH}/token", {"client_id": creds["client_id"], "client_secret": creds["client_secret"],
                                         "grant_type": "refresh_token", "refresh_token": creds["refresh_token"]})
        creds.update(access_token=t["access_token"], refresh_token=t["refresh_token"], expires_at=t["expires_at"])
        save_creds(creds)
    return creds["access_token"]


def cmd_auth(args) -> None:
    query = urllib.parse.urlencode({"client_id": args.client_id, "response_type": "code", "redirect_uri": REDIRECT,
                                    "approval_prompt": "force", "scope": SCOPE})
    url = f"{OAUTH}/authorize?{query}"
    got: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (nombre que exige http.server)
            got.update({k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p>Listo. Ya puedes cerrar esta pestaña y volver a la terminal.</p>".encode("utf-8"))

        def log_message(self, *_):
            pass

    print("Abre esta dirección, entra a Strava y pulsa «Autorizar» (se abre sola si hay navegador):\n")
    print(f"  {url}\n")
    print(f"En la página de tu aplicación de Strava, «Authorization Callback Domain» debe ser: localhost")
    webbrowser.open(url)
    server = HTTPServer(("localhost", PORT), Handler)
    server.timeout = 300
    while "code" not in got and "error" not in got:
        server.handle_request()
        if not got:
            raise SystemExit("No llegó la autorización en 5 minutos. Vuelve a correr el comando.")
    server.server_close()
    if "error" in got:
        raise SystemExit(f"Strava no autorizó: {got['error']}")
    if "activity:read" not in got.get("scope", ""):
        raise SystemExit("Faltó marcar el permiso de ver actividades. Vuelve a correr el comando y deja las casillas marcadas.")
    t = _request(f"{OAUTH}/token", {"client_id": args.client_id, "client_secret": args.client_secret,
                                     "code": got["code"], "grant_type": "authorization_code"})
    athlete = t.get("athlete") or {}
    save_creds({"client_id": args.client_id, "client_secret": args.client_secret, "access_token": t["access_token"],
                "refresh_token": t["refresh_token"], "expires_at": t["expires_at"],
                "athlete": {"id": athlete.get("id"), "firstname": athlete.get("firstname")}})
    print(f"Autorizado ({athlete.get('firstname') or 'atleta'}). Credenciales en {creds_path()} (no entra al repo).")
    print("Sigue: python -m sportsan.ingest.strava_sync sync --after AAAA-MM-DD")


def write_sessions_csv(folder: Path, player_id: str, sports) -> int:
    """Una fila por actividad del índice: las de los deportes elegidos con su detalle (trae el esfuerzo percibido), las
    demás con su resumen. Todas cuentan para la carga."""
    rows = []
    index_path = folder / "activities.json"
    for a in json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []:
        detail = folder / f"{a['id']}.json"
        act = json.loads(detail.read_text(encoding="utf-8"))["activity"] if detail.exists() else a
        rows.append(session_row({**a, **{k: v for k, v in act.items() if v is not None}}, player_id, wanted(a, sports)))
    rows.sort(key=lambda r: r["date"])
    with open(folder / "sessions.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=SESSION_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def cmd_sync(args) -> None:
    creds = load_creds()
    folder = out_dir()
    folder.mkdir(parents=True, exist_ok=True)
    index_path = folder / "activities.json"
    known = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    if args.after:
        after = after_epoch(args.after)
    elif known:
        # Desde la última conocida (un día antes, por si se editó o subió tarde).
        last = max(str(a.get("start_date") or "") for a in known)
        after = int(datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp()) - 86400
    else:
        raise SystemExit("La primera vez hay que decir desde cuándo: --after AAAA-MM-DD")
    player = args.player or (creds.get("athlete") or {}).get("firstname") or "yo"

    try:
        fresh, page = [], 1
        while True:
            batch = _request(f"{API}/athlete/activities?after={after}&per_page=100&page={page}", token=access_token(creds))
            fresh += batch
            if len(batch) < 100:
                break
            page += 1
        known = merge_summaries(known, [summary_of(a) for a in fresh])
        index_path.write_text(json.dumps(known, ensure_ascii=False, indent=1), encoding="utf-8")
        todo = [a for a in known if wanted(a, args.sport) and (args.force or not (folder / f"{a['id']}.json").exists())]
        print(f"{len(fresh)} actividad(es) desde la fecha; {len(known)} en el índice; {len(todo)} por bajar con detalle ({', '.join(args.sport)}).")
        for n, a in enumerate(todo, 1):
            token = access_token(creds)
            detail = _request(f"{API}/activities/{a['id']}", token=token)
            streams = _request(f"{API}/activities/{a['id']}/streams?keys={','.join(STREAM_KEYS)}&key_by_type=true", token=token)
            series = streams_by_type(streams)
            (folder / f"{a['id']}.json").write_text(json.dumps({
                "schema_version": 1,
                "source": "strava",
                "activity": {**summary_of(detail), "perceived_exertion": detail.get("perceived_exertion"),
                             "description": detail.get("description"), "device_name": detail.get("device_name")},
                "laps": [{k: lap.get(k) for k in ("name", "lap_index", "start_index", "end_index", "elapsed_time", "moving_time",
                                                   "distance", "average_heartrate", "max_heartrate", "average_speed", "max_speed")}
                         for lap in detail.get("laps") or []],
                # Series por segundo, todas del mismo largo. Las que el reloj no grabó no aparecen.
                "streams": series,
            }, ensure_ascii=False), encoding="utf-8")
            print(f"  [{n}/{len(todo)}] {str(a.get('start_date_local'))[:10]} {a.get('name')}: {len(series.get('time', []))} muestras, series: {', '.join(sorted(series))}")
        # Las demás actividades: solo el detalle (una petición), para su esfuerzo relativo. Toda carga cuenta.
        rest = [a for a in known if not wanted(a, args.sport) and (args.force or not a.get("detail_checked"))]
        if rest:
            print(f"{len(rest)} actividad(es) de otros deportes: se pide su esfuerzo relativo.")
        for a in rest:
            d = _request(f"{API}/activities/{a['id']}", token=access_token(creds))
            a.update(suffer_score=d.get("suffer_score"), perceived_exertion=d.get("perceived_exertion"), detail_checked=True)
            index_path.write_text(json.dumps(known, ensure_ascii=False, indent=1), encoding="utf-8")
    except RateLimited as e:
        print(f"\n{e}")
    n = write_sessions_csv(folder, player, args.sport)
    print(f"sessions.csv: {n} sesión(es) de {player}. Carpeta: {folder}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Descarga sesiones de Strava con detalle por segundo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("auth", help="autoriza tu cuenta (una sola vez)")
    a.add_argument("--client-id", required=True)
    a.add_argument("--client-secret", required=True)
    a.set_defaults(fn=cmd_auth)
    s = sub.add_parser("sync", help="baja lo que falte")
    s.add_argument("--after", help="AAAA-MM-DD; sin él, desde la última actividad ya descargada")
    s.add_argument("--sport", nargs="+", default=list(DEFAULT_SPORTS), help="deportes que llevan detalle (sport_type de Strava)")
    s.add_argument("--player", help="identificador de la jugadora en sessions.csv (por defecto, tu nombre en Strava)")
    s.add_argument("--force", action="store_true", help="vuelve a bajar las que ya están")
    s.set_defaults(fn=cmd_sync)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
