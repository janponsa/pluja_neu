// Crear un worker inline com a Blob per la generació del GIF
var gifWorkerBlob = new Blob([
  `importScripts('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')`
], { type: 'application/javascript' });

var gifWorkerUrl = URL.createObjectURL(gifWorkerBlob);

// Configuració inicial
const max_range_steps = 30;
const increment_mins = 6;
const possibles_mins = Array.from({ length: 10 }, (_, i) => i * 6);
let range_values = [];
const range_element = document.getElementById('range-slider');

// Variables d'animació
let isPlaying = false;
let animationInterval = null;
const animationSpeed = 130;
const pauseOnLastFrame = 1200;

// Variables GIF
let gif = null;
let captureInProgress = false;
const totalGifFrames = 30;
const gifFrameDelay = 100;

// Funció per formatar números
const fillTo = (num, length) => String(num).padStart(length, '0');

// Capa personalitzada sense parpelleig
L.TileLayerNoFlickering = L.TileLayer.extend({
  _refreshTileUrl: function(tile, url) {
    const img = new Image();
    img.onload = () => L.Util.requestAnimFrame(() => tile.el.src = url);
    img.src = url;
  },
  refresh: function() {
    const wasAnimated = this._map._fadeAnimated;
    this._map._fadeAnimated = false;

    Object.keys(this._tiles).forEach(key => {
      const tile = this._tiles[key];
      if (tile.current && tile.active) {
        const oldsrc = tile.el.src;
        const newsrc = this.getTileUrl(tile.coords);
        if (oldsrc !== newsrc) this._refreshTileUrl(tile, newsrc);
      }
    });

    if (wasAnimated) setTimeout(() => this._map._fadeAnimated = wasAnimated, 5000);
  }
});

L.tileLayerNoFlickering = (url, options) => new L.TileLayerNoFlickering(url, options);

// Funció per generar dades temporals
function setRangeValues() {
  range_values = [];
  let curr_date = new Date();

  const curr_min = curr_date.getUTCMinutes();
  const min = Math.max(...possibles_mins.filter(m => m <= curr_min));
  curr_date.setUTCMinutes(min, 0, 0);

  for (let i = 0; i < max_range_steps; i++) {
    range_values.push({
      any: curr_date.getUTCFullYear(),
      mes: curr_date.getUTCMonth() + 1,
      dia: curr_date.getUTCDate(),
      hora: curr_date.getUTCHours(),
      min: curr_date.getUTCMinutes(),
      utctime: curr_date.getTime()
    });
    curr_date = new Date(curr_date.getTime() - (increment_mins * 60 * 1000));
  }
  range_values.reverse();
}

// Funció per actualitzar el text amb la data actual
function setDateText(r) {
  const t = new Date(r.utctime);
  document.getElementById("plujaoneu-text").textContent =
    `${fillTo(t.getUTCDate(), 2)}/${fillTo(t.getUTCMonth() + 1, 2)}/${t.getUTCFullYear()} ` +
    `${fillTo(t.getUTCHours(), 2)}:${fillTo(t.getUTCMinutes(), 2)} UTC`;
}

// Funció extra per actualitzar el progrés (si la necessites)
function updateProgress(percent) {
  document.getElementById('progress').textContent = `${Math.round(percent)}%`;
}

// Configuració de la capa pluja/neu
const plujaneu_layer = L.tileLayerNoFlickering('https://static-m.meteo.cat/tiles/plujaneu/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
  attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
  opacity: 0.85,
  maxNativeZoom: 7
});

plujaneu_layer.getTileUrl = function(coords) {
  if (!range_values.length || range_element.value >= range_values.length) return '';

  const r = range_values[range_element.value];
  return L.Util.template(this._url, {
    any: r.any,
    mes: fillTo(r.mes, 2),
    dia: fillTo(r.dia, 2),
    hora: fillTo(r.hora, 2),
    minut: fillTo(r.min, 2),
    z: fillTo(coords.z, 2),
    x: fillTo(coords.x, 3),
    y: fillTo(Math.abs(coords.y - 127), 3)
  });
};

// Inicialització del mapa
setRangeValues();

// Creació del mapa amb Leaflet
const map = L.map('map', {
  layers: [plujaneu_layer] // Capa de dades inicials
}).setView([42.5, 1.5], 8); // Configura la vista inicial (coordenades i zoom)

