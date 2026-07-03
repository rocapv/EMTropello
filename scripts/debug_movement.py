"""Diagnóstico: ¿generan movimiento los snapshots? Empareja por línea+trayecto+cercanía."""
import sqlite3, time, math
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "emt.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
now = int(time.time())
snaps = c.execute("SELECT id, ts FROM snapshots ORDER BY id DESC LIMIT 6").fetchall()
print(f"snapshots totales: {c.execute('SELECT COUNT(*) FROM snapshots').fetchone()[0]}")
for s in snaps:
    n = c.execute("SELECT COUNT(*) FROM buses WHERE snapshot_id=?", (s["id"],)).fetchone()[0]
    print(f"  snap {s['id']}  hace {now - s['ts']:5d}s  {n} busos")

if len(snaps) >= 2:
    b, a = snaps[0]["id"], snaps[1]["id"]        # b=último, a=anterior
    dt = snaps[0]["ts"] - snaps[1]["ts"]
    prev = {}
    for r in c.execute("SELECT linea,trayecto,lat,lng FROM buses WHERE snapshot_id=?", (a,)):
        prev.setdefault((r["linea"], r["trayecto"]), []).append((r["lat"], r["lng"]))
    moved = tot = 0
    dmax = 0.0
    for r in c.execute("SELECT linea,trayecto,lat,lng FROM buses WHERE snapshot_id=?", (b,)):
        cands = prev.get((r["linea"], r["trayecto"]))
        if not cands:
            continue
        best = min(cands, key=lambda p: math.hypot((r["lat"]-p[0])*111000, (r["lng"]-p[1])*85000))
        d = math.hypot((r["lat"]-best[0])*111000, (r["lng"]-best[1])*85000)
        if d < 2600:
            tot += 1
            dmax = max(dmax, d)
            if d > 20:
                moved += 1
    print(f"\nentre snap {a}->{b} (dt={dt}s): {moved}/{tot} buses emparejados se movieron >20m; desplazamiento max={dmax:.0f}m")
