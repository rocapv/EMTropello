/* EMTropello · frontend (valencià) — busos d'EMT València en directe sobre el mapa.
   Les posicions són GPS reals (capa 384 del geoportal); el marcador llisca cap a
   la nova posició i la fletxa gira segons el desplaçament real. Punt = parat. */
const API = "";
const REFRESH_MS = 12000;   // el client demana busos a la Raspa cada 12 s
const GLIDE_MS = 12000;     // durada del lliscament entre pulls (= transició CSS)
const MOVE_MIN_M = 12;      // desplaçament mínim (m) per registrar moviment nou
const MATCH_MAX_M = 700;    // radi màxim per lligar un bus al seu marcador previ
const STILL_AFTER_MS = 50000; // sense moure's tant de temps -> es considera parat (punt)
// El GPS d'EMT refresca cada ~20-30 s, més que el nostre refresc: entre dues
// actualitzacions reals el bus manté la seua última posició. Per no pampalluguejar
// a "parat", conservem el rumb i només passem a punt després de STILL_AFTER_MS.

/* color estable i viu per línia (hash del codi -> to HSL) */
const colorCache = {};
function colorLinea(linea) {
  if (colorCache[linea]) return colorCache[linea];
  let h = 0;
  for (let i = 0; i < linea.length; i++) h = (h * 31 + linea.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const c = `hsl(${hue} 72% 58%)`;
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
const marcadores = [];             // {marker, linea, trayecto, realLL, fromLL, toLL, moving}
const lineasVisibles = new Set();
let lineasVistas = new Set();      // totes les línies observades (per a la llegenda)
let ultimoTs = 0;

const distM = (a, b) =>
  Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180) * 111000);

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
// angle en pantalla (graus) del rumb from->to, amb la projecció actual del mapa
function rumbPantalla(fromLL, toLL) {
  const pa = map.latLngToContainerPoint(fromLL), pb = map.latLngToContainerPoint(toLL);
  return Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
}
function pintarIcona(e) {
  const el = e.marker.getElement();
  if (!el) return;
  const dot = el.querySelector(".bus-dot"), arr = el.querySelector(".bus-arrow");
  if (!dot || !arr) return;
  if (e.moving && e.fromLL && e.toLL) {
    arr.style.transform = `rotate(${rumbPantalla(e.fromLL, e.toLL)}deg)`;
    arr.style.display = "block"; dot.style.display = "none";
  } else {
    arr.style.display = "none"; dot.style.display = "block";
  }
}