// create a fullscreen button and add it to the map
L.control.fullscreen({
  position: 'topleft',
  title: 'Show me the fullscreen !',
  titleCancel: 'Exit fullscreen mode',
  content: null,
  forceSeparateButton: false,
  forcePseudoFullscreen: false, // Forçar pantalla completa real
  fullscreenElement: false // Utilitzar el contenidor del mapa
}).addTo(map);


// events are fired when entering or exiting fullscreen.
map.on('enterFullscreen', function () {
	console.log('entered fullscreen');
});

map.on('exitFullscreen', function () {
	console.log('exited fullscreen');
});

// you can also toggle fullscreen from map object
map.toggleFullscreen();

// Afegim un esdeveniment per canviar l'opacitat de les capes en funció de la capa activa
map.on('baselayerchange', function(event) {
  if (event.layer === baseLayers.Blanc) {
    // Quan la capa "FonsBlanc" és seleccionada, establim l'opacitat a 0%
    plujaneu_layer.setOpacity(1); // Estableix opacitat per a la capa plujaneu
    // Aquí pots afegir altres capes si vols que tinguin opacitat 0.85
  } else {
    // Per a qualsevol altra capa, mantindrem l'opacitat a 0.85
    plujaneu_layer.setOpacity(0.85); // Estableix opacitat per a la capa plujaneu
  }
});


const baseLayers = {
  "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }),
  "Topografia": L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>'
  }),
  "Satèl·lit": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© <a href="https://www.arcgis.com/">ESRI</a>'
  }),
  "Fosc": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://carto.com/">CARTO</a>'
  }),
"Blanc": L.tileLayer('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEX///+nxBvIAAAAH0lEQVRoge3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg==', {
    attribution: '',
    tileSize: 256,
    minZoom: 0,
    maxZoom: 20
}),
  "Meteocat": L.tileLayer('https://static-m.meteo.cat/tiles/fons/GoogleMapsCompatible/0{z}/000/000/{x}/000/000/{y}.png', {
    attribution: '© <a href="https://meteo.cat">Meteocat</a>',
    tms: true,
    minZoom: 8,
    maxZoom: 9
  }),
  // Capes WMS dins de baseLayers
  "Topografic": L.tileLayer.wms("https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wms/service?", {
    layers: 'topografic',
    format: 'image/jpeg',
    continuousWorld: true,
    attribution: 'Institut Cartogràfic i Geològic de Catalunya',
  }),
  "Administratiu": L.tileLayer.wms("https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wms/service?", {
    layers: 'administratiu',
    format: 'image/jpeg',
    continuousWorld: true,
    attribution: 'Institut Cartogràfic i Geològic de Catalunya',
  }),
  "Lidar": L.tileLayer.wms("https://wms-mapa-lidar.idee.es/lidar?", {
    layers: 'EL.GridCoverage',
    format: 'image/jpeg',
    crs: L.CRS.EPSG3857, // Corregit: EPSG s'ha d'especificar amb crs
    continuousWorld: true,
    attribution: 'Instituto Geografico Nacinal',
  })
};

// Controla el zoom només per a la capa Meteocat
function updateZoomRestrictions() {
  if (map.hasLayer(baseLayers.Meteocat)) {
    map.options.minZoom = 8;
    map.options.maxZoom = 9;
    map.setZoom(Math.max(8, Math.min(9, map.getZoom()))); // Força el zoom vàlid
  } else {
    map.options.minZoom = 1; // Valor per defecte o ajusta segons altres capes
    map.options.maxZoom = 18;
  }
}

// Actualitza les restriccions quan es canvia de capa
map.on('baselayerchange', updateZoomRestrictions);


baseLayers.OpenStreetMap.addTo(map);

// Capa WMS ICGC
const wmsLayer = L.tileLayer.wms("https://geoserveis.icgc.cat/geoserver/nivoallaus/wms", {
  layers: 'nivoallaus:zonesnivoclima',
  format: 'image/png',
  transparent: true,
  attribution: '© <a href="https://www.icgc.cat/">ICGC</a>',
  opacity: 0.7,
  version: '1.3.0',
  tileSize: 512,
  minZoom: 1,
  maxZoom: 18,
  continuousWorld: true,
  noWrap: true
});

//Boto Mapa
// Obtenim el botó de control
const lockMapBtn = document.getElementById('lock-map');

// Estableix una variable per controlar si el mapa està bloquejat o no
let isMapLocked = false;

