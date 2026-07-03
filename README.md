# EMTropello · busos d'EMT València en directe

Visualitza en temps real els autobusos de l'**EMT de València** com a punts/fletxes
que es mouen sobre un mapa Leaflet fosc. Les posicions són **GPS reals** (no estimades):
es prenen de la capa de seguiment en viu del geoportal municipal.

![live](https://img.shields.io/badge/dades-en%20directe-35d07f)

## Font de dades

ArcGIS MapServer públic (sense token) del geoportal de l'Ajuntament de València:

```
https://geoportal.valencia.es/server/rest/services/EMT/Seguimiento_EMT/MapServer
```

- **Capa 384 · «Buses EMT»** (punts) — un registre per autobús en circulació. Camps:
  - `linea` — codi de línia comercial (`72`, `C1`, `N1`, …)
  - `trayecto` — sentit (`Est.del Nord - Sant Isidre`)
  - `fecha` — última actualització GPS del vehicle (epoch ms)
- La geometria nativa és **EPSG:25830** (UTM 30N); demanem `outSR=4326` i el servidor
  la reprojecta a lon/lat WGS84 → no cal `pyproj`.
- Hi ha ~300 busos en directe i ~40 línies segons l'hora.
- ⚠️ El camp `gid` (ObjectID) **no és estable** entre consultes: es reassigna a cada
  refresc. Per això la identitat de cada bus es reconstrueix al frontend per
  proximitat (mateixa línia + sentit → marcador més pròxim), no per `gid`.

## Arquitectura

- `backend/arcgis.py` — client de la capa 384 (retorna `Bus(linea, trayecto, lat, lng, fecha)`).
- `backend/poller.py` — sondeja cada **15 s** i persisteix a SQLite `data/emt.db`
  (`snapshots` + `buses`); poda a les últimes 40 pasades.
- `backend/api.py` — FastAPI: `GET /api/buses` (últim snapshot) i `/api/health`;
  serveix el frontend estàtic de `web/`. Accés lliure en LAN, token fora de la LAN.
- `web/` — Leaflet (CartoDB dark). Cada bus és una **fletxa** girada al rumb del seu
  desplaçament real, o un **punt** si porta ~50 s parat (parada/capçalera). El marcador
  llisca cap a la nova posició entre pasades. Llegenda de línies amb toggle.

Com el GPS d'EMT refresca cada ~20-30 s (més que el nostre refresc), un bus conserva
el seu rumb entre actualitzacions i només passa a punt després d'estar realment aturat.

## Ús local

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
python -m backend.poller --once          # una passada de prova
python -m backend.poller                 # bucle continu (15 s)
python -m uvicorn backend.api:app --port 8791
# obri http://127.0.0.1:8791/
```

## Desplegament (Raspa)

Dos serveis systemd (`deploy/emtropello-poller.service`, sondeig cada **5 min** +
`emtropello-web.service`) i un `conf` d'Apache (`deploy/apache-emtropello.conf`) que
fa de proxy invers a `127.0.0.1:8791` **només per a la LAN** → `http://192.168.1.100/EMT/`.
El client (navegador) demana dades a la Raspa cada **1 min**.

UI en valencià. Dades © Ajuntament de València (geoportal obert). Projecte no oficial.
