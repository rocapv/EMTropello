"""
Extrae UNA vez la geometría de la red de EMT desde el servicio ArcGIS:
  - trazado (polilíneas) de cada línea -> data/routes.json
  - paradas (puntos, deduplicadas) -> data/stops.json

Cada grupo "Línea X" tiene sub-capas "Ruta" (polilínea) y "Paradas" (puntos)
filtradas a esa línea. Mapeamos por el NOMBRE del grupo padre ("Línea C1" -> "C1").
Las paradas se deduplican por id_parada (una parada la sirven varias líneas; su
campo `lineas` ya lista todas).

Salidas:
  routes.json = { "C1": {"color":"#rrggbb"|null, "paths":[[[lat,lng],...],...]}, ... }
  stops.json  = [ {"id":771,"nom":"Torres dels Serrans","lat":..,"lng":..,"lineas":["28","95","C1"]}, ... ]
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
OUT_STOPS = ROOT / "data" / "stops.json"
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


def clean_nom(denom: str) -> str:
    return re.sub(r"\s*\(\d+\)\s*$", "", denom or "").strip()


def layer_stops(session, lid) -> list[dict]:
    r = session.get(f"{BASE}/{lid}/query", headers=HEADERS, timeout=TIMEOUT, params={
        "where": "suprimida=0", "outFields": "id_parada,denominacion,lineas",
        "returnGeometry": "true", "outSR": "4326", "f": "json", "resultRecordCount": "5000",
    })
    out = []
    for f in r.json().get("features", []):
        a = f.get("attributes", {})
        g = f.get("geometry") or {}
        if g.get("x") is None:
            continue
        out.append({
            "id": int(a.get("id_parada") or 0),
            "nom": clean_nom(a.get("denominacion")),
            "lat": g["y"], "lng": g["x"],
            "lineas": [s.strip() for s in (a.get("lineas") or "").split(",") if s.strip()],
        })
    return out


def main():
    session = requests.Session()
    svc = session.get(BASE, params={"f": "json"}, headers=HEADERS, timeout=TIMEOUT).json()
    layers = svc.get("layers", [])
    by_id = {l["id"]: l for l in layers}

    def code_of(layer):
        parent = by_id.get(layer.get("parentLayerId"), {})
        m = re.match(r"(?:L[ií]nia|L[ií]nea)\s+(.+)", parent.get("name", ""), re.I)
        return (m.group(1) if m else parent.get("name", "")).strip()

    # --- rutas ---
    rutas = [l for l in layers if l.get("name") == "Ruta"]
    print(f"{len(rutas)} capas 'Ruta'")
    result = {}
    for l in rutas:
        code = code_of(l)
        if not code:
            continue
        paths = layer_paths(session, l["id"])
        result[code] = {"color": layer_color(session, l["id"]), "paths": paths}
        time.sleep(0.03)
    OUT.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(f"{len(result)} líneas -> {OUT} ({OUT.stat().st_size/1024:.0f} KB)")

    # --- paradas (deduplicadas por id_parada) ---
    paradas_layers = [l for l in layers if l.get("name") == "Paradas"]
    print(f"{len(paradas_layers)} capas 'Paradas'")
    stops: dict[int, dict] = {}
    for l in paradas_layers:
        for s in layer_stops(session, l["id"]):
            if s["id"] and s["id"] not in stops:
                stops[s["id"]] = s
        time.sleep(0.03)
    stops_list = list(stops.values())
    OUT_STOPS.write_text(json.dumps(stops_list, ensure_ascii=False), encoding="utf-8")
    print(f"{len(stops_list)} paradas únicas -> {OUT_STOPS} ({OUT_STOPS.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