function popupBus(linea, trayecto, fecha) {
  const c = colorLinea(linea);
  const edat = fecha ? `<div class="pop-edat">GPS fa ${fmtEdat(fecha)}</div>` : "";
  return `<span class="pop-linea" style="background:${c}">${linea}</span>` +
    `<span class="pop-tray">${trayecto || ""}</span>${edat}`;
}
function fmtEdat(fechaMs) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(fechaMs / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ---------- emparellament estable bus<->marcador ---------- */
function pintarBusos(busos) {
  const now = Date.now();
  for (const e of marcadores) e.usado = false;
  const nuevos = [];
  const activas = new Set();

  for (const b of busos) {
    if (b.linea) activas.add(b.linea);
    if (!lineasVisibles.has(b.linea)) continue;
    const ll = [b.lat, b.lng];
    // millor marcador lliure de la mateixa línia+trajecte, dins del radi
    let best = null, bestD = Infinity;
    for (const e of marcadores) {
      if (e.usado || e.linea !== b.linea || e.trayecto !== b.trayecto) continue;
      const d = distM(e.realLL, ll);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best && bestD < MATCH_MAX_M) {
      best.usado = true;
      const disp = distM(best.realLL, ll);
      if (disp >= MOVE_MIN_M) {           // GPS actualitzat: nou tram i rumb
        best.fromLL = best.realLL; best.toLL = ll; best.realLL = ll; best.lastMove = now;
      }
      // en marxa mentre s'haja mogut fa poc; si no, passa a punt (parada/capçalera)
      best.moving = (now - best.lastMove) < STILL_AFTER_MS && !!best.fromLL;
      best.fecha = b.fecha; best.trayecto = b.trayecto;
      best.marker.setLatLng(ll);
      best.marker.setPopupContent(popupBus(b.linea, b.trayecto, b.fecha));
      pintarIcona(best);
    } else {
      const marker = L.marker(ll, { icon: iconoBus(colorLinea(b.linea)) })
        .bindPopup(popupBus(b.linea, b.trayecto, b.fecha));
      marker.addTo(busLayer);
      nuevos.push({ marker, linea: b.linea, trayecto: b.trayecto,
        realLL: ll, fromLL: null, toLL: null, moving: false, fecha: b.fecha,
        lastMove: 0, usado: true });
    }
  }
  // esborra marcadors òrfens
  for (let i = marcadores.length - 1; i >= 0; i--) {
    if (!marcadores[i].usado) { busLayer.removeLayer(marcadores[i].marker); marcadores.splice(i, 1); }
  }
  for (const e of nuevos) { marcadores.push(e); pintarIcona(e); }

  // llegenda: afig línies noves observades
  let cambio = false;
  for (const l of activas) if (!lineasVistas.has(l)) { lineasVistas.add(l); lineasVisibles.add(l); cambio = true; }
  if (cambio) construirLeyenda();
}

/* ---------- llegenda de línies (toggle) ---------- */
function construirLeyenda() {
  const ley = document.getElementById("leyenda");
  ley.innerHTML = "";
  const lineas = [...lineasVistas].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  for (const l of lineas) {
    const chip = document.createElement("span");
    chip.className = "chip" + (lineasVisibles.has(l) ? "" : " off");
    chip.textContent = l;
    chip.style.background = colorLinea(l);
    chip.onclick = () => {
      if (lineasVisibles.has(l)) { lineasVisibles.delete(l); chip.classList.add("off"); }
      else { lineasVisibles.add(l); chip.classList.remove("off"); }
      pintarBusos(ultimoBusos);
    };
    ley.appendChild(chip);
  }
  document.getElementById("ley-count").textContent = lineas.length;
}

/* ---------- refresc ---------- */
let ultimoBusos = [];
async function refrescar() {
  try {
    const data = await (await fetch(API + "api/buses?_=" + Date.now(), { cache: "no-store" })).json();
    ultimoBusos = data.busos || [];
    ultimoTs = data.ts || Math.floor(Date.now() / 1000);
    pintarBusos(ultimoBusos);
    const edad = data.edad_seg == null ? "—" : data.edad_seg + " s";
    const vis = [...lineasVisibles].length, tot = lineasVistas.size;
    const filtro = vis < tot ? `<br><span style="color:#9a9aac">${vis}/${tot} línies visibles</span>` : "";
    document.getElementById("stats").innerHTML =
      `<b>${ultimoBusos.length}</b> busos en directe<br>dades fa <b>${edad}</b>${filtro}`;
  } catch (e) {
    document.getElementById("stats").textContent = "sense connexió amb el backend";
  }
}

/* en moure/fer zoom, recalcula l'angle de les fletxes */
map.on("zoomend moveend", () => { for (const e of marcadores) pintarIcona(e); });

function tickSegon() {
  document.getElementById("reloj").textContent = new Date().toLocaleTimeString("ca-ES");
}

// panell colapsable
(function () {
  const hud = document.getElementById("hud"), btn = document.getElementById("hud-toggle");
  if (btn && hud) btn.addEventListener("click", () => {
    const col = hud.classList.toggle("collapsed");
    btn.textContent = col ? "»" : "«";
  });
})();

(async function main() {
  await refrescar();
  setInterval(refrescar, REFRESH_MS);
  setInterval(tickSegon, 1000);
  tickSegon();
})();
