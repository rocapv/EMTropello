"""
API de EMTropello (FastAPI).

Endpoints:
    GET /api/buses    -> autobuses en vivo del último snapshot
    GET /api/health   -> estado
Sirve además el frontend estático de ../web en la raíz.

Acceso: en RED LOCAL sin token; desde fuera de la LAN exige token (como
Metroviolencia). Token en data/token.txt (gitignored) o env EMT_TOKEN.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import threading
import time
from pathlib import Path

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import poller

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "emt.db"
WEB = ROOT / "web"
ROUTES_FILE = ROOT / "data" / "routes.json"
STOPS_FILE = ROOT / "data" / "stops.json"
TOKEN_FILE = ROOT / "data" / "token.txt"
OPEN_UNTIL_FILE = ROOT / "data" / "open_until.txt"   # epoch fins al qual l'accés extern
                                                     # és lliure (sense token); auto-caduca

app = FastAPI(title="EMTropello", version="0.1")

_NET_CACHE: dict | None = None
MATCH_MAX_M = 3000     # radi per lligar un bus amb la seua posició de la pasada anterior
MIN_DT_SEC = 40        # la pasada "anterior" ha de ser >= això d'antiga (si no, el GPS
                       # d'EMT no ha refrescat i eixiria velocitat 0 -> tot parat)

# --- Pull ON-DEMAND: NO hi ha poller de fons. El geoportal només es consulta quan
# un client demana /api/buses i la caché ha caducat (~1 min). Sense clients, zero
# consultes. Diversos clients comparteixen la mateixa caché (1 pull/min com a molt).
CACHE_TTL = 55                          # segons de validesa de la caché (~1 pull/min)
_fetch_session = requests.Session()
_fetch_lock = threading.Lock()
poller.init_db().close()                # assegura les taules (ja no ho fa el poller)


def _ensure_fresh() -> None:
    """Si la última pasada tiene > CACHE_TTL, consulta el geoportal (una sola vez,
    aunque haya varios clientes) y la guarda. Si no, no hace nada (sirve caché)."""
    con = _con()
    try:
        last = con.execute("SELECT ts FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
        if last and int(time.time()) - last["ts"] < CACHE_TTL:
            return
        if not _fetch_lock.acquire(blocking=False):
            # otro hilo ya está consultando el geoportal; servimos lo que haya
            return
        try:
            last = con.execute("SELECT ts FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
            if last and int(time.time()) - last["ts"] < CACHE_TTL:
                return
            poller.poll_once(con, _fetch_session)
        except Exception as e:  # noqa: BLE001 - si el geoportal falla, servimos la última buena
            print("ensure_fresh error:", e)
        finally:
            _fetch_lock.release()
    finally:
        con.close()


def _token() -> str:
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return os.environ.get("EMT_TOKEN", "").strip()


def _open_until() -> float:
    """Epoch fins al qual l'accés extern és lliure (sense token). Si el fitxer no
    existeix o ja ha passat, torna a exigir-se el token. S'auto-caduca."""
    try:
        return float(OPEN_UNTIL_FILE.read_text(encoding="utf-8").strip())
    except Exception:  # noqa: BLE001
        return 0.0


def _is_lan(ip: str) -> bool:
    return (
        ip in ("127.0.0.1", "::1", "localhost")
        or ip.startswith("192.168.")
        or ip.startswith("10.")
        or any(ip.startswith(f"172.{n}.") for n in range(16, 32))
    )


def _client_ip(request: Request) -> str:
    # Apache (mod_proxy) añade la IP real al final de X-Forwarded-For.
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else ""


