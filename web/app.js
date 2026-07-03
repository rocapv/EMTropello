/* EMTropello · frontend (valencià) — busos d'EMT València en directe.
   La Raspa sondeja el geoportal cada 5 min i el client demana cada 1 min; entre
   dades reals el bus es MOU per estima (dead reckoning): el servidor dóna la
   posició actual i l'anterior de cada bus -> calculem la velocitat i avancem el
   marcador de forma contínua a eixa velocitat, corregint a cada dada nova. */
const API = "";
const REFRESH_MS = 60000;    // el client demana busos a la Raspa cada 1 min
const ANIM_MS = 500;         // pas d'animació (estima)
const EXTRAP_MAX_S = 330;    // no extrapolar més enllà d'això (evita que un bus vole)
const MATCH_MAX_M = 3000;    // radi per reidentificar un bus entre pulls
const MOVE_MIN_MS = 0.7;     // velocitat mínima (m/s) per pintar-lo "en marxa"
const MAX_SPEED_MS = 25;     // per damunt d'això => emparellament dolent, el deixem parat

/* color estable i viu per línia (hash del codi -> to HSL) */
const colorCache = {};
function colorLinea(linea) {
  if (colorCache[linea]) return colorCache[linea];
  let h = 0;
  for (let i = 0; i < linea.length; i++) h = (h * 31 + linea.charCodeAt(i)) >>> 0;
  const c = `hsl(${h % 360} 72% 60%)`;
  colorCache[linea] = c;
  return c;
}

const map = L.map("map", { zoomControl: false, attributionControl: false })
  .setView([39.47, -0.376], 13);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
  { maxZoom: 20, subdomains: "abcd" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png",
  { maxZoom: 20, subdomains: "abcd", opacity: 0.7 }).addTo(map);

const busLayer = L.layerGroup().addTo(map);
const buses = [];                  // estat viu de cada bus
const routeLayers = {};            // code -> L.layerGroup (trazado)
const lineasVisibles = new Set();
const lineasVistas = new Set();
const stopsLayer = L.layerGroup();  // parades (visibles en acostar el zoom)
const STOP_ZOOM = 14;               // a partir d'ací es mostren les parades
// índex espacial de la ruta de cada línia, per "enganxar" el bus a la via
const lineSegs = {};                // code -> [{a:[lat,lng], b:[lat,lng]}]
const lineGrid = {};                // code -> Map(cel·la -> [idx de segment])
const CELL = 0.0006;                // ~55 m en latitud
const SNAP_MAX_M = 55;              // si el bus està més lluny de la via, no s'enganxa
let ultimoTs = 0, ultimoPts = 0, edadSeg = 0;

function indexarRuta(code, paths) {
  const segs = [], grid = new Map();
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const idx = segs.length;
      segs.push({ a: path[i], b: path[i + 1] });
      for (const p of [path[i], path[i + 1]]) {
        const k = Math.round(p[0] / CELL) + "|" + Math.round(p[1] / CELL);
        let arr = grid.get(k);
        if (!arr) grid.set(k, arr = []);
        if (arr[arr.length - 1] !== idx) arr.push(idx);
      }
    }
  }
  lineSegs[code] = segs; lineGrid[code] = grid;
}
// projecta p sobre el segment a-b (pla local escalant lng per cos(lat))
function projSeg(p, a, b) {
  const cf = Math.cos(p[0] * Math.PI / 180);
  const ax = a[1] * cf, ay = a[0], bx = b[1] * cf, by = b[0], px = p[1] * cf, py = p[0];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { point: [qy, qx / cf], dist: Math.hypot(px - qx, py - qy) * 111000, a, b };
}
// millor punt de la via de la línia més pròxim a ll (o null)
function snapToLine(code, ll) {
  const grid = lineGrid[code], segs = lineSegs[code];
  if (!grid) return null;
  const cla = Math.round(ll[0] / CELL), cln = Math.round(ll[1] / CELL);
  let best = null; const seen = new Set();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = grid.get((cla + i) + "|" + (cln + j));
    if (!arr) continue;
    for (const idx of arr) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      const s = segs[idx], pr = projSeg(ll, s.a, s.b);
      if (!best || pr.dist < best.dist) best = pr;
    }
  }
  return best;
}
function bearingScreen(from, to) {
  const a = map.latLngToContainerPoint(from), b = map.latLngToContainerPoint(to);
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

const nowSec = () => Date.now() / 1000;
const distM = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180) * 111000);

