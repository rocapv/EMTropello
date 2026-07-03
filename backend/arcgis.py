"""
Cliente del ArcGIS MapServer de seguimiento en vivo de EMT València.

Servicio (público, sin token):
    https://geoportal.valencia.es/server/rest/services/EMT/Seguimiento_EMT/MapServer

Capa 384 = "Buses EMT" (puntos, posición GPS real de cada autobús). Campos:
    linea     -> número/código de línea comercial ("72", "C1", "N1", ...)
    trayecto  -> sentido ("Est.del Nord - Sant Isidre")
    fecha     -> última actualización GPS del vehículo (epoch ms)
La geometría nativa está en EPSG:25830 (UTM 30N); pedimos outSR=4326 y el
servidor la reproyecta a lon/lat WGS84 -> no hace falta pyproj.
"""
from __future__ import annotations

from dataclasses import dataclass

import requests

BASE = "https://geoportal.valencia.es/server/rest/services/EMT/Seguimiento_EMT/MapServer"
BUSES_LAYER = 384
QUERY_URL = f"{BASE}/{BUSES_LAYER}/query"
TIMEOUT = 20

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://geoportal.emtvalencia.es/",
}


@dataclass
class Bus:
    gid: int
    linea: str
    trayecto: str
    lat: float
    lng: float
    fecha: int          # epoch ms de la última posición GPS del vehículo


def fetch_buses(session: requests.Session) -> list[Bus]:
    """Devuelve todos los autobuses en vivo de la capa 384 (lon/lat WGS84)."""
    params = {
        "where": "1=1",
        "outFields": "gid,linea,trayecto,fecha",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
        "resultRecordCount": "2000",
    }
    r = session.get(QUERY_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    if "features" not in data:
        raise RuntimeError(f"respuesta inesperada del servidor: {str(data)[:200]}")
    out: list[Bus] = []
    for f in data["features"]:
        a = f.get("attributes", {})
        g = f.get("geometry") or {}
        if g.get("x") is None or g.get("y") is None:
            continue
        linea = (a.get("linea") or "").strip()
        if not linea:
            continue
        out.append(
            Bus(
                gid=int(a.get("gid") or 0),
                linea=linea,
                trayecto=(a.get("trayecto") or "").strip(),
                lat=float(g["y"]),
                lng=float(g["x"]),
                fecha=int(a.get("fecha") or 0),
            )
        )
    return out
