"""
Mide la SINCRONIZACIÓN de la simulación: con 3 pasadas consecutivas A,B,C,
calcula la velocidad A->B (como el cliente), predice la posición en C y la
compara con la real -> error = el "salto" de corrección que ve el usuario.

Nota: usa predicción en RECTA (no seguimiento de vía), así que es una cota
CONSERVADORA; la simulación real (que sigue la polilínea) acierta más en curvas.
"""
import sqlite3, math
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "emt.db"
MATCH_M = 1000

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row


def mdist(a, b):
    return math.hypot((a[0] - b[0]) * 111000,
                      (a[1] - b[1]) * math.cos(a[0] * math.pi / 180) * 111000)


def buses_of(sid):
    d = {}
    for r in c.execute("SELECT linea,trayecto,lat,lng FROM buses WHERE snapshot_id=?", (sid,)):
        d.setdefault((r["linea"], r["trayecto"]), []).append([r["lat"], r["lng"]])
    return d


def nearest(pool, p, used):
    best, bi, bd = None, -1, MATCH_M
    for i, q in enumerate(pool):
        if i in used:
            continue
        dd = mdist(p, q)
        if dd < bd:
            bd, bi, best = dd, i, q
    return best, bi


snaps = c.execute("SELECT id, ts FROM snapshots ORDER BY id DESC LIMIT 8").fetchall()
# elige 3 consecutivas con separaciones razonables (40-140 s)
trip = None
for i in range(len(snaps) - 2):
    C, B, A = snaps[i], snaps[i + 1], snaps[i + 2]
    if 40 <= C["ts"] - B["ts"] <= 140 and 40 <= B["ts"] - A["ts"] <= 140:
        trip = (A, B, C)
        break
if not trip:
    print("no hay 3 pasadas ~60s consecutivas todavía; snapshots:",
          [(s["id"], s["ts"]) for s in snaps])
    raise SystemExit

A, B, C = trip
dt_ab, dt_bc = B["ts"] - A["ts"], C["ts"] - B["ts"]
print(f"A={A['id']} B={B['id']} C={C['id']}  dt_ab={dt_ab}s dt_bc={dt_bc}s")

Ad, Bd, Cd = buses_of(A["id"]), buses_of(B["id"]), buses_of(C["id"])
err_pred, err_static, speeds = [], [], []
usedA, usedC = {}, {}
for key, bpool in Bd.items():
    apool, cpool = Ad.get(key, []), Cd.get(key, [])
    ua = usedA.setdefault(key, set())
    uc = usedC.setdefault(key, set())
    for bp in bpool:
        a, ai = nearest(apool, bp, ua)
        cc, ci = nearest(cpool, bp, uc)
        if a is None or cc is None:
            continue
        ua.add(ai); uc.add(ci)
        v = ((bp[0] - a[0]) / dt_ab, (bp[1] - a[1]) / dt_ab)
        pred = [bp[0] + v[0] * dt_bc, bp[1] + v[1] * dt_bc]
        err_pred.append(mdist(pred, cc))       # error con predicción
        err_static.append(mdist(bp, cc))       # error si NO se predijera (bus quieto)
        speeds.append(mdist(a, bp) / dt_ab)


def stats(x):
    x = sorted(x)
    n = len(x)
    if not n:
        return "n=0"
    return (f"n={n}  mediana={x[n//2]:.0f}m  p90={x[int(n*0.9)]:.0f}m  "
            f"media={sum(x)/n:.0f}m  max={x[-1]:.0f}m")


print("velocidad estimada:      ", stats(speeds).replace("m", " m/s"))
print("error CON predicción:    ", stats(err_pred), "  <- salto de corrección")
print("error SIN predecir (base):", stats(err_static), "  <- cuánto se movió el bus")
mov = [s for s in speeds if s > 0.7]
print(f"buses en marcha (>0.7 m/s): {len(mov)}/{len(speeds)}")