// Afegir un esdeveniment al botó
lockMapBtn.addEventListener('click', function() {
  if (isMapLocked) {
    // Si el mapa està bloquejat, el desbloquegem
    map.dragging.enable(); // Permet moure el mapa
    map.zoomControl.enable(); // Permet utilitzar el control de zoom
    map.scrollWheelZoom.enable(); // Permet fer zoom amb el ratolí
    lockMapBtn.textContent = "🔓"; // Canvia el text del botó
  } else {
    // Si el mapa no està bloquejat, el bloquegem
    map.dragging.disable(); // Desactiva el desplaçament del mapa
    map.zoomControl.disable(); // Desactiva el control de zoom
    map.scrollWheelZoom.disable(); // Desactiva el zoom amb el ratolí
    lockMapBtn.textContent = "🔒"; // Canvia el text del botó
  }

  // Canvia l'estat de bloqueig
  isMapLocked = !isMapLocked;
});



// Capa per a les comarques (color negre suau)
var comarquesLayer = L.geoJSON(comarquesGeojson, {
  style: function(feature) {
    return {
      color: "#262626", // negre suau (pots provar també "#555" segons el que et sembli)
      weight: 1.5,
      fill: false      // Només línies, sense omplir
    };
  }
});

// Capa per als municipis (color gris)
var municipisGeojson = L.geoJSON(municipisGeojson, {
  style: function(feature) {
    return {
      color: "#4F4F4F", // gris
      weight: 1.2,
      fill: false      // Només línies, sense omplir
    };
  }
});

// Creem un layer group per als markers de càmeres
const camerasLayer = L.layerGroup();

// Afegim els controls de capes. Incloem la capa "Càmeres" com a overlay.
L.control.layers(baseLayers, {
  "Precipitació": plujaneu_layer,
  "Zones de Perill d'Allaus": wmsLayer,
  "Live cams": camerasLayer,
  "Comarques": comarquesLayer,
  "Municipis": municipisGeojson
}, {
  position: 'topright'
}).addTo(map);

// Si vols que la capa de càmeres estigui activa per defecte, descomenta la línia següent:
// camerasLayer.addTo(map);

/* ======================================================
   Afegir markers dels webcams al mapa
   ====================================================== */
// Definició d'una icona personalitzada per als webcams (amb l'emoji de càmera)
const cameraIcon = L.divIcon({
  html: '<span style="font-size:24px;">📍</span>',
  className: 'webcam-icon', // Pots afegir estils addicionals amb CSS
  iconSize: [30, 30],
  iconAnchor: [15, 15] // Centra l'emoji sobre la coordenada
});

// Comprovem que l'array 'webcamPoints' existeix i és un array
if (typeof webcamPoints !== 'undefined' && Array.isArray(webcamPoints)) {
  webcamPoints.forEach(cam => {
    // Crear el marcador a la posició especificada
    const marker = L.marker([cam.lat, cam.lon], { icon: cameraIcon });
    
    // Construir el contingut del popup
    const popupContent = `
      <div style="text-align:center;">
        <h4 style="margin:0 0 5px;">${cam.location}</h4>
        <a href="${cam.link}" target="_blank">
          <img src="${cam.image}" alt="${cam.location}" style="width:300px; height:169px; object-fit: cover; border:1px solid #ccc;"/>
        </a>
        <p style="margin:5px 0 0;">
          <a href="${cam.link}" target="_blank">Veure càmera en directe</a>
        </p>
      </div>
    `;
    // Assignar el popup al marcador
    marker.bindPopup(popupContent);
    // Afegir el marcador al layer group de càmeres
    marker.addTo(camerasLayer);
  });
}

/* ======================================================
   Event Listeners i funcions addicionals
   ====================================================== */
range_element.addEventListener('input', () => {
  plujaneu_layer.refresh();
  setDateText(range_values[range_element.value]);
});

document.getElementById('play-button').addEventListener('click', toggleAnimation);
document.getElementById('gif-button').addEventListener('click', createGIF);

// Actualització automàtica cada minut
setInterval(() => {
  setRangeValues();
  plujaneu_layer.refresh();
  setDateText(range_values[range_element.value]);
}, 60000);

// Funció per actualitzar range_values amb noves dades
function updateRangeValues(newData) {
  range_values = [...range_values, ...newData]; // Afegir noves dades
  if (range_values.length > max_range_steps) {
    range_values = range_values.slice(-max_range_steps); // Mantenir només les últimes dades
  }
}

