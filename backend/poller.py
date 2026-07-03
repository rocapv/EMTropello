"""
Poller: sondea la capa "Buses EMT" del geoportal de València y persiste la
posición GPS de cada autobús en SQLite.

Uso:
    python -m backend.poller --once        # una pasada
    python -m backend.poller               # bucle continuo (INTERVAL s)

Tablas SQLite (data/emt.db):
    snapshots(id, ts)                                    -- una fila por pasada
    buses(snapshot_id, ts, gid, linea, trayecto, lat, lng, fecha)
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path

import requests

from .arcgis import fetch_buses

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "emt.db"

INTERVAL = 300         # segundos entre pasadas (la Raspa mira el geoportal cada 5 min)
KEEP_SNAPSHOTS = 20    # poda: conserva las últimas N pasadas (para calcular rumbo)

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS buses (
    snapshot_id INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    gid         INTEGER NOT NULL,
    linea       TEXT    NOT NULL,
    trayecto    TEXT,
    lat         REAL    NOT NULL,
    lng         REAL    NOT NULL,
    fecha       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_buses_snap ON buses(snapshot_id);
"""


def init_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    con.commit()
    return con


def poll_once(con: sqlite3.Connection, session: requests.Session) -> int:
    buses = fetch_buses(session)
    ts = int(time.time())
    cur = con.execute("INSERT INTO snapshots(ts) VALUES (?)", (ts,))
    snap_id = cur.lastrowid
    con.executemany(
        "INSERT INTO buses(snapshot_id,ts,gid,linea,trayecto,lat,lng,fecha)"
        " VALUES (?,?,?,?,?,?,?,?)",
        [(snap_id, ts, b.gid, b.linea, b.trayecto, b.lat, b.lng, b.fecha) for b in buses],
    )
    # poda: no dejamos crecer la BD sin fin
    con.execute(
        "DELETE FROM buses WHERE snapshot_id <= (SELECT MAX(id)-? FROM snapshots)",
        (KEEP_SNAPSHOTS,),
    )
    con.execute(
        "DELETE FROM snapshots WHERE id <= (SELECT MAX(id)-? FROM snapshots)",
        (KEEP_SNAPSHOTS,),
    )
    con.commit()
    lineas = len({b.linea for b in buses})
    print(f"[{time.strftime('%H:%M:%S')}] snapshot {snap_id}: "
          f"{len(buses)} busos en directe, {lineas} línies")
    return snap_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="una sola pasada y salir")
    ap.add_argument("--interval", type=int, default=INTERVAL)
    args = ap.parse_args()

    con = init_db()
    session = requests.Session()
    if args.once:
        poll_once(con, session)
        return
    while True:
        t0 = time.time()
        try:
            poll_once(con, session)
        except Exception as e:  # noqa: BLE001 - el bucle no debe morir
            print("error en pasada:", e)
        dt = time.time() - t0
        time.sleep(max(1.0, args.interval - dt))


if __name__ == "__main__":
    main()