@app.middleware("http")
async def auth_token(request: Request, call_next):
    q = request.query_params.get("token")
    if _is_lan(_client_ip(request)) or time.time() < _open_until():
        # LAN sempre lliure; a més, finestra temporal d'accés extern obert (sense
        # token) mentre no caduque open_until.txt.
        resp = await call_next(request)
    else:
        token = _token()
        ok = bool(token) and (q == token or request.cookies.get("emttoken") == token)
        if not ok:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        resp = await call_next(request)
        if q == token:
            resp.set_cookie("emttoken", token, max_age=31536000,
                            path="/EMT", httponly=True, samesite="lax")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


def _con() -> sqlite3.Connection:
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")     # lectors i escriptor concurrents
    con.execute("PRAGMA busy_timeout=10000")
    return con


def _cur_prev_snapshots(con):
    """Última pasada + una pasada anterior de >= MIN_DT_SEC (para que haya
    desplazamiento real; si no hay suficiente historial, la más antigua)."""
    snaps = con.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 40").fetchall()
    if not snaps:
        return None, None
    cur = snaps[0]
    prev = None
    for s in snaps[1:]:
        if cur["ts"] - s["ts"] >= MIN_DT_SEC:
            prev = s
            break
    if prev is None and len(snaps) > 1:
        prev = snaps[-1]
    return cur, prev


def _mdist(a_lat, a_lng, b_lat, b_lng) -> float:
    return math.hypot((a_lat - b_lat) * 111000,
                      (a_lng - b_lng) * math.cos(a_lat * math.pi / 180) * 111000)


@app.get("/api/buses")
def buses():
    _ensure_fresh()          # pull on-demand al geoportal si la caché ha caducat
    con = _con()
    cur, prev = _cur_prev_snapshots(con)
    if not cur:
        return {"ts": None, "pts": None, "n": 0, "busos": []}

    # posiciones de la pasada anterior, agrupadas por (línea, trayecto)
    prev_by_key: dict = {}
    if prev:
        for r in con.execute(
            "SELECT linea,trayecto,lat,lng FROM buses WHERE snapshot_id=?", (prev["id"],)
        ):
            prev_by_key.setdefault((r["linea"], r["trayecto"]), []).append((r["lat"], r["lng"]))

    busos = []
    used: dict = {}   # evita asignar el mismo punto previo a dos buses
    for r in con.execute(
        "SELECT gid,linea,trayecto,lat,lng,fecha FROM buses WHERE snapshot_id=?", (cur["id"],)
    ):
        plat = plng = None
        cands = prev_by_key.get((r["linea"], r["trayecto"]))
        if cands:
            best_i, best_d = -1, MATCH_MAX_M
            seen = used.setdefault((r["linea"], r["trayecto"]), set())
            for i, (la, ln) in enumerate(cands):
                if i in seen:
                    continue
                d = _mdist(r["lat"], r["lng"], la, ln)
                if d < best_d:
                    best_d, best_i = d, i
            if best_i >= 0:
                seen.add(best_i)
                plat, plng = cands[best_i]
        busos.append({"linea": r["linea"], "trayecto": r["trayecto"],
                      "lat": r["lat"], "lng": r["lng"], "fecha": r["fecha"],
                      "plat": plat, "plng": plng})

    return {"ts": cur["ts"], "pts": prev["ts"] if prev else None,
            "edad_seg": int(time.time()) - cur["ts"], "n": len(busos), "busos": busos}


@app.get("/api/network")
def network():
    global _NET_CACHE
    if _NET_CACHE is None:
        routes = json.loads(ROUTES_FILE.read_text(encoding="utf-8")) if ROUTES_FILE.exists() else {}
        stops = json.loads(STOPS_FILE.read_text(encoding="utf-8")) if STOPS_FILE.exists() else []
        _NET_CACHE = {"routes": routes, "stops": stops}
    return _NET_CACHE


@app.get("/api/health")
def health():
    con = _con()
    snap = con.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()
    n = con.execute("SELECT COUNT(*) c FROM snapshots").fetchone()["c"]
    return {"ok": True, "snapshots": n, "ultimo_ts": snap["ts"] if snap else None}


if WEB.exists():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")
