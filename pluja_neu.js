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
  const animationSpeed = 100;
  const pauseOnLastFrame = 1000;
  
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
    opacity: 1,
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
  const map = L.map('map', {
    layers: [plujaneu_layer]
  }).setView([42.5, 1.5], 8);
  
  // Capes base
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
    })
  };
  
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
  
  L.control.layers(baseLayers, {
    "Precipitació": plujaneu_layer,
    "Zones de Perill d'Allaus": wmsLayer
  }, {
    position: 'topright'
  }).addTo(map);
  
  /* ======================================================
     Afegir markers dels webcams al mapa
     ====================================================== */
  // Definició d'una icona personalitzada per als webcams (amb l'emoji de càmera)
  const cameraIcon = L.divIcon({
    html: '<span style="font-size:24px;">📷</span>',
    className: 'webcam-icon', // Pots afegir estils addicionals amb CSS
    iconSize: [30, 30],
    iconAnchor: [15, 15] // Centra l'emoji sobre la coordenada
  });
  
  // Comprovem que l'array 'webcamPoints' existeix i és un array
  if (typeof webcamPoints !== 'undefined' && Array.isArray(webcamPoints)) {
    webcamPoints.forEach(cam => {
      // Crear el marcador a la posició especificada
      const marker = L.marker([cam.lat, cam.lon], { icon: cameraIcon }).addTo(map);
  
      // Construir el contingut del popup
      const popupContent = `
        <div style="text-align:center;">
          <h4 style="margin:0 0 5px;">${cam.location}</h4>
          <a href="${cam.link}" target="_blank">
            <img src="${cam.image}" alt="${cam.location}" style="width:100%; max-width:200px; height:auto; border:1px solid #ccc;"/>
          </a>
          <p style="margin:5px 0 0;">
            <a href="${cam.link}" target="_blank">Veure càmera en directe</a>
          </p>
        </div>
      `;
      // Assignar el popup al marcador
      marker.bindPopup(popupContent);
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
  
  // Funció per alternar l'animació
  function toggleAnimation() {
    if (isPlaying) {
      clearInterval(animationInterval);
      isPlaying = false;
    } else {
      animationInterval = setInterval(() => {
        let newValue = (parseInt(range_element.value) + 1) % range_values.length;
        range_element.value = newValue;
        plujaneu_layer.refresh();
        setDateText(range_values[newValue]);
      }, animationSpeed);
      isPlaying = true;
    }
  }
  
  // Funció per crear el GIF (aquí s'utilitza gif.js)
  // Nota: Per capturar l'estat actual del mapa pots utilitzar, per exemple, la biblioteca leaflet-image
  function createGIF() {
    if (captureInProgress) return;
    captureInProgress = true;
    
    gif = new GIF({
      workers: 2,
      quality: 10,
      workerScript: gifWorkerUrl,
      width: 512,  // ajusta segons les teves necessitats
      height: 512  // ajusta segons les teves necessitats
    });
  
    let frame = 0;
    function addFrame() {
      if (frame >= totalGifFrames) {
        gif.render();
        return;
      }
      // Exemple de capturar l'estat actual del mapa utilitzant leaflet-image:
      leafletImage(map, function(err, canvas) {
        if (err) {
          console.error(err);
          captureInProgress = false;
          return;
        }
        gif.addFrame(canvas, { delay: gifFrameDelay });
        frame++;
        addFrame();
      });
    }
    addFrame();
  
    gif.on('finished', function(blob) {
      // Per exemple, obrir el GIF en una nova pestanya
      window.open(URL.createObjectURL(blob));
      captureInProgress = false;
    });
  }
  
