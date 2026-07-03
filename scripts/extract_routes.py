"""
Extrae UNA vez el trazado (polilíneas) de todas las líneas de EMT desde el
servicio ArcGIS y lo guarda en data/routes.json para dibujar la red.

Cada grupo "Línea X" tiene una sub-capa "Ruta" (polilínea) filtrada a esa línea.
Mapeamos Ruta -> línea por el NOMBRE del grupo padre ("Línea C1" -> "C1"), que es
el mismo código string que usa la capa de buses (384).

Salida: data/routes.json = { "C1": {"color":"#rrggbb"|null, "paths":[[[lat,lng],...],...]}, ... }
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import requests

from backend.arcgis import BASE, HEADERS

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "routes.json"
TIMEOUT = 30


def hexcolor(rgba) -> str | None:
    if not rgba or len(rgba) < 3:
        return None
    return "#%02x%02x%02x" % (rgba[0], rgba[1], rgba[2])


def layer_color(session, lid) -> str | None:
    try:
        meta = session.get(f"{BASE}/{lid}", params={"f": "json"},
                           headers=HEADERS, timeout=TIMEOUT).json()
        rend = (meta.get("drawingInfo") or {}).get("renderer") or {}
        sym = rend.get("symbol")
        if not sym and rend.get("uniqueValueInfos"):
            sym = rend["uniqueValueInfos"][0].get("symbol")
        if sym:
            return hexcolor(sym.get("color"))
    except Exception:  # noqa: BLE001
        pass
    return None


def layer_paths(session, lid) -> list[list[list[float]]]:
    r = session.get(f"{BASE}/{lid}/query", headers=HEADERS, timeout=TIMEOUT, params={
        "where": "1=1", "outFields": "", "returnGeometry": "true",
        "outSR": "4326", "f": "json", "resultRecordCount": "5000",
    })
    data = r.json()
    out = []
    for f in data.get("features", []):
        for path in (f.get("geometry") or {}).get("paths", []):
            # ArcGIS: [lng,lat] -> Leaflet [lat,lng]
            out.append([[pt[1], pt[0]] for pt in path])
    return out


def main():
    session = requests.Session()
    svc = session.get(BASE, params={"f": "json"}, headers=HEADERS, timeout=TIMEOUT).json()
    layers = svc.get("layers", [])
    by_id = {l["id"]: l for l in layers}

    rutas = [l for l in layers if l.get("name") == "Ruta"]
    print(f"{len(rutas)} capas 'Ruta' encontradas")

    result = {}
    for l in rutas:
        parent = by_id.get(l.get("parentLayerId"), {})
        gname = parent.get("name", "")
        m = re.match(r"(?:L[ií]nia|L[ií]nea)\s+(.+)", gname, re.I)
        code = (m.group(1) if m else gname).strip()
        if not code:
            continue
        paths = layer_paths(session, l["id"])
        color = layer_color(session, l["id"])
        result[code] = {"color": color, "paths": paths}
        npts = sum(len(p) for p in paths)
        print(f"  {code:>4}  ruta id {l['id']:>3}  {len(paths):>2} tramos, {npts:>4} pts, color {color}")
        time.sleep(0.05)

    OUT.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    size = OUT.stat().st_size
    cols = {v["color"] for v in result.values()}
    print(f"\n{len(result)} líneas -> {OUT} ({size/1024:.0f} KB); {len(cols)} colores distintos")


if __name__ == "__main__":
    main()
