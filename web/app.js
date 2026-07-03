/* EMTropello · frontend (valencià) — busos d'EMT València en directe.
   La Raspa sondeja el geoportal cada 5 min i el client demana cada 1 min. NO
   s'extrapola: cada bus es pinta en la seua ÚLTIMA posició GPS real (enganxada a
   la via), i "salta"/llisca cap a la nova cada vegada que arriba dada nova. Així
   queda sobre el traçat i és exacte (extrapolar en recta el treia de la corba).
   La velocitat (posició actual - anterior) només s'usa per orientar la fletxa. */
const API = "";
const REFRESH_MS = 60000;    // el client demana busos a la Raspa cada 1 min
const ANIM_MS = 500;         // pas d'animació (reorientació de fletxes en zoom/pan)
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
// graf de la ruta de cada línia: polilínies amb longitud acumulada + nodes de
// connexió entre trams. Serveix per SIMULAR el bus avançant AL LLARG de la via.
const RG = {};                      // code -> {paths:[{pts,cum,len}], grid:Map, nodes:Map}
const CELL = 0.0006;                // ~55 m (cel·la per a l'enganxe)
const cellK = (p) => Math.round(p[0] / CELL) + "|" + Math.round(p[1] / CELL);
const nodeK = (p) => p[0].toFixed(5) + "," + p[1].toFixed(5);   // ~1 m (extrems de tram)
let ultimoTs = 0, ultimoPts = 0, edadSeg = 0;

function indexarRuta(code, rawPaths) {
  const paths = [], grid = new Map(), nodes = new Map();
  for (const raw of rawPaths) {
    if (!raw || raw.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + distM(raw[i - 1], raw[i]));
    const pi = paths.length;
    paths.push({ pts: raw, cum, len: cum[cum.length - 1] });
    for (let si = 0; si + 1 < raw.length; si++)
      for (const p of [raw[si], raw[si + 1]]) {
        const k = cellK(p);
        let a = grid.get(k); if (!a) grid.set(k, a = []);
        a.push(pi * 100000 + si);
      }
    for (const end of [0, 1]) {
      const k = nodeK(end ? raw[raw.length - 1] : raw[0]);
      let a = nodes.get(k); if (!a) nodes.set(k, a = []);
      a.push({ pi, end });
    }
  }
  RG[code] = { paths, grid, nodes };
}
// projecta p sobre a-b -> {point, dist(m), t}
function projSeg(p, a, b) {
  const cf = Math.cos(p[0] * Math.PI / 180);
  const ax = a[1] * cf, ay = a[0], bx = b[1] * cf, by = b[0], px = p[1] * cf, py = p[0];
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { point: [qy, qx / cf], dist: Math.hypot(px - qx, py - qy) * 111000, t };
}
// enganxa ll a la via -> {pi, arc(m des de l'inici de la path), dist, tang}
function snapToLine(code, ll) {
  const idx = RG[code]; if (!idx) return null;
  const cla = Math.round(ll[0] / CELL), cln = Math.round(ll[1] / CELL);
  let best = null; const seen = new Set();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = idx.grid.get((cla + i) + "|" + (cln + j));
    if (!arr) continue;
    for (const key of arr) {
      if (seen.has(key)) continue; seen.add(key);
      const pi = Math.floor(key / 100000), si = key % 100000;
      const P = idx.paths[pi], a = P.pts[si], b = P.pts[si + 1];
      const pr = projSeg(ll, a, b);
      if (!best || pr.dist < best.dist)
        best = { pi, arc: P.cum[si] + pr.t * (P.cum[si + 1] - P.cum[si]),
                 dist: pr.dist, tang: [b[0] - a[0], b[1] - a[1]] };
    }
  }
  return best;
}
// punt i tangent a `arc` metres d'una path
function pointAt(P, arc) {
  const cum = P.cum, pts = P.pts;
  arc = Math.max(0, Math.min(P.len, arc));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < arc) lo = m + 1; else hi = m; }
  const i = Math.max(1, lo), seg = cum[i] - cum[i - 1];
  const t = seg ? (arc - cum[i - 1]) / seg : 0, a = pts[i - 1], b = pts[i];
  return { pt: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
           tang: [b[0] - a[0], b[1] - a[1]] };
}
// en arribar a un extrem, tria la path que millor continua el rumb (menys gir)
function siguientePath(idx, pi, dir) {
  const P = idx.paths[pi];
  const far = dir > 0 ? P.pts[P.pts.length - 1] : P.pts[0];
  const near = dir > 0 ? P.pts[P.pts.length - 2] : P.pts[1];
  const hx = far[0] - near[0], hy = far[1] - near[1], hn = Math.hypot(hx, hy) || 1;
  const cands = idx.nodes.get(nodeK(far)); if (!cands) return null;
  let best = null, bd = -2;
  for (const c of cands) {
    if (c.pi === pi) continue;
    const Q = idx.paths[c.pi];
    const s0 = c.end ? Q.pts[Q.pts.length - 1] : Q.pts[0];
    const s1 = c.end ? Q.pts[Q.pts.length - 2] : Q.pts[1];
    const ox = s1[0] - s0[0], oy = s1[1] - s0[1], on = Math.hypot(ox, oy) || 1;
    const dot = (hx * ox + hy * oy) / (hn * on);
    if (dot > bd) { bd = dot; best = { pi: c.pi, dir: c.end ? -1 : 1 }; }
  }
  return bd > -0.4 ? best : null;   // gir massa brusc: para (el reajust de 5 min ho corregix)
}
// avança la simulació del bus `metros` al llarg de la via
function avanzarSim(e, metros) {
  const idx = RG[e.linea]; if (!idx || !e.sim) return;
  let { pi, arc, dir } = e.sim, remain = metros, guard = 0;
  while (remain > 0.01 && guard++ < 30) {
    const P = idx.paths[pi];
    const toEnd = dir > 0 ? P.len - arc : arc;
    if (remain <= toEnd) { arc += dir * remain; break; }
    remain -= toEnd;
    const nxt = siguientePath(idx, pi, dir);
    if (!nxt) { arc = dir > 0 ? P.len : 0; break; }
    pi = nxt.pi; dir = nxt.dir; arc = dir > 0 ? 0 : idx.paths[pi].len;
  }
  e.sim.pi = pi; e.sim.arc = arc; e.sim.dir = dir;
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

  for (const e of buses) e.usado = false;
  const nuevos = [];

  // registra línies noves (per si un bus circula d'una línia sense trazado)
  let cambio = false;
  for (const b of busos) if (b.linea && !lineasVistas.has(b.linea)) {
    lineasVistas.add(b.linea); lineasVisibles.add(b.linea); cambio = true;
  }

  for (const b of busos) {
    const anchor = [b.lat, b.lng];
    // vel en recta (graus/s) només per desempatar el sentit sobre la via
    let vel = [0, 0];
    if (b.plat != null && dt > 0) vel = [(b.lat - b.plat) / dt, (b.lng - b.plng) / dt];

    // REAJUSTA la simulació: enganxa la posició actual (i l'anterior) a la via i
    // calcula velocitat i sentit AL LLARG de la ruta (no en recta)
    const snC = snapToLine(b.linea, anchor);
    const snP = b.plat != null ? snapToLine(b.linea, [b.plat, b.plng]) : null;
    let sim = null, speed = 0;
    if (snC) {
      let dir = 1;
      if (snP && snP.pi === snC.pi && dt > 0) {
        speed = Math.abs(snC.arc - snP.arc) / dt;         // exacte al llarg de la via
        dir = snC.arc >= snP.arc ? 1 : -1;
      } else if (b.plat != null && dt > 0) {
        speed = 1.2 * distM([b.plat, b.plng], anchor) / dt; // recta + factor de curvatura
        if (vel[0] * snC.tang[0] + vel[1] * snC.tang[1] < 0) dir = -1;
      }
      if (speed > MAX_SPEED_MS) speed = 0;                  // emparellament dolent
      sim = { pi: snC.pi, arc: snC.arc, dir };
    } else if (b.plat != null && dt > 0) {
      speed = distM([b.plat, b.plng], anchor) / dt;         // línia sense ruta (nocturnes)
      if (speed > MAX_SPEED_MS) speed = 0;
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
      best.anchor = anchor; best.vel = vel; best.speed = speed; best.sim = sim;
      best.fecha = b.fecha; best.trayecto = b.trayecto;
      best.marker.setPopupContent(popupBus(b));
    } else {
      const marker = L.marker(sim ? pointAt(RG[b.linea].paths[sim.pi], sim.arc).pt : anchor,
        { icon: iconoBus(colorLinea(b.linea)) }).bindPopup(popupBus(b));
      marker.addTo(busLayer);
      nuevos.push({ marker, linea: b.linea, trayecto: b.trayecto, anchor, vel,
        speed, sim, fecha: b.fecha, usado: true });
    }
  }
  // esborra òrfens
  for (let i = buses.length - 1; i >= 0; i--)
    if (!buses[i].usado) { busLayer.removeLayer(buses[i].marker); buses.splice(i, 1); }
  for (const e of nuevos) buses.push(e);
  if (cambio) construirLeyenda();
}

