import sqlite3, time
from pathlib import Path
c = sqlite3.connect(Path(__file__).resolve().parent.parent / "data" / "emt.db")
c.row_factory = sqlite3.Row
now = int(time.time())
total = c.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
print("total snapshots:", total)
snaps = c.execute("SELECT id, ts FROM snapshots ORDER BY id DESC LIMIT 14").fetchall()
prev = None
for s in snaps:
    gap = (prev - s["ts"]) if prev else 0
    n = c.execute("SELECT COUNT(*) FROM buses WHERE snapshot_id=?", (s["id"],)).fetchone()[0]
    age = now - s["ts"]
    print("  snap {:>4}  hace {:>5}s  {:>3} busos  gap_al_anterior={}s".format(s["id"], age, n, gap))
    prev = s["ts"]
# ¿cuál sería el prev que elige la API para el último? (MIN_DT_SEC=40)
cur = snaps[0]
chosen = None
for s in snaps[1:]:
    if cur["ts"] - s["ts"] >= 40:
        chosen = s
        break
print("MIN_DT_SEC=40 -> prev elegido para snap", cur["id"], "=",
      (chosen["id"] if chosen else "NINGUNO (pts=null -> dt=0 -> velocidad 0)"),
      "dt=", (cur["ts"] - chosen["ts"]) if chosen else None)
