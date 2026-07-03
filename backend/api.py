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

import os
import sqlite3
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "emt.db"
WEB = ROOT / "web"
TOKEN_FILE = ROOT / "data" / "token.txt"

app = FastAPI(title="EMTropello", version="0.1")


def _token() -> str:
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return os.environ.get("EMT_TOKEN", "").strip()


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
    if _is_lan(_client_ip(request)):
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
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def _last_snapshot(con) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1").fetchone()


@app.get("/api/buses")
def buses():
    con = _con()
    snap = _last_snapshot(con)
    if not snap:
        return {"ts": None, "n": 0, "busos": []}
    rows = con.execute(
        "SELECT gid,linea,trayecto,lat,lng,fecha FROM buses WHERE snapshot_id=?",
        (snap["id"],),
    ).fetchall()
    busos = [
        {"gid": r["gid"], "linea": r["linea"], "trayecto": r["trayecto"],
         "lat": r["lat"], "lng": r["lng"], "fecha": r["fecha"]}
        for r in rows
    ]
    return {"ts": snap["ts"], "edad_seg": int(time.time()) - snap["ts"],
            "n": len(busos), "busos": busos}


@app.get("/api/health")
def health():
    con = _con()
    snap = _last_snapshot(con)
    n = con.execute("SELECT COUNT(*) c FROM snapshots").fetchone()["c"]
    return {"ok": True, "snapshots": n, "ultimo_ts": snap["ts"] if snap else None}


if WEB.exists():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")