/* ---------- animació: simula el bus avançant AL LLARG de la via ---------- */
let lastAnim = 0;
function animar() {
  const now = nowSec();
  const dtF = lastAnim ? Math.min(2, now - lastAnim) : 0;   // segons des de l'últim pas
  lastAnim = now;
  for (const e of buses) {
    const vis = lineasVisibles.has(e.linea);
    const elm = e.marker.getElement();
    if (elm) elm.style.display = vis ? "" : "none";
    if (!vis) continue;
    let ll, tang = null;
    if (e.sim) {
      if (e.speed >= MOVE_MIN_MS && dtF > 0) avanzarSim(e, e.speed * dtF);
      const P = RG[e.linea].paths[e.sim.pi];
      const pa = pointAt(P, e.sim.arc);
      ll = pa.pt;
      tang = e.sim.dir > 0 ? pa.tang : [-pa.tang[0], -pa.tang[1]];
    } else {
      ll = e.anchor;               // línia sense ruta: última posició real
      tang = [e.vel[0], e.vel[1]];
    }
    e.marker.setLatLng(ll);
    if (!elm) continue;
    const dot = elm.querySelector(".bus-dot"), arr = elm.querySelector(".bus-arrow");
    if (!dot || !arr) continue;
    if (e.speed >= MOVE_MIN_MS && tang) {
      arr.style.transform = `rotate(${bearingScreen(ll, [ll[0] + tang[0], ll[1] + tang[1]])}deg)`;
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
    // NOMÉS reajusta la simulació quan arriba una pasada NOVA (ts distint). Si no,
    // el client demana cada 1 min però la dada canvia cada 5 min: re-enganxar en
    // cada fetch faria saltar el bus arrere a la posició de fa minuts.
    if (data.ts && data.ts !== ultimoTs) {
      ultimoTs = data.ts;
      actualizarBuses(data, edadSeg);
    }
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