// Funció per alternar l'animació
function toggleAnimation() {
  const playButton = document.getElementById('play-button');

  if (isPlaying) {
    clearTimeout(animationInterval);
    isPlaying = false;
    playButton.textContent = '▶️';
  } else {
    isPlaying = true;
    playButton.textContent = '⏸️';

    function nextFrame() {
      if (!isPlaying) return;

      let currentStep = parseInt(range_element.value);

      // Si estem a l'últim fotograma, reiniciem a 0
      if (currentStep >= range_values.length - 1) {
        currentStep = 0;
      } else {
        currentStep++;
      }

      range_element.value = currentStep;
      plujaneu_layer.refresh();
      setDateText(range_values[currentStep]);

      // Velocitat normal o pausa a l'últim fotograma
      const delay = (currentStep === range_values.length - 1) ? pauseOnLastFrame : animationSpeed;
      animationInterval = setTimeout(nextFrame, delay);
    }

    animationInterval = setTimeout(nextFrame, animationSpeed);
  }
}

// Simulació de recepció de noves dades (per exemple, cada 5 minuts)
setInterval(() => {
  const newData = generateNewData(); // Simula la generació de noves dades
  updateRangeValues(newData); // Actualitza range_values
}, 5 * 60 * 1000); // 5 minuts

// Funció per simular la generació de noves dades
function generateNewData() {
  const newData = [];
  const now = new Date();
  for (let i = 0; i < 5; i++) { // Simula 5 nous passos
    const newDate = new Date(now.getTime() + i * increment_mins * 60 * 1000);
    newData.push({
      any: newDate.getUTCFullYear(),
      mes: newDate.getUTCMonth() + 1,
      dia: newDate.getUTCDate(),
      hora: newDate.getUTCHours(),
      min: newDate.getUTCMinutes(),
      utctime: newDate.getTime()
    });
  }
  return newData;
}

// Funció per crear el GIF (aquí s'utilitza gif.js)
// Nota: Per capturar l'estat actual del mapa pots utilitzar, per exemple, la biblioteca leaflet-image
// Funció per crear el GIF (versió simplificada)
function createGIF() {
  if (captureInProgress) return;
  captureInProgress = true;
  
  // Atura l'animació si està en marxa
  if (isPlaying) toggleAnimation();
  
  // Configuració del GIF
  gif = new GIF({
    workers: 2,
    quality: 10,
    width: map.getSize().x,
    height: map.getSize().y,
    transparent: 0xFFFFFFFF
  });

  let currentStep = 0;
  const originalValue = range_element.value;
  
  function captureFrame() {
    if (currentStep >= totalGifFrames) {
      gif.render();
      return;
    }
    
    // Actualitza el slider i espera a que es carreguin les tiles
    range_element.value = currentStep;
    plujaneu_layer.refresh();
    setDateText(range_values[currentStep]);
    
    // Dóna temps a que es carreguin les tiles noves
    setTimeout(() => {
      // Captura el canvas del mapa
      const mapContainer = document.querySelector('#map .leaflet-tile-container');
      html2canvas(mapContainer).then(canvas => {
        gif.addFrame(canvas, { delay: gifFrameDelay });
        currentStep++;
        updateProgress((currentStep / totalGifFrames) * 100);
        captureFrame();
      });
    }, 300); // Ajusta aquest temps segons la velocitat de càrrega de les tiles
  }

  captureFrame();

  gif.on('finished', function(blob) {
    range_element.value = originalValue;
    plujaneu_layer.refresh();
    setDateText(range_values[originalValue]);
    const url = URL.createObjectURL(blob);
    window.open(url);
    captureInProgress = false;
  });
}

// Obtenim el botó i l'element de la llegenda
const toggleLegendBtn = document.getElementById('toggle-legend');
const legendEl = document.querySelector('.legend');

// Afegim un event listener al botó
toggleLegendBtn.addEventListener('click', () => {
  // Si la llegenda està visible (display no és "none"), la amaguem; si no, la mostrem
  if (legendEl.style.display === 'none' || legendEl.style.display === '') {
    // Si no està definit o està en 'none', la mostrem
    legendEl.style.display = 'block';
  } else {
    // En cas contrari, la ocultem
    legendEl.style.display = 'none';
  }
});