/* ---------- trazado de línies (estàtic) ---------- */
async function cargarRed() {
  let net;
  try { net = await (await fetch(API + "api/network")).json(); }
  catch (e) { return; }
  const routes = net.routes || {};
  for (const [code, info] of Object.entries(routes)) {
    const paths = info.paths || [];
    if (!paths.length) continue;
    const grp = L.layerGroup();
    for (const path of paths) {
      L.polyline(path, { color: colorLinea(code), weight: 2, opacity: 0.45,
        smoothFactor: 1.5, interactive: false }).addTo(grp);
    }
    routeLayers[code] = grp;
    lineasVistas.add(code); lineasVisibles.add(code);
    indexarRuta(code, paths);
    grp.addTo(map);
  }
  dibujarParadas(net.stops || []);
  construirLeyenda();
}

/* ---------- parades ---------- */
function dibujarParadas(stops) {
  for (const s of stops) {
    const m = L.circleMarker([s.lat, s.lng], {
      radius: 3, color: "#0d0d12", weight: 1,
      fillColor: "#e8e8ef", fillOpacity: 0.9,
    });
    m.bindPopup(() => {
      const chips = (s.lineas || [])
        .map((l) => `<span class="pop-linea" style="background:${colorLinea(l)}">${l}</span>`).join("");
      return `<div class="pop-parada">🚏 ${s.nom || "Parada"}</div><div class="pop-parada-lin">${chips}</div>`;
    });
    m.addTo(stopsLayer);
  }
  actualizarParadas();
}
function actualizarParadas() {
  const wanted = document.getElementById("paradas-chk").checked && map.getZoom() >= STOP_ZOOM;
  if (wanted && !map.hasLayer(stopsLayer)) stopsLayer.addTo(map);
  else if (!wanted && map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
  const hint = document.getElementById("paradas-hint");
  if (hint) hint.style.display =
    (document.getElementById("paradas-chk").checked && map.getZoom() < STOP_ZOOM) ? "block" : "none";
}

/* ---------- icona: punt (parat) o fletxa (en marxa) ---------- */
function iconoBus(color) {
  return L.divIcon({
    className: "",
    html:
      `<div class="bus-wrap">` +
      `<span class="bus-dot" style="background:${color}"></span>` +
      `<svg class="bus-arrow" viewBox="0 0 24 24" width="22" height="22">` +
      `<path d="M21 12 L6 4 L11 12 L6 20 Z" fill="${color}" stroke="#fff" ` +
      `stroke-width="1.7" stroke-linejoin="round"/></svg>` +
      `</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
}
function popupBus(b) {
  const c = colorLinea(b.linea);
  const edat = b.fecha ? `<div class="pop-edat">GPS fa ${fmtEdat(b.fecha)}</div>` : "";
  return `<span class="pop-linea" style="background:${c}">${b.linea}</span>` +
    `<span class="pop-tray">${b.trayecto || ""}</span>${edat}`;
}
function fmtEdat(fechaMs) {
  const s = Math.max(0, Math.floor(nowSec()) - Math.floor(fechaMs / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ---------- refresc: assigna àncora + velocitat a cada bus ---------- */
function actualizarBuses(data, edad) {
  const busos = data.busos || [];
  const dt = (data.ts && data.pts) ? Math.max(1, data.ts - data.pts) : 0;
  const anchorClient = nowSec() - edad;   // moment client en què el bus és a l'àncora

  for (const e of buses) e.usado = false;
  const nuevos = [];

  // registra línies noves (per si un bus circula d'una línia sense trazado)
  let cambio = false;
  for (const b of busos) if (b.linea && !lineasVistas.has(b.linea)) {
    lineasVistas.add(b.linea); lineasVisibles.add(b.linea); cambio = true;
  }

  for (const b of busos) {
    const anchor = [b.lat, b.lng];
    // velocitat (graus/s) a partir de la posició anterior
    let vel = [0, 0], speed = 0;
    if (b.plat != null && dt > 0) {
      const segM = distM([b.plat, b.plng], anchor);
      speed = segM / dt;
      if (speed <= MAX_SPEED_MS) vel = [(b.lat - b.plat) / dt, (b.lng - b.plng) / dt];
      else speed = 0;   // salt impossible => emparellament dolent, el deixem quiet
    }
    // reidentifica amb un marcador existent (mateixa línia+sentit, més pròxim)
    let best = null, bestD = MATCH_MAX_M;
    for (const e of buses) {
      if (e.usado || e.linea !== b.linea || e.trayecto !== b.trayecto) continue;
      const d = distM(e.anchor, anchor);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) {
      best.usado = true;
      best.anchor = anchor; best.vel = vel; best.speed = speed;
      best.anchorClient = anchorClient; best.fecha = b.fecha;
      best.trayecto = b.trayecto;
      best.marker.setPopupContent(popupBus(b));
    } else {
      const marker = L.marker(anchor, { icon: iconoBus(colorLinea(b.linea)) })
        .bindPopup(popupBus(b));
      marker.addTo(busLayer);
      nuevos.push({ marker, linea: b.linea, trayecto: b.trayecto, anchor, vel,
        speed, anchorClient, fecha: b.fecha, shown: anchor.slice(), usado: true });
    }
  }
  // esborra òrfens
  for (let i = buses.length - 1; i >= 0; i--)
    if (!buses[i].usado) { busLayer.removeLayer(buses[i].marker); buses.splice(i, 1); }
  for (const e of nuevos) buses.push(e);
  if (cambio) construirLeyenda();
}

/* posició estimada d'un bus ara mateix */
function posEstim(e) {
  const el = Math.max(0, Math.min(EXTRAP_MAX_S, nowSec() - e.anchorClient));
  return [e.anchor[0] + e.vel[0] * el, e.anchor[1] + e.vel[1] * el];
}
function animar() {
  for (const e of buses) {
    const vis = lineasVisibles.has(e.linea);
    const elm = e.marker.getElement();
    if (elm) elm.style.display = vis ? "" : "none";
    if (!vis) continue;
    const raw = posEstim(e);
    // enganxa el bus a la via de la seua línia (si està prou a prop); l'angle de
    // la fletxa segueix la tangent de la via, orientada segons el sentit de marxa
    let ll = raw, to = [raw[0] + e.vel[0] * 30, raw[1] + e.vel[1] * 30];
    const snap = snapToLine(e.linea, raw);
    if (snap && snap.dist < SNAP_MAX_M) {
      ll = snap.point;
      let tx = snap.b[0] - snap.a[0], ty = snap.b[1] - snap.a[1];
      if (e.vel[0] * tx + e.vel[1] * ty < 0) { tx = -tx; ty = -ty; }
      to = [ll[0] + tx, ll[1] + ty];
    }
    e.shown = ll;
    e.marker.setLatLng(ll);
    if (!elm) continue;
    const dot = elm.querySelector(".bus-dot"), arr = elm.querySelector(".bus-arrow");
    if (!dot || !arr) continue;
    if (e.speed >= MOVE_MIN_MS) {
      arr.style.transform = `rotate(${bearingScreen(ll, to)}deg)`;
      arr.style.display = "block"; dot.style.display = "none";
    } else {
      arr.style.display = "none"; dot.style.display = "block";
    }
  }
}

/* ---------- llegenda (toggle línia: trazado + busos) ---------- */
function construirLeyenda() {
  const ley = document.getElementById("leyenda");
  ley.innerHTML = "";
  const lineas = [...lineasVistas].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const l of lineas) {
    const chip = document.createElement("span");
    chip.className = "chip" + (lineasVisibles.has(l) ? "" : " off");
    chip.textContent = l;
    chip.style.background = colorLinea(l);
    chip.onclick = () => {
      if (lineasVisibles.has(l)) {
        lineasVisibles.delete(l); chip.classList.add("off");
        if (routeLayers[l]) map.removeLayer(routeLayers[l]);
      } else {
        lineasVisibles.add(l); chip.classList.remove("off");
        if (routeLayers[l]) routeLayers[l].addTo(map);
      }
      animar();
    };
    ley.appendChild(chip);
  }
  document.getElementById("ley-count").textContent = lineas.length;
}

/* ---------- refresc de dades ---------- */
async function refrescar() {
  try {
    const data = await (await fetch(API + "api/buses?_=" + Date.now(), { cache: "no-store" })).json();
    edadSeg = data.edad_seg == null ? 0 : data.edad_seg;
    ultimoTs = data.ts || Math.floor(nowSec());
    actualizarBuses(data, edadSeg);
    animar();
    const edad = data.edad_seg == null ? "—" : (data.edad_seg < 90 ? data.edad_seg + " s"
      : Math.round(data.edad_seg / 60) + " min");
    const vis = [...lineasVisibles].length, tot = lineasVistas.size;
    const filtro = vis < tot ? `<br><span style="color:#9a9aac">${vis}/${tot} línies visibles</span>` : "";
    document.getElementById("stats").innerHTML =
      `<b>${(data.busos || []).length}</b> busos en directe<br>dades fa <b>${edad}</b>${filtro}`;
  } catch (e) {
    document.getElementById("stats").textContent = "sense connexió amb el backend";
  }
}

function tickSegon() {
  document.getElementById("reloj").textContent = new Date().toLocaleTimeString("ca-ES");
}

// parades: mostra/amaga segons zoom i checkbox
map.on("zoomend", actualizarParadas);
document.getElementById("paradas-chk").addEventListener("change", actualizarParadas);

// panell colapsable
(function () {
  const hud = document.getElementById("hud"), btn = document.getElementById("hud-toggle");
  if (btn && hud) btn.addEventListener("click", () => {
    const col = hud.classList.toggle("collapsed");
    btn.textContent = col ? "»" : "«";
  });
})();

(async function main() {
  await cargarRed();
  await refrescar();
  setInterval(refrescar, REFRESH_MS);
  setInterval(animar, ANIM_MS);
  setInterval(tickSegon, 1000);
  tickSegon();
})();
