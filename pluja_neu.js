// Crear un worker inline com a Blob per la generació del GIF
var gifWorkerBlob = new Blob([
    `importScripts('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')`
], { type: 'application/javascript' });

var gifWorkerUrl = URL.createObjectURL(gifWorkerBlob);

// Variables globals que s'han d'inicialitzar abans de l'arrencada (window.load)
const aemetApiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";
let activeDataFilters = { valueMin: null, valueMax: null, altMin: null, altMax: null };
let intervalAutoRefresc = null;

// Memòria cau per a la eliminació del parpelleig (flicker-free)
const imageCache = new Map();
const processedTileCache = new Map();
const proRadarCache = {
    'eurad': new Map(),
    'frcomp': new Map()
};

// Variables de control de precàrrega agressiva
let _prevRangeValue = -1;
let _prefetchQueue = [];
let _isPrefetching = false;
let openMeteoAromeLayer = L.layerGroup();
let openMeteoEcmwfLayer = L.layerGroup();
let openMeteoLeafletAdapter = null;

// Classe base per a WMS sense parpelleig
L.TileLayer.WMS.NoFlicker = L.TileLayer.WMS.extend({
    refresh: function (newTime) {
        if (!this._map) return;
        this.wmsParams.time = newTime;
        const wasAnimated = this._map._fadeAnimated;
        this._map._fadeAnimated = false;

        // Gestió de cues de càrrega per al sistema "Stop & Go"
        this._loadingTiles = 0;

        Object.values(this._tiles).forEach(tile => {
            if (tile.current && tile.active) {
                const newSrc = this.getTileUrl(tile.coords);
                this._refreshTileUrl(tile, newSrc);
            }
        });

        if (wasAnimated) {
            setTimeout(() => { if (this._map) this._map._fadeAnimated = wasAnimated; }, 2000);
        }

        // --- PRECARREGA INTEL·LIGENT (Bidireccional) ---
        console.log("Iniciant precàrrega per a:", newTime);
        this._handleAdvancedPrefetch();
    },

    _refreshTileUrl: function (tile, url) {
        // Si ja la tenim a la memòria cau, la posem a l'instant
        if (imageCache.has(url)) {
            const cachedImg = imageCache.get(url);
            if (cachedImg.complete) {
                tile.el.src = cachedImg.src; // Canvi directe si ja està "complete"
                return;
            } else {
                cachedImg.onload = () => {
                    L.Util.requestAnimFrame(() => { tile.el.src = cachedImg.src; });
                };
                return;
            }
        }

        const img = new Image();
        img.crossOrigin = "Anonymous";
        imageCache.set(url, img);
        this._loadingTiles++;

        img.onload = () => {
            this._loadingTiles--;
            // Només actualitzem si la teula encara existeix i és la mateixa
            L.Util.requestAnimFrame(() => {
                tile.el.src = url;
            });
        };
        img.onerror = () => {
            this._loadingTiles--;
            imageCache.delete(url);
        };
        img.src = url;
    },

    _handleAdvancedPrefetch: function () {
        if (!range_element) return;
        const currentIdx = parseInt(range_element.value);
        if (isNaN(currentIdx)) return;

        // 1. Detectem la direcció del moviment
        let direction = 1; // Per defecte futur
        if (_prevRangeValue !== -1) {
            if (currentIdx < _prevRangeValue) direction = -1; // Històric (passat)
        }
        _prevRangeValue = currentIdx;

        // 2. Generem la cua de frames a pre-carregar (els propers 5 en la direcció del moviment)
        _prefetchQueue = [];
        for (let i = 1; i <= 5; i++) {
            const nextIdx = currentIdx + (i * direction);
            if (nextIdx >= 0 && nextIdx < range_values.length) {
                _prefetchQueue.push(nextIdx);
            }
        }

        // 3. Iniciem la càrrega seqüencial de la cua
        this._processPrefetchQueue();
    },

    _processPrefetchQueue: function () {
        if (_isPrefetching || _prefetchQueue.length === 0) return;
        _isPrefetching = true;

        const nextIdx = _prefetchQueue.shift();
        const radarDate = new Date(range_values[nextIdx].utctime);
        const satDate = findClosestSatTimestamp(radarDate);
        const isoString = satDate.toISOString().split('.')[0] + 'Z';

        const totalToLoad = 5;
        const loadedCount = totalToLoad - _prefetchQueue.length;

        // Feedback visual discret al loader
        const directionText = (_prevRangeValue > nextIdx) ? "passat" : "futur";
        showMapLoader(`Optimitzant satèl·lit (${directionText})... ${loadedCount}/${totalToLoad}`, true);

        this._prefetchTime(isoString).then(() => {
            _isPrefetching = false;
            // Esperem un petit delay per no saturar el canal de xarxa
            setTimeout(() => {
                this._processPrefetchQueue();
                if (_prefetchQueue.length === 0) {
                    setTimeout(hideMapLoader, 2000); // Amaguem el loader quan acabem la cua
                }
            }, 100);
        });
    },

    _prefetchTime: function (time) {
        return new Promise((resolve) => {
            const bounds = this._map.getPixelBounds();
            const tileSize = this.getTileSize();
            const zoom = this._map.getZoom();

            // Afegim un buffer d'1 teula per seguretat (evita misses al pan/zoom)
            const nwTilePoint = bounds.min.divideBy(tileSize.x).floor().subtract([1, 1]);
            const seTilePoint = bounds.max.divideBy(tileSize.x).floor().add([1, 1]);

            const tilesToLoad = [];
            for (let x = nwTilePoint.x; x <= seTilePoint.x; x++) {
                for (let y = nwTilePoint.y; y <= seTilePoint.y; y++) {
                    const coords = L.point(x, y);
                    coords.z = zoom;

                    const originalTime = this.wmsParams.time;
                    this.wmsParams.time = time;
                    const url = this.getTileUrl(coords);
                    this.wmsParams.time = originalTime;

                    if (!imageCache.has(url)) {
                        tilesToLoad.push(url);
                    }
                }
            }

            if (tilesToLoad.length === 0) return resolve();

            let loaded = 0;
            tilesToLoad.forEach(url => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                imageCache.set(url, img);
                img.onload = img.onerror = () => {
                    loaded++;
                    if (loaded === tilesToLoad.length) resolve();
                };
                img.src = url;
            });
        });
    },
});

L.tileLayer.wms.noFlicker = function (url, options) {
    return new L.TileLayer.WMS.NoFlicker(url, options);
};

// ============================================================
// CONFIGURACIÓ EUMETSAT MTG i CAPES DE TEMPS
// ============================================================
const EUMETSAT_MTG_WMS = 'https://view.eumetsat.int/geoserver/mtg_fd/ows';
const EUMETSAT_CREDIT = '© <a href="https://www.eumetsat.int/" target="_blank">EUMETSAT / MTG</a>';

// Funció per iniciar la precàrrega estàtica (bloqueig)
function startStaticPrefetch(hours, isSilent = false) {
    if (!range_values || !range_values.length) return;

    // 1. Calculem el rang
    let startIndex = 0;
    if (hours > 0) {
        const framesToPrefetch = Math.min(range_values.length, hours * 6);
        startIndex = Math.max(0, range_values.length - framesToPrefetch);
    }

    // 2. AJUSTEM EL SLIDER SI NO ÉS SILENT
    if (!isSilent) {
        range_element.min = startIndex;
        range_element.value = range_values.length - 1;
        const event = new Event('input');
        range_element.dispatchEvent(event);
    }

    if (hours === 0) {
        if (!isSilent) {
            showMapLoader("Rang complet restaurat", true);
            setTimeout(hideMapLoader, 2000);
        }
        return;
    }

    // 3. Bloquegem la UI (només si no és silent)
    if (!isSilent) {
        range_element.disabled = true;
        range_element.style.opacity = "0.4";
        showCentralLoader("Optimitzant satèl·lit...", `Carregant dades de les últimes ${hours}h`);
    } else {
        showMapLoader(`Optimitzant nova zona (${hours}h)...`, true);
    }

    // 4. Identifiquem la capa visible per fer la precàrrega
    const activeLayer = timeDependentLayers.find(l => map.hasLayer(l) && (l instanceof L.TileLayer.WMS.NoFlicker || typeof l._prefetchTime === 'function'));
    const activeProRadar = Object.keys(proRadarLayers).find(key => map.hasLayer(proRadarLayers[key]));

    if (!activeLayer && !activeProRadar) {
        hideCentralLoader();
        range_element.disabled = false;
        range_element.style.opacity = "1";
        return;
    }

    const wasFadeAnimated = map._fadeAnimated;
    map._fadeAnimated = false;

    // Generem els índexs a carregar
    const indices = [];
    for (let i = startIndex; i < range_values.length; i++) indices.push(i);

    let loadedFrames = 0;
    const totalFrames = indices.length;

    // Col·leccionem tots els passos únics per evitar re-carregar el mateix timestamp de satèl·lit diverses vegades
    const pendingItems = indices.map(idx => {
        const r = range_values[idx];
        let satIso = null;
        if (activeLayer) {
            const radarDate = new Date(r.utctime);
            const satDate = findClosestSatTimestamp(radarDate);
            satIso = satDate.toISOString().split('.')[0] + 'Z';
        }
        return { idx, r, satIso };
    });

    const prefetchItem = async (item) => {
        const promises = [];
        if (activeLayer && item.satIso) {
            promises.push(activeLayer._prefetchTime(item.satIso));
        }
        if (activeProRadar && item.r.timestamp) {
            promises.push(updateProRadar(activeProRadar, item.r.timestamp, true));
        }
        await Promise.all(promises);
        loadedFrames++;
        showCentralLoader("Optimitzant animació...", `Frame ${loadedFrames} de ${totalFrames}`);
    };

    // Processador en paral·lel (batch size 5 per maximitzar el throughput HTTP)
    const BATCH_SIZE = 5;
    const processPool = async () => {
        while (pendingItems.length > 0) {
            const batch = pendingItems.splice(0, BATCH_SIZE);
            await Promise.all(batch.map(item => prefetchItem(item)));
        }

        // Finalitzat
        hideCentralLoader();
        range_element.disabled = false;
        range_element.style.opacity = "1";
        map._fadeAnimated = wasFadeAnimated; // Restaurem animació

        showMapLoader("Seqüència optimitzada amb èxit ✅", true);
        setTimeout(hideMapLoader, 3000);
    };

    processPool();
}

// Selector del loader central per a precàrrega estàtica
let _activeStaticHours = 0; // Guardem l'últim rang triat

// Listeners per als botons de ràfega (burst)
document.addEventListener('DOMContentLoaded', () => {
    const burstButtons = document.querySelectorAll('.burst-btn');
    burstButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            burstButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const h = parseInt(btn.getAttribute('data-hours'));
            _activeStaticHours = h;
            startStaticPrefetch(h);
        });
    });
});
// Classe personalitzada per als satèl·lits EUMETSAT MTG (sincronització amb el slider)
L.TileLayer.WMS.MTG = L.TileLayer.WMS.NoFlicker.extend({
    refresh: function () {
        if (!range_values || !range_values.length || !range_element) return;
        const val = parseInt(range_element.value);
        if (isNaN(val) || val >= range_values.length) return;

        const radarDate = new Date(range_values[val].utctime);
        const satDate = findClosestSatTimestamp(radarDate);
        const isoString = satDate.toISOString().split('.')[0] + 'Z';

        if (this.wmsParams.time !== isoString) {
            // Cridem al mètode refresh de la classe base NoFlicker
            L.TileLayer.WMS.NoFlicker.prototype.refresh.call(this, isoString);
        }
    }
});

// --- COLORS I LUT PER AL MODE SANDWICH ---
const eumetsatSourceHex = ["#010101", "#050505", "#0a0a0a", "#0f0f0f", "#131314", "#181818", "#1d1d1e", "#222222", "#262627", "#2b2b2c", "#303031", "#353536", "#39393b", "#3e3e40", "#434344", "#474749", "#4c4c4e", "#515153", "#565658", "#5a5a5d", "#5f5f61", "#646466", "#69696b", "#6d6d70", "#727275", "#77777a", "#7c7c7f", "#808083", "#858588", "#8a8a8d", "#8e8e92", "#939397", "#98989c", "#9d9da0", "#a1a1a5", "#a6a6aa", "#ababaf", "#b0b0b4", "#b4b4b9", "#b9b9be", "#bebec2", "#c2c2c7", "#c7c7cc", "#ccccd1", "#d1d1d6", "#d5d5db", "#dadadf", "#dfdfe4", "#e4e4e9", "#e8e8ee", "#ededf3", "#f2f2f8", "#f7f7fd", "#ebeafa", "#e0def7", "#d5d2f4", "#c9c5f1", "#beb9ee", "#b3adeb", "#a8a1e8", "#9c94e5", "#9188e2", "#867cdf", "#7b70dd", "#756ad8", "#7065d3", "#6b5fce", "#655ac9", "#6054c4", "#5b4fc0", "#5649bb", "#5044b6", "#4b3eb1", "#4639ac", "#4134a8", "#4d35a5", "#5a37a3", "#6739a1", "#733b9f", "#803d9c", "#8d3f9a", "#994198", "#a64396", "#b34593", "#bf4791", "#cc498f", "#d94b8d", "#db598f", "#de6891", "#e07693", "#e38596", "#e59398", "#e8a29a", "#eab09c", "#edbf9f", "#efcda1", "#f2dca3", "#f4eaa5", "#f7f9a8", "#eef3a5", "#e5eda3", "#dde7a1", "#d4e19f", "#ccdb9d", "#c3d59b", "#bacf98", "#b2c996", "#a9c394", "#a1bd92", "#98b790", "#90b28e"];
const eumetsatTargetHex = ["#090909", "#111111", "#191919", "#232323", "#2d2d2d", "#353535", "#414141", "#4d4d4d", "#595959", "#656565", "#717171", "#777777", "#7d7d7d", "#838383", "#898989", "#8f8f8f", "#9b9b9b", "#a1a1a1", "#a7a7a7", "#adadad", "#b3b3b3", "#bdbdbd", "#c9c9c9", "#d5d5d5", "#e1e1e1", "#efefef", "#000096", "#0000be", "#0000ea", "#0015ff", "#003bff", "#004fff", "#0062ff", "#0283ff", "#0497ff", "#00b2ff", "#03c7ff", "#06e1ff", "#00faff", "#14ffeb", "#32ffce", "#47ffb8", "#60ff9f", "#7aff86", "#93ff6d", "#abff55", "#c0ff40", "#dfff22", "#feff05", "#ffe501", "#ffc900", "#ffb700", "#ff9b00", "#ff7d00", "#ff5f00", "#ff4400", "#ff2e01", "#ff1300", "#f40200", "#e10101", "#c90000", "#bb0001", "#a80000", "#930000", "#7e0000", "#680808", "#560e0d", "#421514", "#2c1c1c", "#181818", "#000000"];

const eumetsatSourceRGB = eumetsatSourceHex.map(hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }));
const eumetsatTargetRGB = eumetsatTargetHex.map(hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }));

const eumetsatColorLUT = new Map();
eumetsatSourceHex.forEach((hex, i) => {
    const temp = 30 - (i * (110 / 112));
    let targetIdx = temp < -30 ? Math.round(70 - ((temp - (-80)) / 50 * 44)) : Math.round(25 - ((temp - (-30)) / 80 * 25));
    eumetsatColorLUT.set((eumetsatSourceRGB[i].r << 16) | (eumetsatSourceRGB[i].g << 8) | eumetsatSourceRGB[i].b, eumetsatTargetRGB[Math.max(0, Math.min(70, targetIdx))]);
});

const eumetsatMatchCache = new Map();
function findClosestEumetsatColor(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    if (eumetsatMatchCache.has(key)) return eumetsatMatchCache.get(key);
    let minDistance = Infinity, finalColor = null;
    for (let i = 0; i < eumetsatSourceRGB.length; i++) {
        const s = eumetsatSourceRGB[i], dist = Math.sqrt((r - s.r) ** 2 + (g - s.g) ** 2 + (b - s.b) ** 2);
        if (dist < minDistance) { minDistance = dist; finalColor = eumetsatColorLUT.get((s.r << 16) | (s.g << 8) | s.b); }
        if (dist < 4) break;
    }
    const res = minDistance < 25 ? finalColor : null;
    eumetsatMatchCache.set(key, res); return res;
}

// Canvas compartit per processament (evita crear milers de canvas)
const sharedTempCanvas = document.createElement('canvas');
sharedTempCanvas.width = sharedTempCanvas.height = 256;
const sharedTempCtx = sharedTempCanvas.getContext('2d', { willReadFrequently: true });

L.TileLayer.Sandwich = L.TileLayer.WMS.MTG.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        tile.style.imageRendering = 'pixelated';

        // Pels tiles inicials
        this._drawSandwichTile(tile, coords, done);
        return tile;
    },

    _refreshTileUrl: function (tile, url) {
        // Sobreescribim el mètode de NoFlicker per gestionar el canvas manualment
        // i així evitar el parpelleig en actualitzar el temps del slider
        this._drawSandwichTile(tile.el, tile.coords);
    },

    _drawSandwichTile: function (canvas, coords, done) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const visUrl = this._getCustomUrl(coords, 'mtg_fd:vis06_hrfi', '');
        const irUrl = this._getCustomUrl(coords, 'mtg_fd:ir105_hrfi', 'mtg_fd_ir105_hrfi_style_01');

        const getImg = (url) => {
            let img = imageCache.get(url);
            if (!img) {
                img = new Image();
                img.crossOrigin = "Anonymous";
                img.src = url;
                imageCache.set(url, img);
            }
            return img;
        };

        const visImg = getImg(visUrl);
        const irImg = getImg(irUrl);

        let doneCalled = false;
        const safeDone = () => {
            if (done && !doneCalled) {
                doneCalled = true;
                done(null, canvas);
            }
        };

        const executeDraw = () => {
            // Si la imatge visible base no hi és o ha fallat, no podem fer gran cosa
            if (!visImg.complete || visImg.naturalWidth === 0) {
                if (visImg.complete) safeDone(); // Ha fallat (naturalWidth 0)
                return;
            }

            // 1. Netegem el canvas
            ctx.clearRect(0, 0, 256, 256);

            // 2. Pintem VIS (base)
            ctx.drawImage(visImg, 0, 0);

            // 3. Processem IR (només si està disponible)
            if (irImg.complete && irImg.naturalWidth > 0) {
                sharedTempCtx.clearRect(0, 0, 256, 256);
                sharedTempCtx.drawImage(irImg, 0, 0);

                const imageData = sharedTempCtx.getImageData(0, 0, 256, 256);
                const pixels = imageData.data;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] > 10) {
                        const newCol = findClosestEumetsatColor(pixels[i], pixels[i + 1], pixels[i + 2]);
                        if (newCol) {
                            pixels[i] = newCol.r;
                            pixels[i + 1] = newCol.g;
                            pixels[i + 2] = newCol.b;
                            pixels[i + 3] = 255;
                        } else {
                            pixels[i + 3] = 0;
                        }
                    }
                }
                sharedTempCtx.putImageData(imageData, 0, 0);

                ctx.save();
                ctx.globalAlpha = 0.65;
                ctx.globalCompositeOperation = 'multiply';
                ctx.drawImage(sharedTempCanvas, 0, 0);
                ctx.restore();

                // Si hem aconseguit pintar VIS + IR, ja podem donar la teula per finalitzada
                safeDone();
            } else if (irImg.complete) {
                // Si IR ha fallat però VIS és ok, donem per finalitzada només amb VIS
                safeDone();
            }
        };

        // Important: fem servir addEventListener perquè les imatges de la cache
        // són compartides per moltes teules i no podem sobreescriure el .onload
        const onImageEvent = () => executeDraw();

        const onEvent = () => executeDraw();

        // Sempre intentem dibuixar el que tinguem ja en cache
        executeDraw();

        // I ens subscrivim als canvis per quan acabin de carregar (sense sobreescriure .onload)
        if (!visImg.complete) {
            visImg.addEventListener('load', onEvent, { once: true });
            visImg.addEventListener('error', onEvent, { once: true });
        }
        if (!irImg.complete) {
            irImg.addEventListener('load', onEvent, { once: true });
            irImg.addEventListener('error', onEvent, { once: true });
        }

        // Si després de 10 segons encara no hem cridat done, ho fem per no bloquejar el mapa
        setTimeout(safeDone, 10000);
    },

    _getCustomUrl: function (coords, layer, style) {
        const backupLayers = this.wmsParams.layers;
        const backupStyles = this.wmsParams.styles;

        this.wmsParams.layers = layer;
        this.wmsParams.styles = style;
        const url = L.TileLayer.WMS.prototype.getTileUrl.call(this, coords);

        this.wmsParams.layers = backupLayers;
        this.wmsParams.styles = backupStyles;
        return url;
    },

    _prefetchTime: function (time) {
        return new Promise((resolve) => {
            const bounds = this._map.getPixelBounds();
            const tileSize = this.getTileSize();
            const zoom = this._map.getZoom();
            const nwTilePoint = bounds.min.divideBy(tileSize.x).floor().subtract([1, 1]);
            const seTilePoint = bounds.max.divideBy(tileSize.x).floor().add([1, 1]);

            const urlsToLoad = [];
            for (let x = nwTilePoint.x; x <= seTilePoint.x; x++) {
                for (let y = nwTilePoint.y; y <= seTilePoint.y; y++) {
                    const coords = L.point(x, y);
                    coords.z = zoom;
                    const originalTime = this.wmsParams.time;
                    this.wmsParams.time = time;
                    urlsToLoad.push(this._getCustomUrl(coords, 'mtg_fd:vis06_hrfi', ''));
                    urlsToLoad.push(this._getCustomUrl(coords, 'mtg_fd:ir105_hrfi', 'mtg_fd_ir105_hrfi_style_01'));
                    this.wmsParams.time = originalTime;
                }
            }

            let loaded = 0;
            const uniqueUrls = [...new Set(urlsToLoad)].filter(u => !imageCache.has(u));
            if (uniqueUrls.length === 0) return resolve();

            uniqueUrls.forEach(url => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                imageCache.set(url, img);
                img.onload = img.onerror = () => {
                    loaded++;
                    if (loaded === uniqueUrls.length) resolve();
                };
                img.src = url;
            });
        });
    }
});

L.TileLayer.SandwichNative = L.TileLayer.WMS.MTG.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        tile.style.imageRendering = 'pixelated';
        this._drawSandwichTile(tile, coords, done);
        return tile;
    },

    _refreshTileUrl: function (tile, url) {
        this._drawSandwichTile(tile.el, tile.coords);
    },

    _drawSandwichTile: function (canvas, coords, done) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const visUrl = this._getCustomUrl(coords, 'mtg_fd:vis06_hrfi', '');
        const irUrl = this._getCustomUrl(coords, 'mtg_fd:ir105_hrfi', 'mtg_fd_ir105_hrfi_style_02');

        const getImg = (url) => {
            let img = imageCache.get(url);
            if (!img) {
                img = new Image();
                img.crossOrigin = "Anonymous";
                img.src = url;
                imageCache.set(url, img);
            }
            return img;
        };

        const visImg = getImg(visUrl);
        const irImg = getImg(irUrl);

        let doneCalled = false;
        const safeDone = () => {
            if (done && !doneCalled) {
                doneCalled = true;
                done(null, canvas);
            }
        };

        const executeDraw = () => {
            if (!visImg.complete || visImg.naturalWidth === 0) {
                if (visImg.complete) safeDone();
                return;
            }

            ctx.clearRect(0, 0, 256, 256);
            ctx.drawImage(visImg, 0, 0);

            if (irImg.complete && irImg.naturalWidth > 0) {
                ctx.save();
                ctx.globalAlpha = 0.7;
                ctx.globalCompositeOperation = 'multiply';
                ctx.drawImage(irImg, 0, 0);
                ctx.restore();
                safeDone();
            } else if (irImg.complete) {
                safeDone();
            }
        };

        executeDraw();

        if (!visImg.complete) {
            visImg.addEventListener('load', executeDraw, { once: true });
            visImg.addEventListener('error', executeDraw, { once: true });
        }
        if (!irImg.complete) {
            irImg.addEventListener('load', executeDraw, { once: true });
            irImg.addEventListener('error', executeDraw, { once: true });
        }

        setTimeout(safeDone, 10000);
    },

    _getCustomUrl: function (coords, layer, style) {
        const backupLayers = this.wmsParams.layers;
        const backupStyles = this.wmsParams.styles;

        this.wmsParams.layers = layer;
        this.wmsParams.styles = style;
        const url = L.TileLayer.WMS.prototype.getTileUrl.call(this, coords);

        this.wmsParams.layers = backupLayers;
        this.wmsParams.styles = backupStyles;
        return url;
    },

    _prefetchTime: function (time) {
        return new Promise((resolve) => {
            const bounds = this._map.getPixelBounds();
            const tileSize = this.getTileSize();
            const zoom = this._map.getZoom();
            const nwTilePoint = bounds.min.divideBy(tileSize.x).floor().subtract([1, 1]);
            const seTilePoint = bounds.max.divideBy(tileSize.x).floor().add([1, 1]);

            const urlsToLoad = [];
            for (let x = nwTilePoint.x; x <= seTilePoint.x; x++) {
                for (let y = nwTilePoint.y; y <= seTilePoint.y; y++) {
                    const coords = L.point(x, y);
                    coords.z = zoom;
                    const originalTime = this.wmsParams.time;
                    this.wmsParams.time = time;
                    urlsToLoad.push(this._getCustomUrl(coords, 'mtg_fd:vis06_hrfi', ''));
                    urlsToLoad.push(this._getCustomUrl(coords, 'mtg_fd:ir105_hrfi', 'mtg_fd_ir105_hrfi_style_02'));
                    this.wmsParams.time = originalTime;
                }
            }

            let loaded = 0;
            const uniqueUrls = [...new Set(urlsToLoad)].filter(u => !imageCache.has(u));
            if (uniqueUrls.length === 0) return resolve();

            uniqueUrls.forEach(url => {
                const img = new Image();
                img.crossOrigin = "Anonymous";
                imageCache.set(url, img);
                img.onload = img.onerror = () => {
                    loaded++;
                    if (loaded === uniqueUrls.length) resolve();
                };
                img.src = url;
            });
        });
    }
});

function createMtgLayer(layerId, extraClass = '', style = '') {
    const isMultiply = extraClass.includes('multiply');
    const options = {
        layers: layerId, format: 'image/png', transparent: true, version: '1.3.0',
        attribution: EUMETSAT_CREDIT,
        opacity: isMultiply ? 1.0 : 0.9,
        pane: 'satellitePane',
        className: 'wms-no-gap ' + extraClass,
        updateWhenZooming: false,
        updateWhenIdle: true
    };
    if (style) {
        options.styles = style;
    }
    const layer = new L.TileLayer.WMS.MTG(EUMETSAT_MTG_WMS, options);
    layer.on('add remove', reconfigureTimeSliderAsync);
    return layer;
}

function createSandwichLayer() {
    const layer = new L.TileLayer.Sandwich(EUMETSAT_MTG_WMS, {
        layers: 'mtg_fd:vis06_hrfi', // Layer base per defecte
        format: 'image/png', transparent: true, version: '1.3.0',
        attribution: EUMETSAT_CREDIT,
        pane: 'satellitePane',
        className: 'wms-no-gap',
        updateWhenZooming: false,
        updateWhenIdle: true
    });

    layer.on('add remove', reconfigureTimeSliderAsync);
    return layer;
}

function createSandwichNativeLayer() {
    const layer = new L.TileLayer.SandwichNative(EUMETSAT_MTG_WMS, {
        layers: 'mtg_fd:vis06_hrfi',
        format: 'image/png', transparent: true, version: '1.3.0',
        attribution: EUMETSAT_CREDIT,
        pane: 'satellitePane',
        className: 'wms-no-gap',
        updateWhenZooming: false,
        updateWhenIdle: true
    });

    layer.on('add remove', reconfigureTimeSliderAsync);
    return layer;
}

// Poblament de les capes de satèl·lit (ja declarades a dalt)
let satelliteMenuLayers = {
    'GeoColor (dia/nit)': createMtgLayer('rgb_geocolour'),
    'True Color': createMtgLayer('rgb_truecolour'),
    'IR 10.5µm (Grayscale)': createMtgLayer('ir105_hrfi', '', 'mtg_fd_ir105_hrfi_grayscale'),
    'IR 10.5µm (Estil 01 - Color)': createMtgLayer('ir105_hrfi', '', 'mtg_fd_ir105_hrfi_style_01'),
    'IR 10.5µm (Estil 02 - Color)': createMtgLayer('ir105_hrfi', '', 'mtg_fd_ir105_hrfi_style_02'),
    'IR 10.5µm (Multiply Mode)': createMtgLayer('ir105_hrfi', 'multiply'),
    'VIS 0.6µm (Alta Res.)': createMtgLayer('vis06_hrfi'),
    'Cloud Phase RGB': createMtgLayer('rgb_cloudphase'),
    'Cloud Type RGB': createMtgLayer('rgb_cloudtype'),
    'Dust RGB': createMtgLayer('rgb_dust'),
    'Fire Temperature RGB': createMtgLayer('rgb_firetemperature'),
    'Fog / Baixa Nuvolositat': createMtgLayer('rgb_fog'),
    'Neu RGB': createMtgLayer('rgb_snow'),
    'Sandwich MTG (VIS+IR Custom)': createSandwichLayer(),
    'Sandwich MTG (Estil 02 Directe)': createSandwichNativeLayer(),
    'LI Flash Area': createMtgLayer('li_afa'),
};

const eumetsatLayer = satelliteMenuLayers['GeoColor (dia/nit)'];
const eumetsat_ir_layer = satelliteMenuLayers['IR 10.5µm (Grayscale)'];
const eumetsat_hrvis_layer = satelliteMenuLayers['VIS 0.6µm (Alta Res.)'];

let timeDependentLayers = []; // Es poblarà quan la resta de capes radar estiguin definides

// ============================================================
// Sistema d'indicador de càrrega sobre el mapa (DOM Overlay)
// ============================================================
let _mapLoaderEl = null;

function showMapLoader(text, isPrefetch = false) {
    if (!_mapLoaderEl) {
        _mapLoaderEl = document.createElement('div');
        _mapLoaderEl.id = 'map-loader-banner';
        document.body.appendChild(_mapLoaderEl);
    }
    _mapLoaderEl.innerHTML = `<span class="loading-text">${text}</span>`;
    console.log("showMapLoader:", text, "isPrefetch:", isPrefetch);

    if (isPrefetch) {
        _mapLoaderEl.classList.add('prefetching');
    } else {
        _mapLoaderEl.classList.remove('prefetching');
    }

    _mapLoaderEl.style.display = 'flex';
}

function hideMapLoader() {
    if (_mapLoaderEl) {
        _mapLoaderEl.style.display = 'none';
        _mapLoaderEl.classList.remove('prefetching');
    }
}

// Selector del loader central per a precàrrega estàtica
let _centralLoaderEl = null;

function createCentralLoader() {
    if (_centralLoaderEl) return;
    _centralLoaderEl = document.createElement('div');
    _centralLoaderEl.id = 'central-map-loader';
    _centralLoaderEl.innerHTML = `
        <div class="central-loader-content">
            <div class="central-loader-spinner"></div>
            <div id="central-loader-text">Preparant visualització...</div>
            <div id="central-loader-subtext">Això farà que la seqüència sigui totalment fluida.</div>
        </div>
    `;
    document.body.appendChild(_centralLoaderEl);
}

function showCentralLoader(text, subtext) {
    createCentralLoader();
    document.getElementById('central-loader-text').innerText = text;
    document.getElementById('central-loader-subtext').innerText = subtext || "";
    _centralLoaderEl.style.display = 'flex';
}

function hideCentralLoader() {
    if (_centralLoaderEl) _centralLoaderEl.style.display = 'none';
}

// Backward-compat: createLoadingIcon ara mostra el banner i torna un icon invisible
function createLoadingIcon(text) {
    showMapLoader(text);
    // Return an invisible dummy icon so the marker still gets added (and cleared later)
    return L.divIcon({ className: '', html: '', iconSize: [0, 0] });
}


// pluja_neu.js (SUBSTITUEIX EL TEU BLOC 'window.addEventListener' PER AQUEST)

window.addEventListener('load', async () => {
    const loadingScreen = document.getElementById('loading-screen');

    // Amaguem la pantalla de càrrega
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 1000);
    }, 4000);

    // Carreguem les dades locals essencials

    console.log("Iniciant càrrega del vent...");
    initDarkMode(); // <--- Initialize Dark Mode
    await carregarCapaVent();
    console.log("Iniciant càrrega de la climatologia...");
    await carregarClimatologiaLocal();

    console.log("Arrencada completada. Mostrant la vista per defecte.");

    // Mostrem les dades de les estacions (sense interpolació inicial)
    displayVariable('smc_32');

    // Activem el botó del menú per defecte
    const defaultOption = document.querySelector('li[data-variable-key="smc_32"]');
    if (defaultOption) {
        defaultOption.classList.add('active');
        defaultOption.closest('.main-menu-item').querySelector('a').classList.add('active');
    }
    iniciarAutoRefrescRadar();
});

// ======================================================
// MENÚ MÒBIL : Statusbar + Variables Drawer + Time Bottom-Sheet
// ======================================================
(function () {
    // --- Elements ---
    const menuToggle = document.getElementById('mobile-menu-toggle');   // ☰ Variables
    const menuItems = document.getElementById('meteo-menu-items');     // Floating drawer
    const timeToggle = document.getElementById('mobile-time-toggle');   // ⏱ Temps
    const timePanel = document.getElementById('mobile-time-panel');    // Bottom-sheet
    const closeTime = document.getElementById('close-mobile-time-panel');
    const statusText = document.getElementById('mobile-status-text');

    // Sync the mobile time display from the desktop display
    function syncMobilePanelTime() {
        const desktopDisplay = document.getElementById('historic-time-display');
        const mobileDisplay = document.getElementById('mobile-panel-time-display');
        if (desktopDisplay && mobileDisplay) {
            mobileDisplay.textContent = desktopDisplay.textContent;
        }
    }

    // Sync the top-bar status text (variable name + time)
    function syncMobileStatusText() {
        const desktopDisplay = document.getElementById('historic-time-display');
        const activeItem = document.querySelector('#meteo-menu-items li.active[data-variable-key]');
        let varName = activeItem ? activeItem.textContent.trim() : '';
        let timeTxt = desktopDisplay ? desktopDisplay.textContent.trim() : '';
        if (statusText) {
            statusText.textContent = varName ? `${varName} · ${timeTxt}` : timeTxt;
        }
    }

    // Observe the desktop time display for changes and sync to mobile
    const desktopTimeEl = document.getElementById('historic-time-display');
    if (desktopTimeEl) {
        new MutationObserver(() => {
            syncMobilePanelTime();
            syncMobileStatusText();
        }).observe(desktopTimeEl, { childList: true, characterData: true, subtree: true });
    }

    // === 1. Variables drawer toggle ===
    if (menuToggle && menuItems) {
        menuToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = menuItems.classList.toggle('open');
            menuToggle.textContent = isOpen ? '✕ Tancar' : '☰ Variables';
        });

        // Close drawer when user picks a leaf variable
        menuItems.addEventListener('click', (e) => {
            if (e.target.matches('li[data-variable-key]')) {
                menuItems.classList.remove('open');
                menuToggle.textContent = '☰ Variables';
                // Update status text after picking a variable
                setTimeout(syncMobileStatusText, 300);
            }
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (!menuToggle.contains(e.target) && !menuItems.contains(e.target)) {
                menuItems.classList.remove('open');
                menuToggle.textContent = '☰ Variables';
            }
        });
    }

    // === 2. Time bottom-sheet toggle ===
    if (timeToggle && timePanel) {
        timeToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            syncMobilePanelTime();
            timePanel.classList.toggle('open');
        });

        if (closeTime) {
            closeTime.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                timePanel.classList.remove('open');
            });
            // Also handle touch specifically for close button
            closeTime.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                timePanel.classList.remove('open');
            });
        }

        // Stop clicks AND touches INSIDE the panel from propagating
        function stopBubbling(e) {
            e.stopPropagation();
            // We don't preventDefault here because we want the buttons to actually fire their inline onclicks
        }
        timePanel.addEventListener('click', stopBubbling);
        timePanel.addEventListener('touchstart', stopBubbling, { passive: false });
        timePanel.addEventListener('touchend', stopBubbling, { passive: false });

        // Sync time display after any button press inside the panel
        timePanel.addEventListener('click', () => {
            setTimeout(() => {
                syncMobilePanelTime();
                syncMobileStatusText();
            }, 250);
        });
        timePanel.addEventListener('touchend', () => {
            setTimeout(() => {
                syncMobilePanelTime();
                syncMobileStatusText();
            }, 250);
        });

        // Close ONLY when clicking/touching truly outside the panel
        document.addEventListener('click', (e) => {
            if (timePanel.classList.contains('open') &&
                !timePanel.contains(e.target) &&
                !timeToggle.contains(e.target) &&
                !e.target.closest('#historic-controls-container')) {
                timePanel.classList.remove('open');
            }
        });
        document.addEventListener('touchstart', (e) => {
            if (timePanel.classList.contains('open') &&
                !timePanel.contains(e.target) &&
                !timeToggle.contains(e.target) &&
                !e.target.closest('#historic-controls-container')) {
                timePanel.classList.remove('open');
            }
        });
    }
    // === 2.5 Mobile left tools toggle ===
    const mobileLeftToggle = document.getElementById('mobile-side-menu-toggle');
    const sideMenuDesktop = document.getElementById('side-menu');

    if (mobileLeftToggle && sideMenuDesktop) {
        mobileLeftToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            sideMenuDesktop.classList.toggle('mobile-open');
        });

        // Clicar fora tanca el menú (opcional però recomanable)
        document.addEventListener('click', (e) => {
            if (sideMenuDesktop.classList.contains('mobile-open') &&
                !sideMenuDesktop.contains(e.target) &&
                !mobileLeftToggle.contains(e.target)) {
                sideMenuDesktop.classList.remove('mobile-open');
            }
        });
        document.addEventListener('touchstart', (e) => {
            if (sideMenuDesktop.classList.contains('mobile-open') &&
                !sideMenuDesktop.contains(e.target) &&
                !mobileLeftToggle.contains(e.target)) {
                sideMenuDesktop.classList.remove('mobile-open');
            }
        });
    }

    // === 3. Accordion submenu for touch / mobile ===
    function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
    }

    if (menuItems) {
        // Top-level menu toggle
        menuItems.addEventListener('click', (e) => {
            if (!isMobileLayout()) return;
            const link = e.target.closest('.main-menu-item > a');
            if (!link) return;
            const parentItem = link.parentElement;
            const submenu = parentItem.querySelector('.submenu');
            if (!submenu) return;
            e.preventDefault();
            e.stopPropagation();
            const wasOpen = parentItem.classList.contains('is-open');
            menuItems.querySelectorAll('.main-menu-item.is-open').forEach(item => item.classList.remove('is-open'));
            if (!wasOpen) parentItem.classList.add('is-open');
        });

        // Nested submenu level-2 toggle
        menuItems.addEventListener('click', (e) => {
            if (!isMobileLayout()) return;
            const link = e.target.closest('.submenu .has-submenu > a');
            if (!link) return;
            const parentLi = link.parentElement;
            const sub2 = parentLi.querySelector('.submenu-level2');
            if (!sub2) return;
            e.preventDefault();
            e.stopPropagation();
            const wasOpen = parentLi.classList.contains('is-open');
            parentLi.closest('.submenu').querySelectorAll('.has-submenu.is-open').forEach(li => li.classList.remove('is-open'));
            if (!wasOpen) parentLi.classList.add('is-open');
        });
    }
})();

// ======================================================
// DEFINICIÓ DE PROJECCIONS PERSONALITZADES
// ======================================================
proj4.defs('EPSG:25831', '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

const transformation = new L.Transformation(1, -245124.0621, -1, 4767102.8982);

const crs_25831 = new L.Proj.CRS('EPSG:25831', proj4.defs['EPSG:25831'], {
    transformation: transformation
});

// ======================================================

// ======================================================

// --- DARK MODE LOGIC ---
// --- DARK MODE LOGIC ---
// --- DARK MODE LOGIC ---
function initDarkMode() {
    const toggleBtn = document.getElementById('toggle-dark-mode-btn');
    const html = document.documentElement;

    // 1. ALWAYS START IN LIGHT MODE (User Request)
    // We ignore localStorage on init to ensure it always opens fresh in Light Mode.
    // If we wanted to persist, we would check localStorage here.
    html.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light'); // Reset storage to light
    if (toggleBtn) toggleBtn.textContent = '🌙';

    // 2. Event Listener
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const currentTheme = html.getAttribute('data-theme');
            let isDarkNow = false;

            if (currentTheme === 'dark') {
                html.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
                toggleBtn.textContent = '🌙';
                isDarkNow = false;
            } else {
                html.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
                toggleBtn.textContent = '☀️';
                isDarkNow = true;
            }

            // 3. Update Comarques Layer if it exists
            if (typeof comarquesLayer !== 'undefined' && comarquesLayer) {
                comarquesLayer.setStyle({
                    color: isDarkNow ? "#ffffff" : "#262626"
                });
            }
        });
    }
}

// AFEGEIX AIXÒ AL PRINCIPI DEL FITXER


function clearAnimationCache() {
    console.log("Netejant la memòria cau de l'animació...");
    imageCache.clear();
    processedTileCache.clear(); // <-- AFEGEIX AQUESTA LÍNIA
}

// ======================================================
// EINES DE DIBUIX (POLÍGONS AMB ÀREA I FLETXES)
// ======================================================
document.addEventListener('DOMContentLoaded', () => {
    const drawingBtn = document.getElementById('drawing-tool-btn');
    const drawingPanel = document.getElementById('drawing-panel');
    if (!drawingBtn || !drawingPanel) {
        console.error("No s'han trobat els elements del panell de dibuix.");
        return;
    }

    const closeDrawingPanelBtn = document.getElementById('close-drawing-panel');
    const colorPicker = document.getElementById('draw-color-picker');
    const toolButtons = document.querySelectorAll('.draw-tool-btn');
    const colorPalette = document.getElementById('color-palette'); // <-- NOU ELEMENT

    const creativeDrawings = new L.FeatureGroup().addTo(map);
    let activeDrawer = null;
    let activeToolButton = null;

    // Expose globally for Route Planner
    window.enableDrawer = function (tool) {
        if (activeDrawer) {
            activeDrawer.disable();
            activeDrawer = null; // Important: Clear reference
        }
        if (activeToolButton) {
            activeToolButton.classList.remove('active');
            activeToolButton = null;
        }

        const selectedColor = colorPicker.value;
        const selectedOpacity = document.getElementById('draw-opacity-slider').value;

        const drawOptions = {
            shapeOptions: { color: selectedColor, weight: 3, fillOpacity: selectedOpacity },
            polyline: { shapeOptions: { color: selectedColor, weight: 4 } }
        };

        switch (tool) {
            case 'smart-route_LEGACY_REMOVED': // Kept for history reference if needed, but inactive
                break;
            case 'polygon':
                activeDrawer = new L.Draw.Polygon(map, drawOptions);
                break;
            case 'line': // <-- NOU: Simple línia sense fletxa
            case 'arrow':
                activeDrawer = new L.Draw.Polyline(map, drawOptions.polyline);
                break;
            case 'clear':
                creativeDrawings.clearLayers();
                return;
        }

        if (activeDrawer) activeDrawer.enable();

        activeToolButton = document.querySelector(`.draw-tool-btn[data-tool="${tool}"]`);
        if (activeToolButton) activeToolButton.classList.add('active');
    }

    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;

        // Route Planner Logic (Priority)
        if (isRoutePlannerActive && (event.layerType === 'polyline' || event.layerType === 'line')) {
            console.log("Manual Route Created");
            // Remove previous if exists
            if (manualResultLayer) map.removeLayer(manualResultLayer);

            // Keep reference & Show on Map
            manualResultLayer = layer;
            manualResultLayer.addTo(map);
            generateElevationProfile(layer);

            // Disable drawer after one line
            if (activeDrawer) activeDrawer.disable();

            // Restore Panel (if it was hidden)
            const panelRoute = document.getElementById('route-settings-panel');
            if (panelRoute) {
                panelRoute.style.opacity = '1';
                panelRoute.style.pointerEvents = 'auto';
            }
            map.getContainer().style.cursor = '';
            return; // Stop here, don't add to creativeDrawings
        }

        if (drawingPanel.style.display === 'block') {
            if (event.layerType === 'polygon') {
                const geojson = layer.toGeoJSON();
                const areaMetres = turf.area(geojson);
                const areaHectarees = areaMetres / 10000;

                const popupContent = `<b>Àrea:</b><br>${areaHectarees.toFixed(2)} hectàrees`;
                layer.bindPopup(popupContent).openPopup();
                creativeDrawings.addLayer(layer);

            } else if (event.layerType === 'polyline') {
                // Check if we wanted an arrow or just a line
                const activeBtn = document.querySelector('.draw-tool-btn.active');
                const isArrow = activeBtn && activeBtn.dataset.tool === 'arrow';

                creativeDrawings.addLayer(layer);

                if (isArrow) {
                    const decorator = L.polylineDecorator(layer, {
                        patterns: [{
                            offset: '100%',
                            repeat: 0,
                            symbol: L.Symbol.arrowHead({ pixelSize: 15, polygon: false, pathOptions: { stroke: true, weight: 2, color: layer.options.color } })
                        }]
                    });
                    creativeDrawings.addLayer(decorator);
                }

                generateElevationProfile(layer); // Trigger Elevation Profile
            }

            if (activeDrawer) activeDrawer.disable();
            if (activeToolButton) activeToolButton.classList.remove('active');
        }
    });

    drawingBtn.addEventListener('click', () => {
        drawingPanel.style.display = 'block';
    });

    closeDrawingPanelBtn.addEventListener('click', () => {
        if (activeDrawer) activeDrawer.disable();
        if (activeToolButton) activeToolButton.classList.remove('active');
        drawingPanel.style.display = 'none';
    });

    toolButtons.forEach(button => {
        button.addEventListener('click', () => enableDrawer(button.dataset.tool));
    });

    // <-- NOVA LÒGICA PER A LA PALETA DE COLORS -->
    colorPalette.addEventListener('click', (event) => {
        const target = event.target;
        if (target.classList.contains('color-swatch') && target.dataset.color) {
            // Actualitzem el valor del selector de color principal
            colorPicker.value = target.dataset.color;
        }
    });

    makeDraggable(drawingPanel, document.getElementById('drawing-panel-header'));

    // --- ROUTE PLANNER 4.0 (DESIGNER BAR) LOGIC ---
    const routeSidebarBtn = document.getElementById('sidebar-route-btn');
    const designerBar = document.getElementById('route-designer-bar');
    const designerCloseBtn = document.getElementById('designer-close-btn');

    if (routeSidebarBtn && designerBar) {
        routeSidebarBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (designerBar.style.display === 'none' || !designerBar.style.display) {
                // Open Tool
                designerBar.style.display = 'flex';
                // ensure default mode or keep current
                if (!isRoutePlannerActive) enableRoutePlanner('auto');
            } else {
                // Close Tool
                designerBar.style.display = 'none';
                enableRoutePlanner('off'); // disable
                isRoutePlannerActive = false; // Ensure flag is off
                if (window.elevationChartInstance) window.elevationChartInstance.destroy(); // Clear chart
                document.getElementById('elevation-profile-panel').style.display = 'none';
                if (window.manualResultLayer) {
                    map.removeLayer(window.manualResultLayer);
                    window.manualResultLayer = null;
                }
            }
        });
    }

    if (designerCloseBtn) {
        designerCloseBtn.addEventListener('click', () => {
            designerBar.style.display = 'none';
            enableRoutePlanner('off');
            isRoutePlannerActive = false;
            if (window.elevationChartInstance) window.elevationChartInstance.destroy();
            document.getElementById('elevation-profile-panel').style.display = 'none';
            if (window.manualResultLayer) {
                map.removeLayer(window.manualResultLayer);
                window.manualResultLayer = null;
            }
        });
    }

    // Mode Switchers
    document.querySelectorAll('.designer-mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // UI Toggle
            document.querySelectorAll('.designer-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            enableRoutePlanner(btn.dataset.mode);
        });
    });

    // Variable Chips
    document.querySelectorAll('.designer-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            chip.classList.toggle('active');
            // Check if we have active data to re-render immediately
            if (window.lastRouteData) {
                renderChart(window.lastRouteData, getDesignerOptions());
            }
        });
    });



    // ======================================================
    // MODUL AROME PRO CROSS-SECTION (NATIVE INTEGRATION)
    // ======================================================

    const aromeBtn = document.getElementById('sidebar-arome-btn');
    const aromePanel = document.getElementById('arome-panel');
    const closeAromeBtn = document.getElementById('close-arome-panel');
    const aromeResetBtn = document.getElementById('arome-reset-btn');
    const aromeStatus = document.getElementById('arome-status');
    const aromeCanvas = document.getElementById('arome-canvas');
    const aromeTooltip = document.getElementById('arome-tooltip');

    // STATE
    let isAromeModeActive = false;
    let aromeMarkers = [];
    let aromePolyline = null;
    let aromeHoverMarker = null;
    let aromeData = null;
    let isAromeFetching = false;

    // CONFIG
    const AROME_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500];
    const PROXIES = [
        { name: "Directe", fn: (url) => url },
        { name: "Turbo-A", fn: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}` },
        { name: "Turbo-B", fn: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
        { name: "Turbo-C", fn: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
        { name: "Turbo-D", fn: (url) => `https://cors-anywhere.azm.workers.dev/${url}` },
        { name: "Turbo-E", fn: (url) => `https://thingproxy.freeboard.io/fetch/${url}` },
        { name: "Turbo-F", fn: (url) => `https://yacdn.org/proxy/${url}` }
    ];

    // INIT LISTENERS
    if (aromeBtn && aromePanel) {
        aromeBtn.addEventListener('click', () => {
            isAromeModeActive = !isAromeModeActive;

            if (isAromeModeActive) {
                aromeBtn.classList.add('active'); // Add active style to sidebar btn if exists
                aromePanel.style.display = 'flex';
                map.getContainer().style.cursor = 'crosshair';

                // Disable other modes if needed
                if (typeof enableDrawer === 'function') enableDrawer('off');

                // Initialize Draggable
                const header = document.getElementById('arome-panel-header');
                if (header) makeDraggable(aromePanel, header);

                // Initialize Resize Observer (Auto-Adapt Chart)
                if (!window.aromeResizeObserver) {
                    const chartContainer = document.getElementById('arome-chart-container');

                    if (chartContainer) {
                        window.aromeResizeObserver = new ResizeObserver((entries) => {
                            // Debounce slightly or just render if active
                            if (isAromeModeActive && aromeData) {
                                requestAnimationFrame(renderAromeChart);
                            }
                        });
                        window.aromeResizeObserver.observe(chartContainer);
                    }
                }

            } else {
                closeAromeMode();
            }
        });

        closeAromeBtn.addEventListener('click', closeAromeMode);

        aromeResetBtn.addEventListener('click', () => {
            resetAromeMap();
        });

        // Variable Toggles
        document.querySelectorAll('.arome-var-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.arome-var-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (aromeData) renderAromeChart(); // Re-render
            });
        });

        // INTERACTIVITY (Tooltip + Highlight on Map)
        if (aromeCanvas) {
            aromeCanvas.addEventListener('mousemove', handleAromeTooltip);
            aromeCanvas.addEventListener('mouseleave', () => {
                if (aromeTooltip) aromeTooltip.style.display = 'none';
                if (aromeHoverMarker) map.removeLayer(aromeHoverMarker);
            });
        }

    }
    // --- TOOLTIP LOGIC ---
    function handleAromeTooltip(e) {
        if (!aromeData || !aromeCanvas) return;

        const rect = aromeCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const pad = { t: 80, r: 40, b: 50, l: 60 };
        const dw = rect.width - pad.l - pad.r;
        const dh = rect.height - pad.t - pad.b;

        if (x < pad.l || x > pad.l + dw || y < pad.t || y > pad.t + dh) {
            aromeTooltip.style.display = 'none';
            if (aromeHoverMarker) map.removeLayer(aromeHoverMarker);
            return;
        }

        const pctX = (x - pad.l) / dw;
        const idxH = Math.min(aromeData.weather.length - 1, Math.round(pctX * (aromeData.weather.length - 1)));
        const pctY = 1 - (y - pad.t) / dh;
        const idxV = Math.min(AROME_LEVELS.length - 1, Math.round(pctY * (AROME_LEVELS.length - 1)));

        const hoverPos = aromeData.path[idxH];
        if (aromeHoverMarker) map.removeLayer(aromeHoverMarker);

        aromeHoverMarker = L.circleMarker([hoverPos.lat, hoverPos.lng], {
            radius: 8, color: 'white', weight: 4, fillColor: '#6366f1', fillOpacity: 0.9, zIndexOffset: 2000
        }).addTo(map);

        aromeTooltip.style.display = 'block';
        aromeTooltip.style.top = (y - 20) + 'px';
        aromeTooltip.style.left = (x + 20) + 'px';

        const press = AROME_LEVELS[idxV];
        const hData = aromeData.weather[idxH].hourly;
        const tIdx = aromeData.timeIndex;

        if (!hData) return;

        const alt = hData[`geopotential_height_${press}hPa`][tIdx].toFixed(0);
        const t = hData[`temperature_${press}hPa`][tIdx].toFixed(1);
        const hum = hData[`relative_humidity_${press}hPa`][tIdx].toFixed(0);
        const wind = hData[`windspeed_${press}hPa`][tIdx].toFixed(1);

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const valColor = isDark ? 'white' : 'black';

        document.getElementById('arome-tt-header').innerHTML =
            `${(pctX * aromeData.dist).toFixed(1)} km${press} hPa`;

        document.getElementById('arome-tt-body').innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                Alçada:
                ${alt} m
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(128,128,128,0.2); padding-top:2px; margin-top:2px;">
                Temp:
                ${t} °C
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                Humitat:
                ${hum} %
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                Vent:
                ${wind} km/h
            </div>
        `;
    }

    // MAP CLICK INTERCEPTION
    map.on('click', (e) => {
        if (!isAromeModeActive || isAromeFetching) return;

        // Allow only 2 points
        if (aromeMarkers.length >= 2) resetAromeMap();

        const m = L.circleMarker(e.latlng, { radius: 6, color: '#6366f1', weight: 2, fillOpacity: 1, fillColor: '#020617' }).addTo(map);
        aromeMarkers.push(m);

        if (aromeMarkers.length === 2) {
            // Draw Line
            const latlngs = aromeMarkers.map(x => x.getLatLng());
            aromePolyline = L.polyline(latlngs, { color: '#6366f1', weight: 3, dashArray: '8, 12', opacity: 0.8 }).addTo(map);

            // HIDE EMPTY STATE UI
            document.getElementById('arome-empty-state').style.display = 'none';
            document.getElementById('arome-chart-container').style.display = 'none';

            // FETCH DATA
            fetchAromeData();
        }
    });

    function closeAromeMode() {
        isAromeModeActive = false;
        aromePanel.style.display = 'none';
        map.getContainer().style.cursor = '';
        if (aromeBtn) aromeBtn.classList.remove('active');
        resetAromeMap();
    }

    function resetAromeMap() {
        if (aromeMarkers) {
            aromeMarkers.forEach(m => map.removeLayer(m));
        }
        if (aromePolyline) map.removeLayer(aromePolyline);
        if (aromeHoverMarker) map.removeLayer(aromeHoverMarker);

        aromeMarkers = [];
        aromeData = null;
        isAromeFetching = false;

        const emptyState = document.getElementById('arome-empty-state');
        if (emptyState) emptyState.style.display = 'flex';

        const chartContainer = document.getElementById('arome-chart-container');
        if (chartContainer) chartContainer.style.display = 'none';
    }

    // --- PROXY RACE LOGIC ---
    async function fetchParallelRace(url) {
        const controller = new AbortController();
        const busterUrl = url + `&cb=${Math.random().toString(36).substring(7)}`;

        const fetchPromises = PROXIES.map(p => {
            return fetch(p.fn(busterUrl), { signal: controller.signal })
                .then(async res => {
                    if (!res.ok) throw new Error(`Status ${res.status}`);
                    const text = await res.text();
                    try {
                        const json = JSON.parse(text);
                        if (json.error || (json.reason && json.reason.includes("limit exceeded"))) {
                            throw new Error("IP Limit");
                        }
                        controller.abort(); // Cancel others!
                        return { json, source: p.name };
                    } catch (e) { throw new Error("Invalid Format"); }
                });
        });

        try {
            return await Promise.any(fetchPromises);
        } catch (e) {
            throw new Error("All proxies failed");
        }
    }

    async function fetchAromeData() {
        if (isAromeFetching) return;
        isAromeFetching = true;

        aromeStatus.style.display = 'inline-block';
        aromeStatus.innerText = "LLANÇANT CURSA...";
        aromeStatus.className = "animate-pulse"; // Tailwind pulse if available or CSS

        try {
            const p1 = aromeMarkers[0].getLatLng();
            const p2 = aromeMarkers[1].getLatLng();
            const dist = p1.distanceTo(p2) / 1000;
            const steps = 120; // Increased resolution for better profile

            // Interpolate points
            const path = Array.from({ length: steps + 1 }, (_, i) => ({
                lat: (p1.lat + (p2.lat - p1.lat) * (i / steps)),
                lng: (p1.lng + (p2.lng - p1.lng) * (i / steps))
            }));

            const lats = path.map(p => p.lat.toFixed(3)).join(',');
            const lngs = path.map(p => p.lng.toFixed(3)).join(',');
            const varsQuery = AROME_LEVELS.flatMap(l => ['geopotential_height', 'temperature', 'relative_humidity', 'windspeed', 'winddirection'].map(v => `${v}_${l}hPa`)).join(',');

            // Forecast & Elevation (Back to Open-Meteo for reliability)
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&hourly=${varsQuery}&models=arome_france&forecast_days=1&timezone=Europe%2FMadrid`;
            const elevationUrl = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`;

            const [wObj, eObj] = await Promise.all([
                fetchParallelRace(weatherUrl),
                fetchParallelRace(elevationUrl)
            ]);

            const w = wObj.json;
            const e = eObj.json;
            const sourceName = wObj.source;

            // Prepare Data Object
            const currentHour = new Date().getHours();

            aromeData = {
                weather: Array.isArray(w) ? w : [w], // Open-Meteo returns array for multi-point
                elevation: e.elevation,
                dist,
                path,
                steps: steps + 1,
                timeIndex: currentHour
            };

            // Update UI
            document.getElementById('arome-dist-display').innerHTML = `${dist.toFixed(1)}km`;
            document.getElementById('arome-time-pill').innerText = `${currentHour.toString().padStart(2, '0')}:00H`;
            document.getElementById('arome-proxy-pill').innerText = `VIA ${sourceName.toUpperCase()}`;

            document.getElementById('arome-chart-container').style.display = 'flex';
            aromeStatus.style.display = 'none';

            // First Render
            requestAnimationFrame(renderAromeChart);

        } catch (err) {
            console.error("AROME Fetch Error:", err);
            aromeStatus.innerText = "ERROR SERVIDORS";
            aromeStatus.style.color = "red";
            alert("Error connectant amb AROME. Torna-ho a provar (els proxies poden estar saturats).");
            resetAromeMap();
        } finally {
            isAromeFetching = false;
        }
    }

    // --- RENDER VISUALIZATION ---
    function renderAromeChart() {
        if (!aromeData || !aromeCanvas) return;

        const container = document.getElementById('arome-chart-container');
        if (!container) return;

        const ctx = aromeCanvas.getContext('2d', { willReadFrequently: true });

        // Use container dimensions, not just canvas binding
        const rect = container.getBoundingClientRect();
        // Since canvas is flex:1 inside container with some padding, we can use container width minus padding or just let canvas fill.
        // Actually best is to check computed style or the canvas clientWidth after CSS layout.

        // Ensure proper size is read
        const w = aromeCanvas.clientWidth;
        const h = aromeCanvas.clientHeight;

        // Retina scaling
        const dpr = window.devicePixelRatio || 1;
        aromeCanvas.width = w * dpr;
        aromeCanvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const pad = { t: 80, r: 40, b: 50, l: 60 };
        const dw = w - pad.l - pad.r;
        const dh = h - pad.t - pad.b;

        // Determine Mode
        const activeBtn = document.querySelector('.arome-var-btn.active');
        const mode = activeBtn ? activeBtn.dataset.var : 'temp';
        const timeIdx = aromeData.timeIndex;

        // 1. Bilinear Interpolation (Offscreen Canvas)
        const heatCanvas = document.createElement('canvas');
        heatCanvas.width = aromeData.weather.length;
        heatCanvas.height = AROME_LEVELS.length;
        const hCtx = heatCanvas.getContext('2d');
        const imgData = hCtx.createImageData(heatCanvas.width, heatCanvas.height);

        for (let j = 0; j < AROME_LEVELS.length; j++) {
            for (let i = 0; i < aromeData.weather.length; i++) {
                const hData = aromeData.weather[i].hourly;
                if (!hData) continue;

                const idx = ((AROME_LEVELS.length - 1 - j) * heatCanvas.width + i) * 4;
                let rgb;

                const press = AROME_LEVELS[j];

                if (mode === 'temp') {
                    // Temperature Palette
                    const t = hData[`temperature_${press}hPa`][timeIdx];
                    rgb = getAromeTempColor(t);
                } else if (mode === 'wind') {
                    // Wind Palette
                    const s = hData[`windspeed_${press}hPa`][timeIdx];
                    // Hue shift: Blue (calm) -> Green -> Yellow -> Red -> Purple (storm)
                    const hue = Math.max(0, Math.min(285, 250 - (s * 3.2)));
                    rgb = hslToRgb(hue / 360, 0.75, 0.4);
                } else {
                    // Humidity Palette
                    const hum = hData[`relative_humidity_${press}hPa`][timeIdx];
                    rgb = getAromeHumColor(hum);
                }

                imgData.data[idx] = rgb[0];
                imgData.data[idx + 1] = rgb[1];
                imgData.data[idx + 2] = rgb[2];
                imgData.data[idx + 3] = 255; // Alpha
            }
        }
        hCtx.putImageData(imgData, 0, 0);

        // 2. Terrain Profile
        const maxGeoHeight = 6000; // Increased to 6000m to fit high terrain better

        // --- THEMING LOGIC ---
        // Check if dark mode is active (via html data-theme or similar)
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const textColor = isDark ? '#94a3b8' : '#475569';
        const axisColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        const barbColor = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(30, 41, 59, 0.9)';
        const terrainColor1 = isDark ? '#080c14' : '#e2e8f0'; // Deep dark vs Light gray
        const terrainColor2 = isDark ? '#020617' : '#f1f5f9';
        const terrainStroke = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';

        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(heatCanvas, pad.l, pad.t, dw, dh);

        ctx.beginPath();
        ctx.moveTo(pad.l, h - pad.b);

        aromeData.elevation.forEach((elev, i) => {
            const x = pad.l + (i / (aromeData.elevation.length - 1)) * dw;
            const y = (h - pad.b) - (elev / maxGeoHeight) * dh;
            ctx.lineTo(x, y);
        });

        ctx.lineTo(pad.l + dw, h - pad.b);
        ctx.closePath();

        const terrainGrad = ctx.createLinearGradient(0, h - pad.b - 200, 0, h - pad.b);
        terrainGrad.addColorStop(0, terrainColor1);
        terrainGrad.addColorStop(1, terrainColor2);
        ctx.fillStyle = terrainGrad;
        ctx.fill();
        ctx.strokeStyle = terrainStroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // 3. Wind Barbs (Subsampled)
        const skipFactor = Math.max(3, Math.floor(aromeData.weather.length / 14)); // Improved spacing
        ctx.strokeStyle = barbColor;
        ctx.lineWidth = 1;

        for (let i = 0; i < aromeData.weather.length; i += skipFactor) {
            for (let j = 0; j < AROME_LEVELS.length; j++) {
                const hData = aromeData.weather[i].hourly;
                const press = AROME_LEVELS[j];

                const spd = hData[`windspeed_${press}hPa`][timeIdx];
                const dir = hData[`winddirection_${press}hPa`][timeIdx];
                const geo = hData[`geopotential_height_${press}hPa`][timeIdx];

                const x = pad.l + (i / (aromeData.weather.length - 1)) * dw;
                const y = (h - pad.b) - (geo / maxGeoHeight) * dh;

                // Don't draw below ground
                const groundY = (h - pad.b) - (aromeData.elevation[i] / maxGeoHeight) * dh;
                if (y < groundY - 12) {
                    drawWindBarb(ctx, x, y, spd, dir, isDark);
                }
            }
        }

        // 4. Y-AXIS Labels & Grid
        ctx.fillStyle = textColor;
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";

        AROME_LEVELS.forEach((p, i) => {
            const y = pad.t + (AROME_LEVELS.length - 1 - i) * (dh / (AROME_LEVELS.length - 1));
            ctx.fillText(p, pad.l - 12, y);

            // Grid line
            ctx.strokeStyle = axisColor;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + dw, y); ctx.stroke();
        });
    }



    // --- UTILS & PALETTES ---
    function getAromeTempColor(temp) {
        if (temp < -38) return [15, 0, 40];
        if (temp < -36) return [20, 5, 50];
        if (temp < -34) return [25, 10, 60];
        if (temp < -32) return [30, 15, 75];
        if (temp < -30) return [35, 20, 90];
        if (temp < -28) return [40, 25, 105];
        if (temp < -26) return [45, 28, 120];
        if (temp < -24) return [50, 30, 130];
        if (temp < -22) return [55, 33, 140];
        if (temp < -20) return [60, 36, 150];
        if (temp < -18) return [69, 39, 160];
        if (temp < -16) return [86, 54, 163];
        if (temp < -14) return [91, 73, 168];
        if (temp < -12) return [88, 91, 179];
        if (temp < -10) return [81, 110, 194];
        if (temp < -8) return [66, 133, 212];
        if (temp < -6) return [41, 158, 229];
        if (temp < -4) return [13, 179, 238];
        if (temp < -2) return [0, 191, 243];
        if (temp < 0) return [0, 200, 235];
        if (temp < 2) return [20, 209, 203];
        if (temp < 4) return [40, 196, 171];
        if (temp < 6) return [65, 184, 140];
        if (temp < 8) return [90, 189, 110];
        if (temp < 10) return [125, 201, 85];
        if (temp < 12) return [160, 213, 60];
        if (temp < 14) return [195, 225, 45];
        if (temp < 16) return [230, 238, 30];
        if (temp < 18) return [255, 220, 20];
        if (temp < 20) return [255, 195, 15];
        if (temp < 22) return [255, 170, 10];
        if (temp < 24) return [255, 145, 5];
        if (temp < 26) return [255, 120, 0];
        if (temp < 28) return [255, 95, 10];
        if (temp < 30) return [255, 70, 20];
        if (temp < 32) return [250, 50, 40];
        if (temp < 34) return [245, 30, 60];
        if (temp < 36) return [240, 20, 90];
        if (temp < 38) return [235, 10, 120];
        if (temp < 40) return [225, 0, 150];
        if (temp < 42) return [205, 0, 165];
        if (temp < 44) return [185, 0, 180];
        if (temp < 46) return [160, 0, 190];
        return [160, 0, 190];
    }

    function hslToRgb(h, s, l) {
        let r, g, b;
        const f = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        return [Math.round(f(p, q, h + 1 / 3) * 255), Math.round(f(p, q, h) * 255), Math.round(f(p, q, h - 1 / 3) * 255)];
    }

    function getAromeHumColor(rh) {
        // Brown (dry) -> Green -> Blue (wet)
        if (rh < 20) return [188, 143, 143];
        if (rh < 40) return [240, 230, 140];
        if (rh < 60) return [152, 251, 152];
        if (rh < 80) return [60, 179, 113];
        if (rh < 90) return [0, 191, 255];
        return [30, 144, 255];
    }

    function drawWindBarb(ctx, x, y, spdKmh, dir, isDark) {
        if (spdKmh < 4) { ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.stroke(); return; }
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((dir + 180) * Math.PI / 180);

        const len = 12;
        const color = isDark ? "white" : "#1e293b"; // White in DarkMode, DarkSlate in LightMode
        const barbFill = isDark ? "white" : "#1e293b";

        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len);

        let s = spdKmh, pos = len;
        while (s >= 90) { // Triangle (50kts ~ 92kmh)
            ctx.moveTo(0, pos); ctx.lineTo(4, pos - 1.5); ctx.lineTo(0, pos - 3); ctx.fillStyle = barbFill; ctx.fill();
            pos -= 4; s -= 92;
        }
        while (s >= 18) { // Long Barb (10kts ~ 18kmh)
            ctx.moveTo(0, pos); ctx.lineTo(4, pos + 1);
            pos -= 3; s -= 18;
        }
        if (s >= 9) { // Short Barb (5kts ~ 9kmh)
            ctx.moveTo(0, pos); ctx.lineTo(2, pos + 1);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
    }

    // --- HOOK INTO DARK MODE TOGGLE ---
    // If the user clicks the global dark mode button, we need to redraw the canvas
    const globalDarkModeBtn = document.getElementById('toggle-dark-mode-btn');
    if (globalDarkModeBtn) {
        globalDarkModeBtn.addEventListener('click', () => {
            // Wait slightly for the attribute to update/transition
            setTimeout(() => {
                if (aromeData && isAromeModeActive) renderAromeChart();
            }, 50);
        });
    }

});

//Variables refresh
let isAutoRefreshActive = false;
let autoRefreshInterval = null;
let lastCheckedTimestamp = null;

let isLoadingData = false;
let lastSumatoriResult = [];

//altres variables

const MAPBOX_API_KEY = "pk.eyJ1IjoiamFucG9uc2EiLCJhIjoiY21la2JxOGx3MDNvbDJqc2V5dHhrOHlmdSJ9.xP0uBeThN1f-olxgiNd8pw";
var radarLayersCache = []; // Guardarà les 30 capes de l'animació
var opacityGlobal = 0.8;   // Per controlar l'opacitat
const cappiCache = new Map(); // Memòria per guardar els radars ja processats
let velocityLayer; // Variable global buida inicialment

// Helper per al Bulb Humit (Wet Bulb)
function calculateWetBulb(temp, rh) {
    if (rh <= 0 || rh > 105) return null;
    const log_rh = Math.log(rh / 100);
    const temp_frac = (17.625 * temp) / (243.04 + temp);
    const td = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);
    return temp - (temp - td) / 3;
}

// Helper per a la Cota de Neu
function calculateSnowLevel(temp, rh, altitude) {
    if (altitude === null || altitude === undefined) return null;
    const tw = calculateWetBulb(temp, rh);
    if (tw === null) return null;

    // Fórmula ajustada: La neu qualla aprox a Tw < 1.5ºC.
    const level = altitude + ((tw - 1.5) / 0.65) * 100;
    return Math.max(0, level); // No pot ser negativa
}

const VARIABLES_CONFIG = {
    // --- Temperatura ---
    'smc_32': { id: 32, name: 'Temperatura', unit: '°C', decimals: 1, aemet_id: 'ta' },
    'smc_40': { id: 40, name: 'Temperatura màxima', unit: '°C', decimals: 1, aemet_id: 'tamax', summary: 'max' },
    'smc_42': { id: 42, name: 'Temperatura mínima', unit: '°C', decimals: 1, aemet_id: 'tamin', summary: 'min' },
    'dewpoint': {
        name: 'Punt de Rosada',
        unit: '°C',
        decimals: 1,
        isHybrid: true, // Nova propietat per identificar aquesta variable especial
        smc_sources: { temp: 32, rh: 33 }, // Variables SMC necessàries per al càlcul
        aemet_id: 'tpr' // Clau per al valor directe d'AEMET
    },
    'calc_night_humidex_min': {
        name: 'Temp. de Xafogor Nocturna Mínima',
        unit: '°C',
        decimals: 1,
        isNightSummary: true, // Una marca personalitzada per identificar-la fàcilment
        sources: { temp: 32, rh: 33 } // Indiquem que necessita dades de Temp (32) i Humitat (33)
    },
    'weathercom_temp': {
        name: 'Temperatura Express',
        unit: '°C',
        decimals: 1,
        isWeatherComTemp: true // Nova propietat per identificar-la
    },
    'arome_map': {
        name: 'AROME Temperatura (Mapa)',
        special: true,
        isAromeMap: true
    },
    // --- ANOMALIES (Percentils) ---
    // 1. MÀXIMA vs P98 (Onades de Calor)
    // Si surt positiu (+) = Fa més calor que el 98% de la història -> VERMELL
    'anomalia_tmax': {
        name: 'Anomalia T. Màx. (vs P98)',
        unit: '°C',
        decimals: 1,
        isCalculated: true,
        showPositiveSign: true,
        sources: ['smc_40', 'percentils'],
        calculation: (d) => {
            if (!d.percentils || d.percentils.p98_tmax === undefined) return null;
            return d.smc_40 - d.percentils.p98_tmax;
        },
        colorScale: [
            { value: -10, color: 'rgba(0, 100, 255, 1)' },  // Molt per sota del rècord (Fresca)
            { value: -5, color: 'rgba(100, 200, 255, 1)' },
            { value: 0, color: 'rgba(240, 240, 240, 1)' },  // Igual al P98
            { value: 2, color: 'rgba(255, 165, 0, 1)' },    // Superant P98 (Calor)
            { value: 5, color: 'rgba(255, 0, 0, 1)' }       // Rècord destrossat (Foc)
        ]
    },

    // 2. MÍNIMA HIVERN vs P2 (Onades de Fred)
    // Exemple: Mínima 2ºC, P2 -2ºC -> 2 - (-2) = +4 -> Positiu (Més calor que el fred extrem) -> VERMELL/TARONJA
    // Exemple: Mínima -5ºC, P2 -2ºC -> -5 - (-2) = -3 -> Negatiu (Més fred que el fred extrem) -> BLAU FOSC
    'anomalia_tmin_hivern': {
        name: 'Anomalia T. Mín. Hivern (vs P2)',
        unit: '°C',
        decimals: 1,
        isCalculated: true,
        showPositiveSign: true,
        sources: ['smc_42', 'percentils'],
        calculation: (d) => {
            if (!d.percentils || d.percentils.p2_tmin === undefined) return null;
            return d.smc_42 - d.percentils.p2_tmin;
        },
        colorScale: [
            { value: -5, color: 'rgba(0, 0, 139, 1)' },     // -5 graus per sota del límit (Fred Històric) -> BLAU FOSC
            { value: -2, color: 'rgba(0, 0, 255, 1)' },     // Una mica per sota -> BLAU
            { value: 0, color: 'rgba(200, 200, 200, 1)' },  // Igual al límit
            { value: 3, color: 'rgba(255, 165, 0, 1)' },    // Per sobre del límit (Menys fred) -> TARONJA
            { value: 8, color: 'rgba(255, 0, 0, 1)' }       // Molt per sobre del límit (Calor relativa) -> VERMELL
        ]
    },

    // 3. MÍNIMA ESTIU vs P98 (Nits Tòrrides)
    // Si surt positiu (+) = La mínima és més alta que el rècord -> VERMELL
    'anomalia_tmin_estiu': {
        name: 'Anomalia Mín. Estiu (vs P98)',
        unit: '°C',
        decimals: 1,
        isCalculated: true,
        showPositiveSign: true,
        sources: ['smc_42', 'percentils'],
        calculation: (d) => {
            if (!d.percentils || d.percentils.p98_tmin_estiu === undefined) return null;
            return d.smc_42 - d.percentils.p98_tmin_estiu;
        },
        colorScale: [
            { value: -5, color: 'rgba(0, 100, 255, 1)' },   // Nit fresca/normal
            { value: 0, color: 'rgba(240, 240, 240, 1)' },  // Al límit de la calor extrema
            { value: 2, color: 'rgba(255, 100, 0, 1)' },    // Nit Tòrrida (Taronja)
            { value: 5, color: 'rgba(200, 0, 150, 1)' }     // Nit Infernal (Lila/Magenta)
        ]
    },
    'percentil_tmax': {
        name: 'Percentil 98 T. Màxima',
        unit: '°C',
        decimals: 1,
        isPercentile: true, // Una marca per identificar-les
        valueKey: 'p98_tmax' // La clau a buscar dins de dadesPercentils
    },
    'percentil_tmin_hivern': {
        name: 'Percentil 2 T. Mínima (Hivern)',
        unit: '°C',
        decimals: 1,
        isPercentile: true,
        valueKey: 'p2_tmin'
    },
    'percentil_tmin_estiu': {
        name: 'Percentil 98 T. Mínima (Estiu)',
        unit: '°C',
        decimals: 1,
        isPercentile: true,
        valueKey: 'p98_tmin_estiu'
    },
    // --- Temperatura Mitjana ---
    'smc_1000': {
        id: 1000,
        name: 'T. Mitjana Diària (Oficial)',
        unit: '°C',
        decimals: 1,

        // TRUC: Li diem que faci la mitjana. 
        // Com que només hi ha 1 dada, ens retornarà la dada tal qual sense tocar-la.
        summary: 'avg',

        isGlobalAvg: true,
        showRank: true
    },
    'calc_mitjana_diaria_curs': {
        name: 'T. Mitjana en Curs (Estimada)',
        unit: '°C',
        decimals: 1,
        isCalculatedMean: true, // Flag per activar la nostra funció especial
        isGlobalAvg: true       // Flag per activar el marcador global
    },
    'clima_tmitjana_mensual': {
        name: 'T. Mitjana Mensual',
        unit: '°C',
        decimals: 1,
        isClimatologia: true
    },
    'anomalia_tmitjana_mensual': {
        name: 'Anomalia T. Mitjana Mensual',
        unit: '°C',
        decimals: 1,
        isAnomaliaClima: true,
        showPositiveSign: true,
        colorScale: [
            { value: -4, color: 'rgba(0, 0, 255, 1)' },    // Molt fred
            { value: -2, color: 'rgba(100, 149, 237, 1)' }, // Fred
            { value: -0.5, color: 'rgba(173, 216, 230, 1)' },// Una mica fred
            { value: 0, color: 'rgba(240, 240, 240, 1)' },   // Normal
            { value: 0.5, color: 'rgba(255, 228, 181, 1)' }, // Una mica càlid
            { value: 2, color: 'rgba(255, 127, 80, 1)' },   // Càlid
            { value: 4, color: 'rgba(255, 0, 0, 1)' }       // Molt càlid
        ]
    },
    'clima_precip_mensual': {
        name: 'Precip. Mensual Acumulada',
        unit: 'mm',
        decimals: 1,
        isClimatologiaPrecip: true
    },
    'anomalia_precip_mensual': {
        name: 'Anomalia Precip. Mensual',
        unit: 'mm',
        decimals: 1,
        isAnomaliaPrecip: true,
        showPositiveSign: true,
        colorScale: [
            { value: -100, color: 'rgba(101, 67, 33, 1)' },
            { value: -50, color: 'rgba(160, 82, 45, 1)' },
            { value: -20, color: 'rgba(210, 105, 30, 1)' },
            { value: -5, color: 'rgba(244, 164, 96, 1)' },
            { value: 0, color: 'rgba(240, 240, 240, 1)' },
            { value: 5, color: 'rgba(152, 251, 152, 1)' },
            { value: 20, color: 'rgba(60, 179, 113, 1)' },
            { value: 50, color: 'rgba(30, 144, 255, 1)' },
            { value: 100, color: 'rgba(0, 0, 139, 1)' }
        ]
    },
    'ranking_fred_any': {
        name: 'Rànquing de Fred (Posició Anual)',
        unit: '#', // La unitat és la posició
        decimals: 0,
        isSpecialRanking: true, // Flag per activar la funció especial
        // Colors per al mapa segons la posició
        colorScale: [
            { value: 1, color: 'rgba(0, 0, 139, 1)' },   // #1 (Rècord absolut) -> Blau Fosc
            { value: 5, color: 'rgba(30, 144, 255, 1)' }, // Top 5 -> Blau Dodger
            { value: 10, color: 'rgba(135, 206, 250, 1)' },// Top 10 -> Blau Clar
            { value: 50, color: 'rgba(200, 200, 200, 1)' },// Normal -> Gris
            { value: 300, color: 'rgba(255, 165, 0, 1)' },  // Càlid -> Taronja
            { value: 350, color: 'rgba(255, 0, 0, 1)' }     // Rècord Calor -> Vermell
        ]
    },
    // --- Humitat ---
    'smc_33': { id: 33, name: 'Humitat relativa', unit: '%', decimals: 0, aemet_id: 'hr' },
    'smc_3': { id: 3, name: 'Humitat relativa màxima', unit: '%', decimals: 0, aemet_id: null, summary: 'max' },
    'smc_44': { id: 44, name: 'Humitat relativa mínima', unit: '%', decimals: 0, aemet_id: null, summary: 'min' },
    // --- Vent ---
    'wind': { name: 'Dades de Vent Base', internal: true }, // Variable interna per a càlculs
    'wind_speed_ms': { name: 'Velocitat Vent', unit: 'm/s', base_id: 30, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_speed_kmh': { name: 'Velocitat Vent', unit: 'km/h', base_id: 30, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_semihourly_ms': { name: 'Ratxa Màx. (Semi-h)', unit: 'm/s', base_id: 50, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_gust_semihourly_kmh': { name: 'Ratxa Màx. (Semi-h)', unit: 'km/h', base_id: 50, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_daily_ms': {
        name: 'Ratxa Màx. Diària',
        unit: 'm/s',
        id: 50,
        summary: 'max', // Important: Indica que volem el màxim del dia
        isSimpleWind: true, // <--- AFEGIT: Farem servir la funció "bona"
        conversion: 1,
        decimals: 1
    },
    'wind_gust_daily_kmh': {
        name: 'Ratxa Màx. Diària',
        unit: 'km/h',
        id: 50,
        summary: 'max',
        isSimpleWind: true, // <--- AFEGIT
        conversion: 3.6,
        decimals: 1
    },
    'wind_barbs': { name: 'Direcció i Velocitat', isWindBarb: true },
    'wind_barbs_gust': { name: 'Ratxa Màxima i Direcció', isWindBarb: true, windType: 'gust' },
    'smc_1503': { id: 1503, name: 'Velocitat Mitjana Diària Vent 10m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },
    'smc_1504': { id: 1504, name: 'Velocitat Mitjana Diària Vent 6m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },
    'smc_1505': { id: 1505, name: 'Velocitat Mitjana Diària Vent 2m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },

    // --- Precipitació ---
    'precip_semihoraria': {
        id: 35,
        name: 'Precipitació Semihorària',
        unit: 'mm',
        decimals: 1,
        isSemiHourlyRate: true // ★ NOU FLAG PER A BARRES INCREMENTALS
    },
    'smc_35': {
        id: 35,
        name: 'Precipitació acumulada',
        unit: 'mm',
        decimals: 1,
        aemet_id: 'prec',
        summary: 'sum',
        isDailyAccumulation: true // ★ NOU FLAG PER A DENT DE SERRA
    },
    'smc_72': { id: 72, name: 'Precipitació màxima en 1 minut', unit: 'mm', decimals: 1, aemet_id: null },
    'smc_72_daily_max': { id: 72, name: 'Intensitat Màx. Diària', unit: 'mm/min', decimals: 1, summary: 'max' },
    'weathercom_precip': {
        name: 'Precipitació Express',
        unit: 'mm',
        decimals: 1,
        isWeatherCom: true // Propietat clau per identificar-la
    },
    'weathercom_precip_semihourly': {
        name: 'Precipitació Express (Semihorària)',
        isWeatherComSemiHourly: true // Propietat nova per identificar-la
    },
    'ecowitt_precip': {
        name: 'Precipitació Ecowitt',
        unit: 'mm',
        decimals: 1,
        isEcowitt: true // Propietat clau per identificar-la
    },
    'sumatori_precipitacio': {
        name: 'Sumatori Precipitació',
        unit: 'mm',
        decimals: 1
    },
    'diaria_oficials': {
        name: 'Precipitació Diària Oficials',
        unit: 'mm',
        id: 35, // Reutilitzem la lògica de pluja
        decimals: 1,
        isMeteoGuilleriesCombined: true,
        summary: 'sum' // Tractem-ho com acumulació diària
    },
    // Afegeix aquestes dues "variables virtuals" dins del teu objecte VARIABLES_CONFIG
    'alert_intensity': {
        id: 35, // Basat en la precipitació (id: 35)
        name: 'Alerta per Intensitat (>20mm/30min)',
        unit: 'mm',
        decimals: 1,
        summary: 'max', // <-- LA CLAU: demanem el MÀXIM valor del dia
        isAlert: true,
        alertThreshold: 20
    },
    'alert_accumulation': {
        id: 35, // Basat en la precipitació (id: 35)
        name: 'Alerta per Acumulació (>50mm/dia)',
        unit: 'mm',
        decimals: 1,
        summary: 'sum', // <-- Aquí demanem el SUMATORI total del dia
        isAlert: true,
        alertThreshold: 50
    },
    // --- Pressió ---
    'smc_34': { id: 34, name: 'Pressió atmosfèrica', unit: 'hPa', decimals: 1, aemet_id: 'pres' },
    'smc_1': { id: 1, name: 'Pressió atmosfèrica màxima', unit: 'hPa', decimals: 1, aemet_id: null, summary: 'max' },
    'smc_2': { id: 2, name: 'Pressió atmosfèrica mínima', unit: 'hPa', decimals: 1, aemet_id: null, summary: 'min' },
    // --- Neu ---
    'smc_38': {
        id: 38,
        name: 'Gruix de neu a terra',
        unit: 'cm',
        decimals: 0,
        isSnowDepth: true // ★ NOU FLAG PER A LA NEU
    },
    // --- VARIABLES DE NEU CALCULADES ---
    'calc_cota_neu': {
        name: 'Cota de Neu Estimada',
        unit: 'm',
        decimals: 0,
        isCalculated: true,
        sources: ['smc_32', 'smc_33'], // 'altitud' no és una font de l'API, és metadada
        calculation: (d) => {
            const alt = d.altitud; // Ara ja hauria d'estar disponible
            if (alt == null) return null;

            return calculateSnowLevel(d.smc_32, d.smc_33, alt);
        },
        colorScale: [
            { value: 0, color: 'rgba(255, 255, 255, 0.8)' },   // Nivell del mar
            { value: 500, color: 'rgba(200, 240, 255, 0.8)' }, // 500m
            { value: 1000, color: 'rgba(100, 200, 255, 0.8)' },// 1000m
            { value: 1500, color: 'rgba(50, 150, 255, 0.8)' }, // 1500m
            { value: 2000, color: 'rgba(0, 100, 255, 0.8)' },  // 2000m
            { value: 2500, color: 'rgba(0, 50, 200, 0.8)' }    // >2500m
        ],
        popupTemplate: (station, finalValue, config) => {
            const temp = station.smc_32.toFixed(1);
            const rh = station.smc_33.toFixed(0);
            const alt = station.altitud ? station.altitud.toFixed(0) : '?';
            const tw = calculateWetBulb(station.smc_32, station.smc_33).toFixed(1);

            let descripcio = "";
            let colorStatus = "var(--text-main)";
            if (station.altitud) {
                const diff = finalValue - station.altitud; // Cota - Altitud
                if (Math.abs(diff) < 150) {
                    descripcio = "(Aquí mateix! ❄️/💧)";
                    colorStatus = "orange"; // Límit (Visible en dark/light)
                } else if (diff > 0) {
                    descripcio = `(PLUJA 💧 - La neu és ${diff.toFixed(0)}m més amunt)`;
                    colorStatus = "var(--accent-blue)"; // Blau adaptatiu
                } else {
                    descripcio = `(NEU ❄️ - La neu comença ${Math.abs(diff).toFixed(0)}m més avall)`;
                    colorStatus = "#00BFFF"; // Blau cel, maco per neu
                }
            }

            return `<b>${station.nom}</b><br>
                Altitud estació: ${alt} m<br>
                <hr style="margin: 4px 0;">
                <b>Cota de Neu: ~${finalValue.toFixed(0)} m</b><br>
                <b style="color:${colorStatus}">${descripcio}</b><br>
                <i style="font-size:11px;">Basat en Bulb Humit (${tw}°C)</i>`;
        }
    },
    'calc_snow_intensity': {
        name: 'Intensitat de Neu Estimada',
        unit: 'cm/h',
        decimals: 1,
        isCalculated: true,
        sources: ['smc_32', 'precip_semihoraria'], // T i Pluja
        calculation: (d) => {
            // Condició 1: Ha d'estar precipitant
            const precipMmh = d.precip_semihoraria * 2; // Convertim 30min a horària aprox
            if (!precipMmh || precipMmh < 0.1) return 0;

            // Condició 2: La temperatura ha de ser propicia (< 2ºC per dir alguna cosa, ideal < 1)
            // Llavors apliquem ràtio 1:1 o 1:1.5
            const temp = d.smc_32;

            if (temp > 3) return 0; // Pluja
            if (temp > 1.5) return precipMmh * 0.5; // Aiguaneu / Neu molt humida (ràtio baix)
            if (temp > 0) return precipMmh * 1.0; // Neu humida (1:1)
            if (temp > -5) return precipMmh * 1.5; // Neu seca (1:1.5)
            return precipMmh * 2.0; // Pols (1:2)
        },
        colorScale: [
            { value: 0.1, color: 'rgba(230, 230, 255, 0.5)' }, // Molt feble
            { value: 1, color: 'rgba(255, 255, 255, 0.9)' },   // Moderada
            { value: 3, color: 'rgba(100, 255, 255, 0.9)' },   // Forta
            { value: 5, color: 'rgba(255, 100, 255, 0.9)' },   // Molt forta
            { value: 10, color: 'rgba(150, 50, 255, 1)' }      // Torb/Nevada històrica
        ],
        popupTemplate: (station, finalValue, config) => {
            return `<b>${station.nom}</b><br>
                T. Actual: ${station.smc_32.toFixed(1)} °C<br>
                Precip: ${(station.precip_semihoraria * 2).toFixed(1)} mm/h<br>
                <hr style="margin: 4px 0;">
                <b>Intensitat Neu: ~${finalValue.toFixed(1)} cm/h</b>`;
        }
    },
    'calc_snow_potential': {
        name: 'Potencial Acumulació (Snow Power)',
        unit: '%',
        decimals: 0,
        isCalculated: true,
        sources: ['smc_32', 'smc_33', 'precip_semihoraria'],
        calculation: (d) => {
            const temp = d.smc_32;
            const rh = d.smc_33;
            // Si no hi ha dada de precipitació, assumim 0
            const precip = d.precip_semihoraria || 0;

            if (precip <= 0) return 0;

            const tw = calculateWetBulb(temp, rh);
            if (tw == null) return null;

            // Factor Temperatura (Tw)
            // Tw > 1.5 -> 0%
            // Tw = 0 -> 100%
            // Tw < -1 -> 120% (neu molt seca)
            let tempFactor = 0;
            if (tw > 1.5) tempFactor = 0;
            else if (tw > 0) tempFactor = 1 - (tw / 1.5); // Lineal de 0 a 1
            else tempFactor = 1 + (Math.abs(tw) * 0.1); // Bonus per fred

            // Factor Precipitación (intensitat ajuda a desplomar)
            // Si cauen > 2mm/30min, bonus de 20%
            let precipFactor = 1;
            if (precip > 2) precipFactor = 1.2;
            if (precip > 5) precipFactor = 1.5;

            let potential = tempFactor * precipFactor * 100;
            return Math.min(potential, 200); // Cap a 200% (nevada extremadament eficient)
        },
        colorScale: [
            { value: 10, color: 'rgba(200, 200, 200, 0.5)' }, // Poc probable
            { value: 50, color: 'rgba(200, 255, 200, 0.8)' }, // Possible
            { value: 80, color: 'rgba(100, 255, 100, 0.9)' }, // Probable
            { value: 100, color: 'rgba(255, 255, 0, 1)' },    // Eficient
            { value: 120, color: 'rgba(255, 150, 0, 1)' },    // Molt Eficient
            { value: 150, color: 'rgba(255, 0, 0, 1)' }       // EXTREM (Desplomament)
        ],
        popupTemplate: (station, finalValue, config) => {
            let desc = "";
            if (finalValue < 20) desc = "Feble / Poc Probable";
            else if (finalValue < 50) desc = "Moderada / Possible";
            else if (finalValue < 80) desc = "Forta / Probable";
            else if (finalValue < 100) desc = "Molt Forta / Eficient";
            else if (finalValue < 120) desc = "EXTREMA (Eficiència màxima)";
            else desc = "DESPLOMAMENT (Neu a cotes baixes)";

            return `<b>${station.nom}</b><br>
                T. Actual: ${station.smc_32.toFixed(1)} °C<br>
                Precip: ${station.precip_semihoraria ? (station.precip_semihoraria * 2).toFixed(1) : '0'} mm/h<br>
                <hr style="margin: 4px 0;">
                <b>Potencial: ${finalValue.toFixed(0)}%</b><br>
                <i>${desc}</i>`;
        }
    },
    'var_neu_1h': {
        name: 'Acumulació/Fosa (1h)',
        unit: 'cm',
        decimals: 1,
        comparison: 'instant',
        base_id: 38, // Basat en el gruix (id 38)
        showPositiveSign: true,
        timeshift_hours: 1
    },
    'var_neu_3h': {
        name: 'Acumulació/Fosa (3h)',
        unit: 'cm',
        decimals: 1,
        comparison: 'instant',
        base_id: 38,
        showPositiveSign: true,
        timeshift_hours: 3
    },
    'var_neu_6h': {
        name: 'Acumulació/Fosa (6h)',
        unit: 'cm',
        decimals: 1,
        comparison: 'instant',
        base_id: 38,
        showPositiveSign: true,
        timeshift_hours: 6
    },
    'var_neu_24h': {
        name: 'Variació Gruix (24h)',
        unit: 'cm',
        decimals: 0,
        comparison: 'instant',
        base_id: 38,
        showPositiveSign: true,
        timeshift_hours: 24
    },

    // --- VARIABLE INVENTADA: SWE (Snow Water Equivalent) ---
    'calc_swe': {
        name: 'Aigua Equivalent (SWE Estimat)',
        unit: 'mm',
        decimals: 0,
        isCalculated: true,
        sources: ['smc_38'],
        calculation: (d) => {
            const gruix = d.smc_38;
            if (gruix <= 0) return 0;
            return gruix * 3; // Estimació: 1 cm neu = 3 mm aigua (densitat 0.3)
        },
        // NOVA ESCALA COORDINADA AMB LA FUNCIÓ
        colorScale: [
            { value: 0, color: 'rgba(224, 247, 250, 0.9)' },
            { value: 20, color: 'rgba(79, 195, 247, 0.9)' },
            { value: 40, color: 'rgba(33, 150, 243, 0.9)' },
            { value: 80, color: 'rgba(21, 101, 192, 0.9)' },
            { value: 120, color: 'rgba(103, 58, 183, 0.9)' },
            { value: 140, color: 'rgba(136, 14, 79, 0.9)' }
        ],
        popupTemplate: (station, finalValue, config) => {
            return `<b>${station.nom}</b><br>
                    Gruix actual: ${station.smc_38} cm<br>
                    <hr style="margin: 4px 0;">
                    <b>Reserva Hídrica (SWE): ~${finalValue.toFixed(0)} mm</b><br>
                    <i style="font-size:10px; color:#666;">*Estimació basada en densitat mitjana (0.3)</i>`;
        }
    },
    'var_tmax_24h': { name: 'Variació Tª Màx. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', showPositiveSign: true, base_id: 40, summary: 'max' },
    'var_tmin_24h': { name: 'Variació Tª Mín. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', showPositiveSign: true, base_id: 42, summary: 'min' },
    'var_tactual_1h': { name: 'Tendència T. Actual (1h)', unit: '°C', decimals: 1, comparison: 'instant', showPositiveSign: true, base_id: 32, timeshift_hours: 1 },
    'var_tactual_3h': { name: 'Tendència T. Actual (3h)', unit: '°C', decimals: 1, comparison: 'instant', showPositiveSign: true, base_id: 32, timeshift_hours: 3 },
    'var_tactual_6h': { name: 'Tendència T. Actual (6h)', unit: '°C', decimals: 1, comparison: 'instant', showPositiveSign: true, base_id: 32, timeshift_hours: 6 },
    'var_tactual_12h': { name: 'Tendència T. Actual (12h)', unit: '°C', decimals: 1, comparison: 'instant', showPositiveSign: true, base_id: 32, timeshift_hours: 12 },
    'var_tactual_24h': { name: 'Variació Tª Actual 24h', unit: '°C', decimals: 1, comparison: 'instant', showPositiveSign: true, base_id: 32 },
    'var_pressure_3h': {
        name: 'Tendència de Pressió (3h)',
        unit: 'hPa',
        decimals: 1,
        comparison: 'instant', // Indiquem que és una comparació entre dos moments
        base_id: 34,           // La variable base és la pressió (ID 34)
        showPositiveSign: true,
        timeshift_hours: 3     // El desplaçament de temps és de 3 hores
    },
    'var_pressure_24h': {
        name: 'Variació de Pressió (24h)',
        unit: 'hPa',
        decimals: 1,
        comparison: 'instant',
        base_id: 34,
        showPositiveSign: true,
        timeshift_hours: 24    // El desplaçament de temps és de 24 hores
    },
    // --- VARIABLES CALCULADES ---
    'calc_dryness_index': {
        name: 'Índex de Sequedat', unit: '°C', decimals: 1,
        isCalculated: true,
        sources: ['smc_32', 'smc_33'], // Necessitem Temperatura (32) i Humitat (33) per al càlcul
        calculation: (d) => {
            // Pas 1: Calculem el punt de rosada amb la fórmula que ja coneixem.
            const temp = d.smc_32;
            const hr = d.smc_33;
            if (hr <= 0) return null; // Evitem errors amb dades d'humitat invàlides
            const log_rh = Math.log(hr / 100);
            const temp_frac = (17.625 * temp) / (243.04 + temp);
            const dewPoint = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);

            // Pas 2: Retornem la diferència entre la temperatura i el punt de rosada.
            return temp - dewPoint;
        },
        colorScale: [
            { value: 2, color: 'rgba(0, 0, 255, 1)' },     // Blau (Molt Humit / Saturat)
            { value: 5, color: 'rgba(0, 150, 255, 1)' },   // Blau clar
            { value: 8, color: 'rgba(100, 255, 100, 1)' }, // Verd (Confortable)
            { value: 12, color: 'rgba(255, 255, 0, 1)' },  // Groc
            { value: 16, color: 'rgba(255, 150, 0, 1)' },  // Taronja (Aire Sec)
            { value: 20, color: 'rgba(255, 50, 50, 1)' },   // Vermell (Molt Sec)
            { value: 24, color: 'rgba(139, 69, 19, 1)' }    // Marró (Extremadament Sec / Risc d'incendi)
        ],
        popupTemplate: (station, finalValue, config) => {
            const temp = station.smc_32.toFixed(1);
            const rh = station.smc_33.toFixed(0);
            const formattedFinalValue = finalValue.toFixed(config.decimals);

            return `<b>${station.nom}</b><br>
                <hr style="margin: 4px 0;">
                Temperatura: ${temp} °C<br>
                Humitat Relativa: ${rh} %<br>
                <hr style="margin: 4px 0;">
                <b>${config.name}: ${formattedFinalValue} ${config.unit}</b>`;
        }
    },
    'calc_fire_risk_semihourly': {
        name: "Índex de Risc d'Incendi",
        unit: '%',
        decimals: 0,
        isCalculated: true,
        sources: ['smc_32', 'smc_33', 'wind_gust'],
        calculation: (d) => {
            const temp = d.smc_32;
            const hr = d.smc_33;
            const ventMs = (d.wind_gust && d.wind_gust.speed_ms != null) ? d.wind_gust.speed_ms : 0;

            if (temp == null || hr == null) return null;

            // Convertim T a Fahrenheit
            const tempF = temp * 1.8 + 32;

            // Convertim vent (m/s) a milles per hora (mph) per a l'índex Fosberg
            const windMph = ventMs * 2.23694;

            // Calculem l'Equilibrium Moisture Content (EMC)
            let emc = 0;
            if (hr < 10) {
                emc = 0.03229 + 0.281073 * hr - 0.000578 * hr * tempF;
            } else if (hr <= 50) {
                emc = 2.22749 + 0.160107 * hr - 0.01478 * tempF;
            } else {
                emc = 21.08287 - 0.506514 * hr + 0.008329 * hr * hr - 0.01854 * hr * tempF;
            }

            // L'EMC no pot ser negatiu
            emc = Math.max(0.1, emc);

            // Si la humitat del combustible és superior al 30%, el risc és zero
            if (emc > 30) {
                return 0;
            }

            // Ràtio d'humitat i factor de combustible
            const r = emc / 30.0;
            const f = 1.0 - 2.0 * r + 1.5 * r * r - 0.5 * r * r * r;

            // Càlcul de la propagació del foc segons Fosberg (FFWI)
            let ffwi = f * Math.sqrt(1.0 + windMph * windMph) / 0.3002;

            // Limitem entre 0 i 100
            return Math.min(100, Math.max(0, ffwi));
        },
        colorScale: [
            { value: 0, color: 'rgba(40, 167, 69, 1)' },     // Baix (0 - 11)
            { value: 12, color: 'rgba(255, 193, 7, 1)' },    // Moderat (12 - 24)
            { value: 25, color: 'rgba(255, 123, 0, 1)' },    // Alt (25 - 39)
            { value: 40, color: 'rgba(220, 53, 69, 1)' },    // Molt Alt (40 - 59)
            { value: 60, color: 'rgba(108, 2, 138, 1)' }     // Extrem (>= 60)
        ],
        popupTemplate: (station, finalValue, config) => {
            const temp = station.smc_32;
            const rh = station.smc_33;
            const ventMs = (station.wind_gust && station.wind_gust.speed_ms != null) ? station.wind_gust.speed_ms : 0;
            const gust = Math.round(ventMs * 3.6);

            // Calculem EMC de nou per al popup
            const tempF = temp * 1.8 + 32;
            let emc = 0;
            if (rh < 10) {
                emc = 0.03229 + 0.281073 * rh - 0.000578 * rh * tempF;
            } else if (rh <= 50) {
                emc = 2.22749 + 0.160107 * rh - 0.01478 * tempF;
            } else {
                emc = 21.08287 - 0.506514 * rh + 0.008329 * rh * rh - 0.01854 * rh * tempF;
            }
            emc = Math.max(0.1, emc);

            // Càlcul del Dèficit de Pressió de Vapor (VPD) en kPa
            const es = 0.61078 * Math.exp((17.27 * temp) / (temp + 237.3));
            const ea = es * (rh / 100);
            const vpd = es - ea;

            // Rànquings de risc
            let riskText = "EXTREM";
            let riskColor = "rgba(108, 2, 138, 1)";
            let riskTextColor = "#ffffff";
            if (finalValue < 12) {
                riskText = "BAIX";
                riskColor = "rgba(40, 167, 69, 1)";
            } else if (finalValue < 25) {
                riskText = "MODERAT";
                riskColor = "rgba(255, 193, 7, 1)";
                riskTextColor = "#000000";
            } else if (finalValue < 40) {
                riskText = "ALT";
                riskColor = "rgba(255, 123, 0, 1)";
            } else if (finalValue < 60) {
                riskText = "MOLT ALT";
                riskColor = "rgba(220, 53, 69, 1)";
            }

            // Regla dels 30
            const ruleT = temp >= 30;
            const ruleHR = rh <= 30;
            const ruleWind = gust >= 30;
            const activeCount = (ruleT ? 1 : 0) + (ruleHR ? 1 : 0) + (ruleWind ? 1 : 0);

            // Llindars extrems GRAF (Megafoc / Convector)
            const isExtremeHeat = temp >= 40;
            const isExtremeDry = rh <= 10;
            const isMegafireActive = isExtremeHeat || isExtremeDry;

            // Explicació combustible
            let emcText = "Humitat normal (baix risc d'ignició)";
            if (emc < 5) {
                emcText = "Extremadament Sec (Combustió explosiva!)";
            } else if (emc < 10) {
                emcText = "Críticament Sec (Facilitat d'ignició molt alta)";
            } else if (emc < 15) {
                emcText = "Sec (Propagació fàcil en cas d'ignició)";
            } else if (emc < 20) {
                emcText = "Lleugerament Sec (Risc moderat d'ignició)";
            }

            return `<div style="font-family: 'Outfit', sans-serif; min-width: 235px; color: #1e293b; padding: 4px;">
                <h3 style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700; color: #0f172a;">${station.nom}</h3>
                
                ${isMegafireActive ? `
                <!-- Alerta Megafoc Convector -->
                <div style="background-color: #fef2f2; border: 1.5px solid #ef4444; border-radius: 8px; padding: 6px 10px; margin-bottom: 12px; color: #991b1b; font-size: 10px; line-height: 1.3;">
                    <div style="font-weight: 800; font-size: 11px; margin-bottom: 2px;">🚨 LIMIT GRAF (SÚPER-INCENDI)</div>
                    S'ha superat el llindar de megafoc convector (${isExtremeHeat ? `Tª ≥ 40°C` : ''}${isExtremeHeat && isExtremeDry ? ' i ' : ''}${isExtremeDry ? `HR ≤ 10%` : ''}). Propagació convectora fora de capacitat d'extinció!
                </div>
                ` : ''}

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b;">Risc d'Incendi (FFWI)</span>
                    <span style="background-color: ${riskColor}; color: ${riskTextColor}; padding: 3px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; text-align: center;">${riskText}</span>
                </div>

                <!-- Barra de progrés amb gradient -->
                <div style="position: relative; height: 10px; background: linear-gradient(to right, rgba(40, 167, 69, 1) 0%, rgba(40, 167, 69, 1) 12%, rgba(255, 193, 7, 1) 12%, rgba(255, 193, 7, 1) 25%, rgba(255, 123, 0, 1) 25%, rgba(255, 123, 0, 1) 40%, rgba(220, 53, 69, 1) 40%, rgba(220, 53, 69, 1) 60%, rgba(108, 2, 138, 1) 60%, rgba(108, 2, 138, 1) 100%); border-radius: 5px; margin-bottom: 6px; overflow: visible;">
                    <div style="position: absolute; left: ${finalValue}%; top: -3px; width: 6px; height: 16px; background-color: #0f172a; border: 2px solid #ffffff; border-radius: 3px; transform: translateX(-50%); box-shadow: 0 1px 3px rgba(0,0,0,0.3); z-index: 2;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; font-weight: 600; margin-bottom: 12px;">
                    <span>0%</span>
                    <span style="color: #0f172a; font-weight: 700;">${finalValue.toFixed(0)}%</span>
                    <span>100%</span>
                </div>

                <!-- Detall Variables -->
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; background: rgba(0, 0, 0, 0.03); border-radius: 8px; padding: 6px; margin-bottom: 12px; font-size: 11px;">
                    <div style="text-align: center;">
                        <span style="display: block; font-size: 16px;">🌡️</span>
                        <span style="font-weight: 700; color: #0f172a;">${temp.toFixed(1)}°C</span>
                        <span style="display: block; font-size: 9px; color: #64748b;">Temp</span>
                    </div>
                    <div style="text-align: center; border-left: 1px solid rgba(0, 0, 0, 0.08); border-right: 1px solid rgba(0, 0, 0, 0.08);">
                        <span style="display: block; font-size: 16px;">💧</span>
                        <span style="font-weight: 700; color: #0f172a;">${rh.toFixed(0)}%</span>
                        <span style="display: block; font-size: 9px; color: #64748b;">Humitat</span>
                    </div>
                    <div style="text-align: center;">
                        <span style="display: block; font-size: 16px;">💨</span>
                        <span style="font-weight: 700; color: #0f172a;">${gust} km/h</span>
                        <span style="display: block; font-size: 9px; color: #64748b;">Ratxa</span>
                    </div>
                </div>

                <!-- VPD Section -->
                <div style="border-top: 1px solid rgba(0, 0, 0, 0.08); padding-top: 8px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <span style="font-size: 11px; font-weight: 700; color: #334155;">Dèficit Pressió Vapor (VPD):</span>
                        <span style="font-size: 10px; font-weight: 700; color: ${vpd >= 3.0 ? '#ef4444' : (vpd >= 1.8 ? '#f97316' : '#22c55e')};">${vpd.toFixed(2)} kPa</span>
                    </div>
                    <div style="display: flex; gap: 3px; height: 6px; border-radius: 3px; overflow: hidden; background: #e2e8f0; margin-bottom: 4px;">
                        <div style="flex: 10; background: #22c55e; opacity: 1;"></div>
                        <div style="flex: 8; background: #eab308; opacity: ${vpd >= 1.0 ? 1 : 0.25};"></div>
                        <div style="flex: 12; background: #f97316; opacity: ${vpd >= 1.8 ? 1 : 0.25};"></div>
                        <div style="flex: 20; background: #dc2626; opacity: ${vpd >= 3.0 ? 1 : 0.25};"></div>
                    </div>
                    <div style="font-size: 9px; color: ${vpd >= 3.0 ? '#dc2626' : '#64748b'}; font-style: italic; line-height: 1.2;">
                        ${vpd >= 3.0 ? '🚨 <strong>Atmòsfera extremadament dessecant.</strong> Vegetació vulnerable.' : (vpd >= 1.8 ? '⚠️ Dessecació activa. Combustible assecant-se.' : 'Evaporació ambient normal o feble.')}
                    </div>
                </div>

                <!-- Regla dels 30 -->
                <div style="border-top: 1px solid rgba(0, 0, 0, 0.08); padding-top: 8px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <span style="font-size: 11px; font-weight: 700; color: #334155;">Regla dels 30 (30-30-30):</span>
                        <span style="font-size: 10px; font-weight: 700; color: ${activeCount === 3 ? '#ef4444' : (activeCount === 2 ? '#f97316' : '#64748b')};">${activeCount}/3 Actives</span>
                    </div>
                    <div style="font-size: 10px; color: #475569; display: flex; flex-direction: column; gap: 2px;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>🌡️ Temp ≥ 30°C:</span>
                            <span style="font-weight: 600; color: ${ruleT ? '#ef4444' : '#22c55e'};">${ruleT ? 'SÍ ✅' : 'NO ❌'}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>💧 HR ≤ 30%:</span>
                            <span style="font-weight: 600; color: ${ruleHR ? '#ef4444' : '#22c55e'};">${ruleHR ? 'SÍ ✅' : 'NO ❌'}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>💨 Vent ≥ 30 km/h:</span>
                            <span style="font-weight: 600; color: ${ruleWind ? '#ef4444' : '#22c55e'};">${ruleWind ? 'SÍ ✅' : 'NO ❌'}</span>
                        </div>
                    </div>
                </div>

                <!-- Estat del combustible (EMC) -->
                <div style="border-top: 1px solid rgba(0, 0, 0, 0.08); padding-top: 8px; font-size: 10px; color: #64748b; line-height: 1.3;">
                    <div>🍂 Humitat Combustible Est. (EMC): <strong>${emc.toFixed(1)}%</strong></div>
                    <div style="font-style: italic; color: #475569; margin-top: 2px;">${emcText}</div>
                </div>
            </div>`;
        }
    },
    'calc_fog_risk': {
        name: 'Probabilitat de Boira/Boirina',
        unit: 'punts',
        decimals: 0,
        isCalculated: true,
        sources: ['smc_32', 'smc_33', 'wind'],

        calculation: (d) => {
            const temp = d.smc_32;
            const hr = d.smc_33;
            const windKmh = d.wind.speed_ms * 3.6;

            if (hr <= 0) return null;
            const log_rh = Math.log(hr / 100);
            const temp_frac = (17.625 * temp) / (243.04 + temp);
            const dewPoint = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);
            const spread = temp - dewPoint;

            let punts = 0;
            if (spread < 1.0) punts += 4;
            else if (spread < 1.5) punts += 3;
            else if (spread < 2.0) punts += 2;
            else if (spread < 2.5) punts += 1;
            if (windKmh < 5) punts += 3;
            else if (windKmh < 10) punts += 2;
            else if (windKmh < 15) punts += 1;

            return punts;
        },

        colorScale: [
            { value: 1, color: 'rgba(200, 220, 255, 1)' },
            { value: 3, color: 'rgba(180, 200, 220, 1)' },
            { value: 5, color: 'rgba(160, 175, 190, 1)' },
            { value: 7, color: 'rgba(140, 150, 160, 1)' }
        ],
        // ===== INICI DE LA CORRECCIÓ AL POPUP =====
        popupTemplate: (station, finalValue, config) => {
            // Dades originals (numèriques) per als càlculs
            const temp_numeric = station.smc_32;
            const rh_numeric = station.smc_33;

            // Dades formatades (text) només per mostrar
            const temp_display = temp_numeric.toFixed(1);
            const rh_display = rh_numeric.toFixed(0); // Aquesta variable ara es farà servir
            const windKmh_display = (station.wind.speed_ms * 3.6).toFixed(0);

            // Calculem el punt de rosada utilitzant les dades NUMÈRIQUES
            const log_rh = Math.log(rh_numeric / 100);
            const temp_frac = (17.625 * temp_numeric) / (243.04 + temp_numeric);
            const dewPoint = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);
            const spread = temp_numeric - dewPoint;

            // Ara formatem els resultats per mostrar-los
            const dewPoint_display = dewPoint.toFixed(1);
            const spread_display = spread.toFixed(1);

            return `<b>${station.nom}</b><br>
            <hr style="margin: 4px 0;">
            <b style="font-size:14px;">Prob. de Boira: ${finalValue} / 7 punts</b><br>
            <hr style="margin: 4px 0;">
            Temperatura: ${temp_display} °C<br>
            Humitat Relativa: ${rh_display} %<br>
            Punt de Rosada: ${dewPoint_display} °C<br>
            <b>Diferencial: ${spread_display} °C</b><br>
            Vent: ${windKmh_display} km/h`;
        }
    },
    // ★ REEMPLAÇA LA TEVA VARIABLE 'calc_rovellons_index' PER AQUESTA VERSIÓ FINAL ★
    'calc_rovellons_index': {
        name: "Índex de Rovellons",
        unit: 'punts',
        decimals: 0,
        isCalculated: true,
        isSpecial: true,
        sources: ['smc_35', 'smc_42', 'smc_40', 'smc_1503', 'smc_1504', 'smc_1505'], // Totes les fonts de vent
        colorScale: [
            { value: 0, color: 'rgba(248, 210, 153, 0.8)' },
            { value: 25, color: 'rgba(218, 165, 32, 0.8)' },
            { value: 50, color: 'rgba(152, 251, 152, 0.9)' },
            { value: 70, color: 'rgba(255, 165, 0, 1)' },
            { value: 85, color: 'rgba(210, 43, 43, 1)' }
        ],
        popupTemplate: (station, finalValue, config, details) => {
            const getMoonPhaseInfo = () => {
                const FASES = ['🌑 Nova', '🌒 Creixent', '🌓 Quart Creixent', '🌔 Gibosa Creixent', '🌕 Plena', '🌖 Gibosa Minvant', '🌗 Quart Minvant', '🌘 Minvant'];
                const CICLE_LUNAR = 29.530588853; const DATA_NOVA_CONEGUDA = 2451549.5;
                const araEnDiesJulians = (Date.now() / 86400000) - 0.5 + 2440588;
                const faseActual = ((araEnDiesJulians - DATA_NOVA_CONEGUDA) / CICLE_LUNAR) % 1;
                return FASES[Math.floor(faseActual * 8)];
            };

            return `<b>${station.nom}</b><br>
                <hr style="margin: 4px 0;">
                <b style="font-size:16px; display:block; text-align:center;">Índex: ${finalValue} / 100</b><br>
                <hr style="margin: 4px 0;">
                <b><u>Desglossament de la Puntuació:</u></b><br>
                🌧️ Punts per Pluja: <b style="color:green;">+${details.puntsPluja}</b><br>
                (Total acumulat: ${details.precipitacioTotal.toFixed(1)} mm)<br>
                🌡️ Ajust per Tº Nocturna: <b style="${details.puntsTempNoc >= 0 ? 'color:green;' : 'color:red;'}">${details.puntsTempNoc >= 0 ? '+' : ''}${details.puntsTempNoc}</b><br>
                (Nits fredes (<5°C): ${details.diesFreds} | Nits càlides (>15°C): ${details.diesCalids})<br>
                🔥 Penalitz. per Calor: <b style="color:red;">${details.penalitzacioTmax}</b><br>
                (Dies amb T. Màx >25°C: ${details.diesCalor})<br>
                💨 Penalitz. per Vent: <b style="color:red;">${details.penalitzacioVent}</b><br>
                (Dies amb vent persistent: ${details.diesVent} | Font principal: ${details.fontVent})<br>
                🌕 Bonificació per Lluna: <b style="color:green;">+${details.puntsLluna}</b><br>
                (Fase actual: ${getMoonPhaseInfo()})<br>
                <hr style="margin: 4px 0;">
                <i>Aquest índex és una estimació teòrica i no garanteix la presència de bolets.</i>`;
        }
    },
    'calc_amplitude': {
        name: 'Amplitud Tèrmica', unit: '°C', decimals: 1,
        isCalculated: true,
        sources: ['smc_40', 'smc_42'], // T. Màxima i T. Mínima
        calculation: (d) => d.smc_40 - d.smc_42,
        colorScale: [
            { value: 0, color: 'rgba(0, 150, 255, 1)' },   // Blau
            { value: 5, color: 'rgba(0, 220, 220, 1)' },   // Cian
            { value: 10, color: 'rgba(100, 255, 100, 1)' }, // Verd
            { value: 15, color: 'rgba(255, 255, 0, 1)' },  // Groc
            { value: 20, color: 'rgba(255, 150, 0, 1)' },  // Taronja
            { value: 25, color: 'rgba(255, 50, 50, 1)' },   // Vermell
            { value: 30, color: 'rgba(200, 0, 150, 1)' }    // Magenta
        ]
    },
    'calc_windchill': {
        name: 'Sensació Tèrmica (Vent)', unit: '°C', decimals: 1,
        isCalculated: true,
        sources: ['smc_32', 'wind'], // T. Actual i Vent
        calculation: (d) => {
            const temp = d.smc_32;
            const windKmh = Math.sqrt(d.wind.u ** 2 + d.wind.v ** 2) * 3.6; // Convertim de m/s a km/h
            if (temp > 10 || windKmh < 5) return temp; // La fórmula no s'aplica en aquestes condicions
            return 13.12 + 0.6215 * temp - 11.37 * Math.pow(windKmh, 0.16) + 0.3965 * temp * Math.pow(windKmh, 0.16);
        },
        colorScale: [ // Similar a la temperatura, però més freda
            { value: -20, color: 'rgba(180, 50, 255, 1)' },
            { value: -10, color: 'rgba(50, 50, 255, 1)' },
            { value: 0, color: 'rgba(0, 150, 255, 1)' },
            { value: 5, color: 'rgba(0, 220, 200, 1)' },
            { value: 10, color: 'rgba(150, 255, 150, 1)' }
        ]
    },
    'calc_humidex': { // Mantenim la clau per no trencar altres parts del codi
        name: 'Índex de Calor (HI)', unit: '°C', decimals: 1, // Canviem el nom
        isCalculated: true,
        sources: ['smc_32', 'smc_33'], // T. Actual i Humitat Relativa
        calculation: (d) => {
            // Cridem a la nova funció del Heat Index
            return calculateHeatIndex(d.smc_32, d.smc_33);
        },
        colorScale: [ // L'escala de colors es manté vàlida
            { value: 27, color: 'rgba(255, 255, 0, 1)' },  // Groc (Caution)
            { value: 32, color: 'rgba(255, 200, 0, 1)' },
            { value: 39, color: 'rgba(255, 150, 0, 1)' },  // Taronja (Extreme Caution)
            { value: 51, color: 'rgba(255, 80, 80, 1)' },  // Vermell (Danger)
            { value: 52, color: 'rgba(200, 0, 150, 1)' }   // Magenta (Extreme Danger)
        ]
    },
    'calc_wetbulb': {
        name: 'Temperatura de Bulb Humit', unit: '°C', decimals: 1,
        isCalculated: true,
        sources: ['smc_32', 'smc_33'], // T. Actual i Humitat Relativa
        calculation: (d) => {
            const temp = d.smc_32;
            const rh = d.smc_33;

            // Comprovació per evitar errors matemàtics amb humitats invàlides
            if (rh <= 0 || rh > 105) {
                return null; // No mostrem valors per a dades invàlides
            }

            // Pas 1: Càlcul del Punt de Rosada (Td)
            const log_rh = Math.log(rh / 100);
            const temp_frac = (17.625 * temp) / (243.04 + temp);
            const td = (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac);

            // Pas 2: Aproximació del Bulb Humit (Tw) amb la regla d'un terç
            const tw = temp - (temp - td) / 3;

            return tw;
        },
        // S'HA SUBSTITUÏT L'ESCALA ANTIGA PER L'ESCALA DETALLADA DE TEMPERATURA
        colorScale: [
            { value: -18, color: 'rgba(69, 39, 160, 1)' },
            { value: -16, color: 'rgba(86, 54, 163, 1)' },
            { value: -14, color: 'rgba(91, 73, 168, 1)' },
            { value: -12, color: 'rgba(88, 91, 179, 1)' },
            { value: -10, color: 'rgba(81, 110, 194, 1)' },
            { value: -8, color: 'rgba(66, 133, 212, 1)' },
            { value: -6, color: 'rgba(41, 158, 229, 1)' },
            { value: -4, color: 'rgba(13, 179, 238, 1)' },
            { value: -2, color: 'rgba(0, 191, 243, 1)' },
            { value: 0, color: 'rgba(0, 200, 235, 1)' },
            { value: 2, color: 'rgba(20, 209, 203, 1)' },
            { value: 4, color: 'rgba(40, 196, 171, 1)' },
            { value: 6, color: 'rgba(65, 184, 140, 1)' },
            { value: 8, color: 'rgba(90, 189, 110, 1)' },
            { value: 10, color: 'rgba(125, 201, 85, 1)' },
            { value: 12, color: 'rgba(160, 213, 60, 1)' },
            { value: 14, color: 'rgba(195, 225, 45, 1)' },
            { value: 16, color: 'rgba(230, 238, 30, 1)' },
            { value: 18, color: 'rgba(255, 220, 20, 1)' },
            { value: 20, color: 'rgba(255, 195, 15, 1)' },
            { value: 22, color: 'rgba(255, 170, 10, 1)' },
            { value: 24, color: 'rgba(255, 145, 5, 1)' },
            { value: 26, color: 'rgba(255, 120, 0, 1)' },
            { value: 28, color: 'rgba(255, 95, 10, 1)' },
            { value: 30, color: 'rgba(255, 70, 20, 1)' },
            { value: 32, color: 'rgba(250, 50, 40, 1)' },
            { value: 34, color: 'rgba(245, 30, 60, 1)' },
            { value: 36, color: 'rgba(240, 20, 90, 1)' },
            { value: 38, color: 'rgba(235, 10, 120, 1)' },
            { value: 40, color: 'rgba(225, 0, 150, 1)' },
            { value: 42, color: 'rgba(205, 0, 165, 1)' },
            { value: 44, color: 'rgba(185, 0, 180, 1)' },
            { value: 46, color: 'rgba(160, 0, 190, 1)' },
            { value: 48, color: 'rgba(140, 0, 200, 1)' } // Valor afegit per a temperatures > 46
        ]
    },
};

// MAPA DE RELACIÓ: Velocitat -> Direcció (ID SMC)
const WIND_DIR_RELATION = {
    30: 31,   // Velocitat 10m -> Direcció 10m
    48: 49,   // Velocitat 2m -> Direcció 2m
    46: 47,   // Velocitat 6m -> Direcció 6m
    50: 51,   // Ratxa Màx 10m -> Direcció Ratxa 10m
    53: 54,   // Ratxa Màx 6m -> Direcció Ratxa 6m
    56: 57,   // Ratxa Màx 2m -> Direcció Ratxa 2m
    1503: 1509, // Mitjana 10m
    1504: 1510, // Mitjana 6m
    1505: 1511  // Mitjana 2m
};

// ===================================================================================
// PAS 1 (NOU): LÒGICA DE TRADUCCIÓ DE COLORS DEL RADAR
// ===================================================================================

// DICCIONARI OFICIAL: Colors del PNG del Meteocat (la nostra referència).
const escalaMeteocatOficial = [
    { r: 128, g: 0, b: 255 }, { r: 64, g: 0, b: 255 }, { r: 0, g: 0, b: 255 },
    { r: 0, g: 255, b: 255 }, { r: 0, g: 255, b: 128 }, { r: 0, g: 255, b: 0 },
    { r: 63, g: 255, b: 0 }, { r: 127, g: 255, b: 0 }, { r: 191, g: 255, b: 0 },
    { r: 255, g: 255, b: 0 }, { r: 255, g: 171, b: 0 }, { r: 255, g: 129, b: 0 },
    { r: 255, g: 87, b: 0 }, { r: 255, g: 45, b: 0 }, { r: 255, g: 0, b: 0 },
    { r: 255, g: 0, b: 63 }, { r: 255, g: 0, b: 127 }, { r: 255, g: 0, b: 191 },
    { r: 234, g: 51, b: 247 }, { r: 255, g: 255, b: 255 }
];

// NOVA ESCALA FINAL: Una paleta de 20 colors diferents.
const escalaFinalNova = [
    [173, 216, 230], [135, 206, 250], [100, 149, 237], [65, 105, 225],
    [0, 191, 255], [0, 255, 255], [60, 179, 113], [50, 205, 50],
    [173, 255, 47], [255, 255, 0], [255, 215, 0], [255, 165, 0],
    [255, 140, 0], [255, 69, 0], [255, 0, 0], [220, 20, 60],
    [199, 21, 133], [218, 112, 214], [148, 0, 211], [255, 255, 255]
];

function getNouColorPerPixel(r, g, b, a) {
    // Si el píxel és quasi transparent, el deixem transparent.
    if (a < 50) return [0, 0, 0, 0];

    let closestIndex = -1;
    let minDistance = Infinity;

    // Busquem el color més proper a la paleta oficial de Meteocat.
    for (let i = 0; i < escalaMeteocatOficial.length; i++) {
        const originalColor = escalaMeteocatOficial[i];
        const distance = Math.sqrt(
            Math.pow(r - originalColor.r, 2) +
            Math.pow(g - originalColor.g, 2) +
            Math.pow(b - originalColor.b, 2)
        );
        if (distance < minDistance) {
            minDistance = distance;
            closestIndex = i;
        }
    }

    // Si el color no s'assembla a cap, el fem transparent.
    if (minDistance > 50) {
        return [0, 0, 0, 0];
    }

    // ✅ NOVA CONDICIÓ: Si l'índex és 0 o 1 (els dos primers colors),
    // el tornem transparent (R=0, G=0, B=0, Alpha=0).
    if (closestIndex === 0 || closestIndex === 1) {
        return [0, 0, 0, 0];
    }

    // Retornem el color corresponent de la nostra nova paleta.
    const finalColor = escalaFinalNova[closestIndex];
    return [finalColor[0], finalColor[1], finalColor[2], 255];
}

let interpolationLayer = null;
const interpolationTactualLayer = L.layerGroup();
const interpolationTmaxLayer = L.layerGroup();
const interpolationTminLayer = L.layerGroup();
const interpolationTvarLayer = L.imageOverlay('mapa_variacio_tmax.png', [[40.47700661892509, 0.032832192867383085], [42.86307504240322, 3.332793389080445]], {
    opacity: 0.75,
    interactive: false
});

// pluja_neu.js (REEMPLAÇA AQUESTA FUNCIÓ)

function createRegressionModel(stationPoints) {
    const dataForRegression = stationPoints.features.map(f => [f.properties.altitud, f.properties.value]);
    if (dataForRegression.length < 3) throw new Error("No hi ha prou dades per al model.");

    const result = regression.linear(dataForRegression, { precision: 5 });
    if (!result || !result.equation || result.equation.length < 2) {
        throw new Error("La funció de regressió no ha pogut calcular un model vàlid.");
    }

    const model = { m_lat: 0, m_lon: 0, m_alt: result.equation[0], c: result.equation[1] };
    console.log(`[Principal] ✅ Model simple creat. Equació: T = ${model.m_alt.toFixed(3)}*altitud + ${model.c.toFixed(2)}`);
    return model;
}


// Enganxa el codi nou aquí
// ===================================================================
// CODI NOU: GESTIÓ DE METADADADES I ALTITUD
// ===================================================================

// Variable global per guardar les metadades de les estacions
let metadadesEstacions = null;

/**
 * Funció que carrega el teu fitxer operatives.json al iniciar l'aplicació.
 * L'executarem una sola vegada.
 */
async function carregarMetadadesLocals() {
    try {
        const response = await fetch('operatives.json');
        const data = await response.json();
        // Convertim l'array en un Map per a un accés instantani per codi d'estació
        metadadesEstacions = new Map(data.map(estacio => [estacio.codi, estacio]));
        console.log(`✅ Metadades locals carregades correctament per a ${metadadesEstacions.size} estacions.`);
    } catch (error) {
        console.error("Error carregant el fitxer 'operatives.json':", error);
    }
}

let climatologiaEstacions = null;

async function carregarClimatologiaLocal() {
    try {
        const response = await fetch('climatologia_estacions.json');
        climatologiaEstacions = await response.json();
        console.log(`✅ Climatologia local carregada per a ${Object.keys(climatologiaEstacions).length} estacions.`);
    } catch (error) {
        console.error("Error carregant el fitxer 'climatologia_estacions.json':", error);
    }
}

/**
 * Funció per obtenir l'altitud d'un punt consultant un tile del DEM d'AWS.
 * Retorna l'altitud en metres.
 */
/**
 * Decodifica l'altitud a partir dels valors RGB d'un píxel del tile de terreny.
 * Aquesta funció és síncrona i ràpida.
 */
function decodeElevationFromRgb(r, g, b) {
    // Fòrmula de decodificació per al servei de tiles d'AWS Terrarium
    const altitude = (r * 256 + g + b / 256) - 32768;
    return altitude;
}
// ===================================================================
// FI DEL CODI NOU
// ===================================================================


// ======================================================
// LÒGICA PER A PINTAR AVISOS PER COMARCA (VERSIÓ COMPLETA MILLORADA)
// ======================================================
document.addEventListener('DOMContentLoaded', () => {
    // ----- Elements del DOM -----
    const avisosPanel = document.getElementById('avisos-comarques-panel');
    const toggleAvisosBtn = document.getElementById('toggle-avisos-mode-btn');
    // Comprovació per evitar errors si un element no existeix
    if (!avisosPanel || !toggleAvisosBtn) return;

    // ----- Variables de control i estat -----
    let modoAvisosActiu = false;
    let isPaintingActive = false;
    let colorAvisSeleccionat = '#fff200';
    let avisosComarques = {};
    let comarquesLayer;

    const closeAvisosBtn = document.getElementById('close-avisos-panel');
    const clearAvisosBtn = document.getElementById('clear-avisos-btn');
    const colorButtons = document.querySelectorAll('.avis-btn[data-color]');
    const paintBtn = document.getElementById('toggle-paint-mode-btn');

    // ----- Estils i Funcions de la Capa -----
    const estilPerDefecte = { color: "#333", weight: 1, opacity: 0.6, fillOpacity: 0 };

    function getEstilComarca(feature) {
        const nomComarca = feature.properties.NOMCOMAR;
        if (avisosComarques[nomComarca]) {
            return { ...estilPerDefecte, fillColor: avisosComarques[nomComarca], fillOpacity: 0.6 };
        }
        return estilPerDefecte;
    }

    function onEachFeatureComarca(feature, layer) {
        layer.bindPopup(feature.properties.NOMCOMAR);

        layer.on('click', function (e) {
            if (!modoAvisosActiu || !isPaintingActive) return;
            const nomComarca = e.target.feature.properties.NOMCOMAR;

            if (avisosComarques[nomComarca] === colorAvisSeleccionat) {
                delete avisosComarques[nomComarca];
            } else {
                avisosComarques[nomComarca] = colorAvisSeleccionat;
            }
            comarquesLayer.resetStyle(e.target);
        });
    }

    // ----- Creació de la Capa -----
    comarquesLayer = L.geoJson(comarquesGeojson, {

        pane: 'comarquesPane',
        style: getEstilComarca,
        onEachFeature: onEachFeatureComarca
    });

    function netejarAvisos() {
        avisosComarques = {};
        if (map.hasLayer(comarquesLayer)) {
            comarquesLayer.resetStyle();
        }
    }

    // ----- Gestió d'Esdeveniments de la Interfície -----
    toggleAvisosBtn.addEventListener('click', (e) => {
        e.preventDefault();
        modoAvisosActiu = !modoAvisosActiu;

        if (modoAvisosActiu) {
            toggleAvisosBtn.classList.add('active');
            avisosPanel.style.display = 'block';
            map.addLayer(comarquesLayer);
            // ComarquesLayer ja està al poligonsPane (zIndex 400), no cal bringToFront
        } else {
            isPaintingActive = false;
            paintBtn.classList.remove('active');
            toggleAvisosBtn.classList.remove('active');
            avisosPanel.style.display = 'none';
            netejarAvisos();
            map.removeLayer(comarquesLayer);
        }
    });

    paintBtn.addEventListener('click', () => {
        isPaintingActive = !isPaintingActive;
        paintBtn.classList.toggle('active', isPaintingActive);
    });

    colorButtons.forEach(btn => {
        if (btn.dataset.color === colorAvisSeleccionat) btn.classList.add('active');
        btn.addEventListener('click', function () {
            colorButtons.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            colorAvisSeleccionat = this.dataset.color;
        });
    });

    clearAvisosBtn.addEventListener('click', netejarAvisos);

    closeAvisosBtn.addEventListener('click', () => {
        avisosPanel.style.display = 'none';
    });

    // ----- Inicialització del Panell -----
    if (typeof makeDraggable === 'function') {
        makeDraggable(avisosPanel, document.getElementById('avisos-panel-header'));
    }
    avisosPanel.style.display = 'none';
});


// Plugin per dibuixar la icona del llamp sobre les barres del gràfic
const lightningJumpPlugin = {
    id: 'lightningJumpIcon',
    afterDraw: (chart, args, options) => {
        const { jumps } = options;
        if (!jumps || jumps.length === 0) return;

        const { ctx } = chart;
        ctx.save();
        ctx.font = '20px Arial';
        ctx.fillStyle = 'black';
        ctx.textAlign = 'center';

        jumps.forEach(jump => {
            const meta = chart.getDatasetMeta(0);
            const bar = meta.data[jump.index];
            if (bar) {
                const x = bar.x;
                const y = bar.y - 5; // 5 píxels per sobre de la barra
                ctx.fillText('⚡', x, y);
            }
        });
        ctx.restore();
    }
};

let currentVariableKey = 'smc_32'; // Variable per defecte (Temperatura Actual)

const RASTER_RESOLUTION = 0.02; // Mida de la cel·la de la graella en graus
let isAutoDetectMode = true; // Comencem en mode automàtic per defecte
let celulesAnteriors = []; // Guardarà les cèl·lules de l'últim minut
let alertedStormIds = new Set();
let alertQueue = [];
let isAlertAnimating = false;

function toggleAnalysisMode() {
    if (isAutoDetectMode) {
        // Mode Automàtic
        map.removeControl(drawControl);
        drawnItems.clearLayers();
        const overlay = document.getElementById('lightning-jump-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
        if (realtimeLightningManager.historicStrikes.size > 0) {
            analitzarTempestesSMC();
        }
    } else {
        // Mode Manual
        map.addControl(drawControl);
        cellulesTempestaLayer.clearLayers();
        ljIconsLayer.clearLayers(); // <-- AFEGIM LA NETEJA AQUÍ TAMBÉ
    }
}

// Registrem el plugin perquè Chart.js el pugui utilitzar
Chart.register(lightningJumpPlugin);

// La resta del teu codi (var gifWorkerBlob, etc.) continua aquí...

// Configuració inicial
const max_range_steps = 30;
const increment_mins = 6;
const possibles_mins = Array.from({ length: 10 }, (_, i) => i * 6);
let range_values = [];
const range_element = document.getElementById('range-slider');
let historicModeTimestamp = null; // Si és null, estem en mode directe. Si té una data, estem en mode històric.

// Variables d'animació
let isPlaying = false;
let animationInterval = null;
let animationSpeed = 130;
const pauseOnLastFrame = 1200;

// Variables GIF
let gif = null;
let captureInProgress = false;
const totalGifFrames = 30;
const gifFrameDelay = 100;

// Funció per formatar números
const fillTo = (num, length) => String(num).padStart(length, '0');

// Capa personalitzada sense parpelleig (CORREGIDA)
L.TileLayerNoFlickering = L.TileLayer.extend({
    _refreshTileUrl: function (tile, url) {
        const img = new Image();
        img.onload = () => L.Util.requestAnimFrame(() => tile.el.src = url);
        img.src = url;
    },
    refresh: function () {
        // Comprovem si el mapa existeix abans de fer res
        if (!this._map) { return; }

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

        if (wasAnimated) {
            setTimeout(() => {
                // AQUESTA ÉS LA COMPROVACIÓ CLAU:
                // Només restaurem l'estat si la capa encara està al mapa.
                if (this._map) {
                    this._map._fadeAnimated = wasAnimated;
                }
            }, 5000);
        }
    }
});

L.tileLayerNoFlickering = (url, options) => new L.TileLayerNoFlickering(url, options);

// ===================================================================
// VERSIÓ FINAL CORREGIDA: Classe personalitzada per a la capa base de Meteocat
// Aquesta versió implementa la conversió de coordenades TMS estàndard.
// ===================================================================
L.TileLayer.Meteocat = L.TileLayer.extend({
    getTileUrl: function (coords) {
        const z = coords.z;
        const x = coords.x;

        // Fórmula de conversió estàndard de coordenades de Leaflet a TMS.
        // Leaflet (origen a dalt) -> TMS (origen a baix)
        const y_tms = Math.pow(2, z) - coords.y - 1;

        // Funció auxiliar per emplenar amb zeros
        const fill = (num, len) => String(num).padStart(len, '0');

        // Calculem els components dinàmics de la URL amb les coordenades correctes
        const dirX = fill(Math.floor(x / 1000), 3);
        const fileX = fill(x % 1000, 3);

        const dirY = fill(Math.floor(y_tms / 1000), 3);
        const fileY = fill(y_tms % 1000, 3);

        const zoom = fill(z, 2);

        // Construïm la URL final
        return `https://static-m.meteo.cat/tiles/fons/GoogleMapsCompatible/${zoom}/000/${dirX}/${fileX}/000/${dirY}/${fileY}.png`;
    }
});

// Funció "factory" per conveniència
L.tileLayer.meteocat = function (options) {
    return new L.TileLayer.Meteocat('', options);
};



// ===================================================================
// VERSIÓ FINAL I ROBUSTA: Gestiona TOTS els tipus de capes
// ===================================================================

// Funció per allargar l'històric del radar provant fitxers anteriors que no surten al JSON
async function augmentRadarHistory(items, folder) {
    if (!items || items.length === 0) return items;

    // Ordenem per data per seguretat (vell a nou)
    const sorted = [...items].sort((a, b) => {
        const d1 = a.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
        const d2 = b.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
        return new Date(d1[1], d1[2] - 1, d1[3], d1[4], d1[5]) - new Date(d2[1], d2[2] - 1, d2[3], d2[4], d2[5]);
    });

    const oldest = sorted[0];
    const match = oldest.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
    if (!match) return sorted;

    const oldestDate = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5]));
    const extras = [];
    const maxExtras = 15; // Intentem recuperar fins a 1.5 hores més

    for (let i = 1; i <= maxExtras; i++) {
        const targetDate = new Date(oldestDate.getTime() - i * 6 * 60 * 1000);
        const Y = targetDate.getUTCFullYear();
        const M = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
        const D = String(targetDate.getUTCDate()).padStart(2, '0');
        const h = String(targetDate.getUTCHours()).padStart(2, '0');
        const m = String(targetDate.getUTCMinutes()).padStart(2, '0');

        const tsBase = `${Y}${M}${D}${h}${m}`;
        let found = false;

        for (let ss of ["06", "07", "00"]) {
            // Utilitzem images.weserv.nl com a proxy HTTPS
            const originalUrl = `http://www.meteocatclients.com/webs_clients/radar/images/${folder}/${folder}_${tsBase}${ss}.png`;
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(originalUrl)}&t=square`;

            try {
                const res = await fetch(proxyUrl, { method: 'HEAD' });
                if (res.ok) {
                    extras.unshift({
                        src: `./images/${folder}/${folder}_${tsBase}${ss}.png`,
                        title: `cappi250 ${Y}-${M}-${D} ${h}:${m} UTC`
                    });
                    found = true;
                    break;
                }
            } catch (e) { }
        }
        if (!found) break;
    }

    return [...extras, ...sorted];
}

async function setRangeValuesAsync() {
    // ===================================================================
    // PRIMER, COMPROVEM LES CAPES AMB DADES EXTERNES (JSONs)
    // Aquestes tenen la màxima prioritat perquè defineixen els seus propis intervals.
    // ===================================================================

    // --- RADARS PRO (OPERA, FRCOMP, etc.) ---
    const activeProRadar = Object.keys(proRadarLayers).find(key => map.hasLayer(proRadarLayers[key]));
    if (activeProRadar) {
        const cfg = RADAR_PRO_CONFIG[activeProRadar];
        try {
            const response = await fetch(`https://iradar.app/data/composites/recent/${cfg.pathPrefix}/files.json?v=${new Date().getTime()}`);
            const json = await response.json();
            const decodedData = JSON.parse(atob(json.data));

            return decodedData.reverse().map(ts => {
                const any = ts.substring(0, 4);
                const mes = ts.substring(4, 6);
                const dia = ts.substring(6, 8);
                const hora = ts.substring(8, 10);
                const min = ts.substring(10, 12);
                const date = new Date(Date.UTC(any, mes - 1, dia, hora, min));

                return {
                    timestamp: ts,
                    any: parseInt(any),
                    mes: parseInt(mes),
                    dia: parseInt(dia),
                    hora: parseInt(hora),
                    min: parseInt(min),
                    utctime: date.getTime()
                };
            });
        } catch (error) {
            console.error(`Error carregant fitxers radar PRO (${activeProRadar}):`, error);
            return [];
        }
    }

    if (map.hasLayer(rainviewer_layer)) {
        // ... (el codi de RainViewer es queda exactament igual)
        try {
            const response = await fetch('https://api.rainviewer.com/public/weather-maps.json');
            rainviewerApiData = await response.json();
            const allFrames = [...rainviewerApiData.radar.past, ...rainviewerApiData.radar.nowcast];
            return allFrames.map(frame => {
                const date = new Date(frame.time * 1000);
                return { path: frame.path, timestamp: frame.time, any: date.getUTCFullYear(), mes: date.getUTCMonth() + 1, dia: date.getUTCDate(), hora: date.getUTCHours(), min: date.getUTCMinutes(), utctime: date.getTime() };
            });
        } catch (error) { console.error("Error RainViewer:", error); return []; }
    }

    if (map.hasLayer(cappi_intern_layer)) {
        try {
            const targetUrl = 'http://www.meteocatclients.com/webs_clients/radar/cappi250_catalunya_10dBZ.json?' + new Date().getTime();
            const response = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`);
            const data = await response.json();

            const augmentedItems = await augmentRadarHistory(data.items, 'cappi250_catalunya_10dBZ');

            return augmentedItems.map(item => {
                const match = item.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
                if (!match) return null;
                const date = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5]));
                return { url: 'http://www.meteocatclients.com/webs_clients/radar' + item.src.substring(1), any: date.getUTCFullYear(), mes: date.getUTCMonth() + 1, dia: date.getUTCDate(), hora: date.getUTCHours(), min: date.getUTCMinutes(), utctime: date.getTime() };
            }).filter(Boolean);
        } catch (error) { console.error("Error CAPPI Intern:", error); return []; }
    }

    if (map.hasLayer(cappi_llarg_abast_layer)) {
        try {
            const targetUrl = 'http://www.meteocatclients.com/webs_clients/radar/cappi250_llarg_abast_10dBZ.json?' + new Date().getTime();
            const response = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`);
            const data = await response.json();

            const augmentedItems = await augmentRadarHistory(data.items, 'cappi250_llarg_abast_10dBZ');

            return augmentedItems.map(item => {
                const match = item.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
                if (!match) return null;
                const date = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5]));
                return { url: 'http://www.meteocatclients.com/webs_clients/radar' + item.src.substring(1), any: date.getUTCFullYear(), mes: date.getUTCMonth() + 1, dia: date.getUTCDate(), hora: date.getUTCHours(), min: date.getUTCMinutes(), utctime: date.getTime() };
            }).filter(Boolean);
        } catch (error) { console.error("Error CAPPI Llarg Abast:", error); return []; }
    }

    // ===================================================================
    // INTEGRACIÓ INTERVALS ACA (NOU)
    // ===================================================================
    // Busquem si hi ha alguna capa ACA activa
    const activeAcaKey = Object.keys(aca_layers).find(key => map.hasLayer(aca_layers[key]));

    if (activeAcaKey && acaRadarAvailability) {
        console.log(`Capa ACA detectada: ${activeAcaKey}. Utilitzant intervals del proveïdor.`);

        const layer = aca_layers[activeAcaKey];
        const type = layer.acaType;
        const availableTimestamps = acaRadarAvailability[type];

        if (availableTimestamps) {
            const timestamps = Object.keys(availableTimestamps).sort();

            // Si hi ha molts timestamps (històric llarg), agafem només els últims X (ex: 24h o 48h)
            // Això depèn de si volem tot l'històric o només recent. 
            // Per defecte agafem els últims 50 per no saturar el slider si n'hi ha milers.
            const validTimestamps = timestamps.slice(-50);

            return validTimestamps.map(isoString => {
                const date = new Date(isoString);
                return {
                    timestamp: date.getTime() / 1000,
                    any: date.getUTCFullYear(),
                    mes: date.getUTCMonth() + 1,
                    dia: date.getUTCDate(),
                    hora: date.getUTCHours(),
                    min: date.getUTCMinutes(),
                    utctime: date.getTime()
                };
            });
        }
    }

    // ===================================================================
    // SI CAP DE LES ANTERIORS ESTÀ ACTIVA, CALCULEM ELS INTERVALS LOCALMENT
    // Aquesta part és la que hem reordenat i corregit.
    // ===================================================================

    rainviewerApiData = null; // Resetejem les dades de RainViewer per si de cas
    console.log("Calculant intervals de temps localment...");

    const new_range_values = [];
    const now = new Date();
    let curr_date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()));
    let max_steps_animacio, interval_mins_animacio;

    // AQUESTA ÉS LA LÒGICA CORREGIDA:
    // 1. Detectem qui hi ha actiu
    const isRadarActive = map.hasLayer(plujaneu_layer) || map.hasLayer(radar_layer);
    const isAnySatelliteActive = [...Object.values(satelliteMenuLayers)].some(layer => map.hasLayer(layer));
    const isWindyOrMFActive = map.hasLayer(windy_radar_layer) || map.hasLayer(meteofrance_radar_layer);

    if (isRadarActive) {
        // RADAR PRIORITARI: 6 minuts (Sempre que hi hagi radar Meteocat, fem 6 min)
        console.log("Radar Meteocat actiu. Utilitzant intervals de 6 minuts (Prioritat Alta).");
        max_steps_animacio = 30;
        interval_mins_animacio = 6;
        const possibles_mins_6min = Array.from({ length: 10 }, (_, i) => i * 6);
        const curr_min = curr_date.getUTCMinutes();
        const min = Math.max(...possibles_mins_6min.filter(m => m <= curr_min));
        curr_date.setUTCMinutes(min, 0, 0);
        curr_date.setTime(curr_date.getTime() - (6 * 60 * 1000));
    } else if (isAnySatelliteActive) {
        // Només satèl·lit: 10 minuts
        console.log("Només satèl·lit detectat. Utilitzant intervals de 10 minuts.");
        const SAT_LATENCY_MINS = 15;
        curr_date.setTime(curr_date.getTime() - SAT_LATENCY_MINS * 60 * 1000);
        max_steps_animacio = 36;
        interval_mins_animacio = 10;
        const closestMinute = Math.floor(curr_date.getUTCMinutes() / 10) * 10;
        curr_date.setUTCMinutes(closestMinute, 0, 0);
    } else if (isWindyOrMFActive) {
        // ★ AFEGIT: || map.hasLayer(meteofrance_radar_layer)

        console.log("Capa de Windy o MeteoFrance detectada. Utilitzant intervals de 5 minuts.");
        max_steps_animacio = 144; // Més frames per tenir més història
        interval_mins_animacio = 5; // Intervals de 5 minuts

        // Arrodonim al múltiple de 5 més proper
        const roundedMinutes = Math.floor(curr_date.getUTCMinutes() / 5) * 5;
        curr_date.setUTCMinutes(roundedMinutes, 0, 0);

    } else if (map.hasLayer(windy_radar_layer)) {
        console.log("Capa de Windy detectada. Utilitzant intervals de 5 minuts.");
        max_steps_animacio = 144;
        interval_mins_animacio = 5;
        const roundedMinutes = Math.floor(curr_date.getUTCMinutes() / 5) * 5;
        curr_date.setUTCMinutes(roundedMinutes, 0, 0);

        // Comprimim el codi ja que hem pujat la detecció de radar dalt
    }

    // El bucle final per generar els valors es queda igual (Past -> Present)
    for (let i = 0; i < max_steps_animacio; i++) {
        new_range_values.push({
            any: curr_date.getUTCFullYear(),
            mes: curr_date.getUTCMonth() + 1,
            dia: curr_date.getUTCDate(),
            hora: curr_date.getUTCHours(),
            min: curr_date.getUTCMinutes(),
            utctime: curr_date.getTime()
        });
        curr_date.setTime(curr_date.getTime() - (interval_mins_animacio * 60 * 1000));
    }

    new_range_values.reverse();

    // ===================================================================
    // LÒGICA ADVECCIÓ (FUTUR)
    // ===================================================================
    // Si tenim activada l'advecció i estem en mode "Radar Meteocat" (no satèl·lit, ni windy)
    const isRadarMeteocat = !isAnySatelliteActive && !map.hasLayer(windy_radar_layer) && !map.hasLayer(meteofrance_radar_layer);

    if (isAdvectionEnabled && isRadarMeteocat && new_range_values.length > 0) {

        // BALANCE SLIDER: Keep only last 10 steps of history (1 hour) 
        // to match the 10 steps of prediction (1 hour).
        // This puts the slider knob in the MIDDLE.
        const maxHistory = 10;
        if (new_range_values.length > maxHistory) {
            new_range_values.splice(0, new_range_values.length - maxHistory);
        }

        console.log("Generant passos d'advecció (futur)...");

        // L'últim element de l'array actual és l'Observació més recent (Run Time)
        const lastObs = new_range_values[new_range_values.length - 1];

        // CORRECCIÓ: Advection Horizon vs Latency.
        // Advection usually has a 60 min horizon.
        // If we go back too far (e.g. 30 mins), we lose the tail of the forecast (404s).
        // If we stay too close (0 mins), we hit latency 404s.
        // "Sweet Spot": LastObs (T-6) - 1 frame = T-12 mins.
        // This gives us ~48-54 mins of valid forecast.
        const baseTimeMillis = lastObs.utctime - (6 * 60 * 1000);
        const runTimeDate = new Date(baseTimeMillis);

        // Generem 10 passos de futur (1 hora, cada 6 minuts)
        const advectionSteps = 10;
        const advInterval = 6; // minuts

        let futureDate = new Date(lastObs.utctime);

        for (let j = 1; j <= advectionSteps; j++) {
            futureDate.setTime(futureDate.getTime() + (advInterval * 60 * 1000));

            new_range_values.push({
                any: futureDate.getUTCFullYear(),
                mes: futureDate.getUTCMonth() + 1,
                dia: futureDate.getUTCDate(),
                hora: futureDate.getUTCHours(),
                min: futureDate.getUTCMinutes(),
                utctime: futureDate.getTime(),

                // Metadata per a AdveccióURL
                isAdvection: true,
                runTime: new Date(runTimeDate) // Guardem l'objecte data original de l'observació
            });
        }
    }

    return new_range_values;
}

// Funció per actualitzar el text amb la data actual
function setDateText(r) {
    // --- AFEGEIX AQUESTA COMPROVACIÓ ---
    // Si per alguna raó no rebem un objecte de temps vàlid,
    // sortim de la funció per evitar l'error.
    if (!r) {
        return;
    }
    // --- FI DE LA CORRECCIÓ ---

    const t = new Date(r.utctime);
    let text = `${fillTo(t.getUTCDate(), 2)}/${fillTo(t.getUTCMonth() + 1, 2)}/${t.getUTCFullYear()} ` +
        `${fillTo(t.getUTCHours(), 2)}:${fillTo(t.getUTCMinutes(), 2)} UTC`;

    if (r.isAdvection) {
        text += ' (PREVISIÓ)';
        document.getElementById("plujaoneu-text").style.color = '#ff5252';
    } else {
        document.getElementById("plujaoneu-text").style.color = '';
    }

    document.getElementById("plujaoneu-text").textContent = text;
}

// Funció extra per actualitzar el progrés (si la necessites)
function updateProgress(percent) {
    document.getElementById('progress').textContent = `${Math.round(percent)}%`;
}

// Configuració de la capa pluja/neu
const plujaneu_layer = L.tileLayerNoFlickering('https://static-m.meteo.cat/tiles/plujaneu/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
    attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
    opacity: 0.85,
    maxNativeZoom: 7,
    pane: 'radarPane'
});

plujaneu_layer.on('add', function () {
    plujaneu_layer.getContainer().classList.add('pixelated-tile');
});

plujaneu_layer.getTileUrl = function (coords) {
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

// AFEGEIX AQUEST BLOC NOU
// Events per reconfigurar l'animació quan la capa de pluja/neu canvia
plujaneu_layer.on('add remove', reconfigureTimeSliderAsync);

// ===================================================================
// A REEMPLAÇAR EN EL FUTUR
// ===================================================================

const boundsCatalunya = [
    [40.5, 0.1], // Sud-oest
    [42.9, 3.4]  // Nord-est
];

const map = L.map('map', {
    layers: [],
    maxZoom: 18, // <-- AFEGEIX AQUESTA LÍNIA
    scrollWheelZoom: false, // disable original zoom function
    smoothWheelZoom: true,  // enable smooth zoom 
    smoothSensitivity: 1,   // zoom speed. default is 1
}).setView([41.8, 1.6], 8.5);

// Listener de moviment de mapa per a precàrrega dinàmica (ARA SÍ, DESPRÉS D'INICIALITZAR EL MAPA)
map.on('moveend zoomend', () => {
    const autoOptimize = document.getElementById('auto-optimize-sat')?.checked;
    if (_activeStaticHours > 0 && autoOptimize) {
        console.log("Moviment de mapa detectat. Re-optimitzant rang de", _activeStaticHours, "h");
        startStaticPrefetch(_activeStaticHours, true);
    }

    // Actualitzem els bounds per a la capa d'Open-Meteo (si existeix la llibreria)
    const Lib = window.openmeteo || window.OMWeatherMapLayer;
    if (Lib && typeof Lib.updateCurrentBounds === 'function') {
        const b = map.getBounds();
        Lib.updateCurrentBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    }
});

// Add attribution for main data source
map.attributionControl.addAttribution('Dades: <a href="https://meteo.cat" target="_blank">Meteocat</a>');

const dataMarkersLayer = L.markerClusterGroup({
    maxClusterRadius: 15,

    // ★ FUNCIÓ MESTRA PER PINTAR ELS CLÚSTERS (CORREGIDA) ★
    iconCreateFunction: function (cluster) {
        const children = cluster.getAllChildMarkers();
        let totalValue = 0;
        let count = 0;
        let maxValue = -Infinity;
        let minValue = Infinity;

        children.forEach(child => {
            const htmlContent = child.options.icon.options.html;
            // Regex millorada: Tolera espais al voltant del número
            const valueMatch = htmlContent.match(/>\s*([#]?)([+-]?\d+\.?\d*)\s*</);

            if (valueMatch && valueMatch[2]) {
                const value = parseFloat(valueMatch[2]);
                if (!isNaN(value)) { // Assegurem que és un número real
                    totalValue += value;
                    count++;
                    if (value > maxValue) maxValue = value;
                    if (value < minValue) minValue = value;
                }
            }
        });

        // ===== 1. DECIDIM QUIN VALOR MOSTRAR =====
        // Si no hem trobat cap número vàlid (tots eren errors o textos), posem 0 o null
        if (count === 0) {
            maxValue = 0;
            minValue = 0;
            totalValue = 0;
        }

        let displayValue = (count > 0) ? (totalValue / count) : 0;
        let valueForColor = displayValue;

        // LLISTA A: Variables on volem veure el MÀXIM
        const useMaxValueForCluster = [
            'smc_40', 'smc_72_daily_max', 'wind_gust_daily_kmh', 'wind_gust_daily_ms',
            'wind_gust_semihourly_kmh', 'wind_gust_semihourly_ms',
            'calc_fire_risk_semihourly', 'sumatori_precipitacio',
            'clima_precip_mensual',
            'alert_intensity', 'alert_accumulation',
            'smc_35', 'weathercom_precip', 'ecowitt_precip'
        ];

        // LLISTA B: Variables on volem veure el MÍNIM (Rànquing)
        const useMinValueForCluster = [
            'ranking_fred_any'
        ];

        if (useMaxValueForCluster.includes(currentVariableKey)) {
            displayValue = maxValue;
            valueForColor = maxValue;
        } else if (useMinValueForCluster.includes(currentVariableKey)) {
            // PROTECCIÓ ANTI-INFINITY: Si no hi ha dades, mostrem 0 o res
            if (minValue === Infinity || count === 0) {
                displayValue = 0;
                valueForColor = 50; // Color neutre (Gris) per no espantar
            } else {
                displayValue = minValue;
                valueForColor = minValue;
            }
        }

        // ===================================================================

        const config = VARIABLES_CONFIG[currentVariableKey];
        const decimals = (config && config.decimals !== undefined) ? config.decimals : 1;

        // Si el valor és 0 i estem en mode rànquing, potser volem mostrar "-" o "?"
        let formattedValue = formatValueForLabel(displayValue, decimals);
        if (currentVariableKey === 'ranking_fred_any' && displayValue === 0) {
            formattedValue = "?";
        }

        let dynamicColor;
        let textColor = '#000';

        if (config && config.colorScale) {
            dynamicColor = getDynamicColor(valueForColor, config.colorScale);

            if (currentVariableKey === 'ranking_fred_any') {
                // Si és ? (sense dades), posem gris
                if (formattedValue === "?") {
                    dynamicColor = "#CCCCCC";
                } else {
                    if (valueForColor <= 10 || valueForColor >= 300) textColor = '#FFFFFF';
                    formattedValue = '#' + formattedValue;
                }
            }

            if ((currentVariableKey === 'anomalia_tmin_hivern' || currentVariableKey === 'percentil_tmin_hivern') && valueForColor < 0) {
                textColor = '#FFFFFF';
            }

        } else {
            // (Aquest bloc switch es manté igual que abans)
            switch (currentVariableKey) {
                case 'calc_night_humidex_min':
                    if (valueForColor < 20) dynamicColor = '#37d05bff';
                    else if (valueForColor <= 25) dynamicColor = '#ffb907ff';
                    else dynamicColor = '#e82e40ff';
                    break;
                case 'var_pressure_3h':
                case 'var_pressure_24h':
                    dynamicColor = getPressureTrendColor(valueForColor);
                    if (valueForColor > 1.5 || valueForColor < -1.5) textColor = '#FFFFFF';
                    break;
                case 'sumatori_precipitacio':
                case 'clima_precip_mensual':
                    dynamicColor = getPrecipitationSumColor(valueForColor);
                    if (valueForColor > 80) textColor = '#FFFFFF';
                    break;
                case 'var_tmax_24h':
                case 'var_tmin_24h':
                case 'var_tactual_24h':
                case 'var_tactual_1h':
                case 'var_tactual_3h':
                case 'var_tactual_6h':
                case 'var_tactual_12h':
                    dynamicColor = getVariationColor(valueForColor);
                    if (valueForColor > 8 || valueForColor < -8) textColor = '#FFFFFF';
                    break;
                case 'var_neu_1h':
                case 'var_neu_3h':
                case 'var_neu_6h':
                case 'var_neu_24h':
                    dynamicColor = getSnowVariationColor(valueForColor);
                    if (valueForColor > 10 || valueForColor < -10) textColor = '#FFFFFF';
                    break;
                case 'calc_swe':
                    dynamicColor = getSweColor(valueForColor);
                    if (valueForColor > 100) textColor = '#FFFFFF';
                    break;
                case 'wind_speed_ms':
                case 'wind_gust_semihourly_ms':
                case 'wind_gust_daily_ms':
                    // L'escala getWindColor espera km/h.
                    // Si tenim m/s, multipliquem per 3.6 abans de demanar el color.
                    dynamicColor = getWindColor(valueForColor * 3.6);
                    break;

                // Cas 2: Variables en QUILÒMETRES PER HORA
                case 'wind_speed_kmh':
                case 'wind_gust_semihourly_kmh':
                case 'wind_gust_daily_kmh':
                    // El valor ja és bo, el passem directament.
                    dynamicColor = getWindColor(valueForColor);
                    break;
                case 'smc_33': case 'smc_3': case 'smc_44':
                    dynamicColor = getHumidityColor(valueForColor);
                    textColor = getTextColorForHumidity(valueForColor);
                    break;
                case 'smc_34': case 'smc_1': case 'smc_2':
                    dynamicColor = getPressureColor(valueForColor);
                    break;
                case 'smc_38':
                    dynamicColor = getSnowDepthColor(valueForColor);
                    break;
                case 'precip_semihoraria':
                case 'weathercom_precip_semihourly':
                    dynamicColor = getSemihorariaPrecipColor(valueForColor);
                    break;
                case 'weathercom_precip':
                case 'ecowitt_precip':
                case 'smc_35':
                case 'diaria_oficials': // ★ ARA INCLOU LA NOVA VARIABLE
                    dynamicColor = getDailyPrecipitationColor(valueForColor);
                    // ★ AFEGEIX AIXÒ:
                    if (valueForColor > 80) textColor = '#FFFFFF';
                    break;
                case 'smc_72': case 'smc_72_daily_max':
                    dynamicColor = getIntensityColor(valueForColor);
                    break;
                default:
                    dynamicColor = getTempRgbaColor(valueForColor);
                    if (currentVariableKey === 'percentil_tmin_hivern' && valueForColor < 0) {
                        textColor = '#FFFFFF';
                    }
                    break;
            }
        }

        let finalFormattedValue;
        if (config && config.showPositiveSign) {
            const sign = displayValue > 0 ? '+' : (displayValue < 0 ? '' : '');
            finalFormattedValue = sign + formattedValue;
        } else {
            finalFormattedValue = formattedValue;
        }

        const html = `<div style="background-color: ${dynamicColor}; color: ${textColor};">${finalFormattedValue}</div>`;

        return L.divIcon({
            html: html,
            className: 'marker-cluster-custom',
            iconSize: [30, 15]
        });
    }
}).addTo(map);

// Ajusta el mapa als límits de Catalunya.
map.fitBounds(boundsCatalunya);

map.createPane('dibuixPane');
map.getPane('dibuixPane').style.zIndex = 650; // Un valor alt el posa per sobre dels marcadors (600)

map.createPane('interpolationPane');
map.getPane('interpolationPane').style.zIndex = 410; // Un z-index baix per estar al fons

map.createPane('llampsPane');
map.getPane('llampsPane').style.zIndex = 320;

map.createPane('poligonsPane');
map.getPane('poligonsPane').style.zIndex = 330;

map.createPane('comarquesPane');
map.getPane('comarquesPane').style.zIndex = 340;

// Satellite pane: sits just above basemap (200)
map.createPane('satellitePane');
map.getPane('satellitePane').style.zIndex = 205;

map.createPane('radarPane');
map.getPane('radarPane').style.zIndex = 310;

map.createPane('iconesPane');
map.getPane('iconesPane').style.zIndex = 360; // Etiquetes dades

map.createPane('convergenciaPane');
map.getPane('convergenciaPane').style.zIndex = 390; // Per sobre de tot el que hi ha a sota (300-360)

map.createPane('limitPane');
map.getPane('limitPane').style.zIndex = 350; // Límits administratius


// ===================================================================
// SOLUCIÓ: Mou i enganxa les dues línies aquí
// ===================================================================
var drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);
// ===================================================================

var drawControl = new L.Control.Draw({
    position: 'topleft', // <-- AFEGEIX AQUESTA LÍNIA
    draw: {
        polygon: true, // Permet només dibuixar polígons
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false
    },
    edit: {
        featureGroup: drawnItems,
        edit: false, // Desactivem l'edició per simplicitat
        remove: true
    }
});


// Quan els polígons s'ESBORREN
map.on(L.Draw.Event.CREATED, function (event) {
    if (!isAutoDetectMode) { // Només s'executa si el mode automàtic està desactivat
        var layer = event.layer;
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        analisisPolygon = layer.toGeoJSON();
        analitzarLightningJump(); // Crida a l'anàlisi manual
    }
});

// Auto-hide the map loader banner when real markers (not the dummy loader) are added
dataMarkersLayer.on('layeradd', function (e) {
    const icon = e.layer.options && e.layer.options.icon;
    // The dummy loader icon has iconSize [0,0] — skip it
    if (icon && icon.options && icon.options.iconSize && icon.options.iconSize[0] === 0) return;
    hideMapLoader();
});

// ===================================================================

map.on(L.Draw.Event.DELETED, function () {
    if (!isAutoDetectMode) { // Només s'executa en mode manual
        analisisPolygon = null;
        drawnItems.clearLayers();

        // Tanquem i destruïm el gràfic si estava obert
        const overlay = document.getElementById('lightning-jump-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
    }
});

// create a fullscreen button and add it to the map
L.control.fullscreen({
    position: 'topleft',
    title: 'Pantalla completa',
    titleCancel: 'Sortir de la pantalla completa',
    content: null,
    forceSeparateButton: false,
    forcePseudoFullscreen: false,
    fullscreenElement: false
}).addTo(map);


// events are fired when entering or exiting fullscreen.
map.on('enterFullscreen', function () {
    console.log('entered fullscreen');
});

map.on('exitFullscreen', function () {
    console.log('exited fullscreen');
});


async function reconfigureTimeSliderAsync(keepCache = false) {
    // --- AFEGIT: VISIBILITAT CONDICIONAL DEL SLIDER ---
    const isAnyLayerActive = timeDependentLayers.some(layer => map.hasLayer(layer));
    const animationContainer = document.getElementById('animation-controls-container');
    const overlay = document.getElementById('plujaoneu-overlay');

    if (animationContainer) {
        animationContainer.style.display = isAnyLayerActive ? 'flex' : 'none';
    }

    // --- AFEGIT: VISIBILITAT CONDICIONAL DEL BURST SELECTOR ---
    const isAnySatelliteActive = Object.values(satelliteMenuLayers).some(layer => map.hasLayer(layer));
    const isAnyProRadarActive = Object.values(proRadarLayers).some(layer => map.hasLayer(layer));
    const burstControls = document.getElementById('slider-burst-controls');
    if (burstControls) {
        // Mostrem el selector d'hores si hi ha satèl·lit O si hi ha algun radar PRO actiu
        burstControls.style.display = (isAnyLayerActive && (isAnySatelliteActive || isAnyProRadarActive)) ? 'flex' : 'none';
    }

    if (overlay) {
        // CORRECCIÓ: Assegurar que es torna a mostrar si hi ha capes actives, o s'amaga si no.
        overlay.style.display = isAnyLayerActive ? 'block' : 'none';
    }

    // Si no hi ha cap capa per animar, sortim
    if (!isAnyLayerActive) return;
    // ----------------------------------------------------

    clearAnimationCache();
    // Només esborrem la cache si NO és una actualització automàtica (keepCache = false)
    if (!keepCache) {
        cappiCache.clear();
        Object.values(proRadarCache).forEach(cache => cache.clear());
    }
    document.getElementById("plujaoneu-text").textContent = "Carregant intervals...";

    // Crida a la nostra nova funció unificada
    range_values = await setRangeValuesAsync();

    // Default: Set slider to the end.
    let startIndex = range_values.length - 1;

    // ADVECTION LOGIC: If advection is active, set slider to the "Now" point (start of advection)
    // Find the last item that is NOT advection (or the first advection item - 1)
    if (typeof isAdvectionEnabled !== 'undefined' && isAdvectionEnabled) {
        const lastObsIndex = range_values.findLastIndex(item => !item.isAdvection);
        if (lastObsIndex !== -1) {
            startIndex = lastObsIndex;
        }
    }

    range_element.max = range_values.length - 1;
    range_element.value = startIndex;

    const event = new Event('input');
    range_element.dispatchEvent(event);
}


// ===================================================================================
// VERSIÓ CANVAS FINAL: TOLERANT A URLS BUIDES I SENSE PARPELLEIG
// ===================================================================================

// Assegurem que la cache existeix
if (typeof processedTileCache === 'undefined') {
    window.processedTileCache = new Map();
}

L.TileLayer.MeteocatCanvas = L.TileLayer.extend({
    createTile: function (coords, done) {
        var tile = document.createElement('canvas');
        tile.width = 256;
        tile.height = 256;
        tile.style.imageRendering = 'pixelated'; // Perquè es vegi nítid

        // Intentem pintar. Si falla (URL buida), simplement quedarà transparent.
        this._processAndDraw(tile, coords, done);

        return tile;
    },

    // Aquesta funció es crida quan mous l'slider
    refresh: function () {
        // console.log("[DEBUG] Refrescant capa (Moure slider)..."); 
        if (!this._map) return;

        Object.values(this._tiles).forEach(tile => {
            if (tile.current && tile.active) {
                // Passem 'null' com a 'done' perquè la tile ja existeix
                this._processAndDraw(tile.el, tile.coords, null);
            }
        });
    },

    _processAndDraw: function (canvasElement, coords, done) {
        const originalUrl = this.getTileUrl(coords);

        // 1. GESTIÓ DE "PRIMER FRAME DOLENT"
        // Si la URL està buida (típic al carregar), no donem error.
        // Simplement netegem el canvas (transparent) i sortim.
        // Quan l'slider es mogui, 'refresh()' tornarà a cridar això amb la URL bona.
        if (!originalUrl) {
            const ctx = canvasElement.getContext('2d');
            ctx.clearRect(0, 0, 256, 256);
            if (done) {
                // Avisem a Leaflet que ja hem "acabat" (encara que sigui buit)
                this._tileOnLoad(done, canvasElement);
            }
            return;
        }

        // 2. SI JA LA TENIM A LA MEMÒRIA (CACHE) - Instantani
        if (processedTileCache.has(originalUrl)) {
            const ctx = canvasElement.getContext('2d');
            ctx.putImageData(processedTileCache.get(originalUrl), 0, 0);
            if (done) this._tileOnLoad(done, canvasElement);
            return;
        }

        // 3. SI NO, LA CARREGUEM
        var sourceImage = new Image();
        sourceImage.crossOrigin = 'Anonymous';

        sourceImage.onload = () => {
            try {
                // Creem canvas temporal per processar
                var tempCanvas = document.createElement('canvas');
                tempCanvas.width = 256; tempCanvas.height = 256;
                var ctxTemp = tempCanvas.getContext('2d', { willReadFrequently: true });

                ctxTemp.drawImage(sourceImage, 0, 0);
                var imageData = ctxTemp.getImageData(0, 0, 256, 256);
                var data = imageData.data;

                // Apliquem la teva funció de colors
                for (var i = 0; i < data.length; i += 4) {
                    var nouColor = getNouColorPerPixel(data[i], data[i + 1], data[i + 2], data[i + 3]);
                    data[i] = nouColor[0];
                    data[i + 1] = nouColor[1];
                    data[i + 2] = nouColor[2];
                    data[i + 3] = nouColor[3];
                }

                // Guardem a cache
                processedTileCache.set(originalUrl, imageData);

                // CROSS-FADE ANIMATION (The "Viable Option")
                // Check if the canvas already has content (is not transparent/empty)
                // We assume if it's being refreshed, it might have content.
                // To be safe, we only animate if it's a refresh (done is null usually in refresh) 
                // OR checks if context has data? Expensive.
                // Simple heuristic: If the tile is in the DOM and visible.

                const ctx = canvasElement.getContext('2d');

                // Only animate if we are "refreshing" existing tiles (smooth transition desired)
                // 'done' is null during refresh() calls in our implementation below.
                // USER REQUEST: Remove "Fake Flow". We force this to false to skip animation.
                const isRefresh = false; // (done === null);

                if (isRefresh) {
                    // 1. Create a ghost of the OLD frame
                    const oldCanvas = canvasElement.cloneNode(true);
                    // Cloning node doesn't copy canvas content, so draw it manually
                    oldCanvas.getContext('2d').drawImage(canvasElement, 0, 0);

                    // Position it exactly on top of the current tile
                    // Leaflet positions tiles absolutely. We can just append it to the parent.
                    // But we need to ensure z-index or order.
                    // Let's put oldCanvas BEHIND the new one (insertBefore).
                    if (canvasElement.parentNode) {
                        canvasElement.parentNode.insertBefore(oldCanvas, canvasElement);

                        // 2. Prepare NEW frame (hidden initially)
                        canvasElement.style.opacity = '0';
                        canvasElement.style.transition = 'opacity 0.3s ease-out';

                        // Draw new data
                        ctx.putImageData(imageData, 0, 0);

                        // 3. Trigger Animation (Next Tick)
                        requestAnimationFrame(() => {
                            canvasElement.style.opacity = '1';
                            oldCanvas.style.transition = 'opacity 0.3s ease-out';
                            oldCanvas.style.opacity = '0';
                        });

                        // 4. Cleanup
                        setTimeout(() => {
                            if (oldCanvas.parentNode) oldCanvas.parentNode.removeChild(oldCanvas);
                            canvasElement.style.transition = ''; // Clean up style
                        }, 350); // > 0.3s
                    } else {
                        // Fallback if not in DOM
                        ctx.putImageData(imageData, 0, 0);
                    }
                } else {
                    // Standard load (instant)
                    ctx.putImageData(imageData, 0, 0);
                }

                if (done) this._tileOnLoad(done, canvasElement);

            } catch (e) {
                // Si falla processar (CORS?), pintem l'original com a "Plan B"
                const ctx = canvasElement.getContext('2d');
                ctx.drawImage(sourceImage, 0, 0);
                if (done) this._tileOnLoad(done, canvasElement);
            }
        };

        sourceImage.onerror = () => {
            // Si la imatge no carrega, deixem el canvas transparent i no bloquegem
            if (done) this._tileOnLoad(done, canvasElement);
        };

        sourceImage.src = originalUrl;
    },

    // Funció auxiliar per simular l'event 'load' que Leaflet espera
    _tileOnLoad: function (done, tile) {
        tile.classList.add('leaflet-tile-loaded');
        tile.classList.remove('leaflet-tile-loading');
        if (done) done(null, tile);
    }
});

function prepararCapesAnimacio() {
    // 1. Netejar capes anteriors si n'hi ha
    radarLayersCache.forEach(layer => {
        if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    radarLayersCache = [];

    // 2. Crear una capa per a cada imatge de l'array radar_images
    radar_images.forEach(url => {
        // Creem la capa però amb opacitat 0 (invisible)
        var layer = L.imageOverlay(url, bounds, {
            opacity: 0,
            interactive: false,
            pane: 'radarPane'
        }).addTo(map);

        radarLayersCache.push(layer);
    });

    console.log("Capes d'animació preparades: ", radarLayersCache.length);
}

// ===================================================================================
// PAS 3 (MODIFICAT): CREACIÓ DE LA CAPA DE RADAR AMB LA NOVA CLASSE I ADVECCIÓ
// ===================================================================================
let isAdvectionEnabled = false; // Global toggle

const radar_layer = new L.TileLayer.MeteocatCanvas('https://static-m.meteo.cat/tiles/radar/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
    attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
    opacity: 0.85,
    maxNativeZoom: 7,
    pane: 'radarPane'
});

// Nova URL base per Advecció
const advectionBaseUrl = 'https://static-m.meteo.cat/tiles/adveccio/{obsAny}/{obsMes}/{obsDia}/{tgtAny}/{tgtMes}/{tgtDia}/{obsHora}/{obsMin}/{tgtHora}/{tgtMin}/{z}/000/000/{x}/000/000/{y}.png';

radar_layer.getTileUrl = function (coords) {
    if (!range_values.length || range_element.value >= range_values.length) return '';
    const r = range_values[range_element.value];
    if (!r) return '';

    // LOGICA URL ADVECCIÓ
    if (r.isAdvection) {
        // Advection Pattern: .../adveccio/OBS_DATE/TARGET_DATE/OBS_TIME/TARGET_TIME/...
        // r.runTime is the Observation Time (Base)
        // r (itself) is the Target Time

        const obs = r.runTime; // Date object
        const tgt = new Date(r.utctime); // Target Date object

        return L.Util.template(advectionBaseUrl, {
            obsAny: obs.getUTCFullYear(),
            obsMes: fillTo(obs.getUTCMonth() + 1, 2),
            obsDia: fillTo(obs.getUTCDate(), 2),
            obsHora: fillTo(obs.getUTCHours(), 2),
            obsMin: fillTo(obs.getUTCMinutes(), 2),

            tgtAny: tgt.getUTCFullYear(),
            tgtMes: fillTo(tgt.getUTCMonth() + 1, 2),
            tgtDia: fillTo(tgt.getUTCDate(), 2),
            tgtHora: fillTo(tgt.getUTCHours(), 2),
            tgtMin: fillTo(tgt.getUTCMinutes(), 2),

            z: fillTo(coords.z, 2),
            x: fillTo(coords.x, 3),
            y: fillTo(Math.abs(coords.y - 127), 3)
        });
    } else {
        // Standard Observation Pattern
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
    }
};

// --- SOLUCIÓ AL PROBLEMA DE CÀRREGA INICIAL ---
radar_layer.refresh = function () {
    if (!this._map) return;
    Object.values(this._tiles).forEach(tile => {
        if (tile.el) {
            this._processAndDraw(tile.el, tile.coords, null);
        }
    });
};

radar_layer.on('add remove', reconfigureTimeSliderAsync);
radar_layer.on('add', function () {
    radar_layer.getContainer().classList.add('pixelated-tile');

    // Show Advection Toggle
    const advBtn = document.getElementById('advection-toggle-btn');
    if (advBtn) advBtn.style.display = 'block';

    setTimeout(() => {
        if (map.hasLayer(radar_layer)) radar_layer.refresh();
    }, 200);
});

radar_layer.on('remove', function () {
    // Hide Advection Toggle
    const advBtn = document.getElementById('advection-toggle-btn');
    if (advBtn) advBtn.style.display = 'none';

    // Disable Advection on exit to avoid confusion?
    // isAdvectionEnabled = false;
    // if(advBtn) advBtn.classList.remove('active');
});

// UI: Create Toggle Button (if not exists)
// UI: Create Toggle Button (Refined Design)
// UI: Integrated Advection Button (Toolbar)
// We check if it exists in the #animation-controls-container
let integratedBtn = document.getElementById('advection-btn-integrated');

if (!integratedBtn) {
    const controlsContainer = document.getElementById('animation-controls-container');
    if (controlsContainer) {
        integratedBtn = document.createElement('button');
        integratedBtn.id = 'advection-btn-integrated';
        integratedBtn.title = "Activar predicció (Advecció)";
        integratedBtn.innerHTML = '🔮';
        integratedBtn.style.cssText = `
            font-size: 16px; 
            min-width: 35px; 
            cursor: pointer; 
            display: none; /* Hidden by default until Radar is active */
            background: #fcfcfc;
            border: 1px solid #ccc;
            border-radius: 4px;
            margin-left: 5px;
            height: 30px; /* Match height of other buttons */
            vertical-align: middle;
        `;

        integratedBtn.addEventListener('click', () => {
            isAdvectionEnabled = !isAdvectionEnabled;
            if (isAdvectionEnabled) {
                integratedBtn.style.background = '#ffebee';
                integratedBtn.style.border = '1px solid #ff5252';
                integratedBtn.innerHTML = '✨'; // Visual cue
            } else {
                integratedBtn.style.background = '#fcfcfc';
                integratedBtn.style.border = '1px solid #ccc';
                integratedBtn.innerHTML = '🔮';
            }
            reconfigureTimeSliderAsync();
        });

        // Insert it BEFORE the speed toggle if possible, or append
        // controlsContainer.appendChild(integratedBtn); 
        // Let's place it next to speed toggle
        controlsContainer.appendChild(integratedBtn);
    }
}

// We control the BUTTON visibility
radar_layer.on('add', () => {
    if (integratedBtn) integratedBtn.style.display = 'inline-block';
    // Force refresh just in case
    setTimeout(() => { if (map.hasLayer(radar_layer)) radar_layer.refresh(); }, 200);
});
radar_layer.on('remove', () => {
    if (integratedBtn) {
        integratedBtn.style.display = 'none';

        // Reset Advection State on Exit
        if (isAdvectionEnabled) {
            isAdvectionEnabled = false;
            // Reset Button Style
            integratedBtn.style.background = '#fcfcfc';
            integratedBtn.style.border = '1px solid #ccc';
            integratedBtn.innerHTML = '🔮';

            // Reconfigure slider to clear red zones/future steps
            setTimeout(() => reconfigureTimeSliderAsync(), 100);
        }
    }
});


// ... (Existing Color Stops and Functions) ...


// ===================================================================================
// NOU BLOC: LÒGICA PER A LA CAPA DE RADAR DE WINDY
// ===================================================================================

// Escala de colors calibrada per a Windy, basada en la teva implementació original.
const colorStopsDbz = [
    { dbz: -32, color: [115, 75, 174], alpha: 255 },
    { dbz: -31, color: [117, 80, 170], alpha: 255 },
    { dbz: -30, color: [119, 85, 166], alpha: 255 },
    { dbz: -29, color: [122, 90, 161], alpha: 255 },
    { dbz: -28, color: [124, 95, 157], alpha: 255 },
    { dbz: -27, color: [127, 100, 152], alpha: 255 },
    { dbz: -26, color: [129, 105, 148], alpha: 255 },
    { dbz: -25, color: [132, 110, 143], alpha: 255 },
    { dbz: -24, color: [134, 115, 139], alpha: 255 },
    { dbz: -23, color: [137, 120, 134], alpha: 255 },
    { dbz: -22, color: [139, 125, 130], alpha: 255 },
    { dbz: -21, color: [142, 130, 125], alpha: 255 },
    { dbz: -20, color: [144, 135, 121], alpha: 255 },
    { dbz: -19, color: [147, 141, 117], alpha: 255 },
    { dbz: -18, color: [163, 159, 104], alpha: 255 },
    { dbz: -17, color: [170, 167, 115], alpha: 255 },
    { dbz: -16, color: [176, 174, 126], alpha: 255 },
    { dbz: -15, color: [183, 182, 136], alpha: 255 },
    { dbz: -14, color: [190, 189, 147], alpha: 255 },
    { dbz: -13, color: [196, 197, 158], alpha: 255 },
    { dbz: -12, color: [203, 204, 169], alpha: 255 },
    { dbz: -11, color: [210, 212, 180], alpha: 255 },
    { dbz: -10, color: [204, 207, 180], alpha: 255 },
    { dbz: -9, color: [196, 200, 178], alpha: 255 },
    { dbz: -8, color: [189, 194, 177], alpha: 255 },
    { dbz: -7, color: [182, 188, 176], alpha: 255 },
    { dbz: -6, color: [174, 182, 175], alpha: 255 },
    { dbz: -5, color: [167, 176, 174], alpha: 255 },
    { dbz: -4, color: [160, 170, 173], alpha: 255 },
    { dbz: -3, color: [152, 164, 171], alpha: 255 },
    { dbz: -2, color: [145, 158, 170], alpha: 255 },
    { dbz: -1, color: [138, 152, 169], alpha: 255 },
    { dbz: 0, color: [130, 145, 168], alpha: 255 },
    { dbz: 1, color: [123, 139, 167], alpha: 255 },
    { dbz: 2, color: [116, 133, 166], alpha: 255 },
    { dbz: 3, color: [108, 127, 164], alpha: 255 },
    { dbz: 4, color: [101, 121, 163], alpha: 255 },
    { dbz: 5, color: [94, 115, 162], alpha: 255 },
    { dbz: 6, color: [86, 109, 161], alpha: 255 },
    { dbz: 7, color: [79, 103, 160], alpha: 255 },
    { dbz: 8, color: [72, 97, 159], alpha: 255 },
    { dbz: 9, color: [65, 91, 158], alpha: 255 },
    { dbz: 10, color: [67, 97, 162], alpha: 255 },
    { dbz: 11, color: [72, 112, 171], alpha: 255 },
    { dbz: 12, color: [78, 128, 180], alpha: 255 },
    { dbz: 13, color: [83, 144, 190], alpha: 255 },
    { dbz: 14, color: [89, 160, 199], alpha: 255 },
    { dbz: 15, color: [94, 176, 209], alpha: 255 },
    { dbz: 16, color: [100, 192, 218], alpha: 255 },
    { dbz: 17, color: [106, 208, 228], alpha: 255 },
    { dbz: 18, color: [111, 214, 232], alpha: 255 },
    { dbz: 19, color: [91, 213, 185], alpha: 255 },
    { dbz: 20, color: [72, 213, 138], alpha: 255 },
    { dbz: 21, color: [53, 213, 91], alpha: 255 },
    { dbz: 22, color: [17, 213, 24], alpha: 255 },
    { dbz: 23, color: [16, 203, 22], alpha: 255 },
    { dbz: 24, color: [15, 193, 21], alpha: 255 },
    { dbz: 25, color: [15, 183, 20], alpha: 255 },
    { dbz: 26, color: [14, 173, 19], alpha: 255 },
    { dbz: 27, color: [13, 163, 17], alpha: 255 },
    { dbz: 28, color: [13, 153, 16], alpha: 255 },
    { dbz: 29, color: [12, 143, 15], alpha: 255 },
    { dbz: 30, color: [11, 133, 14], alpha: 255 },
    { dbz: 31, color: [11, 123, 12], alpha: 255 },
    { dbz: 32, color: [10, 113, 11], alpha: 255 },
    { dbz: 33, color: [9, 103, 10], alpha: 255 },
    { dbz: 34, color: [9, 94, 9], alpha: 255 },
    { dbz: 35, color: [29, 104, 9], alpha: 255 },
    { dbz: 36, color: [80, 130, 7], alpha: 255 },
    { dbz: 37, color: [131, 157, 6], alpha: 255 },
    { dbz: 38, color: [182, 183, 5], alpha: 255 },
    { dbz: 39, color: [234, 210, 4], alpha: 255 },
    { dbz: 40, color: [255, 226, 0], alpha: 255 },
    { dbz: 41, color: [255, 215, 0], alpha: 255 },
    { dbz: 42, color: [255, 204, 0], alpha: 255 },
    { dbz: 43, color: [255, 193, 0], alpha: 255 },
    { dbz: 44, color: [255, 182, 0], alpha: 255 },
    { dbz: 45, color: [255, 171, 0], alpha: 255 },
    { dbz: 46, color: [255, 160, 0], alpha: 255 },
    { dbz: 47, color: [255, 149, 0], alpha: 255 },
    { dbz: 48, color: [255, 138, 0], alpha: 255 },
    { dbz: 49, color: [255, 128, 0], alpha: 255 },
    { dbz: 50, color: [255, 0, 0], alpha: 255 },
    { dbz: 51, color: [239, 0, 0], alpha: 255 },
    { dbz: 52, color: [223, 0, 0], alpha: 255 },
    { dbz: 53, color: [207, 0, 0], alpha: 255 },
    { dbz: 54, color: [191, 0, 0], alpha: 255 },
    { dbz: 55, color: [176, 0, 0], alpha: 255 },
    { dbz: 56, color: [160, 0, 0], alpha: 255 },
    { dbz: 57, color: [144, 0, 0], alpha: 255 },
    { dbz: 58, color: [128, 0, 0], alpha: 255 },
    { dbz: 59, color: [113, 0, 0], alpha: 255 },
    { dbz: 60, color: [255, 255, 255], alpha: 255 },
    { dbz: 61, color: [255, 227, 255], alpha: 255 },
    { dbz: 62, color: [255, 200, 255], alpha: 255 },
    { dbz: 63, color: [255, 173, 255], alpha: 255 },
    { dbz: 64, color: [255, 146, 255], alpha: 255 },
    { dbz: 65, color: [255, 117, 255], alpha: 255 },
    { dbz: 66, color: [247, 90, 248], alpha: 255 },
    { dbz: 67, color: [240, 64, 241], alpha: 255 },
    { dbz: 68, color: [232, 37, 234], alpha: 255 },
    { dbz: 69, color: [225, 11, 227], alpha: 255 },
    { dbz: 70, color: [178, 0, 255], alpha: 255 },
    { dbz: 71, color: [158, 0, 244], alpha: 255 },
    { dbz: 72, color: [138, 0, 234], alpha: 255 },
    { dbz: 73, color: [118, 0, 224], alpha: 255 },
    { dbz: 74, color: [99, 0, 214], alpha: 255 },
    { dbz: 75, color: [5, 236, 240], alpha: 255 },
    { dbz: 76, color: [4, 185, 188], alpha: 255 },
    { dbz: 77, color: [3, 134, 136], alpha: 255 },
    { dbz: 78, color: [2, 83, 84], alpha: 255 },
    { dbz: 79, color: [1, 32, 32], alpha: 255 },
    { dbz: 80, color: [1, 65, 65], alpha: 255 }
];

function pixelToDbz(pixelValue) {
    return (pixelValue / 255) * 127.5;
}

function getColorForWindyValue(pixelValue) {
    const dbz = pixelToDbz(pixelValue);
    // Filtrar soroll o eco feble (< 10 dBZ)
    if (dbz < 10) return [0, 0, 0, 0];

    // Mapa de dBZ (10 a 70+ dBZ) en 20 escalons corresponents als 20 colors d'escalaFinalNova
    // dbzRang: 10 dBZ -> index 2 (saltem primers febles igual que a Meteocat) fins a 65+ dBZ -> index 19
    let index = Math.floor(((dbz - 10) / 55) * (escalaFinalNova.length - 2)) + 2;
    index = Math.max(2, Math.min(escalaFinalNova.length - 1, index));

    const color = escalaFinalNova[index];
    return [color[0], color[1], color[2], 230];
}

// Classe personalitzada per a la capa de Windy que processa les imatges en un canvas
const WindyRadarLayer = L.TileLayer.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        const ctx = tile.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;

        const sourceImage = new Image();
        sourceImage.crossOrigin = "Anonymous";
        sourceImage.src = this.getTileUrl(coords);

        sourceImage.onload = () => {
            try {
                ctx.drawImage(sourceImage, 0, 0);
                const imageData = ctx.getImageData(0, 0, 256, 256);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const newColor = getColorForWindyValue(data[i]);
                    data[i] = newColor[0]; data[i + 1] = newColor[1]; data[i + 2] = newColor[2]; data[i + 3] = newColor[3];
                }
                ctx.putImageData(imageData, 0, 0);
                done(null, tile);
            } catch (e) { done(e, tile); }
        };
        sourceImage.onerror = () => done(new Error('Error al carregar la imatge de Windy'), tile);
        return tile;
    },
    // Funció de refresc suau per evitar el parpelleig
    refresh: function () {
        if (!this._map) { return; }
        Object.values(this._tiles).forEach(tile => {
            const imgElement = tile.el;
            const sourceImage = new Image();
            sourceImage.crossOrigin = "Anonymous";
            sourceImage.src = this.getTileUrl(tile.coords);
            sourceImage.onload = () => {
                const ctx = imgElement.getContext('2d');
                ctx.clearRect(0, 0, 256, 256); // Neteja el canvas abans de redibuixar
                ctx.drawImage(sourceImage, 0, 0);
                const imageData = ctx.getImageData(0, 0, 256, 256);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const newColor = getColorForWindyValue(data[i]);
                    data[i] = newColor[0]; data[i + 1] = newColor[1]; data[i + 2] = newColor[2]; data[i + 3] = newColor[3];
                }
                ctx.putImageData(imageData, 0, 0);
            };
        });
    }
});
// ===================================================================================
// FI DEL BLOC DE WINDY
// ===================================================================================

const windy_radar_layer = new WindyRadarLayer(
    'https://rdr.windy.com/radar2/composite/{any}/{mes}/{dia}/{hora}{minut}/{z}/{x}/{y}/reflectivity.webp?',
    {
        attribution: 'Radar data &copy; <a href="https://www.windy.com/">Windy.com</a>',
        opacity: 0.85,
        maxNativeZoom: 7,
        className: 'windy-radar-tile', // <-- AFEGEIX AQUESTA OPCIÓ
        pane: 'radarPane'
    }
);

// Mètode per construir la URL dinàmicament, igual que les altres capes
windy_radar_layer.getTileUrl = function (coords) {
    if (!range_values.length || range_element.value >= range_values.length) {
        return L.Util.emptyImageUrl;
    }
    const r = range_values[range_element.value];

    // Assegurem que l'objecte 'r' tingui totes les propietats necessàries
    if (!r || r.any === undefined || r.mes === undefined || r.dia === undefined || r.hora === undefined || r.min === undefined) {
        return L.Util.emptyImageUrl;
    }

    return L.Util.template(this._url, {
        any: r.any,
        mes: fillTo(r.mes, 2),
        dia: fillTo(r.dia, 2),
        hora: fillTo(r.hora, 2),
        minut: fillTo(r.min, 2),
        z: coords.z,
        x: coords.x,
        y: coords.y
    });
};

// Connectem la capa al sistema de temps
windy_radar_layer.on('add remove', reconfigureTimeSliderAsync);

// ===================================================================
// NOVA CAPA: RADAR METEOFRANCE (KERAUNOS) - DIRECTE
// ===================================================================
const meteofrance_radar_layer = L.tileLayerNoFlickering(
    '',
    {
        attribution: '© Keraunos / MeteoFrance',
        opacity: 0.85,
        maxNativeZoom: 10,
        tms: false,
        pane: 'radarPane',
        errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    }
);

meteofrance_radar_layer.getTileUrl = function (coords) {
    if (!range_values.length || range_element.value >= range_values.length) return '';
    const r = range_values[range_element.value];
    if (!r) return '';

    // 1. Temps
    const timeString = `${r.any}${fillTo(r.mes, 2)}${fillTo(r.dia, 2)}${fillTo(r.hora, 2)}${fillTo(r.min, 2)}`;

    // 2. CÀLCUL TMS (Es manté igual)
    const y_tms = Math.pow(2, coords.z) - coords.y - 1;

    // 3. RETORN CAP AL TEU SERVIDOR PYTHON LOCAL
    // Canviem la URL externa per la del teu servidor local
    return `http://localhost:5001/radar/${timeString}/${coords.z}/${coords.x}/${y_tms}.png`;
};

// Connectem la capa
meteofrance_radar_layer.on('add remove', reconfigureTimeSliderAsync);

// ===================================================================
// VERSIÓ FINAL BASADA EN L'EXEMPLE FUNCIONAL DE RAINVIEWER
// ===================================================================
let rainviewerApiData = null; // Variable global per guardar la resposta de l'API

const rainviewer_layer = L.tileLayerNoFlickering(
    // La URL base ara és un placeholder gairebé buit
    '{host}{path}/{tileSize}/{z}/{x}/{y}/{colorScheme}/{options}.png',
    {
        attribution: '© <a href="https://www.rainviewer.com/" target="_blank">RainViewer</a>',
        opacity: 0.8
    }
);

rainviewer_layer.getTileUrl = function (coords) {
    // Comprovacions de seguretat
    if (!rainviewerApiData || !range_values.length || range_element.value >= range_values.length) {
        return '';
    }

    const r = range_values[range_element.value];
    if (!r || !r.path) {
        return '';
    }

    // Construïm la URL exactament com a l'exemple
    return L.Util.template(this._url, {
        host: rainviewerApiData.host, // Agafem el HOST de la resposta de l'API
        path: r.path,                 // Agafem el PATH de la imatge actual
        tileSize: 256,                // Mida de la imatge
        z: coords.z,
        x: coords.x,
        y: coords.y,
        colorScheme: 6,               // Esquema de color "Universal Blue"
        options: '0_1'                // Opcions: 1 (suavitzat) _ 1 (mostrar neu)
    });
};

rainviewer_layer.on('add remove', reconfigureTimeSliderAsync);
// ===================================================================
// FI DEL BLOC DE RAINVIEWER
// ===================================================================

// Esdeveniment per reconfigurar l'animació quan la capa canvia
// Nota: Ara crida a una funció 'async' (asíncrona) que definirem després
rainviewer_layer.on('add remove', reconfigureTimeSliderAsync);
// ===================================================================
// FI DE LA NOVA CAPA
// ===================================================================

// ===================================================================
// OPERA RADAR TEST (FETCH + DECOMPRESS + CANVAS)
// ===================================================================

// Importem fflate dinàmicament si no hi és
if (typeof fflate === 'undefined') {
    const script = document.createElement('script');
    script.src = "https://unpkg.com/fflate@0.8.0";
    document.head.appendChild(script);
}

// Funció CRC32 per calcular els hashes de les URLs d'OPERA (substitueix l'antic MD5)
const crc32 = (function () {
    let table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }
    return function (str) {
        let crc = -1;
        for (let i = 0; i < str.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xFF];
        }
        return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
    };
})();

const colorLUT = new Uint8Array(256 * 4);

function inicialitzarTraductor() {
    for (let byte = 0; byte < 256; byte++) {
        const idx = byte * 4;
        const dbz = (byte * 0.5) - 32;

        let r, g, b, a;

        // INVERSIÓ: El valor 255 és el que està FORA de cobertura.
        // El pintem de gris tènue per marcar el límit.
        if (byte === 255) {
            colorLUT[idx] = 40;
            colorLUT[idx + 1] = 40;
            colorLUT[idx + 2] = 50;
            colorLUT[idx + 3] = 40; // Gris fosc molt tènue (abans 70)
            continue;
        }

        // El valor 0 o dbz molt baix és DINS la cobertura però sense pluja.
        // Ho posem transparent per sota de -30 dBZ per no tapar el mapa.
        if (dbz < -30) {
            colorLUT[idx + 3] = 0;
            continue;
        }
        // Interpolació exacta usant colorStopsDbz (la paleta del CAPPI)
        let lowerStop = colorStopsDbz[0];
        let upperStop = colorStopsDbz[colorStopsDbz.length - 1];

        for (let i = 0; i < colorStopsDbz.length - 1; i++) {
            if (dbz >= colorStopsDbz[i].dbz && dbz <= colorStopsDbz[i + 1].dbz) {
                lowerStop = colorStopsDbz[i];
                upperStop = colorStopsDbz[i + 1];
                break;
            }
        }
        const range = upperStop.dbz - lowerStop.dbz;
        const position = (range === 0) ? 1 : (dbz - lowerStop.dbz) / range;

        r = Math.round(lowerStop.color[0] * (1 - position) + upperStop.color[0] * position);
        g = Math.round(lowerStop.color[1] * (1 - position) + upperStop.color[1] * position);
        b = Math.round(lowerStop.color[2] * (1 - position) + upperStop.color[2] * position);

        a = 210; // Pluja normal/forta

        colorLUT[idx] = r;
        colorLUT[idx + 1] = g;
        colorLUT[idx + 2] = b;
        colorLUT[idx + 3] = a;
    }
}

inicialitzarTraductor();

const RADAR_PRO_PRODUCTS = {
    'z': {
        id: 'z', name: 'Reflectivitat', unit: 'dBZ', suffix: 'z_max2d', pathPart: 'z_max2d',
        scale: [
            { v: -32, c: [115, 75, 174] }, { v: -31, c: [117, 80, 170] }, { v: -30, c: [119, 85, 166] },
            { v: -29, c: [122, 90, 161] }, { v: -28, c: [124, 95, 157] }, { v: -27, c: [127, 100, 152] },
            { v: -26, c: [129, 105, 148] }, { v: -25, c: [132, 110, 143] }, { v: -24, c: [134, 115, 139] },
            { v: -23, c: [137, 120, 134] }, { v: -22, c: [139, 125, 130] }, { v: -21, c: [142, 130, 125] },
            { v: -20, c: [144, 135, 121] }, { v: -19, c: [147, 141, 117] }, { v: -18, c: [163, 159, 104] },
            { v: -17, c: [170, 167, 115] }, { v: -16, c: [176, 174, 126] }, { v: -15, c: [183, 182, 136] },
            { v: -14, c: [190, 189, 147] }, { v: -13, c: [196, 197, 158] }, { v: -12, c: [203, 204, 169] },
            { v: -11, c: [210, 212, 180] }, { v: -10, c: [204, 207, 180] }, { v: -9, c: [196, 200, 178] },
            { v: -8, c: [189, 194, 177] }, { v: -7, c: [182, 188, 176] }, { v: -6, c: [174, 182, 175] },
            { v: -5, c: [167, 176, 174] }, { v: -4, c: [160, 170, 173] }, { v: -3, c: [152, 164, 171] },
            { v: -2, c: [145, 158, 170] }, { v: -1, c: [138, 152, 169] }, { v: 0, c: [130, 145, 168] },
            { v: 1, c: [123, 139, 167] }, { v: 2, c: [116, 133, 166] }, { v: 3, c: [108, 127, 164] },
            { v: 4, c: [101, 121, 163] }, { v: 5, c: [94, 115, 162] }, { v: 6, c: [86, 109, 161] },
            { v: 7, c: [79, 103, 160] }, { v: 8, c: [72, 97, 159] }, { v: 9, c: [65, 91, 158] },
            { v: 10, c: [67, 97, 162] }, { v: 11, c: [72, 112, 171] }, { v: 12, c: [78, 128, 180] },
            { v: 13, c: [83, 144, 190] }, { v: 14, c: [89, 160, 199] }, { v: 15, c: [94, 176, 209] },
            { v: 16, c: [100, 192, 218] }, { v: 17, c: [106, 208, 228] }, { v: 18, c: [111, 214, 232] },
            { v: 19, c: [91, 213, 185] }, { v: 20, c: [72, 213, 138] }, { v: 21, c: [53, 213, 91] },
            { v: 22, c: [17, 213, 24] }, { v: 23, c: [16, 203, 22] }, { v: 24, c: [15, 193, 21] },
            { v: 25, c: [15, 183, 20] }, { v: 26, c: [14, 173, 19] }, { v: 27, c: [13, 163, 17] },
            { v: 28, c: [13, 153, 16] }, { v: 29, c: [12, 143, 15] }, { v: 30, c: [11, 133, 14] },
            { v: 31, c: [11, 123, 12] }, { v: 32, c: [10, 113, 11] }, { v: 33, c: [9, 103, 10] },
            { v: 34, c: [9, 94, 9] }, { v: 35, c: [29, 104, 9] }, { v: 36, c: [80, 130, 7] },
            { v: 37, c: [131, 157, 6] }, { v: 38, c: [182, 183, 5] }, { v: 39, c: [234, 210, 4] },
            { v: 40, c: [255, 226, 0] }, { v: 41, c: [255, 215, 0] }, { v: 42, c: [255, 204, 0] },
            { v: 43, c: [255, 193, 0] }, { v: 44, c: [255, 182, 0] }, { v: 45, c: [255, 171, 0] },
            { v: 46, c: [255, 160, 0] }, { v: 47, c: [255, 149, 0] }, { v: 48, c: [255, 138, 0] },
            { v: 49, c: [255, 128, 0] }, { v: 50, c: [255, 0, 0] }, { v: 51, c: [239, 0, 0] },
            { v: 52, c: [223, 0, 0] }, { v: 53, c: [207, 0, 0] }, { v: 54, c: [191, 0, 0] },
            { v: 55, c: [176, 0, 0] }, { v: 56, c: [160, 0, 0] }, { v: 57, c: [144, 0, 0] },
            { v: 58, c: [128, 0, 0] }, { v: 59, c: [113, 0, 0] }, { v: 60, c: [255, 255, 255] },
            { v: 61, c: [255, 227, 255] }, { v: 62, c: [255, 200, 255] }, { v: 63, c: [255, 173, 255] },
            { v: 64, c: [255, 146, 255] }, { v: 65, c: [255, 117, 255] }, { v: 66, c: [247, 90, 248] },
            { v: 67, c: [240, 64, 241] }, { v: 68, c: [232, 37, 234] }, { v: 69, c: [225, 11, 227] },
            { v: 70, c: [178, 0, 255] }, { v: 71, c: [158, 0, 244] }, { v: 72, c: [138, 0, 234] },
            { v: 73, c: [118, 0, 224] }, { v: 74, c: [99, 0, 214] }, { v: 75, c: [5, 236, 240] },
            { v: 76, c: [4, 185, 188] }, { v: 77, c: [3, 134, 136] }, { v: 78, c: [2, 83, 84] },
            { v: 79, c: [1, 32, 32] }, { v: 80, c: [1, 65, 65] }
        ],
        calc: (b) => (b * 0.5) - 32,
        inv: (v) => (v + 32) / 0.5
    },
    'vil': {
        id: 'vil', name: 'VIL', unit: 'kg/m²', suffix: 'vil', pathPart: 'vil', crcPrefix: 'frcompvil',
        scale: [
            { "value": 0.2, "color": [56, 0, 112] }, { "value": 0.275, "color": [54, 0, 126] }, { "value": 0.35, "color": [52, 0, 140] }, { "value": 0.425, "color": [50, 0, 154] }, { "value": 0.5, "color": [48, 0, 168] }, { "value": 0.625, "color": [36, 0, 189] }, { "value": 0.75, "color": [24, 0, 210] }, { "value": 0.875, "color": [12, 0, 231] }, { "value": 1, "color": [0, 0, 252] }, { "value": 1.125, "color": [0, 27, 237] }, { "value": 1.25, "color": [0, 54, 222] }, { "value": 1.375, "color": [0, 81, 207] }, { "value": 1.5, "color": [0, 108, 192] }, { "value": 1.625, "color": [0, 121, 144] }, { "value": 1.75, "color": [0, 134, 96] }, { "value": 1.875, "color": [0, 147, 48] }, { "value": 2, "color": [0, 160, 0] }, { "value": 2.125, "color": [0, 167, 0] }, { "value": 2.25, "color": [0, 174, 0] }, { "value": 2.375, "color": [0, 181, 0] }, { "value": 2.5, "color": [0, 188, 0] }, { "value": 2.626, "color": [13, 195, 0] }, { "value": 2.75, "color": [26, 202, 0] }, { "value": 2.875, "color": [39, 209, 0] }, { "value": 3, "color": [52, 216, 0] }, { "value": 3.25, "color": [78, 217, 0] }, { "value": 3.5, "color": [104, 218, 0] }, { "value": 3.75, "color": [130, 219, 0] }, { "value": 4, "color": [156, 220, 0] }, { "value": 4.25, "color": [173, 220, 0] }, { "value": 4.5, "color": [190, 220, 0] }, { "value": 4.75, "color": [207, 220, 0] }, { "value": 5, "color": [224, 220, 0] }, { "value": 5.5, "color": [231, 209, 0] }, { "value": 6, "color": [238, 198, 0] }, { "value": 6.5, "color": [245, 187, 0] }, { "value": 7, "color": [252, 176, 0] }, { "value": 7.75, "color": [252, 165, 0] }, { "value": 8.5, "color": [252, 154, 0] }, { "value": 9.25, "color": [252, 143, 0] }, { "value": 10, "color": [252, 132, 0] }, { "value": 11.25, "color": [252, 121, 0] }, { "value": 12.5, "color": [252, 110, 0] }, { "value": 13.75, "color": [252, 99, 0] }, { "value": 15, "color": [252, 88, 0] }, { "value": 16.25, "color": [252, 66, 0] }, { "value": 17.5, "color": [252, 44, 0] }, { "value": 18.75, "color": [252, 22, 0] }, { "value": 20, "color": [252, 0, 0] }, { "value": 21.25, "color": [229, 0, 0] }, { "value": 22.5, "color": [206, 0, 0] }, { "value": 23.75, "color": [183, 0, 0] }, { "value": 25, "color": [160, 0, 0] }, { "value": 26.25, "color": [183, 63, 63] }, { "value": 27.5, "color": [206, 126, 126] }, { "value": 28.75, "color": [229, 189, 189] }, { "value": 30, "color": [252, 252, 252] }
        ],
        calc: (b) => b * 0.125,
        inv: (v) => v / 0.125
    },
    'etop': {
        id: 'etop', name: 'EchoTop', unit: 'km', suffix: 'etop', pathPart: 'etop', crcPrefix: 'frcompetop',
        scale: [
            { "value": 1, "color": [80, 54, 66] }, { "value": 1.1, "color": [83, 56, 68] }, { "value": 1.2, "color": [86, 59, 71] }, { "value": 1.3, "color": [89, 62, 74] }, { "value": 1.4, "color": [92, 64, 77] }, { "value": 1.5, "color": [95, 67, 80] }, { "value": 1.6, "color": [98, 70, 83] }, { "value": 1.7, "color": [101, 72, 86] }, { "value": 1.8, "color": [104, 75, 89] }, { "value": 1.9, "color": [107, 78, 92] }, { "value": 2, "color": [98, 90, 155] }, { "value": 2.1, "color": [100, 92, 160] }, { "value": 2.2, "color": [102, 94, 165] }, { "value": 2.3, "color": [105, 96, 170] }, { "value": 2.4, "color": [107, 98, 175] }, { "value": 2.5, "color": [110, 101, 180] }, { "value": 2.6, "color": [112, 103, 185] }, { "value": 2.7, "color": [115, 105, 190] }, { "value": 2.8, "color": [117, 107, 195] }, { "value": 2.9, "color": [119, 109, 199] }, { "value": 3, "color": [0, 0, 191] }, { "value": 3.1, "color": [0, 0, 198] }, { "value": 3.2, "color": [0, 0, 205] }, { "value": 3.3, "color": [0, 0, 212] }, { "value": 3.4, "color": [0, 0, 219] }, { "value": 3.5, "color": [0, 0, 226] }, { "value": 3.6, "color": [0, 0, 233] }, { "value": 3.7, "color": [0, 0, 240] }, { "value": 3.8, "color": [0, 0, 247] }, { "value": 3.9, "color": [0, 0, 254] }, { "value": 4, "color": [55, 110, 200] }, { "value": 4.1, "color": [57, 115, 206] }, { "value": 4.2, "color": [60, 121, 212] }, { "value": 4.3, "color": [63, 126, 218] }, { "value": 4.4, "color": [66, 132, 224] }, { "value": 4.5, "color": [68, 137, 230] }, { "value": 4.6, "color": [71, 143, 236] }, { "value": 4.7, "color": [74, 148, 242] }, { "value": 4.8, "color": [77, 154, 248] }, { "value": 4.9, "color": [79, 159, 254] }, { "value": 5, "color": [0, 190, 191] }, { "value": 5.1, "color": [0, 195, 195] }, { "value": 5.2, "color": [0, 200, 200] }, { "value": 5.3, "color": [0, 205, 205] }, { "value": 5.4, "color": [0, 210, 210] }, { "value": 5.5, "color": [0, 215, 215] }, { "value": 5.6, "color": [0, 220, 220] }, { "value": 5.7, "color": [0, 225, 225] }, { "value": 5.8, "color": [0, 230, 230] }, { "value": 5.9, "color": [0, 234, 234] }, { "value": 6, "color": [0, 165, 140] }, { "value": 6.1, "color": [0, 167, 141] }, { "value": 6.2, "color": [0, 170, 142] }, { "value": 6.3, "color": [0, 173, 143] }, { "value": 6.4, "color": [0, 176, 144] }, { "value": 6.5, "color": [0, 178, 145] }, { "value": 6.6, "color": [0, 181, 146] }, { "value": 6.7, "color": [0, 184, 147] }, { "value": 6.8, "color": [0, 187, 148] }, { "value": 6.9, "color": [0, 189, 149] }, { "value": 7, "color": [0, 204, 0] }, { "value": 7.1, "color": [0, 210, 0] }, { "value": 7.2, "color": [0, 216, 0] }, { "value": 7.3, "color": [0, 221, 0] }, { "value": 7.4, "color": [0, 227, 0] }, { "value": 7.5, "color": [0, 232, 0] }, { "value": 7.6, "color": [0, 238, 0] }, { "value": 7.7, "color": [0, 243, 0] }, { "value": 7.8, "color": [0, 249, 0] }, { "value": 7.9, "color": [0, 254, 0] }, { "value": 8, "color": [139, 205, 0] }, { "value": 8.1, "color": [146, 210, 0] }, { "value": 8.2, "color": [153, 216, 0] }, { "value": 8.3, "color": [159, 221, 0] }, { "value": 8.4, "color": [166, 227, 0] }, { "value": 8.5, "color": [173, 232, 0] }, { "value": 8.6, "color": [179, 238, 0] }, { "value": 8.7, "color": [186, 243, 0] }, { "value": 8.8, "color": [193, 249, 0] }, { "value": 8.9, "color": [199, 254, 0] }, { "value": 9, "color": [200, 185, 0] }, { "value": 9.1, "color": [206, 189, 0] }, { "value": 9.2, "color": [212, 193, 0] }, { "value": 9.3, "color": [218, 198, 0] }, { "value": 9.4, "color": [224, 202, 0] }, { "value": 9.5, "color": [230, 207, 0] }, { "value": 9.6, "color": [236, 211, 0] }, { "value": 9.7, "color": [242, 216, 0] }, { "value": 9.8, "color": [248, 220, 0] }, { "value": 9.9, "color": [254, 224, 0] }, { "value": 10, "color": [191, 113, 0] }, { "value": 10.1, "color": [198, 117, 0] }, { "value": 10.2, "color": [205, 121, 0] }, { "value": 10.3, "color": [212, 125, 0] }, { "value": 10.4, "color": [219, 129, 0] }, { "value": 10.5, "color": [226, 133, 0] }, { "value": 10.6, "color": [233, 137, 0] }, { "value": 10.7, "color": [240, 141, 0] }, { "value": 10.8, "color": [247, 145, 0] }, { "value": 10.9, "color": [254, 149, 0] }, { "value": 11, "color": [131, 75, 18] }, { "value": 11.1, "color": [135, 77, 19] }, { "value": 11.2, "color": [140, 80, 20] }, { "value": 11.3, "color": [145, 83, 20] }, { "value": 11.4, "color": [150, 86, 21] }, { "value": 11.5, "color": [155, 88, 22] }, { "value": 11.6, "color": [160, 91, 22] }, { "value": 11.7, "color": [165, 94, 23] }, { "value": 11.8, "color": [170, 97, 24] }, { "value": 11.9, "color": [174, 99, 24] },
            { "value": 12, "color": [190, 0, 0] }, { "value": 12.1, "color": [198, 0, 0] }, { "value": 12.2, "color": [205, 0, 0] }, { "value": 12.3, "color": [212, 0, 0] }, { "value": 12.4, "color": [219, 0, 0] }, { "value": 12.5, "color": [226, 0, 0] }, { "value": 12.6, "color": [233, 0, 0] }, { "value": 12.7, "color": [240, 0, 0] }, { "value": 12.8, "color": [247, 0, 0] }, { "value": 12.9, "color": [254, 0, 0] }, { "value": 13, "color": [191, 66, 149] }, { "value": 13.1, "color": [198, 70, 155] }, { "value": 13.2, "color": [205, 74, 161] }, { "value": 13.3, "color": [212, 77, 166] }, { "value": 13.4, "color": [219, 81, 172] }, { "value": 13.5, "color": [226, 85, 177] }, { "value": 13.6, "color": [233, 88, 183] }, { "value": 13.7, "color": [240, 92, 188] }, { "value": 13.8, "color": [247, 96, 194] }, { "value": 13.9, "color": [254, 99, 199] }, { "value": 14, "color": [131, 0, 131] }, { "value": 14.1, "color": [138, 0, 144] }, { "value": 14.2, "color": [146, 0, 158] }, { "value": 14.3, "color": [153, 0, 172] }, { "value": 14.4, "color": [161, 0, 186] }, { "value": 14.5, "color": [169, 0, 199] }, { "value": 14.6, "color": [176, 0, 213] }, { "value": 14.7, "color": [184, 0, 227] }, { "value": 14.8, "color": [192, 0, 241] }, { "value": 14.9, "color": [199, 0, 254] }, { "value": 15, "color": [191, 190, 191] }, { "value": 15.1, "color": [193, 193, 193] }, { "value": 15.2, "color": [195, 195, 195] }, { "value": 15.3, "color": [197, 197, 197] }, { "value": 15.4, "color": [199, 199, 199] }, { "value": 15.5, "color": [201, 201, 201] }, { "value": 15.6, "color": [203, 203, 203] }, { "value": 15.7, "color": [205, 205, 205] }, { "value": 15.8, "color": [208, 208, 208] }, { "value": 15.9, "color": [210, 210, 210] }, { "value": 16, "color": [212, 212, 212] }, { "value": 16.1, "color": [214, 214, 214] }, { "value": 16.2, "color": [216, 216, 216] }, { "value": 16.3, "color": [218, 218, 218] }, { "value": 16.4, "color": [220, 220, 220] }, { "value": 16.5, "color": [222, 222, 222] }, { "value": 16.6, "color": [225, 225, 225] }, { "value": 16.7, "color": [227, 227, 227] }, { "value": 16.8, "color": [229, 229, 229] }, { "value": 16.9, "color": [231, 231, 231] }, { "value": 17, "color": [233, 233, 233] }, { "value": 17.1, "color": [235, 235, 235] }, { "value": 17.2, "color": [237, 237, 237] }, { "value": 17.3, "color": [240, 240, 240] }, { "value": 17.4, "color": [242, 242, 242] }, { "value": 17.5, "color": [244, 244, 244] }, { "value": 17.6, "color": [246, 246, 246] }, { "value": 17.7, "color": [248, 248, 248] }, { "value": 17.8, "color": [250, 250, 250] }, { "value": 17.9, "color": [252, 252, 252] }, { "value": 18, "color": [254, 254, 254] }
        ],
        calc: (b) => b * 0.1,
        inv: (v) => v / 0.1
    },
    'posh': {
        id: 'posh', name: 'Prob. Pedra', unit: '%', suffix: 'posh', pathPart: 'posh', crcPrefix: 'frcompposh',
        scale: [
            { "value": 10, "color": [56, 0, 112] }, { "value": 12.5, "color": [54, 0, 126] }, { "value": 15, "color": [52, 0, 140] }, { "value": 17.5, "color": [50, 0, 154] }, { "value": 20, "color": [48, 0, 168] }, { "value": 22.5, "color": [36, 0, 189] }, { "value": 25, "color": [24, 0, 210] }, { "value": 27.5, "color": [12, 0, 231] }, { "value": 30, "color": [0, 0, 252] }, { "value": 32.5, "color": [0, 27, 237] }, { "value": 35, "color": [0, 54, 222] }, { "value": 37.5, "color": [0, 81, 207] }, { "value": 40, "color": [0, 108, 192] }, { "value": 42.5, "color": [0, 121, 144] }, { "value": 45, "color": [0, 134, 96] }, { "value": 47.5, "color": [0, 147, 48] }, { "value": 50, "color": [0, 160, 0] }, { "value": 51.25, "color": [0, 167, 0] }, { "value": 52.5, "color": [0, 174, 0] }, { "value": 53.75, "color": [0, 181, 0] }, { "value": 55, "color": [0, 188, 0] }, { "value": 56.25, "color": [13, 195, 0] }, { "value": 57.5, "color": [26, 202, 0] }, { "value": 58.75, "color": [39, 209, 0] }, { "value": 60, "color": [52, 216, 0] }, { "value": 61.25, "color": [78, 217, 0] }, { "value": 62.5, "color": [104, 218, 0] }, { "value": 63.75, "color": [130, 219, 0] }, { "value": 65, "color": [156, 220, 0] }, { "value": 66.25, "color": [173, 220, 0] }, { "value": 67.5, "color": [190, 220, 0] }, { "value": 68.75, "color": [207, 220, 0] }, { "value": 70, "color": [224, 220, 0] }, { "value": 71.25, "color": [231, 209, 0] }, { "value": 72.5, "color": [238, 198, 0] }, { "value": 73.75, "color": [245, 187, 0] }, { "value": 75, "color": [252, 176, 0] }, { "value": 76.25, "color": [252, 165, 0] }, { "value": 77.5, "color": [252, 154, 0] }, { "value": 78.75, "color": [252, 143, 0] }, { "value": 80, "color": [252, 132, 0] }, { "value": 81.25, "color": [252, 121, 0] }, { "value": 82.5, "color": [252, 110, 0] }, { "value": 83.75, "color": [252, 99, 0] }, { "value": 85, "color": [252, 88, 0] }, { "value": 86.25, "color": [252, 66, 0] }, { "value": 87.5, "color": [252, 44, 0] }, { "value": 88.75, "color": [252, 22, 0] }, { "value": 90, "color": [252, 0, 0] }, { "value": 91.25, "color": [229, 0, 0] }, { "value": 92.5, "color": [206, 0, 0] }, { "value": 93.75, "color": [183, 0, 0] }, { "value": 95, "color": [160, 0, 0] }, { "value": 96.25, "color": [183, 63, 63] }, { "value": 97.5, "color": [206, 126, 126] }, { "value": 98.75, "color": [229, 189, 189] }, { "value": 100, "color": [252, 252, 252] }
        ],
        calc: (b) => b * 0.4,
        inv: (v) => v / 0.4
    },
    'mehs': {
        id: 'mehs', name: 'Mida Pedra', unit: 'mm', suffix: 'mehs', pathPart: 'mehs', crcPrefix: 'frcompmehs',
        scale: [
            { "value": 0.1, "color": [56, 0, 112] }, { "value": 0.15, "color": [54, 0, 126] }, { "value": 0.2, "color": [52, 0, 140] }, { "value": 0.25, "color": [50, 0, 154] }, { "value": 0.3, "color": [48, 0, 168] }, { "value": 0.375, "color": [36, 0, 189] }, { "value": 0.45, "color": [24, 0, 210] }, { "value": 0.5, "color": [12, 0, 231] }, { "value": 0.6, "color": [0, 0, 252] }, { "value": 0.7, "color": [0, 27, 237] }, { "value": 0.8, "color": [0, 54, 222] }, { "value": 0.9, "color": [0, 81, 207] }, { "value": 1, "color": [0, 108, 192] }, { "value": 1.25, "color": [0, 121, 144] }, { "value": 1.5, "color": [0, 134, 96] }, { "value": 1.75, "color": [0, 147, 48] }, { "value": 2, "color": [0, 160, 0] }, { "value": 2.5, "color": [0, 167, 0] }, { "value": 3, "color": [0, 174, 0] }, { "value": 3.5, "color": [0, 181, 0] }, { "value": 4, "color": [0, 188, 0] }, { "value": 4.5, "color": [13, 195, 0] }, { "value": 5, "color": [26, 202, 0] }, { "value": 5.5, "color": [39, 209, 0] }, { "value": 6, "color": [52, 216, 0] }, { "value": 7, "color": [78, 217, 0] }, { "value": 8, "color": [104, 218, 0] }, { "value": 9, "color": [130, 219, 0] }, { "value": 10, "color": [156, 220, 0] }, { "value": 11.25, "color": [173, 220, 0] }, { "value": 12.5, "color": [190, 220, 0] }, { "value": 13.75, "color": [207, 220, 0] }, { "value": 15, "color": [224, 220, 0] }, { "value": 16.25, "color": [231, 209, 0] }, { "value": 17.5, "color": [238, 198, 0] }, { "value": 18.75, "color": [245, 187, 0] }, { "value": 20, "color": [252, 176, 0] }, { "value": 22.5, "color": [252, 165, 0] }, { "value": 25, "color": [252, 154, 0] }, { "value": 27.5, "color": [252, 143, 0] }, { "value": 30, "color": [252, 132, 0] }, { "value": 32.5, "color": [252, 121, 0] }, { "value": 35, "color": [252, 110, 0] }, { "value": 37.5, "color": [252, 99, 0] }, { "value": 40, "color": [252, 88, 0] }, { "value": 45, "color": [252, 66, 0] }, { "value": 50, "color": [252, 44, 0] }, { "value": 55, "color": [252, 22, 0] }, { "value": 60, "color": [252, 0, 0] }, { "value": 65, "color": [229, 0, 0] }, { "value": 70, "color": [206, 0, 0] }, { "value": 75, "color": [183, 0, 0] }, { "value": 80, "color": [160, 0, 0] }, { "value": 85, "color": [183, 63, 63] }, { "value": 90, "color": [206, 126, 126] }, { "value": 95, "color": [229, 189, 189] }, { "value": 100, "color": [252, 252, 252] }
        ],
        calc: (b) => b * 0.4,
        inv: (v) => v / 0.4
    }
};

// Variable d'estat per al producte seleccionat
let currentRadarProProduct = 'z';

const RADAR_PRO_CONFIG = {
    'eurad': {
        id: 'eurad',
        displayName: 'OPERA (Europa)',
        filePrefix: 'euradz_max2d',
        pathPrefix: 'eurad',
        fileNamePrefix: 'eurad_gmap',
        width: 2150, height: 2300,
        bounds: [[70.3995, -27.8478], [34.3063, 32.0249]],
        availableProducts: ['z']
    },
    'frcomp': {
        id: 'frcomp2',
        displayName: 'Météo-France',
        filePrefix: 'frcompz_max2d',
        pathPrefix: 'frcomp',
        fileNamePrefix: 'frcomp2_gmap',
        width: 1770, height: 1600,
        bounds: [[52.482, -7.9563], [39.5984, 12.7139]],
        availableProducts: ['z', 'vil', 'etop', 'posh', 'mehs']
    }
};

const proRadarLayers = {
    'eurad': L.imageOverlay('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', RADAR_PRO_CONFIG.eurad.bounds, {
        opacity: 1, pane: 'radarPane', className: 'pixelated-image'
    }),
    'frcomp': L.imageOverlay('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', RADAR_PRO_CONFIG.frcomp.bounds, {
        opacity: 1, pane: 'radarPane', className: 'pixelated-image'
    })
};

// Alias per mantenir compatibilitat si cal
const operaRadarTestLayer = proRadarLayers.eurad;

function getProductLut(productKey) {
    const prod = RADAR_PRO_PRODUCTS[productKey];
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) lut[i * 4 + 3] = 0; // Transparència per defecte (inclou byte 0)

    // Cas especial per Reflectivitat (Z) - Lògica d'alta resolució
    if (productKey === 'z') {
        for (let i = 0; i < 256; i++) {
            const idx = i * 4;

            // FIX: El valor 255 és el límit de cobertura. El pintem gris fosc en comptes de lila.
            if (i === 255) {
                lut[idx] = 45; lut[idx + 1] = 45; lut[idx + 2] = 55; lut[idx + 3] = 40; // Abans 80
                continue;
            }

            const dbz = (i * 0.5) - 32;

            // Per sota de -30 dBZ ho posem transparent per no omplir el mapa de lila
            if (dbz < -30) {
                lut[idx + 3] = 0;
                continue;
            }

            if (i < 256) {
                // Busquem els stops per interpolar (usant la paleta global colorStopsDbz)
                let lowerStop = colorStopsDbz[0];
                let upperStop = colorStopsDbz[colorStopsDbz.length - 1];

                for (let j = 0; j < colorStopsDbz.length - 1; j++) {
                    if (dbz >= colorStopsDbz[j].dbz && dbz <= colorStopsDbz[j + 1].dbz) {
                        lowerStop = colorStopsDbz[j];
                        upperStop = colorStopsDbz[j + 1];
                        break;
                    }
                }

                const range = upperStop.dbz - lowerStop.dbz;
                const position = (range === 0) ? 1 : (dbz - lowerStop.dbz) / range;

                let r = Math.round(lowerStop.color[0] * (1 - position) + upperStop.color[0] * position);
                let g = Math.round(lowerStop.color[1] * (1 - position) + upperStop.color[1] * position);
                let b = Math.round(lowerStop.color[2] * (1 - position) + upperStop.color[2] * position);
                let a = 210; // Opacitat base per a la PRO

                lut[idx] = r; lut[idx + 1] = g; lut[idx + 2] = b; lut[idx + 3] = a;
            }
        }
        return lut;
    }

    // Per a la resta de productes (VIL, ETOP, etc.), evitem pintar el byte 255 com a dada
    for (let b = 1; b < 255; b++) {
        const val = prod.calc(b);
        let selectedStop = prod.scale[0];
        for (let j = 0; j < prod.scale.length; j++) {
            if (val >= prod.scale[j].value) {
                selectedStop = prod.scale[j];
            } else {
                break;
            }
        }

        if (selectedStop) {
            lut[b * 4] = selectedStop.color[0];
            lut[b * 4 + 1] = selectedStop.color[1];
            lut[b * 4 + 2] = selectedStop.color[2];
            lut[b * 4 + 3] = 255;
        }
    }

    // Marquem també el límit per a la resta de productes
    lut[255 * 4] = 45; lut[255 * 4 + 1] = 45; lut[255 * 4 + 2] = 55; lut[255 * 4 + 3] = 80;

    return lut;
}

async function updateProRadar(radarKey, timestamp = 'aktual', isPrefetch = false) {
    const cfg = RADAR_PRO_CONFIG[radarKey];
    if (!cfg) return;

    const prod = RADAR_PRO_PRODUCTS[currentRadarProProduct];
    const cacheKey = `${timestamp}_${currentRadarProProduct}`;
    const cache = proRadarCache[radarKey];

    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (!isPrefetch) proRadarLayers[radarKey].setUrl(cached.blobUrl);
        return cached.blobUrl;
    }

    try {
        let url;
        if (timestamp === 'aktual') {
            url = `https://iradar.app/data/composites/recent/${cfg.pathPrefix}/${cfg.fileNamePrefix}.${prod.suffix}.aktual.dat.gz?v=${new Date().getTime()}`;
        } else {
            // Pel historial, hem de saber el prefix del hash.
            // Cada producte té el seu propi prefix: frcomp + productID + _max2d
            const hashPrefix = prod.crcPrefix || cfg.filePrefix;
            const hash = crc32(hashPrefix + timestamp).substring(0, 6);
            const dia = timestamp.substring(0, 8);
            const hm = timestamp.substring(8, 12);
            url = `https://iradar.app/data/composites/history/${cfg.pathPrefix}/${prod.pathPart}/${dia}/${hm}/${hash}`;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error("HTTP error " + response.status);
        const buffer = await response.arrayBuffer();
        const dataBuffer = buffer.slice(12);

        if (typeof fflate === 'undefined') await cargarScript('https://unpkg.com/fflate');

        const dataArray = fflate.gunzipSync(new Uint8Array(dataBuffer));

        const canvas = document.createElement('canvas');
        canvas.width = cfg.width; canvas.height = cfg.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(cfg.width, cfg.height);

        const lut = getProductLut(currentRadarProProduct);

        for (let i = 0; i < dataArray.length; i++) {
            const byte = dataArray[i];
            const idx = i * 4;
            const lutIdx = byte * 4;
            imgData.data[idx] = lut[lutIdx];
            imgData.data[idx + 1] = lut[lutIdx + 1];
            imgData.data[idx + 2] = lut[lutIdx + 2];
            imgData.data[idx + 3] = lut[lutIdx + 3];
        }

        ctx.putImageData(imgData, 0, 0);

        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                const blobUrl = URL.createObjectURL(blob);
                cache.set(cacheKey, { blobUrl, rawData: dataArray });
                if (!isPrefetch) proRadarLayers[radarKey].setUrl(blobUrl);
                resolve(blobUrl);
            });
        });
    } catch (err) {
        console.error(`Error carregant PRO radar ${radarKey} (${currentRadarProProduct}):`, err);
    }
}

// Funció per a la precàrrega bidireccional unificada
async function handleProRadarPrefetch(radarKey, currentIdx) {
    if (!range_values || !range_values.length) return;

    let direction = 1;
    const scrollKey = `_prev${radarKey}RangeValue`;
    if (window[scrollKey] !== undefined) {
        if (currentIdx < window[scrollKey]) direction = -1;
    }
    window[scrollKey] = currentIdx;

    for (let i = 1; i <= 5; i++) {
        const nextIdx = currentIdx + (i * direction);
        if (nextIdx >= 0 && nextIdx < range_values.length) {
            const r = range_values[nextIdx];
            if (r.timestamp && !proRadarCache[radarKey].has(r.timestamp)) {
                updateProRadar(radarKey, r.timestamp, true);
            }
        }
    }
}

// ===================================================================
// PANELL DE CONTROL RADAR PRO (Variable Selector)
// ===================================================================

const radarProPanel = document.createElement('div');
radarProPanel.id = 'radar-pro-panel';
radarProPanel.style.cssText = `
    position: absolute;
    top: 85px;
    right: 15px;
    background: rgba(15, 15, 20, 0.6);
    backdrop-filter: blur(15px);
    -webkit-backdrop-filter: blur(15px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 12px;
    z-index: 1000;
    display: none;
    flex-direction: column;
    gap: 6px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    min-width: 180px;
    font-family: 'Outfit', sans-serif;
    color: white;
`;
document.body.appendChild(radarProPanel);

function updateRadarProPanel() {
    const activeKey = Object.keys(proRadarLayers).find(key => map.hasLayer(proRadarLayers[key]));
    if (!activeKey) {
        radarProPanel.style.display = 'none';
        return;
    }

    const cfg = RADAR_PRO_CONFIG[activeKey];
    radarProPanel.style.display = 'flex';
    radarProPanel.innerHTML = `
        <div style="font-size: 10px; opacity: 0.5; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700;">Variable Radar PRO</div>
    `;

    cfg.availableProducts.forEach(prodId => {
        const prod = RADAR_PRO_PRODUCTS[prodId];
        const isActive = currentRadarProProduct === prodId;
        const btn = document.createElement('div');
        btn.className = 'radar-pro-product-btn';
        btn.style.cssText = `
            padding: 8px 12px;
            background: ${isActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.03)'};
            border: 1px solid ${isActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.1)'};
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s ease;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: ${isActive ? '#00E5FF' : 'rgba(255,255,255,0.9)'};
        `;
        btn.innerHTML = `
            <span style="font-weight: ${isActive ? '600' : '400'}">${prod.name}</span>
            <span style="font-size: 10px; opacity: 0.5;">${prod.unit}</span>
        `;
        btn.onmouseover = () => { if (!isActive) btn.style.background = 'rgba(255,255,255,0.08)'; };
        btn.onmouseout = () => { if (!isActive) btn.style.background = 'rgba(255,255,255,0.03)'; };
        btn.onclick = () => {
            currentRadarProProduct = prodId;
            updateRadarProPanel();
            updateProRadar(activeKey);
            // Si hi ha cache, la càrrega és instantània, si no, es baixarà el nou producte
        };
        radarProPanel.appendChild(btn);
    });
}

// Listeners d'activació i sincronització amb el slider
Object.keys(proRadarLayers).forEach(key => {
    proRadarLayers[key].on('add', () => {
        updateProRadar(key);
        updateRadarProPanel();
    });
    proRadarLayers[key].on('remove', () => {
        updateRadarProPanel();
    });
    proRadarLayers[key].on('add remove', reconfigureTimeSliderAsync);
});

// ===================================================================
// EINA D'INSPECCIÓ DE DADES (dBZ HUD) - VERSIÓ ROBUSTA
// ===================================================================

const dbzTooltip = document.createElement('div');
dbzTooltip.id = 'radar-dbz-tooltip';
dbzTooltip.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: rgba(15, 15, 20, 0.6);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 5px 10px;
    color: #FFFFFF;
    font-family: 'Outfit', sans-serif;
    font-size: 16px;
    font-weight: 500;
    z-index: 100000;
    display: none;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
    white-space: nowrap;
`;
document.body.appendChild(dbzTooltip);

const crosshairEl = document.createElement('div');
crosshairEl.style.cssText = `
    position: fixed;
    pointer-events: none;
    width: 31px;
    height: 31px;
    z-index: 100000;
    display: none;
`;
crosshairEl.innerHTML = `
    <div style="position:absolute; top:15px; left:0; width:31px; height:0.5px; background:rgba(255,255,255,0.4);"></div>
    <div style="position:absolute; top:0; left:15px; width:0.5px; height:31px; background:rgba(255,255,255,0.4);"></div>
`;
document.body.appendChild(crosshairEl);

function updateRadarInspector(e) {
    // 1. Busquem quina capa de radar PRO està activa ara mateix
    let activeKey = null;
    for (const key in proRadarLayers) {
        if (map.hasLayer(proRadarLayers[key])) {
            activeKey = key;
            break;
        }
    }

    if (!activeKey) {
        dbzTooltip.style.display = 'none';
        crosshairEl.style.display = 'none';
        map.getContainer().style.cursor = '';
        return;
    }

    const cfg = RADAR_PRO_CONFIG[activeKey];
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const b = cfg.bounds;

    // 2. Verifiquem límits geogràfics
    if (lat < b[1][0] || lat > b[0][0] || lng < b[0][1] || lng > b[1][1]) {
        dbzTooltip.style.display = 'none';
        crosshairEl.style.display = 'none';
        map.getContainer().style.cursor = '';
        return;
    }

    // 3. Forcem el cursor crosshair
    map.getContainer().style.cursor = 'crosshair';

    // 4. Obtenim el frame actual
    const currentIdx = parseInt(range_element.value);
    if (isNaN(currentIdx) || !range_values[currentIdx]) return;
    const timestamp = range_values[currentIdx].timestamp;
    if (!timestamp) return;

    const cacheKey = `${timestamp}_${currentRadarProProduct}`;
    const cached = proRadarCache[activeKey].get(cacheKey);
    if (!cached || !cached.rawData) {
        dbzTooltip.style.display = 'none';
        crosshairEl.style.display = 'none';
        return;
    }

    // 5. Mapeig de píxel d'alta precisió usant Leaflet
    const layer = proRadarLayers[activeKey];
    const imageElement = layer._image;
    if (!imageElement) return;

    // Traduïm a coordenades de la imatge original basant-nos en els bounds de la config
    const bounds = cfg.bounds; // [[N, W], [S, E]]
    const latRange = bounds[0][0] - bounds[1][0];
    const lngRange = bounds[1][1] - bounds[0][1];

    const localRelX = (e.latlng.lng - bounds[0][1]) / lngRange;
    const localRelY = (bounds[0][0] - e.latlng.lat) / latRange;

    let x = Math.floor(localRelX * cfg.width);
    let y = Math.floor(localRelY * cfg.height);

    // CORRECCIÓ PER A FRANÇA: Gairebé sempre venen invertides verticalment
    if (activeKey === 'frcomp') {
        y = cfg.height - 1 - y;
    }

    if (x >= 0 && x < cfg.width && y >= 0 && y < cfg.height) {
        const pixelIdx = (y * cfg.width) + x;
        const byte = cached.rawData[pixelIdx];

        // DEBUG: Descomenta la línia següent per veure què llegeix el punter
        // console.log(`Radar Inspector (${activeKey}): x=${x}, y=${y}, byte=${byte}, totalSize=${cached.rawData.length}`);

        // Filtrem buits i màscares (0 o 255)
        if (byte === 0 || byte === 255 || byte === undefined) {
            dbzTooltip.style.display = 'none';
            crosshairEl.style.display = 'none';
            return;
        }

        const prod = RADAR_PRO_PRODUCTS[currentRadarProProduct];
        const val = prod.calc(byte);

        // Actualitzem posició i contingut del HUD (Dark Crystal)
        dbzTooltip.style.display = 'block';
        dbzTooltip.style.left = (e.originalEvent.clientX + 18) + 'px';
        dbzTooltip.style.top = (e.originalEvent.clientY - 12) + 'px';

        dbzTooltip.innerHTML = `
            <span style="font-weight:600;">${val.toFixed(val < 10 && val % 1 !== 0 ? 1 : 0)}</span>
            <span style="font-size:11px; opacity:0.5; font-weight:400; margin-left:3px; color:#00E5FF;">${prod.unit}</span>
        `;

        // Actualitzem Creu
        crosshairEl.style.display = 'block';
        crosshairEl.style.left = (e.originalEvent.clientX - 15) + 'px';
        crosshairEl.style.top = (e.originalEvent.clientY - 15) + 'px';
    } else {
        dbzTooltip.style.display = 'none';
        crosshairEl.style.display = 'none';
    }
}

// Assignem els esdeveniments al mapa de forma global
map.on('mousemove', updateRadarInspector);
map.on('mouseout', () => {
    dbzTooltip.style.display = 'none';
    crosshairEl.style.display = 'none';
    map.getContainer().style.cursor = '';
});

// ===================================================================
// NOVA FUNCIÓ GENÈRICA PER CREAR QUALSEVOL RADAR AMB GRAELLA
// ===================================================================
function crearGraellaRadar(imageUrl, boundsUTM, capaDeDesti) {
    if (cappiCache.has(imageUrl)) {
        const capesGuardades = cappiCache.get(imageUrl);
        capaDeDesti.clearLayers();
        capesGuardades.forEach(layer => capaDeDesti.addLayer(layer));
        return;
    }

    const divisionsX = 12;
    const divisionsY = 12;
    const marginPixels = 2;

    const ampleUTM = boundsUTM.maxX - boundsUTM.minX;
    const altUTM = boundsUTM.maxY - boundsUTM.minY;

    const capesDelsTrossets = [];
    const fontImatge = new Image();
    fontImatge.crossOrigin = "Anonymous";

    fontImatge.onload = function () {
        const ampleImatgeOriginal = fontImatge.width;
        const altImatgeOriginal = fontImatge.height;

        const getUTM = (pX, pY) => {
            const x = boundsUTM.minX + (pX / ampleImatgeOriginal) * ampleUTM;
            const y = boundsUTM.minY + ((altImatgeOriginal - pY) / altImatgeOriginal) * altUTM;
            return [x, y];
        };

        for (let i = 0; i < divisionsX; i++) {
            for (let j = 0; j < divisionsY; j++) {
                const sx_orig = Math.round((i / divisionsX) * ampleImatgeOriginal);
                const sy_orig = Math.round((j / divisionsY) * altImatgeOriginal);
                const sw_orig = Math.round(((i + 1) / divisionsX) * ampleImatgeOriginal) - sx_orig;
                const sh_orig = Math.round(((j + 1) / divisionsY) * altImatgeOriginal) - sy_orig;

                const sx = Math.max(0, sx_orig - marginPixels);
                const sy = Math.max(0, sy_orig - marginPixels);
                const sWidth = Math.min(ampleImatgeOriginal - sx, (sx_orig + sw_orig + marginPixels) - sx);
                const sHeight = Math.min(altImatgeOriginal - sy, (sy_orig + sh_orig + marginPixels) - sy);

                if (sWidth <= 0 || sHeight <= 0) continue;

                const utmSW = getUTM(sx, sy + sHeight);
                const utmNE = getUTM(sx + sWidth, sy);

                const sw = proj4('EPSG:25831', 'EPSG:4326').forward(utmSW);
                const ne = proj4('EPSG:25831', 'EPSG:4326').forward(utmNE);
                const boundsWGS84 = L.latLngBounds(L.latLng(sw[1], sw[0]), L.latLng(ne[1], ne[0]));

                const canvasTros = document.createElement('canvas');
                canvasTros.width = sWidth;
                canvasTros.height = sHeight;
                const ctx = canvasTros.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(fontImatge, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

                // --- FILTRE COMARQUES (Protegit per si hi ha errors de CORS) ---
                try {
                    const imageData = ctx.getImageData(0, 0, sWidth, sHeight);
                    const pix = imageData.data;
                    let modified = false;
                    for (let k = 0; k < pix.length; k += 4) {
                        if (pix[k + 3] > 0 && pix[k] < 35 && pix[k + 1] < 35 && pix[k + 2] < 35) {
                            pix[k + 3] = 0;
                            modified = true;
                        }
                    }
                    if (modified) ctx.putImageData(imageData, 0, 0);
                } catch (e) {
                    // Si falla per CORS, no fem res i deixem la teula tal qual
                }

                const layerTros = L.imageOverlay(canvasTros.toDataURL(), boundsWGS84, {
                    opacity: 0.85,
                    interactive: false,
                    pane: 'radarPane',
                    className: 'pixelated-image'
                });

                capesDelsTrossets.push(layerTros);
            }
        }

        cappiCache.set(imageUrl, capesDelsTrossets);
        capaDeDesti.clearLayers();
        capesDelsTrossets.forEach(layer => capaDeDesti.addLayer(layer));
    };

    fontImatge.onerror = function () {
        console.error("Error carregant imatge radar:", imageUrl);
    };

    // Proxy HTTPS per evitar Mixed Content
    fontImatge.src = `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}`;
}


// --- Dades per al radar "CAPPI intern" ---
const CAPPI_BOUNDS_UTM = {
    minX: 245124.0621, minY: 4468639.7120,
    maxX: 552818.0685, maxY: 4767102.8982
};
const initialCappiUrl = 'http://www.meteocatclients.com/webs_clients/radar/images/cappi250_catalunya_10dBZ/cappi250_catalunya_10dBZ_20250907133007.png';
const cappi_intern_layer = L.layerGroup(); // Es declara com un grup buit
cappi_intern_layer.on('add remove', reconfigureTimeSliderAsync);

// --- Dades per al radar "Llarg abast intern" ---
const CAPPI_LLARG_ABAST_BOUNDS_UTM = {
    minX: 109256.0862, minY: 4307260.3859,
    maxX: 783956.8089, maxY: 4961720.0869
};
const initialCappiLlargAbastUrl = 'http://www.meteocatclients.com/webs_clients/radar/images/cappi250_llarg_abast_10dBZ/cappi250_llarg_abast_10dBZ_20250909141206.png';
const cappi_llarg_abast_layer = L.layerGroup(); // Es declara com un grup buit
cappi_llarg_abast_layer.on('add remove', reconfigureTimeSliderAsync);


// --- Càrrega inicial de les imatges per defecte ---
// Cridem la funció genèrica 'crearGraellaRadar' per a cada capa
crearGraellaRadar(initialCappiUrl, CAPPI_BOUNDS_UTM, cappi_intern_layer);
crearGraellaRadar(initialCappiLlargAbastUrl, CAPPI_LLARG_ABAST_BOUNDS_UTM, cappi_llarg_abast_layer);

// ===================================================================
// FINAL DEL NOU BLOC CORRECTE
// ===================================================================

// Aquesta línia s'ha de cridar DESPRÉS que totes les capes necessàries

// REEMPLAÇA EL TEU BLOC 'range_element.addEventListener' SENCER PER AQUEST

range_element.addEventListener('input', () => {
    // La lògica per a les capes de tiles (amb .refresh())
    timeDependentLayers.forEach(layer => {
        if (map.hasLayer(layer) && typeof layer.refresh === 'function') {
            layer.refresh();
        }
    });

    // Ara, la lògica per a les nostres capes de graella
    if (range_values.length > 0 && range_element.value < range_values.length) {
        const novaUrl = range_values[range_element.value].url;
        if (novaUrl) {
            if (map.hasLayer(cappi_intern_layer)) {
                // Si la capa activa és la interna, cridem la funció amb les seves dades
                crearGraellaRadar(novaUrl, CAPPI_BOUNDS_UTM, cappi_intern_layer);
            } else if (map.hasLayer(cappi_llarg_abast_layer)) {
                // Si la capa activa és la de llarg abast, cridem la funció amb les seves dades
                crearGraellaRadar(novaUrl, CAPPI_LLARG_ABAST_BOUNDS_UTM, cappi_llarg_abast_layer);
            }
        }

        // Lògica per als radars PRO
        const activeProRadar = Object.keys(proRadarLayers).find(key => map.hasLayer(proRadarLayers[key]));
        if (activeProRadar) {
            const r = range_values[range_element.value];
            if (r && r.timestamp) {
                updateProRadar(activeProRadar, r.timestamp);
                handleProRadarPrefetch(activeProRadar, parseInt(range_element.value));
            }
        }
    }



    // ESTIL ADVECCIÓ: Gradient Slider (Fix + Redesign)
    const r = range_values[range_element.value];

    // Reset standard styles first
    range_element.style.background = '';

    if (range_values.length > 1) {
        // Find index where advection starts
        const advectionStartIndex = range_values.findIndex(item => item.isAdvection);

        if (advectionStartIndex !== -1) {
            const currentMin = parseInt(range_element.min) || 0;
            const currentMax = parseInt(range_element.max) || (range_values.length - 1);

            // Calculem el percentatge relatiu al visor actual del slider
            let percent = ((advectionStartIndex - currentMin) / (currentMax - currentMin)) * 100;
            percent = Math.max(0, Math.min(100, percent)); // Clamping

            range_element.style.setProperty('background', `linear-gradient(to right, #e0e0e0 0%, #e0e0e0 ${percent}%, #ffcdd2 ${percent}%, #ffcdd2 100%)`, 'important');
        }
    }

    if (r && r.isAdvection) {
        // Handle color (Red) is handled by accent-color mostly
        range_element.style.accentColor = '#ff5252';
    } else {
        range_element.style.accentColor = '';
    }

    setDateText(r);
});




// ===================================================================
// INTEGRACIÓ RADAR ACA (WMS)
// ===================================================================

let acaRadarAvailability = null;

async function fetchAcaAvailability() {
    try {
        const response = await fetch('https://aplicacions.aca.gencat.cat/aetr/vishid/v2/summary/radar_instants?_=' + Date.now());
        acaRadarAvailability = await response.json();
        console.log("Disponibilitat Radar ACA carregada:", acaRadarAvailability);
    } catch (e) {
        console.error("No s'ha pogut carregar la disponibilitat del Radar ACA", e);
    }
}
// Carreguem la disponibilitat a l'inici
fetchAcaAvailability();

// Classe personalitzada per gestionar la sincronització de temps del WMS de l'ACA
L.TileLayer.WMS.ACA = L.TileLayer.WMS.NoFlicker.extend({
    initialize: function (url, options) {
        L.TileLayer.WMS.prototype.initialize.call(this, url, options);
        this.acaType = options.acaType; // ex: 'accumulation_1h'
    },

    onAdd: function (map) {
        L.TileLayer.WMS.prototype.onAdd.call(this, map);
        this.refresh(); // Pintar inicialment

        // AFEGIT: Gestió del clic per obtenir informació (GetFeatureInfo)
        if (!this._map) return;

        this._map.on('click', this._getFeatureInfo, this);
    },

    onRemove: function (map) {
        L.TileLayer.WMS.prototype.onRemove.call(this, map);
        if (this._map) {
            this._map.off('click', this._getFeatureInfo, this);
        }
    },

    refresh: function () {
        if (!acaRadarAvailability || !this.acaType) {
            console.warn(`[ACA DEBUG] Missing availability (${!!acaRadarAvailability}) or type (${this.acaType})`);
            return;
        }

        const slider = document.getElementById('range-slider');
        if (!slider || !range_values || !range_values[slider.value]) {
            console.warn("[ACA DEBUG] Slider or range_values missing");
            return;
        }

        const currentVisorTime = range_values[slider.value].utctime;

        // 1. Busquem el timestamp més proper disponible al JSON
        const availableTimestamps = acaRadarAvailability[this.acaType];
        if (!availableTimestamps) {
            console.warn(`[ACA DEBUG] No timestamps for type ${this.acaType}`);
            return;
        }

        // Obtenim totes les dates disponibles com a timestamps numèrics
        const availableDates = Object.keys(availableTimestamps).map(d => new Date(d).getTime());

        if (availableDates.length === 0) return;

        // Funció per trobar el més proper
        const closest = availableDates.reduce((prev, curr) => {
            return (Math.abs(curr - currentVisorTime) < Math.abs(prev - currentVisorTime) ? curr : prev);
        });

        // Comprovem si la diferència és acceptable (ex: màxim 15 minuts de desfasament)
        const diffMinutes = Math.abs(closest - currentVisorTime) / (1000 * 60);

        console.log(`[ACA DEBUG] Type: ${this.acaType} | Visor: ${new Date(currentVisorTime).toISOString()} | Closest: ${new Date(closest).toISOString()} | Diff: ${diffMinutes.toFixed(1)}m`);

        // Si la diferència és massa gran (>40 min), potser és millor no mostrar res o mostrar l'últim
        if (diffMinutes < 40) {
            const targetIso = new Date(closest).toISOString();
            // Cridem al mètode refresh de NoFlicker en lloc de setParams
            L.TileLayer.WMS.NoFlicker.prototype.refresh.call(this, targetIso);
            this.setOpacity(this.options.opacity || 0.7);
        } else {
            console.log(`[ACA DEBUG] Diff too large (${diffMinutes}m), hiding layer.`);
            // this.setOpacity(0);
        }
    },

    _getFeatureInfo: function (evt) {
        // Només si la capa és visible
        if (!this._map || !this._map.hasLayer(this)) return;

        // Si és un esdeveniment de clic
        if (evt.type === 'click') {
            const url = this.getFeatureInfoUrl(evt.latlng);
            console.log("[ACA DEBUG] FeatureInfo URL:", url);

            if (url) {
                // Fem la petició
                fetch(url)
                    .then(response => response.text()) // Demanem TEXT per gestionar XML o JSON
                    .then(text => {
                        try {
                            const data = JSON.parse(text);
                            this._showFeatureInfo(evt.latlng, data);
                        } catch (e) {
                            // Si falla JSON, assumim XML
                            this._parseXMLFeatureInfo(evt.latlng, text);
                        }
                    })
                    .catch(err => {
                        console.error("[ACA DEBUG] Error fetching FeatureInfo:", err);
                    });
            }
        }
    },

    _parseXMLFeatureInfo: function (latlng, xmlText) {
        // console.log("[ACA DEBUG] RAW XML:", xmlText); 
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");

            // CAS 1: Estructura WFS (scpah:GRAY_INDEX)
            const grayIndexNodes = xmlDoc.getElementsByTagNameNS("*", "GRAY_INDEX");
            if (grayIndexNodes.length > 0) {
                const val = grayIndexNodes[0].textContent;
                this._showFeatureInfo(latlng, { features: [{ properties: { gray_index: val } }] });
                return;
            }

            // CAS 1B: Detectar resposta buida (Sense dades)
            // <wfs:FeatureCollection ...><gml:boundedBy><gml:null>unknown</gml:null></gml:boundedBy></wfs:FeatureCollection>
            const featureMembers = xmlDoc.getElementsByTagNameNS("*", "featureMember");
            if (featureMembers.length === 0 && xmlDoc.getElementsByTagName("FeatureCollection").length > 0) {
                // És una resposta vàlida però buida -> Sense precipitació detectable
                console.log("ACA: Resposta buida (Sense dades en aquest punt)");
                // Opcional: Mostrar popup que digui "Sense dades" o simplement no fer res.
                // this._showFeatureInfo(latlng, { features: [{ properties: { value: "0" } }] }); // Si volem mostrar 0
                return;
            }

            // CAS 2: Estructura FIELDS (Geoserver clàssic)
            const fields = xmlDoc.getElementsByTagName('FIELDS');
            if (fields.length > 0) {
                const attributes = fields[0].attributes;
                const props = {};
                for (let i = 0; i < attributes.length; i++) {
                    props[attributes[i].name] = attributes[i].value;
                }
                this._showFeatureInfo(latlng, { features: [{ properties: props }] });
            }
        } catch (e) {
            console.error("[ACA DEBUG] Error parsing XML:", e);
        }
    },

    getFeatureInfoUrl: function (latlng) {
        // Construcció manual de la URL GetFeatureInfo URL
        const point = this._map.latLngToContainerPoint(latlng, this._map.getZoom());
        const size = this._map.getSize();


        // CALCULEM EL BBOX EN EPSG:3857 (Projecció del mapa)
        const bounds = this._map.getBounds();
        const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
        const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());

        // WMS standard bbox order: minx, miny, maxx, maxy
        const bbox = `${sw.x},${sw.y},${ne.x},${ne.y}`;

        const params = {
            request: 'GetFeatureInfo',
            service: 'WMS',
            SRS: 'EPSG:3857', // Fem servir la mateixa projecció que les teules
            styles: this.wmsParams.styles,
            transparent: this.wmsParams.transparent,
            version: this.wmsParams.version,
            format: this.wmsParams.format,
            bbox: bbox, // BBOX correcte en metres
            height: size.y,
            width: size.x,
            layers: this.wmsParams.layers,
            query_layers: this.wmsParams.layers,
            // Canviem a text/xml si l'usuari veu errors XML, però mantenim la lògica
            info_format: 'text/xml',
            x: Math.round(point.x),
            y: Math.round(point.y),
            time: this.wmsParams.time // Important: el temps actual
        };

        return this._url + L.Util.getParamString(params, this._url, true);
    },


    _showFeatureInfo: function (latlng, data) {
        if (!data || !data.features || data.features.length === 0) return;

        const feature = data.features[0];
        const props = feature.properties;
        let rawValue = props.GRAY_INDEX || props.gray_index || props.value || props.quantity;

        if (rawValue === undefined || rawValue === null) return;

        let numValue = parseFloat(rawValue);
        let formattedValue = isNaN(numValue) ? rawValue : numValue.toFixed(1);

        let title = "Dada Radar";
        let timeLabel = "";
        if (this.acaType.includes("accumulation")) {
            const h = this.acaType.replace("accumulation_", "");
            title = `Acumulació (${h})`;
        } else if (this.acaType.includes("rain_rate")) {
            title = "Intensitat";
        }

        if (this.wmsParams.time) {
            const d = new Date(this.wmsParams.time);
            timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }

        // Creem element DOM per poder afegir listeners
        const container = document.createElement('div');
        container.style.cssText = "font-family: inherit; min-width: 120px; text-align: center;";

        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = "font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 2px;";
        titleDiv.innerText = title;
        container.appendChild(titleDiv);

        const valueDiv = document.createElement('div');
        valueDiv.style.cssText = "font-size: 22px; font-weight: 700; color: #111; margin: 4px 0;";
        valueDiv.innerHTML = `${formattedValue} mm`;
        container.appendChild(valueDiv);

        const timeDiv = document.createElement('div');
        timeDiv.style.cssText = "font-size: 11px; color: #666; margin-bottom: 8px;";
        timeDiv.innerText = timeLabel ? `${timeLabel} h` : '';
        container.appendChild(timeDiv);

        const btnDiv = document.createElement('div');
        btnDiv.style.cssText = "border-top: 1px solid #eee; padding-top: 6px; margin-top: 4px;";

        const btn = document.createElement('button');
        btn.innerText = "Veure Evolució";
        btn.style.cssText = "background: #f8f9fa; border: 1px solid #ddd; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; color: #333; transition: all 0.2s;";
        btn.onmouseover = () => { btn.style.background = "#e9ecef"; };
        btn.onmouseout = () => { btn.style.background = "#f8f9fa"; };
        btn.onclick = (e) => {
            e.stopPropagation(); // Evitem que el click afecti al mapa
            this._showHistoryChart(latlng);
        };

        btnDiv.appendChild(btn);
        container.appendChild(btnDiv);

        L.popup({
            minWidth: 120,
            className: 'aca-popup'
        })
            .setLatLng(latlng)
            .setContent(container)
            .openOn(this._map);
    },

    _showHistoryChart: async function (latlng) {
        // 1. Preparem el modal
        const modalId = 'aca-chart-modal';
        let modal = document.getElementById(modalId);
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = modalId;
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 90%; max-width: 600px; background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 10000; padding: 20px; font-family: 'Inter', sans-serif;
            border: 1px solid rgba(255,255,255,0.5);
        `;

        // Header amb botó de tancar
        const header = document.createElement('div');
        header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;";
        header.innerHTML = `<h3 style="margin:0; font-size: 16px; color:#333;">Evolució Temporal (${this.acaType})</h3>`;

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = "background:none; border:none; font-size: 24px; cursor:pointer; color:#666;";
        closeBtn.onclick = () => modal.remove();
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Canvas per al gràfic
        const canvasContainer = document.createElement('div');
        canvasContainer.style.cssText = "position: relative; height: 300px; width: 100%;";
        const canvas = document.createElement('canvas');
        canvasContainer.appendChild(canvas);
        modal.appendChild(canvasContainer);

        // Spinner de càrrega
        const loader = document.createElement('div');
        loader.innerText = "Carregant dades històriques...";
        loader.style.cssText = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #666;";
        canvasContainer.appendChild(loader);

        document.body.appendChild(modal);

        // 2. Obtenim els timestamps disponibles
        const availableTimestamps = acaRadarAvailability && acaRadarAvailability[this.acaType];
        if (!availableTimestamps) {
            loader.innerText = "No hi ha dades històriques disponibles.";
            return;
        }

        // Agafem les últimes 24 hores (o 24 passos) per no fer massa peticions
        const dates = Object.keys(availableTimestamps).sort();
        const selectedDates = dates.slice(-24); // Últims 24 passos

        // 3. Fem les peticions fetch en paral·lel
        const requests = selectedDates.map(dateStr => {
            // Clonem els paràmetres actuals però canviem el temps
            const tempParams = { ...this.wmsParams, time: new Date(dateStr).toISOString() };

            // Construcció URL manual
            const point = this._map.latLngToContainerPoint(latlng, this._map.getZoom());
            const size = this._map.getSize();
            const bounds = this._map.getBounds();
            const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
            const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
            const bbox = `${sw.x},${sw.y},${ne.x},${ne.y}`;

            const params = {
                request: 'GetFeatureInfo',
                service: 'WMS',
                SRS: 'EPSG:3857',
                styles: tempParams.styles,
                transparent: tempParams.transparent,
                version: tempParams.version,
                format: tempParams.format,
                bbox: bbox,
                height: size.y,
                width: size.x,
                layers: tempParams.layers,
                query_layers: tempParams.layers,
                info_format: 'text/xml',
                x: Math.round(point.x),
                y: Math.round(point.y),
                time: tempParams.time
            };

            const url = this._url + L.Util.getParamString(params, this._url, true);

            return fetch(url)
                .then(r => r.text())
                .then(text => {
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(text, "text/xml");
                    const node = xmlDoc.getElementsByTagNameNS("*", "GRAY_INDEX")[0];
                    let val = node ? parseFloat(node.textContent) : 0;
                    return { time: new Date(dateStr), value: val };
                })
                .catch(() => ({ time: new Date(dateStr), value: null }));
        });

        try {
            const results = await Promise.all(requests);
            loader.remove(); // Treiem spinner

            // 4. Dibuixem el gràfic amb Chart.js
            const ctx = canvas.getContext('2d');

            const labels = results.map(r => r.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            const values = results.map(r => r.value);

            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Precipitació (mm)',
                        data: values,
                        borderColor: '#007bff',
                        backgroundColor: 'rgba(0, 123, 255, 0.1)',
                        borderWidth: 2,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: 'rgba(0,0,0,0.05)' }
                        },
                        x: {
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                        }
                    }
                }
            });

        } catch (err) {
            console.error(err);
            loader.innerText = "Error carregant dades.";
        }
    }
});

// Configuració de totes les capes que volem afegir
const acaLayersConfig = [
    { name: "Intensitat (Rain Rate)", type: "rain_rate" },
    { name: "Acumulació 30 min", type: "accumulation_30min" },
    { name: "Acumulació 1h", type: "accumulation_1h" },
    { name: "Acumulació 3h", type: "accumulation_3h" },
    { name: "Acumulació 6h", type: "accumulation_6h" },
    { name: "Acumulació 12h", type: "accumulation_12h" },
    { name: "Acumulació 24h", type: "accumulation_24h" },
    { name: "Acumulació 48h", type: "accumulation_48h" },
    { name: "Acumulació 72h", type: "accumulation_72h" },
    { name: "Acumulació 96h", type: "accumulation_96h" }
];

const aca_layers = {};
acaLayersConfig.forEach(cfg => {
    aca_layers[cfg.name] = new L.TileLayer.WMS.ACA("https://aplicacions.aca.gencat.cat/geoserver/wms?", {
        layers: `scpah:${cfg.type}`,
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        acaType: cfg.type,
        opacity: 0.7,
        pane: 'radarPane'
    });
    // IMPORTANT: Connectar al sistema de temps per recalcular el slider quan s'activa/desactiva
    aca_layers[cfg.name].on('add remove', reconfigureTimeSliderAsync);
});

// Poblament de les capes depenents del temps (ja declarades a dalt)
timeDependentLayers = [
    plujaneu_layer,
    radar_layer,
    rainviewer_layer,
    ...Object.values(proRadarLayers), // Totes les capes PRO són temporals
    windy_radar_layer,
    meteofrance_radar_layer,
    cappi_intern_layer,
    cappi_llarg_abast_layer,
    ...Object.values(satelliteMenuLayers),
    ...Object.values(aca_layers)
];

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
    "Meteocat": L.tileLayer.meteocat({ // <<< Canvi important aquí
        attribution: '© <a href="https://meteo.cat">Meteocat</a>',
        minZoom: 7,
        maxZoom: 13
    }),
    "Topografic ICGC": L.tileLayer.wms("https://geoserveis.icgc.cat/servei/catalunya/mapa-base/wms/service?", {
        layers: 'topografic',
        format: 'image/jpeg',
        continuousWorld: true,
        attribution: 'Institut Cartogràfic i Geològic de Catalunya',
    }),
    "Lidar": L.tileLayer.wms("https://wms-mapa-lidar.idee.es/lidar?", {
        layers: 'EL.GridCoverage',
        format: 'image/jpeg',
        crs: L.CRS.EPSG3857,
        continuousWorld: true,
        attribution: 'Instituto Geografico Nacional',
    }),
    // --- Capes JSON de l'ICGC (Mapes Generals) ---
    "ICGC (JSON) Estàndard General": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard_general.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Estàndard Simplificat": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Gris": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC Relleu": L.maplibreGL({
        style: 'full_relleu.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Fosc": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_fosc.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "Relleu maritim": L.maplibreGL({
        style: 'https://api.maptiler.com/maps/019a34ee-839d-7829-aba5-6487053ad71c/style.json?key=sK8w9o9W2AiyAAzvkjBV',
        attribution: '© <a href="https://www.maptiler.com/" target="_blank">MapTiler</a>'
    }),
    // --- Capes JSON de l'ICGC (Mapes d'Imatge) ---
    "ICGC (JSON) Orto Híbrida": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_hibrida.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto Estàndard": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto amb Xarxa Viària": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_xarxa_viaria.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto Estàndard Gris": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),

    // --- Capes JSON de l'ICGC (Mapes Administratius) ---
    "ICGC (JSON) Delimitació Estàndard": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Delimitació Gris": L.maplibreGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Límits Administratius": L.maplibreGL({
        style: 'relleu_comarques.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "Base Meteocat (JSON)": L.maplibreGL({
        style: 'meteocat.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "Base Relleu - Color": L.maplibreGL({
        style: 'icgc_ombra_hipsometria.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
};

// Controla el zoom només per a la capa Meteocat
function updateZoomRestrictions() {
    if (map.hasLayer(baseLayers.Meteocat)) {
        // Apliquem els nous límits de zoom per a la capa de Meteocat
        map.options.minZoom = 7;
        map.options.maxZoom = 13; // Canviat de 12 a 13
        // Ajustem el zoom actual si queda fora dels nous límits
        map.setZoom(Math.max(7, Math.min(13, map.getZoom())));
    } else {
        // Per a la resta de capes, restaurem el zoom per defecte
        map.options.minZoom = 1;
        map.options.maxZoom = 18;
    }
}

map.on('baselayerchange', updateZoomRestrictions);
baseLayers["ICGC (JSON) Límits Administratius"].addTo(map);

// Capa WMS ICGC Allaus (Desactivada per usar la nostra visualització pròpia)
/*
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
*/
// Ara wmsLayer serà el contenidor (Grup) de la nostra capa personalitzada (GeoJSON + Icones)
// Això permet activar-la/desactivar-la des del control de capes "Informació Geogràfica" existent.
const wmsLayer = L.layerGroup();

// ==========================================
// TRIGGER PER A ZONES D'ALLAUS (LAYER CONTROL)
// ==========================================
map.on('overlayadd', function (e) {
    if (e.name === "Zones Perill Allaus") {
        console.log("Activada capa Zones Perill Allaus via Layer Control...");
        displayAllausZones();
    }
});

// Capa de comarques
var comarquesLayer = L.geoJSON(comarquesGeojson, {
    pane: 'limitPane',
    style: function () {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return { color: isDark ? "#ffffff" : "#262626", weight: 1, fill: false };
    }
});
comarquesLayer.addTo(map);

// Capa de municipis
var municipisGeojsonLayer = L.geoJSON(municipisGeojson, {
    pane: 'limitPane',
    style: { color: "#4F4F4F", weight: 1.2, fill: false }
});

// Capa de països del món (amb detall)
var monLayer = L.geoJSON(monGeojson, {
    pane: 'limitPane',
    style: {
        color: "#ffffff", // Color de la línia (blanc)
        weight: 1.5,       // Gruix de la línia
        fill: false,       // Sense farciment
        opacity: 0.7       // Opacitat de la línia
    }
});

// Capa de mon
var contornMonGeolayer = L.geoJSON(contornMonGeojson, {
    style: { color: "#ffffffff", weight: 1, fill: false }
});

// ===================================================================
// REVOLUCIÓ 2025: SISTEMA DE CÀMERES INTEL·LIGENT
// ===================================================================

// 1. Creem la capa buida
const advancedCamerasLayer = L.layerGroup();

// 2. Icona del punter (Pots personalitzar-la)
const camIcon = L.divIcon({
    html: '<div style="font-size:22px; filter: drop-shadow(2px 2px 2px rgba(0,0,0,0.5));">📍</div>',
    className: 'marker-custom-cam',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -10]
});

// 3. Funció per extreure l'ID net de la URL de la imatge antiga
function getCamIdFromImage(url) {
    try {
        // Exemple: ".../snapshots/andorralavella-data.jpg" -> "andorralavella"
        const filename = url.split('/').pop();
        return filename.replace('-data.jpg', '').replace('.jpg', '');
    } catch (e) { return null; }
}

// ===================================================================
// 4. GENERACIÓ INTELLIGENT: NOMÉS CÀMERES ACTIVES (ONLINE)
// ===================================================================

// Mapa per controlar quins marcadors tenim pintats actualment (ID -> Marker)
const activeCameraMarkers = new Map();

async function loadActiveWebcams() {
    try {
        // 1. Consultem l'API
        // Afegim un timestamp per evitar que el navegador guardi la resposta en memòria cau
        const response = await fetch(`https://api.projecte4estacions.com/api/sessions?_=${Date.now()}`);
        const sessionData = await response.json();

        // Llistat d'IDs que HAURIEN d'estar al mapa en aquest moment
        const idsQueHaurienDeSerAlMapa = new Set();

        if (typeof webcamPoints !== 'undefined' && Array.isArray(webcamPoints)) {
            webcamPoints.forEach(cam => {
                const cleanId = getCamIdFromImage(cam.image);
                if (!cleanId) return;

                // --- LÒGICA DE FILTRAT ---
                const cameresForcades = ['comadevaca']; // Les teves excepcions
                const estaActiva = sessionData.hasOwnProperty(cleanId);
                const esForcada = cameresForcades.includes(cleanId);

                // Si ha d'aparèixer al mapa
                if (estaActiva || esForcada) {
                    idsQueHaurienDeSerAlMapa.add(cleanId);

                    // CAS A: La càmera ha d'aparèixer però NO la tenim pintada -> LA CREEM
                    if (!activeCameraMarkers.has(cleanId)) {
                        console.log(`🟢 Nova càmera detectada: ${cleanId}`);

                        const streamUrl = `https://api.projecte4estacions.com/live/${cleanId}/live.m3u8`;
                        const marker = L.marker([cam.lat, cam.lon], { icon: camIcon });

                        const popupContent = `
                            <div class="webcam-popup-inner" id="popup-inner-${cleanId}">
                                <div class="webcam-header">${cam.location}</div>
                                <div class="media-container">
                                    <div id="view-live-${cleanId}" class="w-full h-full">
                                        <video id="video-${cleanId}" muted playsinline style="width:100%; height:100%;"></video>
                                    </div>
                                    <div id="view-img-${cleanId}" class="w-full h-full hidden-mode">
                                        <img src="${cam.image}?r=${Date.now()}" alt="${cam.location}">
                                    </div>
                                </div>
                                <div class="webcam-controls">
                                    <button class="webcam-btn active" id="btn-live-${cleanId}" onclick="switchCamMode('${cleanId}', 'live')"><span class="live-dot"></span> Directe</button>
                                    <button class="webcam-btn" id="btn-img-${cleanId}" onclick="switchCamMode('${cleanId}', 'img')">📷 Foto</button>
                                    <button class="webcam-btn" onclick="openBigCam('${cleanId}', '${streamUrl}', '${cam.location.replace(/'/g, "\\'")}')">⤢ Gran</button>
                                </div>
                            </div>
                        `;

                        marker.bindPopup(popupContent, {
                            className: 'leaflet-popup-webcam',
                            minWidth: 420, maxWidth: 450, autoPan: true
                        });

                        // Events del popup (igual que abans)
                        marker.on('popupopen', () => {
                            const container = document.getElementById(`popup-inner-${cleanId}`);
                            if (container) {
                                L.DomEvent.disableClickPropagation(container);
                                L.DomEvent.disableScrollPropagation(container);
                            }
                            const videoEl = document.getElementById(`video-${cleanId}`);
                            if (videoEl && Hls.isSupported()) {
                                const hls = new Hls();
                                hls.loadSource(streamUrl);
                                hls.attachMedia(videoEl);
                                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                                    videoEl.play().catch(e => { });
                                });
                                videoEl.hlsInstance = hls;
                            } else if (videoEl && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
                                videoEl.src = streamUrl;
                                videoEl.play().catch(e => { });
                            }
                        });

                        marker.on('popupclose', () => {
                            const videoEl = document.getElementById(`video-${cleanId}`);
                            if (videoEl && videoEl.hlsInstance) {
                                videoEl.hlsInstance.destroy();
                                delete videoEl.hlsInstance;
                            }
                        });

                        // Afegim a la capa i al nostre registre
                        marker.addTo(advancedCamerasLayer);
                        activeCameraMarkers.set(cleanId, marker);
                    }
                    // CAS B: La càmera ja hi és -> NO FEM RES (així no tallem el vídeo)
                }
            });

            // CAS C: Neteja (Garbage Collection)
            // Si tenim un marcador pintat que JA NO està a la llista d'actius -> L'ESBORREM
            activeCameraMarkers.forEach((marker, id) => {
                if (!idsQueHaurienDeSerAlMapa.has(id)) {
                    console.log(`🔴 Càmera desconnectada: ${id}`);
                    advancedCamerasLayer.removeLayer(marker);
                    activeCameraMarkers.delete(id);
                }
            });
        }
    } catch (error) {
        console.error("❌ Error actualitzant càmeres:", error);
    }
}

// Cridem la funció per iniciar la càrrega
loadActiveWebcams();

// --- FUNCIONS GLOBALS PER CONTROLAR EL POPUP ---

// Canviar entre Foto i Vídeo
window.switchCamMode = function (id, mode) {
    const liveDiv = document.getElementById(`view-live-${id}`);
    const imgDiv = document.getElementById(`view-img-${id}`);
    const btnLive = document.getElementById(`btn-live-${id}`);
    const btnImg = document.getElementById(`btn-img-${id}`);

    // Aturem interacció amb mapa per si de cas
    const container = document.getElementById(`popup-inner-${id}`);
    if (container) L.DomEvent.disableClickPropagation(container);

    if (mode === 'live') {
        liveDiv.classList.remove('hidden-mode');
        imgDiv.classList.add('hidden-mode');
        btnLive.classList.add('active');
        btnImg.classList.remove('active');

        const v = document.getElementById(`video-${id}`);
        if (v) v.play().catch(e => { });
    } else {
        liveDiv.classList.add('hidden-mode');
        imgDiv.classList.remove('hidden-mode');
        btnLive.classList.remove('active');
        btnImg.classList.add('active');
    }
};

// Obre el modal de pantalla gran
window.openBigCam = function (id, url, title) {
    // Tanca el popup petit primer
    map.closePopup();

    const overlay = document.createElement('div');
    overlay.className = 'webcam-modal-overlay';
    overlay.innerHTML = `
        <div style="color:white; margin-bottom:10px; font-size:18px;">${title}</div>
        <video id="big-video-${id}" class="webcam-modal-video" controls autoplay></video>
        <button class="webcam-modal-close" onclick="closeBigCam(this)">Tancar</button>
    `;
    document.body.appendChild(overlay);

    const v = document.getElementById(`big-video-${id}`);
    if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(v);
        v.hlsInstance = hls; // Guardem referència
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
    }
};

// Tanca el modal
window.closeBigCam = function (btn) {
    const overlay = btn.parentElement;
    const v = overlay.querySelector('video');
    if (v && v.hlsInstance) {
        v.hlsInstance.destroy();
    }
    document.body.removeChild(overlay);
};


// Capa WMS Xarxa Hidrogràfica
const xarxaHidrograficaLayer = L.tileLayer.wms("https://aplicacions.aca.gencat.cat/geoserver/wms?", {
    layers: 'Xarxa_hidrografica',
    format: 'image/png',
    transparent: true,
    version: '1.1.1',
    attribution: '© <a href="https://www.aca.gencat.cat/">ACA</a>',
    opacity: 0.7
});

// ★★★ VERSIÓ FINAL I NETA DE LA CAPA D'ACTUACIONS URGENTS ★★★
const actuacionsUrgentsLayer = L.esri.featureLayer({
    url: 'https://services7.arcgis.com/ZCqVt1fRXwwK6GF4/ArcGIS/rest/services/ACTUACIONS_URGENTS_online_PRO_AMB_FASE_VIEW/FeatureServer/0',

    pointToLayer: function (geojson, latlng) {
        const fase = geojson.properties.COM_FASE || 'ACTIU';
        let iconUrl;

        switch (fase) {
            case 'Estabilitzat':
                iconUrl = 'imatges/estabilitzat.png';
                break;
            case 'Controlat':
                iconUrl = 'imatges/controlat.png';
                break;
            case 'Extingit':
                iconUrl = 'imatges/extingit.png';
                break;
            case 'Actiu':
            default:
                iconUrl = 'imatges/actiu.png';
                break;
        }

        const iconaIncendi = L.icon({
            iconUrl: iconUrl,
            iconSize: [30, 30],
            iconAnchor: [15, 30],
            popupAnchor: [0, -30]
        });

        return L.marker(latlng, { icon: iconaIncendi });
    },

    onEachFeature: function (feature, layer) {
        if (feature.properties) {
            const props = feature.properties;
            const formatDate = (timestamp) => {
                if (!timestamp) return 'No especificada';
                return new Date(timestamp).toLocaleString('ca-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            };
            const faseText = props.COM_FASE || 'ACTIU (sense info)';

            let popupContent = `<b>${props.TAL_DESC_ALARMA1 || 'Actuació urgent'}</b><br>`;
            popupContent += `<hr style="margin: 4px 0;">`;
            popupContent += `<b>Tipus:</b> ${props.TAL_DESC_ALARMA2 || 'No especificat'}<br>`;
            popupContent += `<b>Municipi:</b> ${props.MUNICIPI_DPX || 'N/D'}<br>`;
            popupContent += `<b>Fase:</b> ${faseText}<br>`;
            popupContent += `<b>Inici:</b> ${formatDate(props.ACT_DAT_INICI)}`;
            layer.bindPopup(popupContent);
        }
    }
});


// ★★★ VERSIÓ FINAL I NETA DE LA CAPA DEL PLA ALFA ★★★
const plaAlfaLayer = L.esri.featureLayer({
    url: 'https://services7.arcgis.com/ZCqVt1fRXwwK6GF4/ArcGIS/rest/services/Pla_Alfa_Municipal_Avui_FL_2_view/FeatureServer/0',

    pane: 'poligonsPane',

    style: function (feature) {
        let color = '#CCCCCC';
        let opacitat = 0.65;
        const nivell = feature.properties.PERIL_M;

        switch (nivell) {
            case 0:
                opacitat = 0;
                break;
            case 1:
                color = '#ffff60';
                break;
            case 2:
                color = '#fc7622';
                break;
            case 3:
                color = '#f90202';
                break;
            case 4:
                color = '#900202';
                break;
        }

        return {
            fillColor: color,
            fillOpacity: opacitat,
            weight: 1,
            color: color
        };
    },

    onEachFeature: function (feature, layer) {
        if (feature.properties) {
            const props = feature.properties;
            const nivellsText = { 0: "Nivell 0 (Baix)", 1: "Nivell 1 (Moderat)", 2: "Nivell 2 (Alt)", 3: "Nivell 3 (Molt Alt)", 4: "Nivell 4 (Extrem)" };
            let popupContent = `<b>${props.NOMMUNI}</b><br><hr style="margin: 4px 0;"><b>Pla Alfa:</b> ${nivellsText[props.PERIL_M] || 'No definit'}`;
            layer.bindPopup(popupContent);
        }
    }
});

/**
 * Troba el timestamp de l'última dada de l'SMC que hauria d'estar disponible,
 * tenint en compte els retards de publicació (dades disponibles als minuts :16 i :46 aprox).
 * @param {Date} date - La data a partir de la qual calcular.
 * @returns {Date} Un objecte Date amb el timestamp de l'última dada disponible.
 */

/**
 * Calcula un timestamp objectiu basat en l'hora actual.
 * Aquesta funció està sincronitzada amb la lògica de 'fetchSmcData'.
 * @param {Date} date - La data a partir de la qual calcular.
 * @returns {Date} Un objecte Date amb el timestamp calculat.
 */
function findLatestSmcTimestamp(date) {
    const targetDate = new Date(date.getTime()); // Treballem sobre una còpia
    const currentUtcMinutes = targetDate.getUTCMinutes();

    // ======================================================
    // INICI DE LA MODIFICACIÓ
    // Aquesta lògica ara és idèntica a la de 'fetchSmcData'
    // ======================================================
    if (currentUtcMinutes >= 46) {
        targetDate.setUTCMinutes(0, 0, 0);
    } else if (currentUtcMinutes >= 16) {
        targetDate.setUTCHours(targetDate.getUTCHours() - 1);
        targetDate.setUTCMinutes(30, 0, 0);
    } else {
        targetDate.setUTCHours(targetDate.getUTCHours() - 1);
        targetDate.setUTCMinutes(0, 0, 0);
    }
    // ======================================================
    // FI DE LA MODIFICACIÓ
    // ======================================================

    return targetDate;
}

// ===================================================================
// NOU SISTEMA UNIFICAT DE VISUALITZACIÓ DE DADES (VERSIÓ FINAL CORREGIDA)
// ===================================================================



/**
 * Formata un valor per a les etiquetes del mapa.
 * Elimina el ".0" si no hi ha decimals significatius.
 * @param {number} value - El número a formatar.
 * @param {number} decimals - El nombre de decimals desitjat.
 * @returns {string} El valor formatat com a text.
 */
function formatValueForLabel(value, decimals) {
    if (typeof value !== 'number' || isNaN(value)) {
        return value; // Retorna el valor original si no és un número
    }

    const roundedValue = parseFloat(value.toFixed(decimals));

    // Si el valor arrodonit no té part fraccional (és a dir, acaba en .0),
    // el retornem com un enter.
    if (roundedValue % 1 === 0) {
        return roundedValue.toString();
    }

    // Altrament, el retornem amb els seus decimals.
    return roundedValue.toString();
}


// Funció per obtenir la dada instantània de l'SMC per una data concreta
async function fetchSmcInstant(variableId, date) {
    // La data ja ve calculada correctament. Només la formatem.
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const timestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;

    const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${timestampString}&codi_variable=${variableId}&_=${Date.now()}`;
    try {
        const data = await $.getJSON(urlDades);
        console.log(`Petició a ${urlDades} retornada amb ${data.length} registres.`);
        return data || [];
    } catch (error) {
        console.error(`Error obtenint dada instantània de l'SMC per a ${timestampString}:`, error);
        return [];
    }
}

// ===== REEMPLAÇA AQUESTA FUNCIÓ =====
function fetchSmcDailySummary(variableId, aggregationType, startDate, endDate) {
    return new Promise((resolve) => {
        // Converteix les dates a format ISO (UTC) i treu la 'Z' final, ja que l'API és flexible.
        const iniciDiaString = startDate.toISOString().slice(0, -1);
        const fiDiaString = endDate.toISOString().slice(0, -1);

        const selectClause = `codi_estacio, ${aggregationType}(valor_lectura) AS valor`;
        const whereClause = `data_lectura >= '${iniciDiaString}' AND data_lectura <= '${fiDiaString}' AND codi_variable = '${variableId}'`;
        const query = `$query=SELECT ${selectClause} WHERE ${whereClause} GROUP BY codi_estacio`;
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}&_=${Date.now()}`;
        console.log("URL de la consulta:", urlDades);
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        $.when($.getJSON(urlDades), $.getJSON(urlMetadades)).done((dadesResponse, metadadesResponse) => {
            const [dadesVariable, metadata] = [dadesResponse[0], metadadesResponse[0]];
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));
            const processedData = dadesVariable.map(lectura => {
                const estacioInfo = estacionsMap.get(lectura.codi_estacio);
                return estacioInfo ? { source: 'smc', ...estacioInfo, ...lectura, timestamp: new Date().toISOString() } : null;
            }).filter(d => d !== null);
            resolve({ data: processedData, timestamp: new Date().toISOString() });
        }).fail(() => resolve({ data: [], timestamp: null }));
    });
}

// ★ AFEGEIX AQUESTA NOVA FUNCIÓ AL TEU CODI ★
// S'encarrega de consultar la base de dades de variables diàries (7bvh-jvq2).
function fetchTrueDailyData(variableId, date) {
    return new Promise((resolve) => {
        // Formatem la data al format que necessita l'API (YYYY-MM-DD)
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const dateString = `${yyyy}-${mm}-${dd}`;

        // Construïm la consulta utilitzant date_trunc_ymd, que és el mètode correcte per a aquesta font.
        const query = `$query=SELECT codi_estacio, valor WHERE date_trunc_ymd(data_lectura) = '${dateString}T00:00:00' AND codi_variable = '${variableId}'`;
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${query}&_=${Date.now()}`;

        console.log(`[DADES DIÀRIES] Fent petició per al dia ${dateString} a la variable ${variableId}.`);

        $.getJSON(urlDades)
            .done(data => {
                // El format de retorn ja és compatible, només l'embolcallem.
                resolve({ data: data, timestamp: date.toISOString() });
            })
            .fail(err => {
                console.error(`[DADES DIÀRIES] Error obtenint dades per a la variable ${variableId} el dia ${dateString}:`, err);
                resolve({ data: [], timestamp: null }); // Retornem un array buit en cas d'error.
            });
    });
}

/**
 * NOVA FUNCIÓ: Obté la precipitació acumulada diària directament de la variable 1300.
 * Aquesta font de dades és més fiable però només està disponible per a dates amb més de 2 dies d'antiguitat.
 * @param {Date} date - La data per a la qual es vol obtenir la dada.
 * @returns {Promise<object>} Una promesa que resol amb les dades en el mateix format que les altres funcions fetch.
 */
function fetchDailyAccumulationDirectly(date) {
    return new Promise((resolve, reject) => {
        // Formatem la data al format que necessita l'API (YYYY-MM-DD)
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const dateString = `${yyyy}-${mm}-${dd}`;

        // Construïm la consulta per a la nova API (variable 1300)
        const query = `$query=SELECT codi_estacio, valor WHERE date_trunc_ymd(data_lectura) = '${dateString}T00:00:00' AND codi_variable = '1300'`;
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${query}&_=${Date.now()}`;

        console.log(`[NOVA API] Fent petició per al dia ${dateString} a la variable 1300. URL:`, urlDades);

        $.getJSON(urlDades)
            .done(data => {
                // Retornem les dades en un format compatible amb la resta del codi
                resolve({ data: data, timestamp: date.toISOString() });
            })
            .fail(err => {
                console.error(`[NOVA API] Error obtenint dades per al dia ${dateString}:`, err);
                // Si falla, retornem un array buit per no trencar el procés
                resolve({ data: [], timestamp: null });
            });
    });
}

// =====================================================================================
// 1. AFEGEIX AQUESTA NOVA FUNCIÓ
// Aquesta funció s'encarrega de demanar el sumatori de pluja a l'API
// =====================================================================================

/**
 * NOVA FUNCIÓ (A PROVA D'ERRORS DE L'API)
 * Obté TOTES les lectures de precipitació individuals per a un interval de dates.
 * @param {Date} startDate - Data d'inici de l'interval.
 * @param {Date} endDate - Data de fi de l'interval.
 * @returns {Promise<Object>} Una promesa que resol amb totes les lectures sense processar.
 */
function fetchAllPrecipitationReadings(startDate, endDate) {
    return new Promise((resolve) => {
        const iniciString = startDate.toISOString();
        const fiString = endDate.toISOString();

        // Consulta simple: selecciona només el codi i el valor, sense agregacions.
        const selectClause = `codi_estacio, valor_lectura`;
        const whereClause = `data_lectura >= '${iniciString}' AND data_lectura <= '${fiString}' AND codi_variable = '35'`;
        // Afegim un límit alt per si de cas, tot i que per a pocs dies no hauria de ser problema.
        const query = `$query=SELECT ${selectClause} WHERE ${whereClause} LIMIT 50000`;

        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}&_=${Date.now()}`;
        console.log("URL final (sense SUM):", urlDades);

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.when($.getJSON(urlDades), $.getJSON(urlMetadades)).done((dadesResponse, metadadesResponse) => {
            const [readings, metadata] = [dadesResponse[0], metadadesResponse[0]];
            resolve({ readings, metadata });
        }).fail((err) => {
            console.error("Error en la crida per obtenir lectures individuals:", err);
            resolve({ readings: [], metadata: [] });
        });
    });
}

// Funció per obtenir i processar dades d'AEMET
async function fetchAemetData() {
    const url = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
    try {
        const res1 = await fetch(url, { headers: { 'api_key': aemetApiKey } });
        const info = await res1.json();
        if (info.estado !== 200) throw new Error(info.descripcion);
        const res2 = await fetch(info.datos);
        return await res2.json();
    } catch (error) {
        console.error("Error AEMET:", error);
        return [];
    }
}

// ★ REEMPLAÇA LA TEVA FUNCIÓ 'getDynamicColor' PER AQUESTA VERSIÓ CORREGIDA ★

/**
 * Retorna el color corresponent a un valor segons una escala definida.
 * Aquesta versió corregida no interpola, simplement assigna el color del rang inferior.
 * @param {number} value - El valor a pintar.
 * @param {Array<Object>} scale - L'escala de colors, ex: [{value: 0, color: '...'}, ...]
 * @returns {string} El color RGBA correcte.
 */
function getDynamicColor(value, scale) {
    // Cas 1: Si el valor és més petit que el primer punt de l'escala, retorna el primer color.
    if (value < scale[0].value) {
        return scale[0].color;
    }

    // Cas 2: Busquem el color correcte recorrent l'escala a la inversa.
    for (let i = scale.length - 1; i >= 0; i--) {
        // Si el valor és més gran o igual que el punt actual de l'escala...
        if (value >= scale[i].value) {
            // ...retornem el seu color i acabem.
            return scale[i].color;
        }
    }

    // Com a mesura de seguretat, si res no funciona, retorna el primer color.
    return scale[0].color;
}

// ======================================================
// AFEGEIX AQUESTES NOVES ESCALES DE COLORS
// ======================================================

/**
 * Retorna un color per a la humitat relativa (%).
 * De marró (sec) a blau fosc (saturat).
 */
function getHumidityColor(rh) {
    const alpha = 1;
    if (rh < 20) return `rgba(188, 143, 143, ${alpha})`; // RosyBrown (molt sec)
    if (rh < 40) return `rgba(240, 230, 140, ${alpha})`; // Khaki (sec)
    if (rh < 60) return `rgba(152, 251, 152, ${alpha})`; // PaleGreen (moderat)
    if (rh < 80) return `rgba(60, 179, 113, ${alpha})`;  // MediumSeaGreen (humit)
    if (rh < 90) return `rgba(0, 191, 255, ${alpha})`;    // DeepSkyBlue (molt humit)
    return `rgba(0, 0, 205, ${alpha})`;                  // MediumBlue (saturat)
}

/**
 * Retorna el color del text (blanc o negre) per a les etiquetes d'humitat.
 * @param {number} rh - Humitat relativa en %.
 * @returns {string} El color del text ('#FFFFFF' o '#000000').
 */
function getTextColorForHumidity(rh) {
    if (rh >= 90) {
        return '#FFFFFF'; // Blanc per a valors d'humitat molt alts
    }
    return '#000000'; // Negre per a la resta
}

/**
 * Retorna un color per a la pressió atmosfèrica (hPa).
 * De taronja (baixa pressió) a blau/violeta (alta pressió).
 */
function getPressureColor(hpa) {
    const alpha = 1;
    if (hpa < 990) return `rgba(255, 127, 80, ${alpha})`;   // Coral (molt baixa)
    if (hpa < 1000) return `rgba(255, 165, 0, ${alpha})`;  // Orange (baixa)
    if (hpa < 1010) return `rgba(218, 165, 32, ${alpha})`; // Goldenrod (normal-baixa)
    if (hpa < 1020) return `rgba(144, 238, 144, ${alpha})`; // LightGreen (normal)
    if (hpa < 1030) return `rgba(173, 216, 230, ${alpha})`; // LightBlue (alta)
    return `rgba(147, 112, 219, ${alpha})`;                // MediumPurple (molt alta)
}

/**
 * Retorna un color per al gruix de neu (cm).
 * De blanc a blau fosc.
 */
function getSnowDepthColor(cm) {
    const alpha = 1;
    if (cm <= 0) return '#ffffff';                      // Blanc (sense neu)
    if (cm < 5) return `rgba(240, 248, 255, ${alpha})`; // AliceBlue
    if (cm < 10) return `rgba(173, 216, 230, ${alpha})`;// LightBlue
    if (cm < 25) return `rgba(135, 206, 250, ${alpha})`;// LightSkyBlue
    if (cm < 50) return `rgba(0, 191, 255, ${alpha})`;   // DeepSkyBlue
    if (cm < 100) return `rgba(30, 144, 255, ${alpha})`; // DodgerBlue
    return `rgba(0, 0, 139, ${alpha})`;                 // DarkBlue (molta neu)
}

/**
 * Retorna el color per a la variació de gruix de neu (NOVA ESCALA CORREGIDA).
 * - Valors positius (Acumulació) -> VERMELLS 🔴
 * - Valors negatius (Fosa) -> BLAUS VISIBLES 🔵
 */
function getSnowVariationColor(cm) {
    const alpha = 1;

    // --- POSITIUS (Acumulació / Guany de neu) -> VERMELLS ---
    if (cm >= 50) return `rgba(139, 0, 0, ${alpha})`;    // Vermell fosc
    if (cm >= 30) return `rgba(178, 34, 34, ${alpha})`;  // Firebrick
    if (cm >= 20) return `rgba(220, 20, 60, ${alpha})`;  // Crimson
    if (cm >= 10) return `rgba(255, 0, 0, ${alpha})`;    // Vermell pur
    if (cm >= 5) return `rgba(255, 69, 0, ${alpha})`;   // Vermell taronja
    if (cm >= 2) return `rgba(255, 99, 71, ${alpha})`;  // Tomàquet
    if (cm > 0) return `rgba(255, 127, 80, ${alpha})`; // Coral (Més visible que el salmó)

    // --- ESTABLE (0) ---
    if (cm === 0) return `rgba(255, 255, 255, 0.0)`;      // Transparent

    // --- NEGATIUS (Fosa / Pèrdua de neu) -> BLAUS ---
    if (cm <= -20) return `rgba(0, 0, 128, ${alpha})`;    // Navy (Molt fosc)
    if (cm <= -10) return `rgba(0, 0, 205, ${alpha})`;    // MediumBlue
    if (cm <= -5) return `rgba(65, 105, 225, ${alpha})`; // RoyalBlue
    if (cm <= -2) return `rgba(30, 144, 255, ${alpha})`; // DodgerBlue

    // CORRECCIÓ: Canviem el cian pàl·lid per un blau cel intens que es vegi sobre blanc
    return `rgba(0, 191, 255, ${alpha})`;                 // DeepSkyBlue
}

/**
 * Retorna el color per a la Reserva d'Aigua (SWE) en mm.
 * Escala: Blau Clar -> Blau Fosc -> Lila -> Magenta Fosc
 */
function getSweColor(mm) {
    const alpha = 0.9;

    if (mm < 10) return `rgba(224, 247, 250, ${alpha})`; // Cyan molt pàl·lid (Poca reserva)
    if (mm < 50) return `rgba(79, 195, 247, ${alpha})`;  // Blau cel
    if (mm < 100) return `rgba(33, 150, 243, ${alpha})`;  // Blau
    if (mm < 200) return `rgba(21, 101, 192, ${alpha})`;  // Blau fosc
    if (mm < 400) return `rgba(103, 58, 183, ${alpha})`;  // Lila/Violeta (Reserva important)
    if (mm < 800) return `rgba(140, 0, 200, ${alpha})`;   // Púrpura (Reserva molt gran)
    return `rgba(136, 14, 79, ${alpha})`;                 // Magenta fosc (Reserva massiva)
}

/**
 * Escala de colors de temperatura d'alta resolució (intervals d'1 grau).
 * @param {number} temp - Temperatura en °C.
 * @returns {string} El color RGBA calculat.
 */
function getTempRgbaColor(temp) {
    const alpha = 1;
    if (temp < -18) return `rgba(69, 39, 160, ${alpha})`;
    if (temp < -16) return `rgba(86, 54, 163, ${alpha})`;
    if (temp < -14) return `rgba(91, 73, 168, ${alpha})`;
    if (temp < -12) return `rgba(88, 91, 179, ${alpha})`;
    if (temp < -10) return `rgba(81, 110, 194, ${alpha})`;
    if (temp < -8) return `rgba(66, 133, 212, ${alpha})`;
    if (temp < -6) return `rgba(41, 158, 229, ${alpha})`;
    if (temp < -4) return `rgba(13, 179, 238, ${alpha})`;
    if (temp < -2) return `rgba(0, 191, 243, ${alpha})`;
    if (temp < 0) return `rgba(0, 200, 235, ${alpha})`;
    if (temp < 2) return `rgba(20, 209, 203, ${alpha})`;
    if (temp < 4) return `rgba(40, 196, 171, ${alpha})`;
    if (temp < 6) return `rgba(65, 184, 140, ${alpha})`;
    if (temp < 8) return `rgba(90, 189, 110, ${alpha})`;
    if (temp < 10) return `rgba(125, 201, 85, ${alpha})`;
    if (temp < 12) return `rgba(160, 213, 60, ${alpha})`;
    if (temp < 14) return `rgba(195, 225, 45, ${alpha})`;
    if (temp < 16) return `rgba(230, 238, 30, ${alpha})`;
    if (temp < 18) return `rgba(255, 220, 20, ${alpha})`;
    if (temp < 20) return `rgba(255, 195, 15, ${alpha})`;
    if (temp < 22) return `rgba(255, 170, 10, ${alpha})`;
    if (temp < 24) return `rgba(255, 145, 5, ${alpha})`;
    if (temp < 26) return `rgba(255, 120, 0, ${alpha})`;
    if (temp < 28) return `rgba(255, 95, 10, ${alpha})`;
    if (temp < 30) return `rgba(255, 70, 20, ${alpha})`;
    if (temp < 32) return `rgba(250, 50, 40, ${alpha})`;
    if (temp < 34) return `rgba(245, 30, 60, ${alpha})`;
    if (temp < 36) return `rgba(240, 20, 90, ${alpha})`;
    if (temp < 38) return `rgba(235, 10, 120, ${alpha})`;
    if (temp < 40) return `rgba(225, 0, 150, ${alpha})`;
    if (temp < 42) return `rgba(205, 0, 165, ${alpha})`;
    if (temp < 44) return `rgba(185, 0, 180, ${alpha})`;
    if (temp < 46) return `rgba(160, 0, 190, ${alpha})`;
    return `rgba(140, 0, 200, ${alpha})`;
}

/**
 * ★★★ AFEGEIX AQUESTA NOVA FUNCIÓ AL TEU CODI ★★★
 * Crea un objecte de gradient de color per a la capa d'interpolació IDW
 * utilitzant l'escala de colors de temperatura ja definida.
 * @returns {object} Un objecte de gradient, ex: {0.1: 'blue', 0.5: 'yellow', 1.0: 'red'}
 */
function createTemperatureGradient() {
    const gradient = {};
    const minTemp = -20; // Temperatura mínima de l'escala
    const maxTemp = 45;  // Temperatura màxima de l'escala

    // Generem 100 punts de color per a una transició suau
    for (let i = 0; i <= 100; i++) {
        const step = i / 100;
        const temp = minTemp + (step * (maxTemp - minTemp));
        const color = getTempRgbaColor(temp);

        // El format que espera la llibreria és {punt_escala: 'color'}
        // El punt_escala ha d'anar de 0.0 a 1.0
        gradient[step.toFixed(2)] = color;
    }
    return gradient;
}

/**
 * Calcula l'Índex de Calor (Heat Index) del NWS dels EUA.
 * @param {number} tempC - Temperatura en graus Celsius.
 * @param {number} rh - Humitat relativa en percentatge (ex: 70).
 * @returns {number|null} L'índex de calor en graus Celsius, o la temperatura original si no s'aplica.
 */
function calculateHeatIndex(tempC, rh) {
    if (tempC === null || rh === null || isNaN(tempC) || isNaN(rh)) {
        return null;
    }

    // Convertir temperatura a Fahrenheit
    const tempF = (tempC * 9 / 5) + 32;

    // La fórmula principal només s'aplica per a T > 80°F i HR > 40%
    if (tempF < 80 || rh < 40) {
        return tempC; // Si no es compleixen les condicions, retornem la temperatura real.
    }

    // Fórmula de regressió múltiple de Steadman/Rothfusz
    let heatIndexF = -42.379 +
        2.04901523 * tempF +
        10.14333127 * rh -
        0.22475541 * tempF * rh -
        0.00683783 * tempF * tempF -
        0.05481717 * rh * rh +
        0.00122874 * tempF * tempF * rh +
        0.00085282 * tempF * rh * rh -
        0.00000199 * tempF * tempF * rh * rh;

    // Ajustaments addicionals per a condicions específiques
    if (rh < 13 && tempF >= 80 && tempF <= 112) {
        const adjustment = ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
        heatIndexF -= adjustment;
    } else if (rh > 85 && tempF >= 80 && tempF <= 87) {
        const adjustment = ((rh - 85) / 10) * ((87 - tempF) / 5);
        heatIndexF += adjustment;
    }

    // Si el resultat és menor que la temperatura, agafem la temperatura.
    if (heatIndexF < tempF) {
        heatIndexF = tempF;
    }

    // Convertir el resultat final de nou a Celsius
    return (heatIndexF - 32) * 5 / 9;
}


/**
 * ★ NOVA FUNCIÓ: Retorna un color per a la tendència de pressió. ★
 * Vermells per a baixades, blaus per a pujades.
 * @param {number} hpa_change - La variació de pressió en hPa.
 * @returns {string} El color RGBA calculat.
 */
function getPressureTrendColor(hpa_change) {
    const alpha = 1;
    // Baixades fortes (mal temps imminent)
    if (hpa_change < -1.5) return `rgba(220, 20, 60, ${alpha})`; // Carmesí
    // Baixades moderades
    if (hpa_change < 0) return `rgba(255, 140, 0, ${alpha})`;    // Taronja Fosc
    // Pujades fortes (millora clara)
    if (hpa_change > 1.5) return `rgba(30, 144, 255, ${alpha})`; // Blau Dodger
    // Pujades moderades
    if (hpa_change > 0) return `rgba(135, 206, 250, ${alpha})`;  // Blau Cel Clar
    // Estable
    return `rgba(220, 220, 220, ${alpha})`;                      // Gris Clar
}

// ===== BLOC DE FUNCIONS DEFINITIU (COPIAR I ENGANXAR AL LLOC NET) =====

// VERSIÓ FINAL: Càrrega dades de SMC per a una data concreta (o la més recent)
function fetchSmcData(variableId, targetDate = null) {
    return new Promise((resolve) => {
        if (variableId === null) return resolve({ data: [] });
        let timestampToUse = targetDate ? new Date(targetDate.getTime()) : findLatestSmcTimestamp(new Date());
        const yyyy = timestampToUse.getUTCFullYear();
        const mm = String(timestampToUse.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(timestampToUse.getUTCDate()).padStart(2, '0');
        const hh = String(timestampToUse.getUTCHours()).padStart(2, '0');
        const mi = String(timestampToUse.getUTCMinutes()).padStart(2, '0');
        const finalTimestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${variableId}&_=${Date.now()}`;
        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));
            $.getJSON(urlDades).done(dadesVariable => {
                const processedData = dadesVariable.map(lectura => {
                    const estacioInfo = estacionsMap.get(lectura.codi_estacio);
                    return estacioInfo ? { source: 'smc', ...estacioInfo, valor: lectura.valor_lectura, timestamp: finalTimestampString + 'Z', codi_estacio: lectura.codi_estacio } : null;
                }).filter(Boolean);
                resolve({ data: processedData });
            }).fail(() => resolve({ data: [] }));
        }).fail(() => resolve({ data: [] }));
    });
}

// VERSIÓ FINAL: Càrrega de dades de vent de 3 nivells
// VERSIÓ FINAL: Càrrega de dades de vent de 3 nivells guardant l'origen
async function fetchAllWindData(dataType, targetDate = null) {
    let speed_ids, dir_ids;

    // Definim l'ordre de preferència: 10m -> 2m -> 6m (o com estigui a l'API)
    if (dataType === 'speed') {
        speed_ids = [30, 48, 46];
        dir_ids = [31, 49, 47];
    } else {
        // Ratxes: 10m (50), 6m (53), 2m (56)
        speed_ids = [50, 53, 56];
        dir_ids = [51, 54, 57];
    }

    const promises = [...speed_ids, ...dir_ids].map(id => fetchSmcData(id, targetDate));
    const results = await Promise.all(promises);

    const speedResults = results.slice(0, 3);
    const dirResults = results.slice(3, 6);

    const finalWindData = new Map();

    for (let i = 0; i < 3; i++) {
        // Mapa de direccions per a aquest nivell
        const dirMap = new Map(dirResults[i].data.map(d => [d.codi_estacio, parseFloat(d.valor)]));

        speedResults[i].data.forEach(station => {
            // Només afegim l'estació si no la tenim ja (prioritzem 10m sobre la resta)
            if (!finalWindData.has(station.codi_estacio) && dirMap.has(station.codi_estacio)) {
                finalWindData.set(station.codi_estacio, {
                    ...station,
                    speed_ms: parseFloat(station.valor),
                    direction: dirMap.get(station.codi_estacio),
                    // ★ GUARDEM L'ID DE LA VARIABLE QUE HEM TROBAT (EX: 48, 56...) ★
                    real_variable_id: speed_ids[i]
                });
            }
        });
    }
    return Array.from(finalWindData.values());
}

// FUNCIÓ NOVA: Obté la ratxa màxima diària de les 3 alçades i les fusiona
async function fetchAllDailyWindData(targetDate = null) {
    // Si no hi ha data, és avui
    const dateForDay = targetDate || new Date();

    // Definim el dia sencer (00:00 a 23:59)
    const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));

    // IDs de les variables de ratxa a les 3 alçades
    const gust_ids = [50, 53, 56];

    // Fem les 3 peticions en paral·lel demanant el 'max'
    const promises = gust_ids.map(id => fetchSmcDailySummary(id, 'max', startOfDay, endOfDay));
    const results = await Promise.all(promises);

    const finalWindMap = new Map();

    // Fusionem els resultats agafant sempre el valor MÀXIM trobat
    results.forEach((res, index) => {
        if (res && res.data) {
            res.data.forEach(d => {
                const val = parseFloat(d.valor || d.valor_lectura);
                if (!isNaN(val)) {
                    // Si l'estació no hi és, o el nou valor és més alt, actualitzem
                    if (!finalWindMap.has(d.codi_estacio) || val > finalWindMap.get(d.codi_estacio).speed_ms) {
                        finalWindMap.set(d.codi_estacio, {
                            ...d,
                            speed_ms: val, // Guardem el valor com a speed_ms per compatibilitat
                            real_variable_id: gust_ids[index] // Guardem de quina variable ha sortit
                        });
                    }
                }
            });
        }
    });

    return Array.from(finalWindMap.values());
}

/**
 * VERSIÓ FINAL: Activa o desactiva l'actualització automàtica
 * canviant la imatge del botó.
 */
function toggleAutoRefresh() {
    isAutoRefreshActive = !isAutoRefreshActive;
    const autoRefreshBtn = document.getElementById('toggle-auto-refresh-btn');
    const icon = autoRefreshBtn.querySelector('img'); // Seleccionem la imatge dins del botó

    if (isAutoRefreshActive) {
        icon.src = 'imatges/pause.png'; // Canviem a la imatge de pausa
        icon.alt = 'Pausar actualització';
        autoRefreshBtn.title = 'Pausar actualització automàtica';
        autoRefreshBtn.classList.add('active');

        checkForDataUpdates();
        autoRefreshInterval = setInterval(checkForDataUpdates, 30000);

    } else {
        icon.src = 'imatges/play.png'; // Canviem a la imatge de play
        icon.alt = 'Activar actualització';
        autoRefreshBtn.title = 'Activar actualització automàtica';
        autoRefreshBtn.classList.remove('active');

        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    }
}

/**
 * NOVA FUNCIÓ: Comprova si hi ha dades noves de SMC disponibles i refresca la vista.
 */
function checkForDataUpdates() {
    // Si l'auto-refresh no està actiu o estem en mode històric, no fem res.
    if (!isAutoRefreshActive || historicModeTimestamp !== null) {
        return;
    }

    const latestAvailableTimestamp = findLatestSmcTimestamp(new Date());

    // Si és la primera vegada que comprovem, només guardem l'hora actual com a referència.
    if (lastCheckedTimestamp === null) {
        lastCheckedTimestamp = latestAvailableTimestamp;
        return;
    }

    // Si l'hora de les noves dades és posterior a l'última que vam comprovar...
    if (latestAvailableTimestamp.getTime() > lastCheckedTimestamp.getTime()) {
        console.log("Noves dades de SMC detectades! Actualitzant la vista...");

        // Guardem la nova hora de referència
        lastCheckedTimestamp = latestAvailableTimestamp;

        // Cridem a la funció que refresca la variable que estigui activa en aquell moment
        refreshCurrentVariableView();
    }
}


// ======================================================
// AFEGEIX AQUESTA FUNCIÓ AL TEU CODI
// ======================================================
function stopAllDataLayers() {
    // Atura i neteja el gestor de llamps si està actiu
    if (typeof realtimeLightningManager !== 'undefined' && realtimeLightningManager.isActive) {
        realtimeLightningManager.stop();
    }

    // Neteja les capes de dades existents (com les de temperatura, vent, etc.)
    if (typeof dataMarkersLayer !== 'undefined') {
        dataMarkersLayer.clearLayers();
    }

    // Amaga el panell del sumatori si estava visible
    const sumatoriControls = document.getElementById('sumatori-controls');
    if (sumatoriControls) {
        sumatoriControls.style.display = 'none';
    }

    console.log("Totes les capes de dades han estat aturades i netejades.");
}

// ===================================================================
// NOU: Funció central per aplicar filtres de dades
// ===================================================================
/**
 * Filtra un array d'estacions basant-se en els filtres globals.
 * L'objecte estació HA DE TENIR les propietats 'valor' i 'altitud'.
 * @param {Array} stationDataArray - L'array complet d'estacions.
 * @returns {Array} Un nou array només amb les estacions que passen el filtre.
 */
function applyDataFilters(stationDataArray) {
    // Si no hi ha filtres actius, retornem l'array sencer ràpidament.
    if (activeDataFilters.valueMin === null && activeDataFilters.valueMax === null &&
        activeDataFilters.altMin === null && activeDataFilters.altMax === null) {
        return stationDataArray;
    }

    return stationDataArray.filter(station => {
        // 1. GESTIÓ ROBUSTA DEL VALOR (Números i Text)
        let value = station.valor;

        // Si és text (Meteocat), el convertim a número. Si ja és número (Express), el deixem igual.
        if (typeof value === 'string') {
            value = parseFloat(value);
        }

        // Si el valor no és vàlid (NaN), descartem l'estació.
        if (value === null || value === undefined || isNaN(value)) {
            return false;
        }

        // 2. FILTRE PER VALOR (Mínim i Màxim)
        if (activeDataFilters.valueMin !== null && value < activeDataFilters.valueMin) return false;
        if (activeDataFilters.valueMax !== null && value > activeDataFilters.valueMax) return false;

        // 3. GESTIÓ ROBUSTA DE L'ALTITUD
        let alt = station.altitud;
        // Convertim a número si cal
        if (alt !== null && alt !== undefined) {
            alt = parseFloat(alt);
        } else {
            alt = null; // Assegurem que és null si no existeix
        }

        // 4. FILTRE PER ALTITUD
        // Només apliquem aquest filtre si l'usuari ha posat algun número a les caixes d'altitud
        if (activeDataFilters.altMin !== null || activeDataFilters.altMax !== null) {
            // Si volem filtrar per altitud, les estacions SENSE altitud (com Weather.com) s'han d'amagar
            if (alt === null) return false;

            if (activeDataFilters.altMin !== null && alt < activeDataFilters.altMin) return false;
            if (activeDataFilters.altMax !== null && alt > activeDataFilters.altMax) return false;
        }

        // Si ha superat totes les proves, l'acceptem.
        return true;
    });
}
function makeDraggable(element, handle) {
    const dragHandle = handle || element;
    let isDragging = false, offsetX, offsetY;

    function startDrag(e) {
        if (e.target.tagName.toLowerCase() === 'button' ||
            e.target.closest('button') ||
            e.target.tagName.toLowerCase() === 'input') {
            e.stopPropagation();
            return;
        }

        isDragging = true;
        element.classList.add('is-dragging');

        const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);

        const rect = element.getBoundingClientRect();
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;

        element.style.setProperty('position', 'fixed', 'important');
        element.style.setProperty('transform', 'none', 'important');
        element.style.setProperty('margin', '0', 'important');
        element.style.setProperty('box-sizing', 'border-box', 'important');
        element.style.setProperty('bottom', 'auto', 'important');
        element.style.setProperty('right', 'auto', 'important');
        element.style.setProperty('width', `${rect.width}px`, 'important');
        // Eliminem el style.height fix per permetre que el panell es col·lapse naturalment al minimitzar

        element.style.setProperty('left', `${rect.left}px`, 'important');
        element.style.setProperty('top', `${rect.top}px`, 'important');

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', stopDrag);

        if (e.cancelable && e.target === dragHandle) e.preventDefault();
    }

    function drag(e) {
        if (!isDragging) return;
        const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);

        element.style.setProperty('left', `${clientX - offsetX}px`, 'important');
        element.style.setProperty('top', `${clientY - offsetY}px`, 'important');
    }

    function stopDrag() {
        isDragging = false;
        element.classList.remove('is-dragging');
        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
    }

    dragHandle.addEventListener('mousedown', startDrag);
    dragHandle.addEventListener('touchstart', startDrag, { passive: false });
}

// --- HELPER PER A COORDENADES DMS (Meteo Guilleries) ---
function parseDMS(dmsString) {
    if (!dmsString) return null;
    // Format esperat: "41°55'38''N - 02°19'02''E"
    // Separem per " - "
    const parts = dmsString.split(' - ');
    if (parts.length !== 2) return null;

    function convert(str) {
        // Ex: "41°55'38''N" o "41º55'38''N"
        // Acceptem tant el símbol de grau (°) com l'ordinal (º), i cometes dobles o dues simples
        const regex = /(\d+)[°º](\d+)'(\d+)(?:''|")([NSEW])/;
        const match = str.match(regex);
        if (!match) return null;

        let deg = parseFloat(match[1]);
        let min = parseFloat(match[2]);
        let sec = parseFloat(match[3]);
        let dir = match[4];

        let decimal = deg + (min / 60) + (sec / 3600);

        if (dir === 'S' || dir === 'W') {
            decimal = -decimal;
        }
        return decimal;
    }

    const lat = convert(parts[0]);
    const lon = convert(parts[1]);

    if (lat === null || lon === null) return null;
    return { lat, lon };
}

async function fetchMeteoGuilleriesData() {
    try {
        // URL proxy o directa si CORS ho permet (assumim que funciona o l'usuari té un proxy)
        // L'usuari ha donat: https://www.meteoguilleries.cat/API/carregarMapa
        const response = await fetch('https://www.meteoguilleries.cat/API/carregarMapa');
        const data = await response.json();

        // data és un array de categories. Busquem la que té tipus "Estacions"
        const estacionsCategory = data.find(d => d.tipus === 'Estacions');
        if (!estacionsCategory || !estacionsCategory.fills) return [];

        return estacionsCategory.fills.map(d => {
            const coords = parseDMS(d.posicioGPS);
            if (!coords) return null;

            // "plujaAvui": "66.50"
            const val = parseFloat(d.plujaAvui);
            if (isNaN(val)) return null;

            return {
                nom: d.nom || d.lloc, // Usem d.nom que sembla existir al JSON real, o d.lloc com a fallback
                lat: coords.lat,
                lon: coords.lon,
                valor: val,
                source: 'meteoguilleries'
            };
        }).filter(d => d !== null);

    } catch (e) {
        console.error("Error carregant Meteo Guilleries:", e);
        return [];
    }
}

// Per a variables simples (Temperatura Actual, Humitat, Pressió, Pluja)
async function displayVariable(variableKey, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const config = VARIABLES_CONFIG[variableKey];

    // --- GESTIÓ DINÀMICA DE L'ATRIBUCIÓ (METEO GUILLERIES) ---
    // Ho fem amb un petit retard per assegurar que Leaflet actualitza el control
    setTimeout(() => {
        const mgAttribution = ' | <a href="https://www.meteoguilleries.cat/" target="_blank">MeteoGuilleries</a>';
        map.attributionControl.removeAttribution(mgAttribution);

        if (config.isMeteoGuilleriesCombined) {
            map.attributionControl.addAttribution(mgAttribution);
        }
    }, 10);

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    if (!isHistoric) { lastCheckedTimestamp = timestampToUse; }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'instant',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers();

    // Netejar la capa d'Open-Meteo si existia
    if (map.hasLayer(openMeteoAromeLayer)) {
        map.removeLayer(openMeteoAromeLayer);
    }

    if (config.special) {
        if (config.isAromeMap) {
            startAromeMapLayer();
        } else {
            startWindLayer();
        }
        isLoadingData = false; return;
    }

    const smcResult = await fetchSmcData(config.id, timestampToUse);
    let finalData = smcResult.data;

    if (!isHistoric && config.aemet_id) {
        const aemetRawData = await fetchAemetData();
        if (aemetRawData && aemetRawData.length > 0 && typeof contornCatGeojson !== 'undefined') {
            const catalunyaPolygon = contornCatGeojson.features[0];
            const estacionsAemetCat = aemetRawData.filter(d => {
                if (d.lat && d.lon) {
                    const point = turf.point([d.lon, d.lat]);
                    return turf.booleanPointInPolygon(point, catalunyaPolygon);
                }
                return false;
            });

            if (estacionsAemetCat.length > 0) {
                const estacionsIdemaMap = new Map();
                estacionsAemetCat.forEach(d => {
                    if (typeof d[config.aemet_id] !== 'undefined') {
                        if (!estacionsIdemaMap.has(d.idema) || d.fint > estacionsIdemaMap.get(d.idema).fint) {
                            estacionsIdemaMap.set(d.idema, d);
                        }
                    }
                });

                finalData.push(...Array.from(estacionsIdemaMap.values()).map(d => ({
                    source: 'aemet',
                    lat: d.lat,
                    lon: d.lon,
                    nom: d.ubi,
                    valor: d[config.aemet_id],
                    fint: d.fint
                })));
            }
        }
    }

    // ★ NOVA INTEGRACIÓ METEO GUILLERIES ★
    if (!isHistoric && config.isMeteoGuilleriesCombined) {
        const mgData = await fetchMeteoGuilleriesData();
        if (mgData && mgData.length > 0) {
            finalData.push(...mgData);
        }
    }

    dataMarkersLayer.clearLayers();

    const filteredData = applyDataFilters(finalData);
    window.lastMeteoData = filteredData; // Save for Elevation Profile


    filteredData.forEach(estacio => {
        const value = Number(estacio.valor); if (isNaN(value)) return;

        let color;
        let textColor = '#000000';

        // --- LÒGICA DE COLORS CORREGIDA ---
        switch (config.id) {
            case 33: case 3: case 44:
                color = getHumidityColor(value);
                textColor = getTextColorForHumidity(value);
                break;

            case 35: // PRECIPITACIÓ
                if (config.isDailyAccumulation || config.summary === 'sum') {
                    color = getDailyPrecipitationColor(value);

                    // ★ AFEGEIX AIXÒ SI NO HI ÉS:
                    if (value > 80) textColor = '#FFFFFF';

                } else {
                    color = getSemihorariaPrecipColor(value);
                }
                break;

            case 72:
                color = getIntensityColor(value);
                break;

            case 34: case 1: case 2:
                color = getPressureColor(value);
                break;

            case 38:
                color = getSnowDepthColor(value);
                break;

            default:
                // Si és una variable de vent que s'ha colat aquí, usem l'escala de vent
                if (config.name.includes('Vent') || config.name.includes('Ratxa')) {
                    // Si la unitat és m/s convertim a km/h per al color
                    const valKmh = config.unit === 'm/s' ? value * 3.6 : value;
                    color = getWindColor(valKmh);
                } else {
                    // Per defecte (Temperatura)
                    color = getTempRgbaColor(value);
                }
        }

        const formattedValue = formatValueForLabel(value, config.decimals);
        let borderStyle = '';
        if (estacio.source === 'aemet' && estacio.fint) {
            const dataFint = new Date(estacio.fint + 'Z'); // AEMET retorna temps en UTC normalment, afegim Z
            const dataAvui = timestampToUse ? new Date(timestampToUse) : new Date();
            // Diferència en minuts
            const diffMinuts = (dataAvui - dataFint) / (1000 * 60);
            if (diffMinuts > 35) {
                borderStyle = 'box-shadow: 0 0 0 2px red;';
            }
        }

        const icon = L.divIcon({
            className: 'temp-label',
            // ASSEGURA'T QUE HI DIU: color: ${textColor};
            html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; ${borderStyle}">${formattedValue}</div>`,
            iconSize: [30, 18],
            iconAnchor: [15, 9]
        });

        const marker = L.marker([estacio.lat, estacio.lon], {
            icon: icon,
            valor: value  // <-- AQUESTA ÉS LA CLAU
        }).addTo(dataMarkersLayer);

        if (estacio.source === 'smc' || !estacio.source) {
            const popupHTML = generateChartPopupHTML(estacio, config.id, config);
            marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });

            marker.on('popupopen', () => {
                const canvasId = `chart-${estacio.codi_estacio}`;
                loadStationChart(
                    estacio.codi_estacio,
                    config.id,
                    canvasId,
                    config.name,
                    24,
                    false,
                    false,
                    config.conversion,
                    { ...config, lat: estacio.lat, lon: estacio.lon },
                    timestampToUse
                );
                setupPopupEvents(estacio, config.id, config, timestampToUse);
            });
        } else {
            let popupContent = `<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`;
            // Afegim l'hora de l'última dada per a AEMET
            if (estacio.fint) {
                try {
                    const dataHora = estacio.fint.slice(11, 16);
                    popupContent += `<br><small style="color: #666;">Última dada: ${dataHora}h</small>`;
                } catch (e) { }
            }
            marker.bindPopup(popupContent);
        }
    });

    isLoadingData = false;
}

// AFEGEIX AQUESTA NOVA FUNCIÓ AL TEU FITXER
async function displayPercentileVariable(config) {
    // 1. FORCEM l'execució (ignorem el bloqueig per si s'ha quedat penjat)
    isLoadingData = true;

    // 2. Comprovació de seguretat: Existeix la variable global?
    if (typeof dadesPercentils === 'undefined') {
        isLoadingData = false;
        return;
    }

    // Mostrem l'estat "Carregant"
    updateHistoricDisplay({ mode: 'static', type: 'summary', timestamp: new Date() });
    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    try {
        // URL de les metadades de les estacions
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";

        const metadata = await $.getJSON(urlMetadades);

        // Creem el mapa per creuar dades
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, {
            nom: est.nom_estacio,
            lat: parseFloat(est.latitud),
            lon: parseFloat(est.longitud),
            altitud: parseFloat(est.altitud)
        }]));

        dataMarkersLayer.clearLayers();
        let count = 0;
        let errors = 0;

        // 3. Recorrem el teu fitxer de percentils
        const keys = Object.keys(dadesPercentils);

        for (const stationCode in dadesPercentils) {
            const percentileData = dadesPercentils[stationCode];
            const stationInfo = estacionsMap.get(stationCode);

            if (stationInfo) {
                // Tenim coordenades per a aquesta estació
                const value = percentileData[config.valueKey];

                if (value !== undefined && value !== null) {
                    // Tenim valor per a la variable seleccionada
                    const color = getTempRgbaColor(value);
                    const formattedValue = formatValueForLabel(value, config.decimals);

                    let textColor = 'black';
                    if (config.valueKey === 'p2_tmin' && value < 0) {
                        textColor = 'white';
                    }

                    const icon = L.divIcon({
                        className: 'temp-label',
                        html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                        iconSize: [30, 18],
                        iconAnchor: [15, 9]
                    });

                    L.marker([stationInfo.lat, stationInfo.lon], { icon })
                        .bindPopup(`<b>${stationInfo.nom}</b> (${stationCode})<br>${config.name}: <b>${formattedValue} ${config.unit}</b>`)
                        .addTo(dataMarkersLayer);

                    count++;
                } else {
                    // Estació existeix però no té la dada que busquem (p.ex. p98_tmax)
                    // console.warn(`Estació ${stationCode} trobada, però falta la clau: ${config.valueKey}`);
                }
            } else {
                // El codi del teu fitxer (ex: "YX") no està a la llista del Meteocat
                if (errors < 5) console.warn(`⚠️ Estació del teu fitxer no trobada a les metadades del Meteocat: ${stationCode}`);
                errors++;
            }
        }

        if (count === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No s\'han trobat coincidències' }) }).addTo(dataMarkersLayer);
        } else {
        }

    } catch (error) {
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error intern (mira la consola)' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// Funció auxiliar per a "debounce"
function debounce(func, timeout = 100) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

// Funció per actualitzar les estadístiques del panell de llamps (NOMÉS CATALUNYA)
function updateLightningStats() {
    const statsContainer = document.querySelector('.lightning-stats-bar');
    if (!statsContainer) return;

    let totalStrikes = 0;
    let maxMag = 0;
    let posStrikes = 0;
    let negStrikes = 0;

    // Comptem llamps en directe a Catalunya
    realtimeLightningManager.strikeMarkers.forEach(m => {
        if (m.isCat) {
            totalStrikes++;
            if (m.mag && Math.abs(m.mag) > maxMag) maxMag = Math.abs(m.mag);
            if (m.pol > 0) posStrikes++; else if (m.pol < 0) negStrikes++;
        }
    });

    // Comptem llamps històrics a Catalunya
    realtimeLightningManager.historicStrikes.forEach(s => {
        if (s.isCat) totalStrikes++;
    });

    const currentCells = (typeof celulesAnteriors !== 'undefined') ? celulesAnteriors.filter(c => c.esActiva).length : 0;

    statsContainer.innerHTML = `
        <div style="flex: 1; text-align: center; color: #3b82f6;" title="Llamps dins de Catalunya">📡 ${totalStrikes} Llamps (Cat)</div>
        <div style="flex: 1; text-align: center; color: #ef4444;">⛈️ ${currentCells} Cèl·lules</div>
    `;
}

// REEMPLAÇA AQUESTA FUNCIÓ
function createLightningPopup() {
    const existingPopup = document.getElementById('lightning-popup');
    if (existingPopup) existingPopup.remove();

    const popup = L.DomUtil.create('div', 'info-popup modern-lightning-panel', map.getContainer());
    popup.id = 'lightning-popup';
    L.DomEvent.disableClickPropagation(popup);

    popup.innerHTML = `
        <div class="lightning-panel-header" id="lightning-panel-header">
            <div class="lightning-title">⚡ Configuració Llamps</div>
            <div class="panel-header-actions" style="display: flex; gap: 8px; align-items: center;">
                <button id="minimize-lightning-panel" class="close-panel-btn" style="font-size: 14px; font-weight: bold;">−</button>
                <button id="close-lightning-panel" class="close-panel-btn">&times;</button>
            </div>
        </div>
        
        <div id="lightning-panel-content">
            <div class="lightning-stats-bar" style="display: flex; gap: 10px; padding: 10px 16px; background: rgba(0,0,0,0.02); border-bottom: 1px solid rgba(0,0,0,0.03); font-size: 11px; font-weight: 600;">
                <!-- S'omplirà dinàmicament -->
            </div>

            <div class="lightning-options">
                <label class="custom-radio-label"><input type="radio" name="lightning-view" value="historic" checked> Mostrar Llamps i Històric</label>
            </div>
            
            <div id="historic-lightning-controls" class="lightning-subcontrols">
                 <label for="historic-lightning-slider" id="historic-lightning-label" class="styled-slider-label">Últims 120 minuts</label>
                 <input type="range" id="historic-lightning-slider" class="styled-range-slider" min="5" max="120" step="1" value="120">
            </div>
            
            <div id="analysis-mode-controls" class="lightning-subcontrols">
                <label class="custom-checkbox-label">
                    <input type="checkbox" id="auto-cell-detection-toggle" checked> Detecció Cèl·lules Tempesta
                </label>
                <label class="custom-checkbox-label" style="margin-top: 8px;">
                    <input type="checkbox" id="heatmap-mode-toggle"> Mapa de Densitat (Heatmap)
                </label>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 8px;">
                    <label class="custom-checkbox-label">
                        <input type="checkbox" id="audio-alerts-toggle"> Alertes Sonores
                    </label>
                    <button id="test-lightning-audio" style="font-size: 10px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 4px; padding: 2px 6px; cursor: pointer; color: #3b82f6;">Test 🔊</button>
                </div>
            </div>
        </div>
    `;

    // Inicialitzem les dades per primer cop
    updateLightningStats();

    const radios = popup.querySelectorAll('input[name="lightning-view"]');

    // Inicialitzem Draggable
    if (typeof makeDraggable === 'function') {
        makeDraggable(popup, document.getElementById('lightning-panel-header'));
    }

    const historicControls = document.getElementById('historic-lightning-controls');
    const slider = document.getElementById('historic-lightning-slider');
    const sliderLabel = document.getElementById('historic-lightning-label');
    const autoDetectToggle = document.getElementById('auto-cell-detection-toggle');
    autoDetectToggle.checked = isAutoDetectMode;

    radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                const mode = e.target.value;
                realtimeLightningManager.toggleHistoricLayers(mode);
                historicControls.style.display = (mode === 'historic') ? 'block' : 'none';
                document.getElementById('analysis-mode-controls').style.display = (mode === 'historic') ? 'block' : 'none';
            }
        });
    });

    const debouncedSetTimeFilter = debounce((minutes) => realtimeLightningManager.setTimeFilter(minutes), 100);

    slider.addEventListener('input', (e) => {
        const minutes = parseInt(e.target.value);
        sliderLabel.textContent = `Últims ${minutes} minuts`;
        debouncedSetTimeFilter(minutes);
    });

    autoDetectToggle.addEventListener('change', (e) => {
        isAutoDetectMode = e.target.checked;
        toggleAnalysisMode();
    });

    const heatmapToggle = document.getElementById('heatmap-mode-toggle');
    heatmapToggle.checked = realtimeLightningManager.heatmapMode;
    heatmapToggle.addEventListener('change', (e) => {
        realtimeLightningManager.heatmapMode = e.target.checked;
        realtimeLightningManager.refreshStyles();
    });

    const audioToggle = document.getElementById('audio-alerts-toggle');
    audioToggle.checked = realtimeLightningManager.audioAlertsActive;
    audioToggle.addEventListener('change', (e) => {
        realtimeLightningManager.audioAlertsActive = e.target.checked;
    });

    // Test d'àudio per inicialitzar l'AudioContext
    const testAudioBtn = document.getElementById('test-lightning-audio');
    if (testAudioBtn) {
        testAudioBtn.addEventListener('click', () => {
            realtimeLightningManager.playAudioAlert();
            testAudioBtn.textContent = "OK! ✅";
            setTimeout(() => { testAudioBtn.textContent = "Test 🔊"; }, 2000);
        });
    }

    const closeBtn = document.getElementById('close-lightning-panel');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (popup) popup.remove();
        });
    }

    // Lògica de minimitzar (IDÈNTICA A LES CONVERGÈNCIES)
    const minimizeBtn = document.getElementById('minimize-lightning-panel');
    const panelContent = document.getElementById('lightning-panel-content');

    if (minimizeBtn && panelContent) {
        minimizeBtn.addEventListener('click', () => {
            const isMinimized = popup.classList.toggle('minimized');
            panelContent.style.display = isMinimized ? 'none' : 'block';
            minimizeBtn.textContent = isMinimized ? '+' : '−';

            // Si estem maximitzant, eliminem l'amplada/alçada fixa que hagi pogut posar el draggable
            if (!isMinimized) {
                popup.style.removeProperty('width');
                popup.style.removeProperty('height');
                popup.style.removeProperty('border-radius');
                popup.style.removeProperty('padding');
                popup.style.removeProperty('display');
                popup.style.removeProperty('align-items');
                popup.style.removeProperty('justify-content');
            } else {
                // Quan minimitzem, forcem l'amplada segons l'estil del visor per a panells col·lapsats
                popup.style.width = '240px';
            }
        });
    }

    // Force historic mode by default since we merged them
    if (realtimeLightningManager.currentMode !== 'historic') {
        realtimeLightningManager.toggleHistoricLayers('historic');
    }

    // Assegurem l'estat inicial correcte de les eines de dibuix
    toggleAnalysisMode();
}

// Per a Velocitat i Ratxa (Semihorària i Diària) - LÒGICA UNIFICADA DE COLORS
async function displaySimpleWind(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    let timestampToUse;

    // Si és un resum diari (té 'summary'), la data és el dia sencer. Si no, és l'hora actual.
    if (config.summary) {
        timestampToUse = isHistoric ? targetDate : new Date();
    } else {
        timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());
        if (!isHistoric) { lastCheckedTimestamp = timestampToUse; }
    }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: config.summary ? 'summary' : 'simple_wind',
        timestamp: timestampToUse
    });

    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    let finalData;

    // ★ AQUÍ ESTÀ EL CANVI: Tria quina funció de dades fer servir ★
    if (config.summary === 'max') {
        // Si és Ratxa Diària -> Usem la nova funció diària
        finalData = await fetchAllDailyWindData(timestampToUse);
    } else {
        // Si és Instantani/Semihorari -> Usem la funció clàssica
        const dataType = (config.base_id === 30) ? 'speed' : 'gust';
        finalData = await fetchAllWindData(dataType, timestampToUse);
    }

    dataMarkersLayer.clearLayers();
    const filteredData = applyDataFilters(finalData.map(d => ({ ...d, valor: d.speed_ms * config.conversion })));

    filteredData.forEach(estacio => {
        // 1. Obtenim el valor base en m/s (que és com ve de l'API)
        let valueMs = parseFloat(estacio.speed_ms);
        if (isNaN(valueMs)) return;

        // 2. Calculem el valor en km/h PER AL COLOR (sempre)
        const valueInKmh = valueMs * 3.6;

        // 3. Calculem el valor A MOSTRAR segons la configuració (m/s o km/h)
        const displayValue = valueMs * config.conversion;

        // 4. Obtenim el color usant SEMPRE km/h (perquè getWindColor espera km/h)
        const color = getWindColor(valueInKmh);

        const formattedValue = displayValue.toFixed(config.decimals);

        const icon = L.divIcon({
            className: 'temp-label',
            html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
            iconSize: [30, 18],
            iconAnchor: [15, 9]
        });

        const marker = L.marker([estacio.lat, estacio.lon], { icon }).addTo(dataMarkersLayer);

        if (estacio.source === 'smc' || !estacio.source) {
            estacio.valor = displayValue;

            // Usem l'ID real trobat (ex: 56) si existeix, si no el base
            const variableIdPerGrafic = estacio.real_variable_id || config.base_id || config.id;

            const popupHTML = generateChartPopupHTML(estacio, variableIdPerGrafic, config);
            marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });

            marker.on('popupopen', () => {
                const canvasId = `chart-${estacio.codi_estacio}`;

                loadStationChart(
                    estacio.codi_estacio,
                    variableIdPerGrafic,
                    canvasId,
                    config.name,
                    24,
                    false,
                    false,
                    config.conversion,
                    { ...config, lat: estacio.lat, lon: estacio.lon },
                    timestampToUse
                );

                setupPopupEvents(estacio, variableIdPerGrafic, config, timestampToUse);
            });
        } else {
            // Fallback
            marker.bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${valueInKmh.toFixed(1)} km/h (${valueMs.toFixed(1)} m/s)`);
        }
    });
    isLoadingData = false;
}

// ★ REEMPLAÇA LA TEVA FUNCIÓ 'displayRovellonsIndex' PER AQUESTA ★
async function displayRovellonsIndex(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;
    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant ${config.name}... (càrrega intensiva)`) }).addTo(dataMarkersLayer);

    const dateForQuery = targetDate || new Date();
    updateHistoricDisplay({ mode: targetDate ? 'historic' : 'live', type: 'summary', timestamp: dateForQuery });

    const endDate = new Date(dateForQuery);
    const startDate = new Date(dateForQuery);
    startDate.setDate(startDate.getDate() - 20);

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));
        const promises = [];
        for (let i = 0; i < 20; i++) {
            const currentDate = new Date(startDate);
            currentDate.setDate(currentDate.getDate() + i);
            const startOfDay = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate(), 0, 0, 0, 0));
            const endOfDay = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate(), 23, 59, 59, 999));

            promises.push(fetchSmcDailySummary(35, 'sum', startOfDay, endOfDay));
            promises.push(fetchSmcDailySummary(42, 'min', startOfDay, endOfDay));
            promises.push(fetchSmcDailySummary(40, 'max', startOfDay, endOfDay));
            promises.push(fetchTrueDailyData(1505, currentDate));
            promises.push(fetchTrueDailyData(1504, currentDate));
            promises.push(fetchTrueDailyData(1503, currentDate));
        }

        const results = await Promise.all(promises);

        const stationAnalysis = new Map();
        results.forEach((result, index) => {
            if (!result || !result.data) return;
            const dataTypeIndex = index % 6;

            result.data.forEach(d => {
                const stationId = d.codi_estacio;
                if (!stationAnalysis.has(stationId)) {
                    stationAnalysis.set(stationId, { precipData: [], tminData: [], tmaxData: [], wind2mData: [], wind6mData: [], wind10mData: [] });
                }
                const value = parseFloat(d.valor || d.valor_lectura);
                if (!isNaN(value)) {
                    const s = stationAnalysis.get(stationId);
                    if (dataTypeIndex === 0) s.precipData.push(value);
                    else if (dataTypeIndex === 1) s.tminData.push(value);
                    else if (dataTypeIndex === 2) s.tmaxData.push(value);
                    else if (dataTypeIndex === 3) s.wind2mData.push(value * 3.6);
                    else if (dataTypeIndex === 4) s.wind6mData.push(value * 3.6);
                    else if (dataTypeIndex === 5) s.wind10mData.push(value * 3.6);
                }
            });
        });

        dataMarkersLayer.clearLayers();

        stationAnalysis.forEach((data, stationId) => {
            const stationInfo = estacionsMap.get(stationId);
            if (!stationInfo || data.precipData.length < 15) return;

            let puntsPluja = 0, puntsTempNoc = 0, penalitzacioTmax = 0, penalitzacioVent = 0, puntsLluna = 0;
            let diesVent = 0;
            let fontVent = "N/D";

            let dadesVentASumar = null;
            let llindarVent = 0;

            if (data.wind2mData.length > 0) {
                fontVent = "2m"; llindarVent = 8; dadesVentASumar = data.wind2mData;
            } else if (data.wind6mData.length > 0) {
                fontVent = "6m"; llindarVent = 12; dadesVentASumar = data.wind6mData;
            } else if (data.wind10mData.length > 0) {
                fontVent = "10m"; llindarVent = 15; dadesVentASumar = data.wind10mData;
            }

            if (dadesVentASumar) {
                diesVent = dadesVentASumar.filter(v => v > llindarVent).length;
            }
            penalitzacioVent = -Math.min(20, diesVent * 5);

            const precipTotal = data.precipData.reduce((a, b) => a + b, 0);
            if (precipTotal > 100) puntsPluja = 50; else if (precipTotal > 75) puntsPluja = 45;
            else if (precipTotal > 50) puntsPluja = 40; else if (precipTotal > 30) puntsPluja = 30;
            else if (precipTotal > 20) puntsPluja = 20;

            const diesFreds = data.tminData.filter(t => t < 5).length;
            const diesCalids = data.tminData.filter(t => t > 15).length;
            let basePuntsTemp = 0;
            if (diesFreds <= 1) basePuntsTemp += 20; else if (diesFreds <= 3) basePuntsTemp += 10;
            if (diesCalids <= 3) basePuntsTemp += 20; else if (diesCalids <= 6) basePuntsTemp += 10;
            puntsTempNoc = basePuntsTemp;

            const diesCalor = data.tmaxData.filter(t => t > 25).length;
            penalitzacioTmax = -Math.min(20, diesCalor * 5);

            const FASES_BONUS = ['🌖 Gibosa Minvant', '🌗 Quart Minvant', '🌘 Minvant'];
            const CICLE_LUNAR = 29.530588853; const DATA_NOVA_CONEGUDA = 2451549.5;
            const araEnDiesJulians = (Date.now() / 86400000) - 0.5 + 2440588;
            const faseActual = ((araEnDiesJulians - DATA_NOVA_CONEGUDA) / CICLE_LUNAR) % 1;
            const faseText = ['🌑 Nova', '🌒 Creixent', '🌓 Quart Creixent', '🌔 Gibosa Creixent', '🌕 Plena', '🌖 Gibosa Minvant', '🌗 Quart Minvant', '🌘 Minvant'][Math.floor(faseActual * 8)];
            if (FASES_BONUS.includes(faseText)) puntsLluna = 10;

            // ★ AQUESTA ÉS LA LÍNIA CORREGIDA: ARA SE SUMA 'puntsLluna' ★
            let score = puntsPluja + puntsTempNoc + penalitzacioTmax + penalitzacioVent + puntsLluna;
            const finalScore = Math.max(0, Math.min(100, Math.round(score)));

            const color = getDynamicColor(finalScore, config.colorScale);
            const formattedValue = finalScore.toFixed(config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18], iconAnchor: [15, 9]
            });

            const details = {
                precipitacioTotal: precipTotal, diesFreds, diesCalids, diesCalor, diesVent, fontVent,
                puntsPluja, puntsTempNoc, penalitzacioTmax, penalitzacioVent, puntsLluna
            };
            const popupContent = config.popupTemplate(stationInfo, finalScore, config, details);
            L.marker([stationInfo.lat, stationInfo.lon], { icon }).bindPopup(popupContent).addTo(dataMarkersLayer);
        });

    } catch (error) {
        console.error("Error a displayRovellonsIndex:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta històrica' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// ===================================================================
// FUNCIÓ CORREGIDA: DISPLAY SUMMARY VARIABLE
// Soluciona: Gràfics buits en estacions de vent de 2m i 6m
// ===================================================================
async function displaySummaryVariable(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    const isHistoric = targetDate !== null;
    let dateForDay = isHistoric ? targetDate : new Date();

    if (!isHistoric && config.id === 1000) {
        dateForDay = new Date();
        dateForDay.setDate(dateForDay.getDate() - 1);
    }

    if (!isHistoric && config.id !== 1000) {
        lastCheckedTimestamp = findLatestSmcTimestamp(new Date());
    }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'summary',
        timestamp: dateForDay
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    const globalPanel = document.getElementById('global-stats-panel');
    if (globalPanel) globalPanel.style.display = 'none';

    const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));

        let resultData = [];

        // --- BLOC DE DESCÀRREGA I FUSIÓ ---

        if (currentVariableKey.includes('wind_gust_daily')) {
            const gust_ids = [50, 53, 56]; // 10m, 6m, 2m
            const promises = gust_ids.map(id => fetchSmcDailySummary(id, 'max', startOfDay, endOfDay));
            const results = await Promise.all(promises);
            const finalGustMap = new Map();

            // AQUI ESTÀ LA CLAU: Use 'index' per saber quin ID estem processant
            results.forEach((res, index) => {
                if (res && res.data) {
                    res.data.forEach(d => {
                        const val = parseFloat(d.valor || d.valor_lectura);
                        if (!isNaN(val)) {
                            // Si és millor o nova, guardem l'objecte I TAMBÉ L'ID REAL (50, 53 o 56)
                            if (!finalGustMap.has(d.codi_estacio) || val > finalGustMap.get(d.codi_estacio).valor) {
                                finalGustMap.set(d.codi_estacio, {
                                    ...d,
                                    valor: val,
                                    real_variable_id: gust_ids[index] // <--- GUARDEM L'ID REAL
                                });
                            }
                        }
                    });
                }
            });
            resultData = Array.from(finalGustMap.values());

        } else if (config.id === 1000) {
            let fetchRes = await fetchTrueDailyData(1000, dateForDay);
            if (!fetchRes || fetchRes.data.length === 0) {
                fetchRes = await fetchSmcDailySummary(32, 'avg', startOfDay, endOfDay);
            }
            resultData = fetchRes.data.map(d => ({ ...d, valor: d.valor || d.valor_lectura }));
        } else {
            const fetchRes = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
            resultData = fetchRes.data.map(d => ({ ...d, valor: d.valor || d.valor_lectura }));
        }

        // ★ NOVA INTEGRACIÓ METEO GUILLERIES (TAMBÉ EN RESUMS DIARIS) ★
        if (!isHistoric && config.isMeteoGuilleriesCombined) {
            const mgData = await fetchMeteoGuilleriesData();
            if (mgData && mgData.length > 0) {
                // Afegim les dades de MG a resultData
                // resultData espera objectes amb { codi_estacio, valor, ... }
                // MG data té { nom, lat, lon, valor, source }
                // Com que resultData després es creua amb estacionsMap per codi_estacio, hem d'anar amb compte.
                // EL BLOC 'enrichedData' FILTRA SI NO TROBA L'ESTACIÓ AL MAPA DE METEOCAT.
                // PER TANT, HEM D'AFEGIR MG DIRECTAMENT A 'enrichedData' DESPRÉS.
            }
        }

        const enrichedData = resultData.map(d => {
            const stationInfo = estacionsMap.get(d.codi_estacio);
            return stationInfo ? { ...d, ...stationInfo } : null;
        }).filter(Boolean);

        // ★ ARA SÍ: AFEGIM METEO GUILLERIES DESPRÉS D'ENRIQUIR (PER NO NECESSITAR METADADES SMC)
        if (!isHistoric && config.isMeteoGuilleriesCombined) {
            const mgData = await fetchMeteoGuilleriesData();
            if (mgData && mgData.length > 0) {
                enrichedData.push(...mgData);
            }
        }

        dataMarkersLayer.clearLayers();
        const filteredData = applyDataFilters(enrichedData);


        // Panell global
        if (config.isGlobalAvg && filteredData.length > 0 && globalPanel) {
            const totalSum = filteredData.reduce((acc, curr) => acc + parseFloat(curr.valor), 0);
            const globalMean = totalSum / filteredData.length;
            const valDiv = document.getElementById('global-stats-value');
            const descDiv = document.getElementById('global-stats-count');
            let colorGlobal = '#fff';
            if (globalMean < 5) colorGlobal = '#aeeaff'; else if (globalMean > 25) colorGlobal = '#ff8787';
            valDiv.innerHTML = `${globalMean.toFixed(1)} ${config.unit}`;
            valDiv.style.color = colorGlobal;
            const dataText = dateForDay.toLocaleDateString('ca-ES', { day: '2-digit', month: '2-digit' });
            descDiv.innerText = `Mitjana de ${filteredData.length} estacions (${dataText})`;
            globalPanel.style.display = 'block';
        }

        if (filteredData.length === 0) {
            L.marker(map.getCenter(), { icon: createLoadingIcon('No hi ha dades disponibles per aquesta data.') }).addTo(dataMarkersLayer);
            return;
        }

        filteredData.forEach(estacio => {
            let value = Number(estacio.valor); if (isNaN(value)) return;

            if (config.conversion) { value *= config.conversion; }

            let color;
            let textColor = '#000000';

            // --- BLOC DE COLORS CORREGIT ---
            if (config.id === 50 || config.name.includes('Ratxa') || config.name.includes('Vent')) {
                const valForColor = (config.unit === 'm/s') ? value * 3.6 : value;
                color = getWindColor(valForColor);
            }
            else if (config.id === 35) {
                if (config.isDailyAccumulation || config.summary === 'sum') {
                    color = getDailyPrecipitationColor(value);
                    if (value > 80) textColor = '#FFFFFF';
                } else {
                    color = getSemihorariaPrecipColor(value);
                }
            }
            else if (config.id === 72) {
                color = getIntensityColor(value);
            }
            else if (config.id === 33 || config.id === 3 || config.id === 44) {
                color = getHumidityColor(value);
                textColor = getTextColorForHumidity(value);
            }
            else if (config.id === 34 || config.id === 1 || config.id === 2) {
                color = getPressureColor(value);
            }
            else {
                color = getTempRgbaColor(value);
            }

            const formattedValue = formatValueForLabel(value, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18], iconAnchor: [15, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], {
                icon: icon,
                valor: value  // <-- AQUESTA ÉS LA CLAU
            }).addTo(dataMarkersLayer);

            if (config.showRank) {
                marker.bindPopup(`
                    <b>${estacio.nom}</b><br>
                    <span style="font-size:14px; color:#333;">Mitjana Diària: <b>${formattedValue} ${config.unit}</b></span>
                    <div style="font-size:10px; color:#888;">Data: ${dateForDay.toLocaleDateString()}</div>
                    <hr style="margin: 8px 0;">
                    <div id="rank-loader-${estacio.codi_estacio}" style="font-size:12px; color:#666;">
                        ⏳ Calculant rànquing anual...
                    </div>
                `);
                marker.on('popupopen', async () => {
                    try {
                        const rankingData = await getStationYearlyRanking(estacio.codi_estacio, dateForDay.getFullYear(), value);
                        const rankContainer = document.getElementById(`rank-loader-${estacio.codi_estacio}`);
                        if (rankContainer) rankContainer.innerHTML = rankingData;
                    } catch (e) { }
                });

            } else if (estacio.source === 'smc' || !estacio.source) {
                // GRÀFIC
                estacio.valor = value;

                // ★ CORRECCIÓ AQUÍ: Usem l'ID real (ex: 56) si el tenim, si no el 50 per defecte
                let chartVarId = config.id;
                if (estacio.real_variable_id) {
                    chartVarId = estacio.real_variable_id;
                } else if (currentVariableKey.includes('wind_gust')) {
                    chartVarId = 50;
                }

                const popupHTML = generateChartPopupHTML(estacio, chartVarId, config);
                marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });

                marker.on('popupopen', () => {
                    const canvasId = `chart-${estacio.codi_estacio}`;
                    loadStationChart(estacio.codi_estacio, chartVarId, canvasId, config.name, 24, false, false, config.conversion, { ...config, lat: estacio.lat, lon: estacio.lon }, dateForDay);
                    setupPopupEvents(estacio, chartVarId, config, dateForDay);
                });
            } else {
                marker.bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`);
            }
        });

    } catch (error) {
        console.error("Error a displaySummaryVariable:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

/**
 * Calcula el rànquing anual OMPLINT ELS FORATS i aplicant un TALL NET (Hard Cutoff).
 * Garanteix que el recompte de dies sigui matemàticament perfecte (ex: 322 per al 18 de nov).
 */
async function getStationYearlyRanking(stationCode, year, currentValue, targetDateObj) {
    // Data límit (el dia que estem consultant)
    const targetDate = targetDateObj || new Date();
    // Normalitzem a format string YYYY-MM-DD per evitar problemes d'hores
    const targetDateStr = targetDate.toISOString().split('T')[0];

    // 1. Consultem l'historial OFICIAL (Var 1000)
    const startYearStr = `${year}-01-01T00:00:00`;
    const endYearStr = `${year}-12-31T23:59:59`;

    const queryOfficial = `$query=SELECT data_lectura, valor WHERE codi_estacio='${stationCode}' AND codi_variable='1000' AND data_lectura >= '${startYearStr}' AND data_lectura <= '${endYearStr}' ORDER BY data_lectura ASC LIMIT 400`;
    const urlOfficial = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${queryOfficial}&_=${Date.now()}`;

    try {
        const response = await fetch(urlOfficial);
        const dataOfficial = await response.json();

        const uniqueValues = new Map();
        let lastOfficialDateStr = null;

        if (dataOfficial && dataOfficial.length > 0) {
            dataOfficial.forEach(d => {
                const dateKey = d.data_lectura.split('T')[0];
                const val = parseFloat(d.valor);
                if (!isNaN(val)) {
                    uniqueValues.set(dateKey, val);
                    lastOfficialDateStr = dateKey;
                }
            });
        }

        // 2. DETECCIÓ I CÀLCUL DE FORATS
        if (lastOfficialDateStr) {
            let gapStart = new Date(lastOfficialDateStr);
            gapStart.setDate(gapStart.getDate() + 1);

            const gapEndStr = targetDateStr; // El dia que estem consultant
            const gapStartStr = gapStart.toISOString().split('T')[0];

            // Si hi ha dies al mig (ex: últim oficial 16, target 18 -> forat dia 17)
            if (gapStartStr < gapEndStr) {
                console.log(`⚡ Detectat forat: Del ${gapStartStr} al ${gapEndStr}.`);

                const queryGap = `$query=SELECT date_trunc_ymd(data_lectura) as dia, avg(valor_lectura) as valor WHERE codi_estacio='${stationCode}' AND codi_variable='32' AND data_lectura >= '${gapStartStr}T00:00:00' AND data_lectura < '${gapEndStr}T00:00:00' GROUP BY dia`;
                const urlGap = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${queryGap}&_=${Date.now()}`;

                try {
                    const responseGap = await fetch(urlGap);
                    const dataGap = await responseGap.json();

                    if (dataGap && dataGap.length > 0) {
                        dataGap.forEach(d => {
                            const val = parseFloat(d.valor);
                            const dateKey = d.dia.split('T')[0];
                            if (!isNaN(val) && !uniqueValues.has(dateKey)) {
                                uniqueValues.set(dateKey, val);
                            }
                        });
                    }
                } catch (err) { }
            }
        }

        // 3. AFEGIM EL VALOR ACTUAL (TARGET)
        if (!isNaN(currentValue)) {
            uniqueValues.set(targetDateStr, currentValue);
        }

        // ★★★ 4. EL TALL NET (HARD CUTOFF) ★★★
        // Aquest és el pas nou que soluciona el teu problema.
        // Eliminem qualsevol data que sigui POSTERIOR a la data objectiu.
        // Això evita que "Avui" (dia 323) es coli quan demanem "Ahir" (dia 322).
        for (const [dateKey, val] of uniqueValues) {
            if (dateKey > targetDateStr) {
                uniqueValues.delete(dateKey);
            }
        }

        // 5. PREPARAR DADES
        const allValues = Array.from(uniqueValues.values());

        if (allValues.length === 0) return `<div style="margin-top:10px; color:#999; font-size:11px;">Sense dades.</div>`;

        // Ordenem
        allValues.sort((a, b) => a - b);
        const totalDiesRegistrats = allValues.length;

        // 6. POSICIÓ
        let rankColdest = 1;
        let found = false;

        for (let i = 0; i < allValues.length; i++) {
            if (Math.abs(allValues[i] - currentValue) < 0.0001 && !found) {
                rankColdest = i + 1;
                found = true;
                break;
            }
        }
        // Fallback per aproximació
        if (!found) {
            rankColdest = 1;
            for (let i = 0; i < allValues.length; i++) {
                if (currentValue > allValues[i]) rankColdest++;
            }
        }

        const rankWarmest = totalDiesRegistrats - rankColdest + 1;

        // 7. HTML
        let textDescripcio = "";
        let colorEstil = "#333";

        if (rankColdest === 1) { textDescripcio = "🥇 EL DIA MÉS FRED DE L'ANY!"; colorEstil = "#0000cd"; }
        else if (rankWarmest === 1) { textDescripcio = "🥇 EL DIA MÉS CÀLID DE L'ANY!"; colorEstil = "#d32f2f"; }
        else if (rankColdest <= 5) { textDescripcio = `Top 5 Dies més Freds (#${rankColdest})`; colorEstil = "#1e90ff"; }
        else if (rankWarmest <= 5) { textDescripcio = `Top 5 Dies més Càlids (#${rankWarmest})`; colorEstil = "#ff5722"; }
        else { textDescripcio = `Dia #${rankColdest} més fred (de ${totalDiesRegistrats})`; }

        const percent = (rankColdest / totalDiesRegistrats) * 100;

        return `
            <div style="margin-top:8px; padding-top:8px; border-top:1px solid #eee;">
                <div style="font-weight:bold; color:${colorEstil}; margin-bottom:4px; text-align:center; font-size:12px;">${textDescripcio}</div>
                <div style="display:flex; justify-content:space-between; font-size:10px; color:#666; margin-bottom:2px;">
                    <span>Mín: ${allValues[0].toFixed(1)}°</span>
                    <span>Màx: ${allValues[totalDiesRegistrats - 1].toFixed(1)}°</span>
                </div>
                <div style="width:100%; height:10px; background:#eee; border-radius:5px; position:relative; border:1px solid #ccc;">
                    <div style="width:100%; height:100%; background: linear-gradient(to right, #3498db, #85c1e9, #f1c40f, #e74c3c); border-radius:5px; opacity:0.6;"></div>
                    <div style="position:absolute; left:${percent}%; top:-3px; width:4px; height:14px; background:#000; border:1px solid #fff; transform:translateX(-50%); box-shadow: 1px 1px 2px rgba(0,0,0,0.3);"></div>
                </div>
                <div style="text-align:center; font-size:10px; margin-top:3px; color:#888;">
                    Posició ${rankColdest} de ${totalDiesRegistrats} dies registrats
                </div>
            </div>
        `;

    } catch (error) {
        console.error("Error al ranking:", error);
        return `<div style="margin-top:10px; color:red; font-size:11px;">Error càlcul.</div>`;
    }
}

/**
 * Genera un mapa on cada etiqueta és la posició del rànquing de fred de l'any.
 * VERSIÓ ESTÈTICA: Popup compacte i centrat.
 */
async function displayRankingMap(config) {
    if (isLoadingData) return; isLoadingData = true;

    const now = new Date();
    const currentYear = now.getFullYear();

    updateHistoricDisplay({ mode: 'live', type: 'summary', timestamp: now });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant Rànquing ${currentYear} (pot trigar)...`) }).addTo(dataMarkersLayer);
    const globalPanel = document.getElementById('global-stats-panel');
    if (globalPanel) globalPanel.style.display = 'none';

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT codi_estacio, nom_estacio, latitud, longitud, altitud";
        const metadata = await $.getJSON(urlMetadades);

        const estacionsMap = new Map(metadata.map(e => [
            e.codi_estacio,
            {
                nom: e.nom_estacio,
                lat: parseFloat(e.latitud),
                lon: parseFloat(e.longitud),
                altitud: parseFloat(e.altitud)
            }
        ]));

        // PAS 1: DADES D'AVUI
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
        const currentIso = now.toISOString().slice(0, 19);
        const startIso = startOfDay.toISOString().slice(0, 19);

        const urlAvui = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT codi_estacio, avg(valor_lectura) as valor WHERE data_lectura >= '${startIso}' AND data_lectura <= '${currentIso}' AND codi_variable = '32' GROUP BY codi_estacio LIMIT 5000&_=${Date.now()}`;
        const dadesAvui = await $.getJSON(urlAvui);
        const mapAvui = new Map(dadesAvui.map(d => [d.codi_estacio, parseFloat(d.valor)]));

        // PAS 2: HISTORIAL OFICIAL
        const yearStart = `${currentYear}-01-01T00:00:00`;
        const yearEnd = `${currentYear}-12-31T23:59:59`;
        const urlHistory = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?$query=SELECT codi_estacio, valor, data_lectura WHERE codi_variable='1000' AND data_lectura >= '${yearStart}' AND data_lectura <= '${yearEnd}' LIMIT 200000&_=${Date.now()}`;
        const dadesHistory = await $.getJSON(urlHistory);

        const mapHistory = new Map();
        let maxGlobalDateStr = `${currentYear}-01-01`;

        dadesHistory.forEach(d => {
            if (!mapHistory.has(d.codi_estacio)) {
                mapHistory.set(d.codi_estacio, { values: [], maxDate: '0000-00-00' });
            }
            const val = parseFloat(d.valor);
            if (!isNaN(val)) {
                const entry = mapHistory.get(d.codi_estacio);
                entry.values.push(val);
                const dateStr = d.data_lectura.split('T')[0];
                if (dateStr > entry.maxDate) entry.maxDate = dateStr;
                if (dateStr > maxGlobalDateStr) maxGlobalDateStr = dateStr;
            }
        });

        // PAS 3: GAP FILLING
        let gapStartDate = new Date(maxGlobalDateStr);
        gapStartDate.setDate(gapStartDate.getDate() + 1);
        gapStartDate.setUTCHours(0, 0, 0, 0);

        let gapEndDate = new Date(now);
        gapEndDate.setUTCHours(0, 0, 0, 0);

        if (gapStartDate < gapEndDate) {
            const gapStartStr = gapStartDate.toISOString().slice(0, 19);
            const gapEndStr = gapEndDate.toISOString().slice(0, 19);
            console.log(`⚡ Rànquing Massiu: Recuperant forat automàtic del ${gapStartStr} al ${gapEndStr}...`);

            const urlGap = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT codi_estacio, date_trunc_ymd(data_lectura) as dia, avg(valor_lectura) as valor WHERE codi_variable='32' AND data_lectura >= '${gapStartStr}' AND data_lectura < '${gapEndStr}' GROUP BY codi_estacio, dia LIMIT 50000&_=${Date.now()}`;

            try {
                const dadesGap = await $.getJSON(urlGap);
                dadesGap.forEach(d => {
                    const val = parseFloat(d.valor);
                    if (!mapHistory.has(d.codi_estacio)) {
                        mapHistory.set(d.codi_estacio, { values: [], maxDate: '0000-00-00' });
                    }
                    if (!isNaN(val)) {
                        mapHistory.get(d.codi_estacio).values.push(val);
                    }
                });
                console.log(`   -> Afegits ${dadesGap.length} registres diaris recuperats.`);
            } catch (e) {
                console.error("Error recuperant gap massiu:", e);
            }
        }

        // PAS 4: PINTAT
        dataMarkersLayer.clearLayers();
        let count = 0;

        estacionsMap.forEach((info, code) => {
            if (mapAvui.has(code)) {
                const valAvui = mapAvui.get(code);

                let historialValues = [];
                if (mapHistory.has(code)) {
                    historialValues = mapHistory.get(code).values;
                }

                historialValues.push(valAvui);
                historialValues.sort((a, b) => a - b);
                const totalDies = historialValues.length;

                let rank = 1;
                for (let i = 0; i < historialValues.length; i++) {
                    if (Math.abs(historialValues[i] - valAvui) < 0.0001) {
                        rank = i + 1;
                        break;
                    }
                }
                if (rank === 1 && Math.abs(historialValues[0] - valAvui) > 0.0001) {
                    for (let i = 0; i < historialValues.length; i++) {
                        if (valAvui > historialValues[i]) rank++;
                    }
                }

                let color = getDynamicColor(rank, config.colorScale);
                let textColor = '#000';
                let labelContent = `#${rank}`;
                let border = 'none';
                let zIndex = 0;

                if (rank === 1) {
                    color = '#00008b';
                    textColor = '#fff';
                    labelContent = '🥇';
                    border = '2px solid gold';
                    zIndex = 1000;
                } else if (rank <= 5) {
                    textColor = '#fff';
                } else if (rank > 300) {
                    textColor = '#fff';
                }

                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; border:${border}; display: flex; align-items: center; justify-content: center; font-weight:bold; font-size:11px;">${labelContent}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                const marker = L.marker([info.lat, info.lon], { icon, zIndexOffset: zIndex });

                // ★ ESTIL COMPACTE DEL POPUP ★
                // Definim una amplada fixa petita i centrem el text
                const popupContent = `
                    <div style="width: 180px; text-align: center;">
                        <b style="font-size: 15px;">${info.nom}</b><br>
                        <div style="margin-top: 4px; font-size: 13px;">
                            Mitjana Avui: <b>${valAvui.toFixed(1)} °C</b>
                        </div>
                        <hr style="margin: 8px 0; border: 0; border-top: 1px solid #ddd;">
                        <div style="background: #f0f0f0; padding: 5px; border-radius: 5px;">
                            <div style="font-weight: bold; font-size: 16px; color: #333;">RÀNQUING: #${rank}</div>
                            <div style="font-size: 11px; color: #666;">(de ${totalDies} dies registrats el ${currentYear})</div>
                        </div>
                        <div style="margin-top: 8px; font-style: italic; font-size: 11px; color: #888;">
                            #1 = Dia més fred de l'any
                        </div>
                    </div>
                `;
                marker.bindPopup(popupContent, {
                    className: 'ranking-popup', // Classe personalitzada
                    minWidth: 150,              // Mínim estret
                    maxWidth: 180               // Màxim limitat
                }).addTo(dataMarkersLayer);

                count++;
            }
        });

        if (count === 0) {
            L.marker(map.getCenter(), {
                icon: createLoadingIcon("No s'han trobat dades suficients.")
            }).addTo(dataMarkersLayer);
        }

    } catch (error) {
        console.error("Error al mapa de rànquing:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error de càlcul massiu' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}


/**
 * ★ VERSIÓ 2: Calcula i mostra la xafogor nocturna mínima en HORA LOCAL (00:00 a 08:00) ★
 * Aquesta versió millorada converteix l'interval local a UTC i afegeix l'hora
 * del mínim al popup informatiu de l'estació.
 */
async function displayNightHumidexMin(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    const dateForQuery = targetDate || new Date();
    updateHistoricDisplay({
        mode: targetDate ? 'historic' : 'live',
        type: 'summary',
        timestamp: dateForQuery
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    // ★ INICI DE LA MODIFICACIÓ D'HORA LOCAL ★
    // 1. Definim l'inici i el final de la nit en HORA LOCAL.
    const startOfLocalNight = new Date(dateForQuery.getFullYear(), dateForQuery.getMonth(), dateForQuery.getDate(), 0, 0, 0);
    const endOfLocalNight = new Date(dateForQuery.getFullYear(), dateForQuery.getMonth(), dateForQuery.getDate(), 8, 0, 0);

    // 2. Creem la llista de timestamps, avançant en hora local. El codi els convertirà a UTC automàticament.
    const timestamps = [];
    let currentTime = new Date(startOfLocalNight);
    while (currentTime <= endOfLocalNight) {
        timestamps.push(new Date(currentTime));
        currentTime.setMinutes(currentTime.getMinutes() + 30); // Avancem 30 minuts
    }
    // ★ FINAL DE LA MODIFICACIÓ D'HORA LOCAL ★

    const tempPromises = timestamps.map(ts => fetchSmcData(config.sources.temp, ts));
    const rhPromises = timestamps.map(ts => fetchSmcData(config.sources.rh, ts));

    try {
        const tempResults = await Promise.all(tempPromises);
        const rhResults = await Promise.all(rhPromises);

        const stationData = new Map();
        const collateData = (results, type) => {
            results.forEach(result => {
                if (result.data) {
                    result.data.forEach(reading => {
                        if (!stationData.has(reading.codi_estacio)) {
                            stationData.set(reading.codi_estacio, {
                                nom: reading.nom,
                                lat: reading.lat,
                                lon: reading.lon,
                                readings: new Map()
                            });
                        }
                        const stationEntry = stationData.get(reading.codi_estacio);
                        const tsKey = new Date(reading.timestamp).getTime();
                        if (!stationEntry.readings.has(tsKey)) {
                            stationEntry.readings.set(tsKey, {});
                        }
                        stationEntry.readings.get(tsKey)[type] = parseFloat(reading.valor);
                    });
                }
            });
        };

        collateData(tempResults, 'temp');
        collateData(rhResults, 'rh');

        const finalResults = [];
        stationData.forEach((data, stationId) => {
            let minHumidex = Infinity;
            let tempAtMin = null;
            let rhAtMin = null;
            let timeOfMin = null; // ★ Variable per guardar l'hora del mínim

            data.readings.forEach((reading, ts) => {
                if (reading.temp !== undefined && reading.rh !== undefined) {
                    const temp = reading.temp;
                    const hr = reading.rh;

                    const currentHumidex = calculateHeatIndex(temp, hr);

                    if (currentHumidex < minHumidex) {
                        minHumidex = currentHumidex;
                        tempAtMin = temp;
                        rhAtMin = hr;
                        timeOfMin = ts; // ★ Guardem el timestamp exacte del mínim
                    }
                }
            });

            if (minHumidex !== Infinity) {
                finalResults.push({
                    codi_estacio: stationId,
                    nom: data.nom,
                    lat: data.lat,
                    lon: data.lon,
                    min_humidex: minHumidex,
                    temp_at_min: tempAtMin,
                    rh_at_min: rhAtMin,
                    time_of_min: timeOfMin // ★ Afegim l'hora als resultats finals
                });
            }
        });

        dataMarkersLayer.clearLayers();

        // NOU: Aplicar filtres
        const filteredData = applyDataFilters(finalResults.map(s => ({ ...s, valor: s.min_humidex })));

        if (filteredData.length === 0) { // <-- Canviat a filteredData
            L.marker(map.getCenter(), { icon: createLoadingIcon('No hi ha dades (o estan filtrades).') }).addTo(dataMarkersLayer); // <-- Missatge canviat
            setTimeout(() => dataMarkersLayer.clearLayers(), 3000);
            return;
        }

        filteredData.forEach(station => {
            const value = station.min_humidex;
            let color, labelText, textColor = '#000000';

            if (value < 20) {
                labelText = '0';
                color = '#37d05bff';
            } else if (value >= 20 && value <= 25) {
                labelText = formatValueForLabel(value, config.decimals);
                color = '#ffb907ff';
            } else {
                labelText = formatValueForLabel(value, config.decimals);
                color = '#e82e40ff';
            }

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${labelText}</div>`,
                iconSize: [30, 18],
                iconAnchor: [15, 9]
            });

            // ★ MODIFICACIÓ DEL POPUP ★
            // Creem un objecte Date amb l'hora del mínim i el formatem a hora local (HH:mm)
            const timeString = new Date(station.time_of_min).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });

            const popupContent = `<b>${station.nom}</b><br><hr style="margin: 4px 0;">
                Temperatura: ${station.temp_at_min.toFixed(1)} °C<br>
                Humitat Relativa: ${station.rh_at_min.toFixed(0)} %<br>
                <hr style="margin: 4px 0;">
                <b>Xafogor Nocturn Mínim: ${station.min_humidex.toFixed(1)} °C</b><br>
                <span style="font-size: smaller;">(Registrat a les ${timeString}h)</span>`;

            L.marker([station.lat, station.lon], { icon: icon, value: value })
                .bindPopup(popupContent)
                .addTo(dataMarkersLayer);
        });

    } catch (error) {
        console.error("Error a displayNightHumidexMin:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

/**
 * Funció per calcular les coordenades del mosaic de l'API de Weather.com
 * a partir de les coordenades del mapa de Leaflet.
 */
function getTileCoordinates(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor(n * ((lon + 180) / 360));
    const y = Math.floor(n * (1 - (Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI)) / 2);
    return { x: x, y: y };
}

/**
 * Arrodoneix un objecte Date al minut anterior més proper (múltiple de 15).
 * Exemple: 12:10 -> 12:00. 12:20 -> 12:15.
 * @param {Date} date - La data a arrodonir.
 * @returns {Date} La data arrodonida.
 */
function roundToNearest15Minutes(date) {
    const d = new Date(date);
    const minutes = d.getMinutes();
    const roundedMinutes = Math.floor(minutes / 15) * 15;
    d.setMinutes(roundedMinutes, 0, 0);
    return d;
}

// Les funcions auxiliars roundToNearest15Minutes() i getTileCoordinates() es mantenen igual.
async function displayWeatherComPrecipitation() {
    if (isLoadingData) return;
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon('Carregant dades...') }).addTo(dataMarkersLayer);

    const config = VARIABLES_CONFIG['weathercom_precip'];
    const weatherComApiKey = "e1f10a1e78da46f5b10a1e78da96f525";

    const mapZoom = Math.round(map.getZoom());
    const fetchZoomLevel = Math.min(mapZoom + 5, 12);
    const bounds = map.getBounds();
    const tileZoom = fetchZoomLevel - 1;

    const topLeftTile = getTileCoordinates(bounds.getNorthWest().lat, bounds.getNorthWest().lng, tileZoom);
    const bottomRightTile = getTileCoordinates(bounds.getSouthEast().lat, bounds.getSouthEast().lng, tileZoom);

    const promises = [];
    const now = new Date();
    const roundedDate = roundToNearest15Minutes(now);
    const timeEnd = roundedDate.getTime();
    const timeStart = timeEnd - (15 * 60 * 1000);

    for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
            const url = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart}-${timeEnd}&stepped=true`;
            promises.push(fetch(url).then(res => res.ok ? res.json() : null));
        }
    }

    try {
        const results = await Promise.all(promises);
        const rawStations = [];

        results.forEach(data => {
            if (!data) return;
            const key = `${timeStart}-${timeEnd}`;
            if (data.hasOwnProperty(key) && data[key].features) {
                data[key].features.forEach(feature => {
                    const properties = feature.properties;
                    const dailyRainInches = properties.dailyrainin;

                    if (dailyRainInches !== null) {
                        rawStations.push({
                            lat: feature.geometry.coordinates[1],
                            lon: feature.geometry.coordinates[0],
                            valor: dailyRainInches * 25.4, // Convertim a mm (Número)
                            nom: properties.neighborhood,
                            altitud: null
                        });
                    }
                });
            }
        });

        // Eliminem duplicats
        const uniqueStations = new Map();
        rawStations.forEach(s => uniqueStations.set(`${s.lat},${s.lon}`, s));
        const uniqueArray = Array.from(uniqueStations.values());

        // ★ APLICAR FILTRES (Ara funcionarà bé amb números)
        const filteredData = applyDataFilters(uniqueArray);

        dataMarkersLayer.clearLayers();

        if (filteredData.length === 0) {
            L.marker(map.getCenter(), { icon: createLoadingIcon('No hi ha dades (o estan filtrades).') }).addTo(dataMarkersLayer);
        } else {
            filteredData.forEach(estacio => {
                const rainMm = estacio.valor;
                const color = getDailyPrecipitationColor(rainMm);

                // ★ NOVA LÍNIA: Color blanc si supera 100mm (Això faltava)
                const textColor = rainMm > 80 ? '#FFFFFF' : '#000000';

                const formattedValue = formatValueForLabel(rainMm, 1);
                const icon = L.divIcon({
                    className: 'temp-label',
                    // ★ AFEGIM 'color: ${textColor}' A L'HTML
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                L.marker([estacio.lat, estacio.lon], {
                    icon: icon,
                    valor: rainMm // <-- Guardem el valor en mm
                })
                    .bindPopup(`<b>${estacio.nom}</b><br>Acumulació diària: ${formattedValue} ${config.unit}`)
                    .addTo(dataMarkersLayer);
            });
        }
    } catch (error) {
        console.error("Error carregant les dades de Weather.com:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}
async function displayWeatherComSemiHourlyPrecipitation() {
    if (isLoadingData) return;
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon('Carregant dades...') }).addTo(dataMarkersLayer);

    const config = { name: 'Precipitació Semihorària Express', unit: 'mm', decimals: 1 };
    const weatherComApiKey = "e1f10a1e78da46f5b10a1e78da96f525";

    const mapZoom = Math.round(map.getZoom());
    const fetchZoomLevel = Math.min(mapZoom + 1, 12);
    const bounds = map.getBounds();
    const tileZoom = fetchZoomLevel - 1;
    const topLeftTile = getTileCoordinates(bounds.getNorthWest().lat, bounds.getNorthWest().lng, tileZoom);
    const bottomRightTile = getTileCoordinates(bounds.getSouthEast().lat, bounds.getSouthEast().lng, tileZoom);

    const now = new Date();
    const roundedDate = roundToNearest15Minutes(now);
    const timeEnd1 = roundedDate.getTime();
    const timeStart1 = timeEnd1 - (15 * 60 * 1000);
    const timeEnd2 = timeStart1;
    const timeStart2 = timeEnd2 - (15 * 60 * 1000);

    const promises = [];
    for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
            const url1 = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart1}-${timeEnd1}&stepped=true`;
            const url2 = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart2}-${timeEnd2}&stepped=true`;
            promises.push(fetch(url1).then(res => res.ok ? res.json() : null));
            promises.push(fetch(url2).then(res => res.ok ? res.json() : null));
        }
    }

    try {
        const allResults = await Promise.all(promises);
        const stationTotals = new Map();

        allResults.forEach(data => {
            if (!data) return;
            Object.keys(data).forEach(key => {
                if (data[key].features) {
                    data[key].features.forEach(feature => {
                        const id = feature.properties.id || `${feature.properties.neighborhood}-${feature.geometry.coordinates.join(',')}`;
                        const rainInches = feature.properties.rainin || 0;
                        if (stationTotals.has(id)) {
                            stationTotals.get(id).totalRainInches += rainInches;
                        } else {
                            stationTotals.set(id, { feature: feature, totalRainInches: rainInches });
                        }
                    });
                }
            });
        });

        const rawArray = [];
        stationTotals.forEach(stationData => {
            rawArray.push({
                lat: stationData.feature.geometry.coordinates[1],
                lon: stationData.feature.geometry.coordinates[0],
                valor: stationData.totalRainInches * 25.4, // Convertim a mm
                nom: stationData.feature.properties.neighborhood,
                altitud: null
            });
        });

        // ★ APLICAR FILTRES
        const filteredData = applyDataFilters(rawArray);

        dataMarkersLayer.clearLayers();

        if (filteredData.length === 0) {
            L.marker(map.getCenter(), { icon: createLoadingIcon('No hi ha dades (o estan filtrades).') }).addTo(dataMarkersLayer);
        } else {
            filteredData.forEach(estacio => {
                const rainMm = estacio.valor;
                const color = getSemihorariaPrecipColor(rainMm);
                const formattedValue = formatValueForLabel(rainMm, 1);
                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18], iconAnchor: [15, 9]
                });
                L.marker([estacio.lat, estacio.lon], { icon: icon })
                    .bindPopup(`<b>${estacio.nom}</b><br>Precipitació (30 min): ${formattedValue} ${config.unit}`)
                    .addTo(dataMarkersLayer);
            });
        }
    } catch (error) {
        console.error("Error Weather.com Semihorari:", error);
        dataMarkersLayer.clearLayers();
    } finally {
        isLoadingData = false;
    }
}

async function displayWeatherComTemperature() {
    if (isLoadingData) return;
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon('Carregant dades...') }).addTo(dataMarkersLayer);

    const config = VARIABLES_CONFIG['weathercom_temp'];
    const weatherComApiKey = "e1f10a1e78da46f5b10a1e78da96f525";

    // Càlcul de zoom i coordenades (Igual que a Precipitació Express)
    const mapZoom = Math.round(map.getZoom());
    const fetchZoomLevel = Math.min(mapZoom + 1, 12);
    const bounds = map.getBounds();
    const tileZoom = fetchZoomLevel - 1;

    const topLeftTile = getTileCoordinates(bounds.getNorthWest().lat, bounds.getNorthWest().lng, tileZoom);
    const bottomRightTile = getTileCoordinates(bounds.getSouthEast().lat, bounds.getSouthEast().lng, tileZoom);

    const promises = [];
    const now = new Date();
    const roundedDate = roundToNearest15Minutes(now);
    const timeEnd = roundedDate.getTime();
    const timeStart = timeEnd - (15 * 60 * 1000);

    for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
            const url = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart}-${timeEnd}&stepped=true`;
            promises.push(fetch(url).then(res => res.ok ? res.json() : null));
        }
    }

    try {
        const results = await Promise.all(promises);
        const rawStations = [];

        results.forEach(data => {
            if (!data) return;
            const key = `${timeStart}-${timeEnd}`;
            if (data.hasOwnProperty(key) && data[key].features) {
                data[key].features.forEach(feature => {
                    const properties = feature.properties;
                    // --- CANVI CLAU: Llegim 'tempf' ---
                    const tempF = properties.tempf;

                    if (tempF !== null && tempF !== undefined) {
                        // Convertim Fahrenheit a Celsius: (F - 32) * 5/9
                        const tempC = (tempF - 32) * 5 / 9;

                        rawStations.push({
                            lat: feature.geometry.coordinates[1],
                            lon: feature.geometry.coordinates[0],
                            valor: tempC, // Guardem el valor en Celsius
                            nom: properties.neighborhood || 'Ubicació Express',
                            altitud: null // Aquesta API no sol donar altitud, així que serà null
                        });
                    }
                });
            }
        });

        // Eliminem duplicats (per si se superposen tiles)
        const uniqueStations = new Map();
        rawStations.forEach(s => uniqueStations.set(`${s.lat.toFixed(4)},${s.lon.toFixed(4)}`, s));
        const uniqueArray = Array.from(uniqueStations.values());

        // ★ APLICAR FILTRES (Filtre de valors funcionarà, el d'altitud només si trobem com treure-la)
        const filteredData = applyDataFilters(uniqueArray);

        dataMarkersLayer.clearLayers();

        if (filteredData.length === 0) {
            L.marker(map.getCenter(), { icon: createLoadingIcon('No hi ha dades o estan filtrades.') }).addTo(dataMarkersLayer);
        } else {
            filteredData.forEach(estacio => {
                const tempValue = estacio.valor;

                // --- CANVI CLAU: Usem l'escala de TEMPERATURA ---
                const color = getTempRgbaColor(tempValue);
                const formattedValue = formatValueForLabel(tempValue, 1);

                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                L.marker([estacio.lat, estacio.lon], { icon: icon })
                    .bindPopup(`<b>${estacio.nom}</b><br>Temperatura: ${formattedValue} ${config.unit}`)
                    .addTo(dataMarkersLayer);
            });
        }
    } catch (error) {
        console.error("Error carregant Temperatura Express:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}


async function displayEcowittPrecipitation() {
    if (isLoadingData) return;
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), {
        icon: createLoadingIcon("Carregant dades d'Ecowitt...")
    }).addTo(dataMarkersLayer);

    const config = VARIABLES_CONFIG['ecowitt_precip'];
    const url = 'https://meteo-api.projecte4estacions.com/api/ecowitt/stations';
    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const requestZoom = Math.min(map.getZoom(), 8);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lngsw: sw.lng, latsw: sw.lat, lngne: ne.lng, latne: ne.lat, zoom: requestZoom })
        });

        if (!response.ok) throw new Error(`Error del proxy: ${response.statusText}`);
        const geojsonData = await response.json();
        dataMarkersLayer.clearLayers();

        const featuresLose = geojsonData.data_lose?.features || [];
        const featuresMeter = geojsonData.data_meter?.features || [];
        const allFeatures = [...featuresLose, ...featuresMeter];

        if (!allFeatures || allFeatures.length === 0) {
            L.marker(map.getCenter(), {
                icon: createLoadingIcon("No hi ha estacions d'Ecowitt.")
            }).addTo(dataMarkersLayer);
            return;
        }

        const rawStations = [];
        allFeatures.forEach(feature => {
            const props = feature.properties;
            let rainValue = null;
            if (typeof props.dailyrainin === 'number') rainValue = props.dailyrainin;
            else if (typeof props.drain_piezo === 'number') rainValue = props.drain_piezo;

            if (props.isdata === 1 && rainValue !== null) {
                rawStations.push({
                    lat: feature.geometry.coordinates[1],
                    lon: feature.geometry.coordinates[0],
                    valor: rainValue, // Aquest valor ja és numèric
                    nom: props.name || 'Estació Ecowitt',
                    altitud: props.altitude ? parseFloat(props.altitude) : null
                });
            }
        });

        // ★ APLICAR FILTRES
        const filteredData = applyDataFilters(rawStations);

        filteredData.forEach(estacio => {
            const rainMm = estacio.valor;
            const color = getDailyPrecipitationColor(rainMm);

            // ★ NOVA LÍNIA: Color blanc si supera 100mm
            const textColor = rainMm > 80 ? '#FFFFFF' : '#000000';

            const formattedValue = formatValueForLabel(rainMm, 1);
            const icon = L.divIcon({
                className: 'temp-label',
                // ★ AFEGEIX 'color: ${textColor}' A L'HTML
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18],
                iconAnchor: [15, 9]
            });

            L.marker([estacio.lat, estacio.lon], { icon: icon })
                .bindPopup(`<b>${estacio.nom}</b><br>Acumulació diària: ${formattedValue} ${config.unit}`)
                .addTo(dataMarkersLayer);
        });

    } catch (error) {
        console.error("Error Ecowitt:", error);
        dataMarkersLayer.clearLayers();
    } finally {
        isLoadingData = false;
    }
}

// Assegura't que la teva funció displayWindBarb quedi així
async function displayWindBarb(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'wind_barb',
        timestamp: timestampToUse
    });

    // Netejar marcadors existents
    dataMarkersLayer.clearLayers();

    // Netejar capa d'allaus si existeix
    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }

    windBarbsLayer.clearLayers();

    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(windBarbsLayer);

    // Obtenim les dades (Velocitat Mitjana per defecte o Ratxa)
    const windType = config.windType || 'speed';
    const finalData = await fetchAllWindData(windType, timestampToUse);

    windBarbsLayer.clearLayers();

    finalData.forEach(estacio => {
        const { lat, lon, nom, speed_ms, direction, real_variable_id } = estacio;

        if (isNaN(speed_ms) || isNaN(direction)) return;

        // Creem la icona (ara amb el puntet petit)
        const icon = createWindBarbIcon(speed_ms, direction);

        const marker = L.marker([lat, lon], { icon }).addTo(windBarbsLayer);

        // ==========================================================
        // LÒGICA DE GRÀFIC (POPUP)
        // ==========================================================
        if (estacio.source === 'smc' || !estacio.source) {
            // Preparem el valor per al títol del popup
            estacio.valor = speed_ms * 3.6; // Convertim a km/h per mostrar al títol

            // Usem l'ID real (ex: 30, 48...) o un per defecte (30 = vent 10m)
            // Creem una config temporal per al gràfic perquè mostri unitats correctes
            const chartConfig = {
                ...config,
                unit: 'km/h',
                conversion: 3.6 // Assegurem que el gràfic pinti km/h
            };

            const chartVarId = real_variable_id || 30;

            const popupHTML = generateChartPopupHTML(estacio, chartVarId, chartConfig);
            marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });

            marker.on('popupopen', () => {
                const canvasId = `chart-${estacio.codi_estacio}`;

                loadStationChart(
                    estacio.codi_estacio,
                    chartVarId,
                    canvasId,
                    config.name,
                    24,
                    false,
                    false,
                    chartConfig.conversion,
                    { ...chartConfig, lat: estacio.lat, lon: estacio.lon },
                    timestampToUse
                );

                setupPopupEvents(estacio, chartVarId, chartConfig, timestampToUse);
            });
        } else {
            // Fallback per a AEMET (sense gràfic per ara)
            marker.bindPopup(`<b>${nom}</b><br>Velocitat: ${(speed_ms * 3.6).toFixed(1)} km/h<br>Direcció: ${direction.toFixed(0)}°`);
        }
    });

    isLoadingData = false;
    hideMapLoader();

    // SYNC 3D STATIONS
    if (typeof is3DMode !== 'undefined' && is3DMode && typeof sync3DStations === 'function') {
        sync3DStations(filteredData, config.id);
    }
}

// Per al Punt de Rosada
async function displayDewPoint(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    if (!isHistoric) { lastCheckedTimestamp = timestampToUse; }

    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'hybrid',
        timestamp: timestampToUse
    });

    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    try {
        const smcPromises = [fetchSmcData(config.smc_sources.temp, timestampToUse), fetchSmcData(config.smc_sources.rh, timestampToUse)];
        const finalPromises = isHistoric ? smcPromises : [...smcPromises, fetchAemetData()];
        const [smcTemp, smcHumidity, aemetRawData] = await Promise.all(finalPromises);
        const finalData = [];
        const smcHumidityMap = new Map(smcHumidity.data.map(d => [d.codi_estacio, d.valor]));
        smcTemp.data.forEach(station => {
            if (smcHumidityMap.has(station.codi_estacio)) {
                const temp = parseFloat(station.valor), rh = parseFloat(smcHumidityMap.get(station.codi_estacio));
                if (isNaN(temp) || isNaN(rh) || rh <= 0) return;
                const log_rh = Math.log(rh / 100), temp_frac = (17.625 * temp) / (243.04 + temp);
                finalData.push({ ...station, valor: (243.04 * (log_rh + temp_frac)) / (17.625 - log_rh - temp_frac) });
            }
        });
        if (!isHistoric && aemetRawData && aemetRawData.length > 0 && typeof contornCatGeojson !== 'undefined') {
            const catalunyaPolygon = contornCatGeojson.features[0];
            const estacionsAemetCat = aemetRawData.filter(d => {
                if (d.lat && d.lon) {
                    const point = turf.point([d.lon, d.lat]);
                    return turf.booleanPointInPolygon(point, catalunyaPolygon);
                }
                return false;
            });

            if (estacionsAemetCat.length > 0) {
                const estacionsIdemaMap = new Map();
                estacionsAemetCat.forEach(d => {
                    if (typeof d[config.aemet_id] !== 'undefined') {
                        if (!estacionsIdemaMap.has(d.idema) || d.fint > estacionsIdemaMap.get(d.idema).fint) {
                            estacionsIdemaMap.set(d.idema, d);
                        }
                    }
                });

                finalData.push(...Array.from(estacionsIdemaMap.values()).map(d => ({
                    source: 'aemet',
                    lat: d.lat,
                    lon: d.lon,
                    nom: d.ubi,
                    valor: d[config.aemet_id],
                    fint: d.fint
                })));
            }
        }
        dataMarkersLayer.clearLayers();
        finalData.forEach(estacio => {
            const value = Number(estacio.valor); if (isNaN(value)) return;
            const color = getTempRgbaColor(value);
            const formattedValue = formatValueForLabel(value, config.decimals);

            let borderStyle = '';
            if (estacio.source === 'aemet' && estacio.fint) {
                const dataFint = new Date(estacio.fint + 'Z');
                const dataAvui = timestampToUse ? new Date(timestampToUse) : new Date();
                const diffMinuts = (dataAvui - dataFint) / (1000 * 60);
                if (diffMinuts > 35) {
                    borderStyle = 'box-shadow: 0 0 0 2px red;';
                }
            }

            const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; ${borderStyle}">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
            let popupContent = `<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`;
            if (estacio.fint) {
                try {
                    const dataHora = estacio.fint.slice(11, 16);
                    popupContent += `<br><small style="color: #666;">Última dada: ${dataHora}h</small>`;
                } catch (e) { }
            }
            L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(popupContent).addTo(dataMarkersLayer);
        });
    } catch (error) { console.error("Error a displayDewPoint:", error); }
    finally { isLoadingData = false; }
}

// REEMPLAÇA LA TEVA FUNCIÓ AMB AQUESTA VERSIÓ
async function displayCalculatedVariable(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    console.log(`displayCalculatedVariable: ${config.name}`);

    // Cleanup Allaus Layer
    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }

    // ... (la part inicial de la funció es manté igual) ...
    const isHistoric = targetDate !== null;
    const isSummaryBased = config.sources.some(key => {
        const sourceConfig = VARIABLES_CONFIG[key];
        return sourceConfig && sourceConfig.summary;
    });

    const displayType = isSummaryBased ? 'calculated_summary' : 'calculated_instant';
    const timestampForDisplay = isHistoric ? targetDate : (isSummaryBased ? new Date() : findLatestSmcTimestamp(new Date()));

    if (!isHistoric) {
        lastCheckedTimestamp = timestampForDisplay;
    }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: displayType,
        timestamp: timestampForDisplay
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    const dateToFetch = isHistoric ? targetDate : new Date();

    const sourcePromises = config.sources.map(sourceKey => {
        // ===== INICI DE LA MODIFICACIÓ CLAU =====
        if (sourceKey === 'percentils') {
            // Si la font és 'percentils', no cal fer cap petició a l'API.
            // Retornem les dades directament del nostre fitxer carregat.
            return Promise.resolve({ key: sourceKey, data: dadesPercentils });
        }
        // ===== FI DE LA MODIFICACIÓ CLAU =====

        const sourceConfig = VARIABLES_CONFIG[sourceKey];
        if (sourceKey === 'wind') {
            return fetchAllWindData('speed', isHistoric ? dateToFetch : null).then(data => ({ key: sourceKey, data }));
        } else if (sourceKey === 'wind_gust') {
            return fetchAllWindData('gust', isHistoric ? dateToFetch : null).then(data => ({ key: sourceKey, data }));
        } else if (sourceConfig && sourceConfig.summary) {
            const startOfDay = new Date(Date.UTC(dateToFetch.getUTCFullYear(), dateToFetch.getUTCMonth(), dateToFetch.getUTCDate(), 0, 0, 0, 0));
            const endOfDay = new Date(Date.UTC(dateToFetch.getUTCFullYear(), dateToFetch.getUTCMonth(), dateToFetch.getUTCDate(), 23, 59, 59, 999));
            return fetchSmcDailySummary(sourceConfig.id, sourceConfig.summary, startOfDay, endOfDay)
                .then(result => ({ key: sourceKey, data: result.data }));
        } else if (sourceConfig) {
            return fetchSmcData(sourceConfig.id, isHistoric ? dateToFetch : null).then(result => ({ key: sourceKey, data: result.data }));
        } else {
            return Promise.resolve(null);
        }
    });

    try {
        // ★ MODIFICACIÓ: Carreguem metadades (Altitud!) en paral·lel
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        const metadataPromise = fetch(urlMetadades)
            .then(res => res.json())
            .catch(err => { console.warn("Error carregant metadades:", err); return []; });

        const [sourceResults, metadata] = await Promise.all([
            Promise.all(sourcePromises),
            metadataPromise
        ]);

        // Creem un mapa ràpid d'altituds
        const estacionsMetadataMap = new Map();
        if (metadata && Array.isArray(metadata)) {
            metadata.forEach(est => {
                estacionsMetadataMap.set(est.codi_estacio, {
                    altitud: parseFloat(est.altitud)
                });
            });
        }

        const mergedDataByStation = new Map();

        sourceResults.forEach(result => {
            if (!result || !result.data) return;

            // ===== INICI DE LA SEGONA MODIFICACIÓ =====
            if (result.key === 'percentils') {
                // Si són les dades de percentils, les afegim a cada estació
                Object.keys(result.data).forEach(stationCode => {
                    if (!mergedDataByStation.has(stationCode)) {
                        mergedDataByStation.set(stationCode, { codi_estacio: stationCode });
                    }
                    mergedDataByStation.get(stationCode).percentils = result.data[stationCode];
                });
                return; // Continuem amb la següent font de dades
            }
            // ===== FI DE LA SEGONA MODIFICACIÓ =====

            result.data.forEach(stationData => {
                const stationId = stationData.codi_estacio || `${stationData.lat.toFixed(4)},${stationData.lon.toFixed(4)}`;
                if (!mergedDataByStation.has(stationId)) {
                    // Mirem si tenim metadades extra (altitud!) al mapa que acabem de carregar
                    let alt = null;
                    if (estacionsMetadataMap.has(stationId)) {
                        alt = estacionsMetadataMap.get(stationId).altitud;
                    }
                    mergedDataByStation.set(stationId, {
                        nom: stationData.nom,
                        lat: stationData.lat,
                        lon: stationData.lon,
                        codi_estacio: stationData.codi_estacio,
                        altitud: alt // <--- Importantíssim per a la cota de neu
                    });
                }
                const station = mergedDataByStation.get(stationId);
                if (result.key === 'wind' || result.key === 'wind_gust') {
                    station[result.key] = stationData;
                } else {
                    station[result.key] = parseFloat(stationData.valor);
                }
            });
        });

        // ... (la resta de la funció, des de 'dataMarkersLayer.clearLayers()' fins al final, es manté exactament igual) ...
        dataMarkersLayer.clearLayers();

        mergedDataByStation.forEach((station) => {
            const hasAllData = config.sources.every(sourceKey => station[sourceKey] !== undefined && station[sourceKey] !== null && (typeof station[sourceKey] === 'object' || !isNaN(station[sourceKey])));

            if (hasAllData) {
                if (config.sources.includes('wind') && station.wind.speed_ms !== undefined) {
                    const speed = station.wind.speed_ms;
                    const direction = station.wind.direction;
                    const angleRad = (270 - direction) * (Math.PI / 180);
                    station.wind.u = speed * Math.cos(angleRad);
                    station.wind.v = speed * Math.sin(angleRad);
                }

                const finalValue = config.calculation(station);
                if (finalValue === null || isNaN(finalValue)) return;

                let color = getDynamicColor(finalValue, config.colorScale);
                let formattedValue;
                if (config.showPositiveSign) {
                    const sign = finalValue > 0 ? '+' : '';
                    const numericValue = formatValueForLabel(finalValue, config.decimals);
                    formattedValue = sign + numericValue;
                } else {
                    formattedValue = formatValueForLabel(finalValue, config.decimals);
                }

                // ★ MODIFICACIÓ: Si és la Cota de Neu i està per sota de l'estació -> Emoticona
                if (config.name === 'Cota de Neu Estimada' && station.altitud && finalValue < station.altitud) {
                    formattedValue = "❄️";
                    color = '#0d47a1'; // Deep Blue for high contrast with white snowflake
                }

                let textColor = '#000000';
                if (currentVariableKey === 'anomalia_tmin_hivern' && finalValue < 0) {
                    textColor = '#FFFFFF';
                } else if (currentVariableKey === 'calc_fire_risk_semihourly' && finalValue >= 60) {
                    textColor = '#FFFFFF';
                }

                const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });

                let popupContent;
                if (config.popupTemplate) {
                    popupContent = config.popupTemplate(station, finalValue, config);
                } else {
                    popupContent = `<b>${station.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`;
                }

                L.marker([station.lat, station.lon], { icon }).bindPopup(popupContent).addTo(dataMarkersLayer);
            }
        });

    } catch (error) {
        console.error("❌ Error CRÍTIC a displayCalculatedVariable:", error);
        console.error(error.stack);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: `Error: ${error.message}` }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// ===================================
// CODI NOU: CLIMATOLOGIES I ANOMALIES MENSUALS
// ===================================
function getNomMes(monthIndex) {
    const nomsMesos = [
        "Gener", "Febrer", "Març", "Abril", "Maig", "Juny", 
        "Juliol", "Agost", "Setembre", "Octubre", "Novembre", "Desembre"
    ];
    return nomsMesos[monthIndex];
}

async function fetchAndCalculateMonthlyAverages(dateToUse) {
    const yyyy = dateToUse.getFullYear();
    const mm = String(dateToUse.getMonth() + 1).padStart(2, '0');
    const dd = String(dateToUse.getDate()).padStart(2, '0');
    const startString = `${yyyy}-${mm}-01T00:00:00`;
    const endString = `${yyyy}-${mm}-${dd}T23:59:59`;

    // 1. Petició de les mitjanes diàries oficials a Socrata (7bvh-jvq2)
    const queryDaily = `$query=SELECT codi_estacio, valor, data_lectura WHERE codi_variable='1000' AND data_lectura >= '${startString}' AND data_lectura <= '${endString}' LIMIT 50000`;
    const urlDaily = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${queryDaily}&_=${Date.now()}`;

    console.log(`[CLIMATOLOGIA] URL Mitjanes Diàries: ${urlDaily}`);

    try {
        const dadesDaily = await $.getJSON(urlDaily).catch(() => []);

        const dailyValuesMap = new Map(); // codi_estacio (UPPERCASE) -> Array de valors diaris
        const stationDatesMap = new Map(); // codi_estacio (UPPERCASE) -> Set de dies amb dades oficials (YYYY-MM-DD)

        let maxDailyDateStr = null;

        // Processar dades oficials
        if (dadesDaily && dadesDaily.length > 0) {
            dadesDaily.forEach(item => {
                if (!item.codi_estacio) return;
                const codi = item.codi_estacio.toUpperCase();

                // Filtrar per assegurar-nos que només processem estacions que tenen climatologia
                if (climatologiaEstacions && !climatologiaEstacions[codi]) return;

                const val = parseFloat(item.valor);
                if (isNaN(val)) return;

                if (!dailyValuesMap.has(codi)) {
                    dailyValuesMap.set(codi, []);
                }
                dailyValuesMap.get(codi).push(val);

                if (!stationDatesMap.has(codi)) {
                    stationDatesMap.set(codi, new Set());
                }
                const datePart = item.data_lectura.slice(0, 10);
                stationDatesMap.get(codi).add(datePart);

                if (!maxDailyDateStr || datePart > maxDailyDateStr) {
                    maxDailyDateStr = datePart;
                }
            });
        }

        // Determinar el costat del "gap" (des del final de les dades oficials fins a avui)
        let gapStartStr = null;
        if (maxDailyDateStr) {
            // El gap comença el dia següent de maxDailyDateStr
            const nextDay = new Date(maxDailyDateStr);
            nextDay.setDate(nextDay.getDate() + 1);
            
            // Format YYYY-MM-DD
            const gapYyyy = nextDay.getFullYear();
            const gapMm = String(nextDay.getMonth() + 1).padStart(2, '0');
            const gapDd = String(nextDay.getDate()).padStart(2, '0');
            gapStartStr = `${gapYyyy}-${gapMm}-${gapDd}`;
        } else {
            // Si no hi ha dades oficials, intentem des del dia 1 del mes
            gapStartStr = `${yyyy}-${mm}-01`;
        }

        // Comprovem si el gapStartDate és anterior o igual a la data de finalització (dd)
        const gapStartDate = new Date(`${gapStartStr}T00:00:00`);
        const endDateObj = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);

        if (gapStartDate <= endDateObj) {
            const startRecentString = `${gapStartStr}T00:00:00`;
            const queryRecent = `$query=SELECT codi_estacio, date_trunc_ymd(data_lectura) as dia, avg(valor_lectura) as valor WHERE codi_variable='32' AND data_lectura >= '${startRecentString}' AND data_lectura <= '${endString}' GROUP BY codi_estacio, dia LIMIT 50000`;
            const urlRecent = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${queryRecent}&_=${Date.now()}`;

            console.log(`[CLIMATOLOGIA] URL Semihorari Recent (Gap Filling des de ${gapStartStr}): ${urlRecent}`);

            const dadesRecent = await $.getJSON(urlRecent).catch(() => []);

            if (dadesRecent && dadesRecent.length > 0) {
                dadesRecent.forEach(item => {
                    if (!item.codi_estacio) return;
                    const codi = item.codi_estacio.toUpperCase();

                    // Filtrar per assegurar-nos que només processem estacions que tenen climatologia
                    if (climatologiaEstacions && !climatologiaEstacions[codi]) return;

                    const val = parseFloat(item.valor);
                    if (isNaN(val)) return;

                    const datePart = item.dia.slice(0, 10);

                    // Si l'estació ja té mitjana diària oficial per a aquest dia, no la dupliquem
                    const existingDates = stationDatesMap.get(codi);
                    if (existingDates && existingDates.has(datePart)) {
                        return;
                    }

                    if (!dailyValuesMap.has(codi)) {
                        dailyValuesMap.set(codi, []);
                    }
                    dailyValuesMap.get(codi).push(val);

                    if (!stationDatesMap.has(codi)) {
                        stationDatesMap.set(codi, new Set());
                    }
                    stationDatesMap.get(codi).add(datePart);
                });
            }
        }

        return dailyValuesMap;

    } catch (e) {
        console.error("Error obtenint dades mensuals:", e);
        return new Map();
    }
}

async function displayClimatologia(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    console.log(`displayClimatologia: ${config.name}`);

    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }
    if (map.hasLayer(openMeteoAromeLayer)) {
        map.removeLayer(openMeteoAromeLayer);
    }

    const isHistoric = targetDate !== null;
    const dateToUse = isHistoric ? new Date(targetDate) : new Date();
    const monthIndex = dateToUse.getMonth();

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'climatologia_mensual',
        timestamp: dateToUse
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant mitjanes del mes...`) }).addTo(dataMarkersLayer);

    if (!climatologiaEstacions) {
        await carregarClimatologiaLocal();
    }

    try {
        const dailyValuesMap = await fetchAndCalculateMonthlyAverages(dateToUse);

        if (dailyValuesMap.size === 0 || !climatologiaEstacions) {
            console.warn("[CLIMATOLOGIA] No s'han obtingut dades diàries de Socrata o la climatologia no està disponible.");
            dataMarkersLayer.clearLayers();
            L.marker(map.getCenter(), { icon: L.divIcon({ className: '', html: '<div style="background: white; padding: 5px; border-radius: 5px; box-shadow: 0 0 5px rgba(0,0,0,0.3); white-space: nowrap;">Dades no disponibles per a aquest mes encara</div>' }) }).addTo(dataMarkersLayer);
            isLoadingData = false;
            return;
        }

        const finalData = [];
        for (const codi in climatologiaEstacions) {
            const station = climatologiaEstacions[codi];
            
            const actualVals = dailyValuesMap.get(codi.toUpperCase());
            if (!actualVals || actualVals.length === 0) continue;
            
            const actualMean = actualVals.reduce((sum, v) => sum + v, 0) / actualVals.length;

            finalData.push({
                source: 'clima_actual',
                codi_estacio: codi,
                nom: station.nom,
                lat: station.geografia.latitud,
                lon: station.geografia.longitud,
                altitud: station.geografia.altitud,
                valor: actualMean
            });
        }

        dataMarkersLayer.clearLayers();

        const filteredData = applyDataFilters(finalData);
        window.lastMeteoData = filteredData;

        filteredData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;

            const color = getTempRgbaColor(value);
            const textColor = '#000000';

            const formattedValue = formatValueForLabel(value, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">${formattedValue}</div>`,
                iconSize: [30, 18],
                iconAnchor: [15, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], {
                icon: icon,
                valor: value
            }).addTo(dataMarkersLayer);

            let popupContent = `<b>${estacio.nom}</b><br>` +
                               `Mitjana Mensual Actual (${getNomMes(monthIndex)}): <b>${formattedValue} °C</b><br>` +
                               `<small style="color: #666;">Codi: ${estacio.codi_estacio} | Altitud: ${estacio.altitud}m (Calculada de ${dailyValuesMap.get(estacio.codi_estacio).length} dies)</small>`;
            marker.bindPopup(popupContent);
        });

    } catch (error) {
        console.error("Error a displayClimatologia:", error);
        dataMarkersLayer.clearLayers();
    }

    isLoadingData = false;
}

async function displayAnomaliaClima(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    console.log(`displayAnomaliaClima: ${config.name}`);

    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }
    if (map.hasLayer(openMeteoAromeLayer)) {
        map.removeLayer(openMeteoAromeLayer);
    }

    const isHistoric = targetDate !== null;
    const dateToUse = isHistoric ? new Date(targetDate) : new Date();
    const monthIndex = dateToUse.getMonth();

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'anomalia_clima',
        timestamp: dateToUse
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant anomalies del mes...`) }).addTo(dataMarkersLayer);

    if (!climatologiaEstacions) {
        await carregarClimatologiaLocal();
    }

    try {
        const dailyValuesMap = await fetchAndCalculateMonthlyAverages(dateToUse);

        if (dailyValuesMap.size === 0 || !climatologiaEstacions) {
            console.warn("[ANOMALIA CLIMA] No s'han obtingut dades diàries de Socrata o la climatologia no està disponible.");
            dataMarkersLayer.clearLayers();
            L.marker(map.getCenter(), { icon: L.divIcon({ className: '', html: '<div style="background: white; padding: 5px; border-radius: 5px; box-shadow: 0 0 5px rgba(0,0,0,0.3); white-space: nowrap;">Dades no disponibles per a aquest mes encara</div>' }) }).addTo(dataMarkersLayer);
            isLoadingData = false;
            return;
        }

        const finalData = [];
        for (const codi in climatologiaEstacions) {
            const station = climatologiaEstacions[codi];
            
            const valArray = station.climatologia["TMm (°C)"];
            if (!valArray) continue;
            const climaMean = valArray[monthIndex];
            if (climaMean === null || climaMean === undefined) continue;

            const actualVals = dailyValuesMap.get(codi.toUpperCase());
            if (!actualVals || actualVals.length === 0) continue;
            
            const actualMean = actualVals.reduce((sum, v) => sum + v, 0) / actualVals.length;
            const anomaly = actualMean - climaMean;

            finalData.push({
                source: 'anomalia',
                codi_estacio: codi,
                nom: station.nom,
                lat: station.geografia.latitud,
                lon: station.geografia.longitud,
                altitud: station.geografia.altitud,
                climaMean: climaMean,
                actualMean: actualMean,
                valor: anomaly
            });
        }

        dataMarkersLayer.clearLayers();

        const filteredData = applyDataFilters(finalData);
        window.lastMeteoData = filteredData;

        filteredData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;

            const color = getDynamicColor(value, config.colorScale);
            const textColor = '#000000';

            const sign = value > 0 ? '+' : '';
            const formattedValue = sign + formatValueForLabel(value, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">${formattedValue}</div>`,
                iconSize: [35, 18],
                iconAnchor: [17, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], {
                icon: icon,
                valor: value
            }).addTo(dataMarkersLayer);

            let popupContent = `<b>${estacio.nom}</b><br>` +
                               `Anomalia: <b>${formattedValue} °C</b><br>` +
                               `Mitjana Actual: ${estacio.actualMean.toFixed(1)} °C<br>` +
                               `Climatologia (${getNomMes(monthIndex)}): ${estacio.climaMean.toFixed(1)} °C<br>` +
                               `<small style="color: #666;">Codi: ${estacio.codi_estacio} | Altitud: ${estacio.altitud}m</small>`;
            marker.bindPopup(popupContent);
        });

    } catch (error) {
        console.error("Error a displayAnomaliaClima:", error);
        dataMarkersLayer.clearLayers();
    }

    isLoadingData = false;
}

async function fetchAndCalculateMonthlyPrecipitation(dateToUse) {
    const yyyy = dateToUse.getFullYear();
    const mm = String(dateToUse.getMonth() + 1).padStart(2, '0');
    const dd = String(dateToUse.getDate()).padStart(2, '0');
    const startString = `${yyyy}-${mm}-01T00:00:00`;
    const endString = `${yyyy}-${mm}-${dd}T23:59:59`;

    // 1. Petició de les precipitacions diàries oficials a Socrata (7bvh-jvq2) - variable '1300'
    const queryDaily = `$query=SELECT codi_estacio, valor, data_lectura WHERE codi_variable='1300' AND data_lectura >= '${startString}' AND data_lectura <= '${endString}' LIMIT 50000`;
    const urlDaily = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${queryDaily}&_=${Date.now()}`;

    console.log(`[CLIMATOLOGIA PRECIP] URL Precipitacions Diàries: ${urlDaily}`);

    try {
        const dadesDaily = await $.getJSON(urlDaily).catch(() => []);

        const dailyValuesMap = new Map(); // codi_estacio (UPPERCASE) -> Array de valors diaris
        const stationDatesMap = new Map(); // codi_estacio (UPPERCASE) -> Set de dies amb dades oficials (YYYY-MM-DD)

        let maxDailyDateStr = null;

        // Processar dades oficials
        if (dadesDaily && dadesDaily.length > 0) {
            dadesDaily.forEach(item => {
                if (!item.codi_estacio) return;
                const codi = item.codi_estacio.toUpperCase();

                // Filtrar per assegurar-nos que només processem estacions que tenen climatologia
                if (climatologiaEstacions && !climatologiaEstacions[codi]) return;

                const val = parseFloat(item.valor);
                if (isNaN(val)) return;

                if (!dailyValuesMap.has(codi)) {
                    dailyValuesMap.set(codi, []);
                }
                dailyValuesMap.get(codi).push(val);

                if (!stationDatesMap.has(codi)) {
                    stationDatesMap.set(codi, new Set());
                }
                const datePart = item.data_lectura.slice(0, 10);
                stationDatesMap.get(codi).add(datePart);

                if (!maxDailyDateStr || datePart > maxDailyDateStr) {
                    maxDailyDateStr = datePart;
                }
            });
        }

        // Determinar el costat del "gap" (des del final de les dades oficials fins a avui)
        let gapStartStr = null;
        if (maxDailyDateStr) {
            const nextDay = new Date(maxDailyDateStr);
            nextDay.setDate(nextDay.getDate() + 1);
            
            const gapYyyy = nextDay.getFullYear();
            const gapMm = String(nextDay.getMonth() + 1).padStart(2, '0');
            const gapDd = String(nextDay.getDate()).padStart(2, '0');
            gapStartStr = `${gapYyyy}-${gapMm}-${gapDd}`;
        } else {
            gapStartStr = `${yyyy}-${mm}-01`;
        }

        const gapStartDate = new Date(`${gapStartStr}T00:00:00`);
        const endDateObj = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);

        if (gapStartDate <= endDateObj) {
            const startRecentString = `${gapStartStr}T00:00:00`;
            // Per a la precipitació semihorària recent usem la variable 35 agrupada per suma
            const queryRecent = `$query=SELECT codi_estacio, date_trunc_ymd(data_lectura) as dia, sum(valor_lectura) as valor WHERE codi_variable='35' AND data_lectura >= '${startRecentString}' AND data_lectura <= '${endString}' GROUP BY codi_estacio, dia LIMIT 50000`;
            const urlRecent = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${queryRecent}&_=${Date.now()}`;

            console.log(`[CLIMATOLOGIA PRECIP] URL Semihorari Recent (Gap Filling des de ${gapStartStr}): ${urlRecent}`);

            const dadesRecent = await $.getJSON(urlRecent).catch(() => []);

            if (dadesRecent && dadesRecent.length > 0) {
                dadesRecent.forEach(item => {
                    if (!item.codi_estacio) return;
                    const codi = item.codi_estacio.toUpperCase();

                    // Filtrar per assegurar-nos que només processem estacions que tenen climatologia
                    if (climatologiaEstacions && !climatologiaEstacions[codi]) return;

                    const val = parseFloat(item.valor);
                    if (isNaN(val)) return;

                    const datePart = item.dia.slice(0, 10);

                    const existingDates = stationDatesMap.get(codi);
                    if (existingDates && existingDates.has(datePart)) {
                        return;
                    }

                    if (!dailyValuesMap.has(codi)) {
                        dailyValuesMap.set(codi, []);
                    }
                    dailyValuesMap.get(codi).push(val);

                    if (!stationDatesMap.has(codi)) {
                        stationDatesMap.set(codi, new Set());
                    }
                    stationDatesMap.get(codi).add(datePart);
                });
            }
        }

        return dailyValuesMap;

    } catch (e) {
        console.error("Error obtenint dades mensuals de precipitació:", e);
        return new Map();
    }
}

async function displayClimatologiaPrecip(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    console.log(`displayClimatologiaPrecip: ${config.name}`);

    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }
    if (map.hasLayer(openMeteoAromeLayer)) {
        map.removeLayer(openMeteoAromeLayer);
    }

    const isHistoric = targetDate !== null;
    const dateToUse = isHistoric ? new Date(targetDate) : new Date();
    const monthIndex = dateToUse.getMonth();

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'climatologia_precip_mensual',
        timestamp: dateToUse
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant precipitació del mes...`) }).addTo(dataMarkersLayer);

    if (!climatologiaEstacions) {
        await carregarClimatologiaLocal();
    }

    try {
        const dailyValuesMap = await fetchAndCalculateMonthlyPrecipitation(dateToUse);

        if (dailyValuesMap.size === 0 || !climatologiaEstacions) {
            console.warn("[CLIMATOLOGIA PRECIP] No s'han obtingut dades de Socrata o la climatologia no està disponible.");
            dataMarkersLayer.clearLayers();
            L.marker(map.getCenter(), { icon: L.divIcon({ className: '', html: '<div style="background: white; padding: 5px; border-radius: 5px; box-shadow: 0 0 5px rgba(0,0,0,0.3); white-space: nowrap;">Dades no disponibles per a aquest mes encara</div>' }) }).addTo(dataMarkersLayer);
            isLoadingData = false;
            return;
        }

        const finalData = [];
        for (const codi in climatologiaEstacions) {
            const station = climatologiaEstacions[codi];
            
            const actualVals = dailyValuesMap.get(codi.toUpperCase());
            if (!actualVals || actualVals.length === 0) continue;
            
            const actualSum = actualVals.reduce((sum, v) => sum + v, 0);

            finalData.push({
                source: 'precip_actual',
                codi_estacio: codi,
                nom: station.nom,
                lat: station.geografia.latitud,
                lon: station.geografia.longitud,
                altitud: station.geografia.altitud,
                valor: actualSum
            });
        }

        dataMarkersLayer.clearLayers();

        const filteredData = applyDataFilters(finalData);
        window.lastMeteoData = filteredData;

        filteredData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;

            const color = getPrecipitationSumColor(value);
            const textColor = '#000000';

            const formattedValue = formatValueForLabel(value, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">${formattedValue}</div>`,
                iconSize: [35, 18],
                iconAnchor: [17, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], {
                icon: icon,
                valor: value
            }).addTo(dataMarkersLayer);

            let popupContent = `<b>${estacio.nom}</b><br>` +
                               `Precipitació Acumulada (${getNomMes(monthIndex)}): <b>${formattedValue} mm</b><br>` +
                               `<small style="color: #666;">Codi: ${estacio.codi_estacio} | Altitud: ${estacio.altitud}m (Calculada de ${dailyValuesMap.get(estacio.codi_estacio.toUpperCase()).length} dies)</small>`;
            marker.bindPopup(popupContent);
        });

    } catch (error) {
        console.error("Error a displayClimatologiaPrecip:", error);
        dataMarkersLayer.clearLayers();
    }

    isLoadingData = false;
}

async function displayAnomaliaPrecip(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    console.log(`displayAnomaliaPrecip: ${config.name}`);

    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }
    if (map.hasLayer(openMeteoAromeLayer)) {
        map.removeLayer(openMeteoAromeLayer);
    }

    const isHistoric = targetDate !== null;
    const dateToUse = isHistoric ? new Date(targetDate) : new Date();
    const monthIndex = dateToUse.getMonth();

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'anomalia_precip_mensual',
        timestamp: dateToUse
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Calculant anomalies de pluja...`) }).addTo(dataMarkersLayer);

    if (!climatologiaEstacions) {
        await carregarClimatologiaLocal();
    }

    try {
        const dailyValuesMap = await fetchAndCalculateMonthlyPrecipitation(dateToUse);

        if (dailyValuesMap.size === 0 || !climatologiaEstacions) {
            console.warn("[ANOMALIA PRECIP] No s'han obtingut dades de Socrata o la climatologia no està disponible.");
            dataMarkersLayer.clearLayers();
            L.marker(map.getCenter(), { icon: L.divIcon({ className: '', html: '<div style="background: white; padding: 5px; border-radius: 5px; box-shadow: 0 0 5px rgba(0,0,0,0.3); white-space: nowrap;">Dades no disponibles per a aquest mes encara</div>' }) }).addTo(dataMarkersLayer);
            isLoadingData = false;
            return;
        }

        const finalData = [];
        for (const codi in climatologiaEstacions) {
            const station = climatologiaEstacions[codi];
            
            const valArray = station.climatologia["PPT (mm)"];
            if (!valArray) continue;
            const climaPrecip = valArray[monthIndex];
            if (climaPrecip === null || climaPrecip === undefined) continue;

            const actualVals = dailyValuesMap.get(codi.toUpperCase());
            if (!actualVals || actualVals.length === 0) continue;
            
            const actualSum = actualVals.reduce((sum, v) => sum + v, 0);
            const anomaly = actualSum - climaPrecip;

            finalData.push({
                source: 'anomalia_precip',
                codi_estacio: codi,
                nom: station.nom,
                lat: station.geografia.latitud,
                lon: station.geografia.longitud,
                altitud: station.geografia.altitud,
                climaPrecip: climaPrecip,
                actualSum: actualSum,
                valor: anomaly
            });
        }

        dataMarkersLayer.clearLayers();

        const filteredData = applyDataFilters(finalData);
        window.lastMeteoData = filteredData;

        filteredData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;

            const color = getDynamicColor(value, config.colorScale);
            const textColor = '#000000';

            const sign = value > 0 ? '+' : '';
            const formattedValue = sign + formatValueForLabel(value, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">${formattedValue}</div>`,
                iconSize: [40, 18],
                iconAnchor: [20, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], {
                icon: icon,
                valor: value
            }).addTo(dataMarkersLayer);

            let popupContent = `<b>${estacio.nom}</b><br>` +
                               `Anomalia: <b>${formattedValue} mm</b><br>` +
                               `Acumulat Actual: ${estacio.actualSum.toFixed(1)} mm<br>` +
                               `Climatologia (${getNomMes(monthIndex)}): ${estacio.climaPrecip.toFixed(1)} mm<br>` +
                               `<small style="color: #666;">Codi: ${estacio.codi_estacio} | Altitud: ${estacio.altitud}m</small>`;
            marker.bindPopup(popupContent);
        });

    } catch (error) {
        console.error("Error a displayAnomaliaPrecip:", error);
        dataMarkersLayer.clearLayers();
    }

    isLoadingData = false;
}

// ===================================
// DEFINICIÓ DE POSICIONS FIXES PER A LES ZONES D'ALLAUS
// ===================================
var iconAran = { "type": "Feature", "properties": { "id": "1" }, "geometry": { "type": "Point", "coordinates": [0.87, 42.75] } };
var iconPallaresa = { "type": "Feature", "properties": { "id": "3" }, "geometry": { "type": "Point", "coordinates": [1.21, 42.56] } };
var iconRibagor = { "type": "Feature", "properties": { "id": "2" }, "geometry": { "type": "Point", "coordinates": [0.87, 42.53] } };
var iconTer = { "type": "Feature", "properties": { "id": "7" }, "geometry": { "type": "Point", "coordinates": [2.21, 42.35] } };
var iconPerafita = { "type": "Feature", "properties": { "id": "4" }, "geometry": { "type": "Point", "coordinates": [1.73, 42.46] } };
var iconCadi = { "type": "Feature", "properties": { "id": "5" }, "geometry": { "type": "Point", "coordinates": [1.75, 42.34] } };
var iconPrepirineu = { "type": "Feature", "properties": { "id": "6" }, "geometry": { "type": "Point", "coordinates": [1.64, 42.24] } };

// Mapa d'accés ràpid a coordenades [lat, lon] per ID
// Leaflet fa servir [lat, lon], GeoJSON [lon, lat]
const FIXED_ZONE_COORDS = {
    "1": [iconAran.geometry.coordinates[1], iconAran.geometry.coordinates[0]],
    "3": [iconPallaresa.geometry.coordinates[1], iconPallaresa.geometry.coordinates[0]],
    "2": [iconRibagor.geometry.coordinates[1], iconRibagor.geometry.coordinates[0]],
    "7": [iconTer.geometry.coordinates[1], iconTer.geometry.coordinates[0]],
    "4": [iconPerafita.geometry.coordinates[1], iconPerafita.geometry.coordinates[0]],
    "5": [iconCadi.geometry.coordinates[1], iconCadi.geometry.coordinates[0]],
    "6": [iconPrepirineu.geometry.coordinates[1], iconPrepirineu.geometry.coordinates[0]]
};

// ===================================
// DEFINICIÓ D'ICONES PERSONALITZADES
// ===================================
// ===================================
// DEFINICIÓ D'ICONES PERSONALITZADES
// ===================================
// Mides ajustades a un terme mig (aprox 45-55px)
var iconPerill0 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-0.png', iconSize: [40, 40] });
var iconPerill1 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-1-t.png', iconSize: [47, 50] });
var iconPerill12 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-12-t.png', iconSize: [57, 50] });
var iconPerill13 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-13-t.png', iconSize: [57, 50] });
var iconPerill14 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-14-t.png', iconSize: [57, 50] });
var iconPerill2 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-2-t.png', iconSize: [47, 50] });
var iconPerill21 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-21-t.png', iconSize: [53, 50] });
var iconPerill23 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-23-t.png', iconSize: [53, 50] });
var iconPerill24 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-24-t.png', iconSize: [53, 50] });
var iconPerill3 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-3-t.png', iconSize: [55, 50] });
var iconPerill31 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-31-t.png', iconSize: [53, 50] });
var iconPerill32 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-32-t.png', iconSize: [53, 50] });
var iconPerill34 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-34-t.png', iconSize: [53, 50] });
var iconPerill35 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-35-t.png', iconSize: [53, 50] });
var iconPerill4 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-4-t.png', iconSize: [61, 50] });
var iconPerill41 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-41-t.png', iconSize: [61, 50] });
var iconPerill42 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-42-t.png', iconSize: [61, 50] });
var iconPerill43 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-43-t.png', iconSize: [61, 50] });
var iconPerill45 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-45-t.png', iconSize: [61, 50] });
var iconPerill5 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-5-t.png', iconSize: [61, 50] });
var iconPerill52 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-52-t.png', iconSize: [61, 50] });
var iconPerill53 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-53-t.png', iconSize: [61, 50] });
var iconPerill54 = L.icon({ iconUrl: 'https://bpa.icgc.cat/img/perill/perill-54-t.png', iconSize: [61, 50] });

// Helper per seleccionar la icona
function getAvalancheIcon(nivell) {
    const nivellStr = String(nivell);
    const iconMap = {
        "0": iconPerill0,
        "1": iconPerill1,
        "12": iconPerill12,
        "13": iconPerill13,
        "14": iconPerill14,
        "2": iconPerill2,
        "21": iconPerill21,
        "23": iconPerill23,
        "24": iconPerill24,
        "3": iconPerill3,
        "31": iconPerill31,
        "32": iconPerill32,
        "34": iconPerill34,
        "35": iconPerill35,
        "4": iconPerill4,
        "41": iconPerill41,
        "42": iconPerill42,
        "43": iconPerill43,
        "45": iconPerill45,
        "5": iconPerill5,
        "52": iconPerill52,
        "53": iconPerill53,
        "54": iconPerill54
    };
    return iconMap[nivellStr] || iconMap["0"];
}

/**
 * Genera un contingut HTML "intel·ligent" per al popup d'allaus.
 * Analitza el text per trobar problemes clau i els presenta de forma més visual.
 */
function generateSmartPopupContent(info, iconUrl, nivell) {
    // 1. Detectar problemes d'allaus (Simulat via keywords)
    const textCombined = (info.text_estat_mantell + " " + info.text_distribucio).toLowerCase();
    const problems = [];

    if (textCombined.includes("plaques") || textCombined.includes("placa")) {
        problems.push({ name: "Plaques de Vent", icon: "🌬️", desc: "Acumulacions de neu ventada inestables." });
    }
    if (textCombined.includes("fusió") || textCombined.includes("humida") || textCombined.includes("pluja")) {
        problems.push({ name: "Neu Humida/Fusió", icon: "💧", desc: "Pèrdua de cohesió per aigua líquida." });
    }
    if (textCombined.includes("neu recent") || textCombined.includes("nevada")) {
        problems.push({ name: "Neu Recent", icon: "❄️", desc: "Mantell inestable per noves precipitacions." });
    }
    if (textCombined.includes("lliscament") || textCombined.includes("basal")) {
        problems.push({ name: "Lliscaments Basals", icon: "🗻", desc: "Despreniment de tot el mantell sobre el terra." });
    }

    // Si no detectem res, posem un genèric
    if (problems.length === 0) {
        problems.push({ name: "Condicions Generals", icon: "⚠️", desc: "Consultar el butlletí detallat." });
    }

    // 2. Construir HTML dels problemes
    let problemsHtml = `
        <div style="display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px;">
    `;
    problems.forEach(p => {
        problemsHtml += `
            <div style="background: #eef; border: 1px solid #ccd; border-radius: 4px; padding: 4px 8px; font-size: 0.85em; display: flex; align-items: center; gap: 5px;">
                <span>${p.icon}</span> <strong>${p.name}</strong>
            </div>
        `;
    });
    problemsHtml += `</div>`;

    // 3. Resum del mantell (tallem si és molt llarg o usem detalls)
    // Eliminem etiquetes HTML del text si n'hi hagués per netejar
    const cleanMantell = info.text_estat_mantell ? info.text_estat_mantell.replace(/<[^>]*>?/gm, '') : "Sense dades.";

    // 4. Construcció Final
    // DISSENY MODERN & FULL WIDTH
    // Utilitzem un contenidor principal que contraresta el padding per defecte de Leaflet (aprox 13px+19px)
    // i després apliquem padding intern consistent.
    return `
        <div style="
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            color: #333;
            min-width: 300px;
            margin: -14px -20px; /* Full bleed override */
            border-radius: 12px;
            overflow: hidden; /* Assegura que els bordes rodons es vegin */
            pointer-events: auto !important;
        ">
            <!-- HEADER -->
            <div style="
                background: linear-gradient(135deg, #f6f8f9 0%, #e5ebee 100%);
                padding: 15px 20px;
                border-bottom: 1px solid #dcdfe3;
            ">
                <h3 style="margin: 0; color: #2c3e50; font-size: 1.25em; font-weight: 700;">${info.nom_zona}</h3>
                <div style="font-size: 0.85em; color: #7f8c8d; margin-top: 4px; display: flex; align-items: center; gap: 5px;">
                    📅 Butlletí vàlid: <strong>${info.datavalidesabutlleti}</strong>
                </div>
            </div>

            <!-- BODY -->
            <div style="padding: 15px 20px; background: #fff;">
                
                <!-- DANGER LEVEL CARD -->
                <div style="
                    display: flex; 
                    align-items: center; 
                    background: #fff; 
                    border: 1px solid #edf2f7; 
                    border-radius: 12px; 
                    box-shadow: 0 2px 8px rgba(0,0,0,0.05); 
                    padding: 12px; 
                    margin-bottom: 20px;
                ">
                    <div style="
                        width: 60px; 
                        height: 60px; 
                        display: flex; 
                        align-items: center; 
                        justify-content: center; 
                        margin-right: 15px; 
                        background: #f8fafc; 
                        border-radius: 8px;
                    ">
                        <img src="${iconUrl}" alt="Nivell ${nivell}" style="height: 50px; width: auto;">
                    </div>
                    <div style="flex: 1;">
                        <span style="display: block; font-size: 0.8em; text-transform: uppercase; color: #718096; letter-spacing: 0.5px; font-weight: 600;">PERILL ACTUAL</span>
                        <strong style="display: block; font-size: 1.4em; color: #e53e3e; line-height: 1.2;">${info.perill_text}</strong>
                    </div>
                </div>

                <!-- PROBLEMS SECTION -->
                <div style="margin-bottom: 20px;">
                    <strong style="display: block; font-size: 0.85em; text-transform: uppercase; color: #a0aec0; letter-spacing: 0.5px; margin-bottom: 8px;">Problemes Principals</strong>
                    ${problemsHtml}
                </div>
                
                <!-- DETAILS ACCORDIONS -->
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <details style="
                        background: #f7fafc; 
                        border: 1px solid #e2e8f0; 
                        border-radius: 8px; 
                        padding: 0; 
                        transition: all 0.2s ease;
                        overflow: hidden;
                    ">
                        <summary style="
                            padding: 10px 15px; 
                            font-weight: 600; 
                            cursor: pointer; 
                            color: #4a5568; 
                            outline: none; 
                            user-select: none;
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                        ">
                            <span>📝 Estat del Mantell</span>
                            <span style="font-size: 0.8em; opacity: 0.6;">▼</span>
                        </summary>
                        <div style="
                            padding: 0 15px 15px 15px; 
                            margin-top: 0; 
                            font-size: 0.95em; 
                            line-height: 1.6; 
                            color: #4a5568; 
                            border-top: 1px solid #edf2f7; 
                            padding-top: 10px;
                            max-height: 200px; /* SCROLL LIMIT */
                            overflow-y: auto;  /* ENABLE SCROLL */
                        ">
                            ${cleanMantell}
                        </div>
                    </details>

                    <details style="
                        background: #f7fafc; 
                        border: 1px solid #e2e8f0; 
                        border-radius: 8px; 
                        padding: 0;
                        overflow: hidden;
                    ">
                        <summary style="
                            padding: 10px 15px; 
                            font-weight: 600; 
                            cursor: pointer; 
                            color: #4a5568; 
                            outline: none; 
                            user-select: none;
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                        ">
                            <span>🌍 Distribució</span>
                            <span style="font-size: 0.8em; opacity: 0.6;">▼</span>
                        </summary>
                        <div style="
                            padding: 0 15px 15px 15px; 
                            margin-top: 0; 
                            font-size: 0.95em; 
                            line-height: 1.6; 
                            color: #4a5568; 
                            border-top: 1px solid #edf2f7; 
                            padding-top: 10px;
                            max-height: 150px; /* SCROLL LIMIT */
                            overflow-y: auto;  /* ENABLE SCROLL */
                        ">
                            ${info.text_distribucio || "Informació no disponible."}
                        </div>
                    </details>
                </div>
            </div>
            
            <!-- FOOTER -->
            <div style="
                background: #f8fafc; 
                padding: 12px 20px; 
                border-top: 1px solid #e2e8f0; 
                text-align: right;
            ">
                <a href="https://www.icgc.cat/Ciutada/Explora-Catalunya/Allaus/Butlleti-de-Perill-d-Allaus-BPA" target="_blank" style="
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 0.85em; 
                    font-weight: 600;
                    color: #3182ce; 
                    text-decoration: none; 
                    pointer-events: auto;
                    transition: color 0.2s;
                ">
                    Veure Butlletí Complet 
                    <span style="font-size: 1.1em;">›</span>
                </a>
            </div>
        </div>
    `;
}

// Global variable for Allaus layer
let allausLayer = null;

// Helper per obtenir el color segons el grau de perill (1-5)
function getPerillColor(level) {
    switch (parseInt(level)) {
        case 1: return "#CCFF66"; // Feble
        case 2: return "#FFFF00"; // Moderat
        case 3: return "#FF9900"; // Marcat
        case 4: return "#FF0000"; // Fort
        case 5: return "#CC0000"; // Molt Fort
        default: return "#f5f5f5"; // Desconegut / Sense dades
    }
}

// Funció recursiva per buscar el butlletí més recent (fins a 7 dies enrere)
async function fetchBPAData(date = new Date(), depth = 0) {
    if (depth > 7) return null; // Límit de recursivitat

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const url = `https://bpa.icgc.cat/api/apiext/butlletiglobal?id=512&values=${dateStr};1`;
    console.log(`Cercant butlletí per la data: ${dateStr}...`);

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Network response was not ok");

        const data = await response.json();

        // Validem si hem rebut dades útils (array no buit)
        if (Array.isArray(data) && data.length > 0) {
            console.log(`Dades BPA trobades per ${dateStr}!`);
            return data;
        } else {
            console.log(`No hi ha butlletí per ${dateStr}. Provant dia anterior...`);
            // Passem al dia anterior
            const prevDate = new Date(date);
            prevDate.setDate(prevDate.getDate() - 1);
            return fetchBPAData(prevDate, depth + 1);
        }
    } catch (error) {
        console.warn(`Error carregant BPA per ${dateStr}:`, error);
        // En cas d'error, també provem el dia anterior
        const prevDate = new Date(date);
        prevDate.setDate(prevDate.getDate() - 1);
        return fetchBPAData(prevDate, depth + 1);
    }
}

async function displayAllausZones() {
    // 1. Neteja de la capa contenidor (wmsLayer actua com a grup)
    if (typeof wmsLayer !== 'undefined' && wmsLayer) wmsLayer.clearLayers();
    // No netegem dataMarkersLayer per independència


    // Si ja tenim la capa carregada i simplement volem mostrar-la, podríem fer-ho,
    // però com que ara depenem d'una API externa, millor refrescar o comprovar.
    // Per simplicitat, si ja existeix la capa, la netegem i la tornem a crear amb les dades actualitzades.
    if (allausLayer && map.hasLayer(allausLayer)) {
        map.removeLayer(allausLayer);
    }

    // 2. Comprovar GeoJSON base
    if (typeof zonesAllaus === 'undefined') {
        console.error("zonesAllaus no està definit. Comprova que allaus_zones.js s'ha carregat.");
        return;
    }

    // 3. Indicador de càrrega
    const loadingIcon = createLoadingIcon('Carregant BPA...');
    const loadingMarker = L.marker(map.getCenter(), { icon: loadingIcon });
    if (typeof wmsLayer !== 'undefined' && wmsLayer) wmsLayer.addLayer(loadingMarker);

    try {
        // 4. Obtenir dades de l'API (amb backtracking automàtic)
        const bpaData = await fetchBPAData();

        if (typeof wmsLayer !== 'undefined' && wmsLayer) wmsLayer.removeLayer(loadingMarker);
        hideMapLoader();

        if (!bpaData) {
            alert("No s'han trobat dades del Butlletí d'Allaus recents.");
            return;
        }

        // 5. Fusionar dades: Mapem les dades de l'API al GeoJSON local
        // Creem un mapa per accés ràpid: id_zona -> dades
        const bpaMap = {};
        bpaData.forEach(item => {
            bpaMap[item.id_zona] = item;
        });

        allausLayer = L.geoJSON(zonesAllaus, {
            style: function (feature) {
                const zonaId = feature.properties.id;
                const info = bpaMap[zonaId];

                // Estil base
                let style = {
                    weight: 2,
                    opacity: 1,
                    color: '#666',
                    fillOpacity: 0.6,
                    fillColor: '#ccc'
                };

                if (info && info.grau_perill_primari) {
                    const color = getPerillColor(info.grau_perill_primari);
                    style.fillColor = color;
                    style.color = '#333'; // Vora més fosca per contrast
                    // Si el perill és alt, la vora més gruixuda
                    if (parseInt(info.grau_perill_primari) >= 3) {
                        style.weight = 3;
                    }
                }
                return style;
            },
            onEachFeature: function (feature, layer) {
                const zonaId = feature.properties.id;
                const info = bpaMap[zonaId];

                if (info) {
                    const nivell = parseInt(info.grau_perill_primari) || 0;
                    const dangerIcon = getAvalancheIcon(nivell);
                    const iconUrl = dangerIcon.options.iconUrl;

                    // --- REFINAMENT: Popup "Intel·ligent" ---
                    let popupContent = generateSmartPopupContent(info, iconUrl, nivell);

                    layer.bindPopup(popupContent);

                    // --- NOU: AFEGIR ICONA AL CENTRE DEL MAPA (POSICIÓ FIXA) ---
                    let center = layer.getBounds().getCenter();
                    if (FIXED_ZONE_COORDS[zonaId]) {
                        center = FIXED_ZONE_COORDS[zonaId];
                    }

                    // Afegim el marcador al grup wmsLayer
                    if (typeof wmsLayer !== 'undefined' && wmsLayer) {
                        L.marker(center, { icon: dangerIcon })
                            .bindPopup(popupContent)
                            .addTo(wmsLayer);
                    }

                } else {
                    layer.bindPopup(`<b>${feature.properties.name}</b><br>Sense dades disponibles.`);
                }
            }
        });
        if (typeof wmsLayer !== 'undefined' && wmsLayer) wmsLayer.addLayer(allausLayer);

    } catch (e) {
        console.error(e);
        if (typeof wmsLayer !== 'undefined' && wmsLayer) wmsLayer.removeLayer(loadingMarker);
        hideMapLoader();
        alert("Error carregant les dades d'allaus.");
    }
}

// Nova funció per visualitzar dades per zones (Comarques)
function displayRegionalVariable(mergedDataByStation, config) {
    if (!comarquesLayer) {
        console.error("No s'ha trobat la capa de comarques.");
        return;
    }

    // ASSEGURAR VISIBILITAT:
    if (!map.hasLayer(comarquesLayer)) {
        console.log("Afegint comarquesLayer al mapa...");
        comarquesLayer.addTo(map);
    }
    comarquesLayer.bringToFront();

    // 1. Calculem p primer tots les valors per estació
    const stationValues = [];
    mergedDataByStation.forEach(station => {
        const hasAllData = config.sources.every(sourceKey => station[sourceKey] !== undefined && station[sourceKey] !== null && (typeof station[sourceKey] === 'object' || !isNaN(station[sourceKey])));
        if (hasAllData) {
            const val = config.calculation(station);
            if (val !== null) {
                stationValues.push({ lat: station.lat, lon: station.lon, val: val });
            }
        }
    });

    console.log(`displayRegionalVariable: ${stationValues.length} estacions amb dades.`);

    // 2. Iterem les comarques i busquem quines estacions cauen a dins
    comarquesLayer.eachLayer(layer => {
        const comarcaFeature = layer.feature;

        // Validació Turf
        if (typeof turf === 'undefined') {
            console.error("Critical: Turf.js no està carregat!");
            return;
        }
        const comarcaPoly = comarcaFeature.geometry; // GeoJSON geometry

        // Filtrem estacions dins del polígon
        const stationsInside = stationValues.filter(st => {
            const pt = turf.point([st.lon, st.lat]);
            return turf.booleanPointInPolygon(pt, comarcaFeature);
        });

        if (stationsInside.length > 0) {
            // Calculem la mitjana
            const sum = stationsInside.reduce((a, b) => a + b.val, 0);
            const avg = sum / stationsInside.length;

            // Determinem el color
            const color = getDynamicColor(avg, config.colorScale);
            // console.log(`Comarca ${comarcaFeature.properties.NOMCOMAR}: ${avg.toFixed(0)}m (${stationsInside.length} estacions) -> ${color}`);

            // Apliquem estil (farcint)
            layer.setStyle({
                fillColor: color,
                fillOpacity: 0.6,
                weight: 2,
                color: 'white', // Vora blanca per destacar
                opacity: 1
            });

            // Popup
            layer.bindPopup(`<b>${comarcaFeature.properties.NOMCOMAR || "Comarca"}</b><br>
                             ${config.name}: <b>~${avg.toFixed(0)} m</b><br>
                             <i style="font-size:11px">Mitjana de ${stationsInside.length} estacions</i>`);
        } else {
            // Si no hi ha dades, estil per defecte (transparent o gris)
            layer.setStyle({
                fillColor: '#ccc',
                fillOpacity: 0.1,
                weight: 1,
                color: '#666'
            });
            layer.bindPopup(`<b>${comarcaFeature.properties.NOMCOMAR}</b><br>Sense dades`);
        }
    });

    console.log("Visualització regional completada.");
}

// Funció per netejar l'estil de les comarques
function resetComarquesStyle() {
    if (typeof comarquesLayer !== 'undefined' && comarquesLayer) {
        comarquesLayer.eachLayer(layer => {
            // Estil per defecte
            layer.setStyle({
                fillColor: '#ccc',
                fillOpacity: 0.1,
                weight: 1,
                color: '#666',
                opacity: 0.5
            });
            layer.unbindPopup();
            layer.bindPopup(`<b>${layer.feature.properties.NOMCOMAR}</b>`);
        });
    }
}

// ===== AFEGIR AQUESTA NOVA FUNCIÓ DE COLORS =====

/**
 * Retorna un color per a l'escala de vent, basat en la velocitat en km/h.
 * @param {number} speedKmh - Velocitat del vent en km/h.
 * @returns {string} El color RGBA calculat.
 */
function getWindColor(speedKmh) {
    const alpha = 1;
    if (speedKmh < 1) return `rgba(200, 200, 200, ${alpha})`;  // Calma (gris)
    if (speedKmh < 10) return `rgba(173, 216, 230, ${alpha})`; // Blau cel
    if (speedKmh < 20) return `rgba(144, 238, 144, ${alpha})`; // Verd clar
    if (speedKmh < 30) return `rgba(152, 251, 152, ${alpha})`; // Verd pàl·lid
    if (speedKmh < 40) return `rgba(255, 255, 0, ${alpha})`;   // Groc
    if (speedKmh < 50) return `rgba(255, 215, 0, ${alpha})`;   // Groc daurat
    if (speedKmh < 60) return `rgba(255, 165, 0, ${alpha})`;   // Taronja
    if (speedKmh < 70) return `rgba(255, 140, 0, ${alpha})`;   // Taronja fosc
    if (speedKmh < 80) return `rgba(255, 69, 0, ${alpha})`;    // Vermell-taronja
    if (speedKmh < 100) return `rgba(255, 0, 0, ${alpha})`;     // Vermell
    if (speedKmh < 120) return `rgba(220, 20, 60, ${alpha})`;   // Carmesí
    return `rgba(199, 21, 133, ${alpha})`; // Magenta
}

/**
 * Retorna un color per a l'escala d'intensitat de precipitació en mm/min.
 */
function getIntensityColor(intensity) {
    if (intensity <= 0) return '#ffffff'; // Transparent per a zero
    if (intensity < 0.5) return "#a1d3fc"; // Molt feble
    if (intensity < 1) return "#0095f9"; // Feble
    if (intensity < 2) return "#00c42c"; // Moderada
    if (intensity < 4) return "#ffee47"; // Forta
    if (intensity < 6) return "#ff7235"; // Molt forta
    if (intensity < 10) return "#ff214e"; // Torrencial
    return "#bd30f3";                      // Extrema
}

// =======================================================================
// DUES NOVES ESCALES DE COLORS PER A PRECIPITACIÓ
// =======================================================================

// --- Escala 1: Per al SUMATORI DE PRECIPITACIÓ (la que vas demanar primer) ---
const colors_sumatori = ["#f0f0f0", "#d9e6bf", "#b3cc99", "#8cbf73", "#66b34d", "#4e8c48", "#287233", "#196f99",
    "#1c50d3", "#2c85ff", "#56a7f0", "#7cd7ff", "#ffed66", "#ffcc33", "#ffaa00", "#ff8800",
    "#ff5500", "#ff2200", "#cc0000", "#990066", "#d400ff", "#ff99ff", "#e0e0e0", "#b0b0b0",
    "#808080", "#665544", "#ccb977"];
const values_sumatori = [1, 2, 5, 7, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 125, 150, 175, 200, 250, 300, 400, 500];

function getPrecipitationSumColor(mm) {
    for (let i = 0; i < values_sumatori.length; i++) {
        if (mm <= values_sumatori[i]) {
            return colors_sumatori[i] || colors_sumatori[colors_sumatori.length - 1];
        }
    }
    return colors_sumatori[colors_sumatori.length - 1];
}


// --- Escala 2: Per a la PRECIPITACIÓ DIÀRIA (la nova que has demanat) ---
const colors_diaria = [
    "#a1d3fc", "#51b5fa", "#0095f9", "#106e2b", "#008126", "#00c42c", "#44e534",
    "#8fd444", "#91ea32", "#ffee47", "#ecd336", "#fd5523", "#ff7235", "#ff9a67", "#ff486f",
    "#ff214e", "#c30617", "#85030f", "#5b1670", "#bd30f3"
];
const values_diaria = [
    0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 100, 150, 200
];

function getDailyPrecipitationColor(mm) {
    // Cas especial per a pluja inapreciable o zero
    if (mm < values_diaria[0]) {
        return 'ffffff';
    }

    // Com que hi ha 20 colors i 21 valors, iterem fins al penúltim valor
    for (let i = 0; i < values_diaria.length - 1; i++) {
        if (mm <= values_diaria[i + 1]) {
            return colors_diaria[i];
        }
    }

    // Si el valor és més gran que l'últim llindar, retornem l'últim color.
    return colors_diaria[colors_diaria.length - 1];
}

/**
 * Retorna un color per a l'escala de precipitació semihorària (blocs de 30 min).
 */
function getSemihorariaPrecipColor(mm) {
    if (mm <= 0.1) return '#ffffff'; // Transparent per a pluja inapreciable
    if (mm < 1) return "#a1d3fc"; // Blau molt clar
    if (mm < 2.5) return "#51b5fa"; // Blau clar
    if (mm < 5) return "#0095f9"; // Blau
    if (mm < 10) return "#00c42c"; // Verd
    if (mm < 15) return "#ffee47"; // Groc
    if (mm < 25) return "#ff7235"; // Taronja
    if (mm < 40) return "#ff214e"; // Vermell
    return "#bd30f3";              // Lila per a valors molt alts
}

// ======================================================
// ESCALES DE COLORS OFICIALS PER A NEU (SMC/Oficial)
// ======================================================

const colors_neu = [
    "#bdbdbd", "#aba5a5", "#818181", "#616161", "#96d1f9", "#78b9fb", "#50a5f5", "#3c97f5",
    "#2883f1", "#1e6eeb", "#1464d3", "#0a5ac3", "#46028f", "#4c028f", "#54028d", "#5a028d",
    "#62028d", "#68028b", "#7c0289", "#990287", "#c30481", "#df047e", "#f3047c", "#f51485",
    "#f72a91", "#f93c9b", "#fd5eaf", "#ff6eb7", "#fb85c3", "#f58dc7", "#ed95cb", "#e79dcd",
    "#dfa5d1", "#d9add5", "#d1b5d9", "#cbbddd", "#c3c7e1", "#b5d7e9", "#abe3ef", "#a1eff3",
    "#99f7f7", "#95fbf9", "#93f3f1", "#89e7e5", "#7edbd9", "#72bdc5", "#78bbc7", "#81b7cd",
    "#89b1d1", "#91add5", "#99a7db", "#a3a3df"
];

const values_neu = [
    0.1, 0.5, 1, 2, 3, 5, 7, 9, 11, 13, 15, 17, 19, 22, 26, 30, 34, 38, 43, 49,
    55, 70, 90, 110, 130, 150, 200, 250, 270
];

// 1. Funció per a les ETIQUETES del mapa
function getSnowDepthColor(cm) {
    if (cm < values_neu[0]) return '#ffffff'; // Blanc per a valors < 0.1

    for (let i = 0; i < values_neu.length; i++) {
        if (cm <= values_neu[i]) {
            return colors_neu[i];
        }
    }
    // Si supera el màxim (270), retornem l'últim color o el següent de la llista
    return colors_neu[values_neu.length] || colors_neu[colors_neu.length - 1];
}

// 2. Funció per al GRADIENT DEL GRÀFIC
function getSnowGradient(ctx, chartArea, scales) {
    if (!chartArea) return '#96d1f9';
    const yAxis = scales.y;
    const maxVal = yAxis.max || 1;
    const maxScale = Math.max(maxVal, 1); // Evitem dividir per 0

    // Gradient de baix (0) a dalt (max)
    const gradient = ctx.createLinearGradient(0, yAxis.getPixelForValue(0), 0, yAxis.getPixelForValue(maxScale));

    // Color base
    gradient.addColorStop(0, colors_neu[0]);

    for (let i = 0; i < values_neu.length; i++) {
        const val = values_neu[i];
        const col = colors_neu[i];

        // Calculem on cau aquest valor dins l'escala vertical del gràfic (0 a 1)
        let offset = val / maxScale;

        // Només afegim el color si està dins del rang visible
        if (offset >= 0 && offset <= 1) {
            gradient.addColorStop(offset, col);
        }
    }
    return gradient;
}

/**
 * Retorna un color per a l'escala de variació de temperatura en 24h.
 * Vermells per a pujades (fins a +15°C), blaus per a baixades (fins a -15°C).
 * @param {number} variation - La variació de temperatura en °C.
 * @returns {string} El color RGBA calculat.
 */
function getVariationColor(variation) {
    const alpha = 1;
    // Valors positius (escalfament) -> Vermells
    if (variation > 12) return `rgba(180, 0, 0, ${alpha})`;      // Variació > +12°C
    if (variation > 8) return `rgba(255, 0, 0, ${alpha})`;       // Variació > +8°C
    if (variation > 4) return `rgba(255, 100, 100, ${alpha})`;   // Variació > +4°C
    if (variation > 0.5) return `rgba(255, 180, 180, ${alpha})`; // Variació > +0.5°C

    // Valors negatius (refredament) -> Blaus
    if (variation < -12) return `rgba(0, 0, 139, ${alpha})`;     // Variació < -12°C
    if (variation < -8) return `rgba(0, 0, 255, ${alpha})`;      // Variació < -8°C
    if (variation < -4) return `rgba(100, 100, 255, ${alpha})`;  // Variació < -4°C
    if (variation < -0.5) return `rgba(173, 216, 230, ${alpha})`;// Variació < -0.5°C

    // Canvi mínim (-0.5 a 0.5) -> Neutral
    return `rgba(240, 240, 240, ${alpha})`; // Gris molt clar
}

//CALCUL TEMPERATURA MITJANA

/**
 * Calcula la temperatura mitjana diària en temps real (des de les 00:00 fins ara).
 * També actualitza el marcador global de Catalunya.
 */
async function displayRealtimeMean(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const dateForQuery = targetDate || new Date();
    updateHistoricDisplay({ mode: targetDate ? 'historic' : 'live', type: 'summary', timestamp: dateForQuery });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon('Calculant mitjanes...') }).addTo(dataMarkersLayer);

    const globalPanel = document.getElementById('global-stats-panel');
    if (globalPanel) globalPanel.style.display = 'none';

    try {
        const startOfDay = new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 0, 0, 0, 0));
        const isToday = new Date().toDateString() === dateForQuery.toDateString();
        const endQuery = isToday ? new Date() : new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 23, 59, 59, 999));

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));

        const iniciString = startOfDay.toISOString().slice(0, 19);
        const fiString = endQuery.toISOString().slice(0, 19);

        // Demanem VARIABLE 32 (Temperatura instantània) per calcular nosaltres la mitjana
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT codi_estacio, valor_lectura WHERE data_lectura >= '${iniciString}' AND data_lectura <= '${fiString}' AND codi_variable = '32' LIMIT 50000&_=${Date.now()}`;

        const lectures = await $.getJSON(urlDades);
        const stationSums = new Map();
        const stationCounts = new Map();

        lectures.forEach(d => {
            const val = parseFloat(d.valor_lectura);
            if (!isNaN(val)) {
                const currentSum = stationSums.get(d.codi_estacio) || 0;
                const currentCount = stationCounts.get(d.codi_estacio) || 0;
                stationSums.set(d.codi_estacio, currentSum + val);
                stationCounts.set(d.codi_estacio, currentCount + 1);
            }
        });

        dataMarkersLayer.clearLayers();

        let totalCatalunyaSum = 0;
        let totalStationsCount = 0;
        const finalStations = [];

        stationSums.forEach((sum, code) => {
            const count = stationCounts.get(code);
            if (count > 5 && estacionsMap.has(code)) { // Mínim 5 lectures
                const avg = sum / count;
                const info = estacionsMap.get(code);

                totalCatalunyaSum += avg;
                totalStationsCount++;

                const color = getTempRgbaColor(avg);
                const formattedValue = avg.toFixed(1);
                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: #000; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18], iconAnchor: [15, 9]
                });

                const marker = L.marker([info.lat, info.lon], { icon }).addTo(dataMarkersLayer);

                // ========================================================
                // AFEGIT: LÒGICA DEL RÀNQUING PER A LA MITJANA CALCULADA
                // ========================================================
                if (config.showRank) {
                    marker.bindPopup(`
                        <b>${info.nom}</b><br>
                        <span style="font-size:14px; color:#333;">Mitjana en Curs: <b>${formattedValue} ${config.unit}</b></span>
                        <hr style="margin: 8px 0;">
                        <div id="rank-loader-${code}" style="font-size:12px; color:#666;">
                            ⏳ Calculant rànquing anual...
                        </div>
                    `);

                    marker.on('popupopen', async () => {
                        try {
                            // Fem servir la mateixa funció de rànquing que ja tenim!
                            const rankingData = await getStationYearlyRanking(code, dateForQuery.getFullYear(), avg);
                            const rankContainer = document.getElementById(`rank-loader-${code}`);
                            if (rankContainer) rankContainer.innerHTML = rankingData;
                        } catch (e) {
                            console.error(e);
                        }
                    });
                } else {
                    marker.bindPopup(`<b>${info.nom}</b><br>Mitjana (prov): ${formattedValue} °C`);
                }

                finalStations.push({ ...info, codi_estacio: code, valor: avg });
            }
        });

        if (config.isGlobalAvg && totalStationsCount > 0 && globalPanel) {
            const mitjanaCatalunya = totalCatalunyaSum / totalStationsCount;
            const valDiv = document.getElementById('global-stats-value');
            const descDiv = document.getElementById('global-stats-count');

            let colorGlobal = '#fff';
            if (mitjanaCatalunya < 5) colorGlobal = '#aeeaff';
            else if (mitjanaCatalunya > 25) colorGlobal = '#ff8787';

            valDiv.innerHTML = `${mitjanaCatalunya.toFixed(1)} °C`;
            valDiv.style.color = colorGlobal;
            descDiv.innerText = `Mitjana de ${totalStationsCount} estacions`;
            globalPanel.style.display = 'block';
        }

        lastSumatoriResult = finalStations;

    } catch (error) {
        console.error("Error a displayRealtimeMean:", error);
        dataMarkersLayer.clearLayers();
    } finally {
        isLoadingData = false;
    }
}
async function displayPrecipitationSum() {
    if (isLoadingData) return;

    const startDateInput = document.getElementById('start-date').value;
    const endDateInput = document.getElementById('end-date').value;

    if (!startDateInput || !endDateInput || new Date(startDateInput) >= new Date(endDateInput)) {
        alert("Si us plau, selecciona un interval de dates vàlid.");
        return;
    }

    const startDate = new Date(startDateInput);
    const endDate = new Date(endDateInput);
    endDate.setUTCHours(23, 59, 59, 999);

    isLoadingData = true;
    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), {
        icon: createLoadingIcon('Processant dades...')
    }).addTo(dataMarkersLayer);

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));
        const promises = [];
        let loopDate = new Date(startDate);
        const today = new Date();
        const cutoffDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
        cutoffDate.setUTCHours(0, 0, 0, 0);

        while (loopDate <= endDate) {
            const startOfDay = new Date(Date.UTC(loopDate.getUTCFullYear(), loopDate.getUTCMonth(), loopDate.getUTCDate()));

            if (loopDate < cutoffDate) {
                const startOfDayCopy = new Date(startOfDay);
                const p = fetchDailyAccumulationDirectly(startOfDayCopy).then(async res => {
                    if (!res || !res.data || res.data.length === 0) {
                        console.log(`[Sumatori] Dades oficials 1300 no disponibles pel dia ${startOfDayCopy.toISOString()}, fent fallback a variable 35.`);
                        const endOfDay = new Date(startOfDayCopy);
                        endOfDay.setUTCHours(23, 59, 59, 999);
                        return await fetchSmcDailySummary(35, 'sum', startOfDayCopy, endOfDay);
                    }
                    return res;
                });
                promises.push(p);
            } else {
                const endOfDay = new Date(startOfDay);
                endOfDay.setUTCHours(23, 59, 59, 999);
                promises.push(fetchSmcDailySummary(35, 'sum', startOfDay, endOfDay));
            }
            loopDate.setDate(loopDate.getDate() + 1);
        }

        const dailyResults = await Promise.all(promises);

        const finalSums = new Map();
        for (const dayResult of dailyResults) {
            if (dayResult && dayResult.data) {
                for (const stationData of dayResult.data) {
                    const stationCode = stationData.codi_estacio;
                    const dailyValue = parseFloat(stationData.valor);
                    if (!isNaN(dailyValue)) {
                        const currentTotal = finalSums.get(stationCode) || 0;
                        finalSums.set(stationCode, currentTotal + dailyValue);
                    }
                }
            }
        }

        // NOU: Convertim el Map 'finalSums' a un Array estàndard per poder filtrar-lo
        const finalDataArray = [];
        finalSums.forEach((totalSum, stationCode) => {
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo) {
                finalDataArray.push({
                    ...estacioInfo,
                    codi_estacio: stationCode,
                    valor: totalSum, // Aquesta és la propietat que 'applyDataFilters' espera
                    altitud: estacioInfo.altitud // Ja l'havíem afegit a estacionsMap
                });
            }
        });

        // NOU: Ara apliquem els filtres sobre l'array
        const filteredData = applyDataFilters(finalDataArray);

        dataMarkersLayer.clearLayers();

        if (filteredData.length === 0) { // <-- Comprovem l'array filtrat
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades (o estan filtrades)' }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3000);
            return;
        }

        // NOU: Fem el bucle sobre 'filteredData'
        filteredData.forEach(estacio => {
            const totalSum = estacio.valor;

            if (totalSum > 0) {
                const color = getPrecipitationSumColor(totalSum);

                // ★ NOVA LÍNIA PER CALCULAR EL COLOR DEL TEXT
                const textColor = totalSum > 80 ? '#FFFFFF' : '#000000';

                const formattedValue = formatValueForLabel(totalSum, 1);

                const icon = L.divIcon({
                    className: 'temp-label',
                    // ★ AFEGEIX 'color: ${textColor}' A L'ESTIL HTML
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                // ★ IMPORTANT: Afegim el popup amb el gràfic per al sumatori
                const sumConfig = {
                    id: 35,
                    name: 'Precipitació',
                    unit: 'mm',
                    isSumatoriChart: true,
                    sumStartDate: startDate,
                    sumEndDate: endDate
                };

                const popupHTML = generateChartPopupHTML(estacio, 35, sumConfig);

                // Assignem al marcador i l'afegim al mapa
                const marker = L.marker([estacio.lat, estacio.lon], { icon: icon });
                marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });
                marker.addTo(dataMarkersLayer);

                // Quan obrim el popup, carreguem el gràfic per dies
                marker.on('popupopen', () => {
                    const canvasId = `chart-${estacio.codi_estacio}`;
                    // Enviem hores = 0 perquè farem servir les dates del 'config' a dins
                    loadStationChart(estacio.codi_estacio, 35, canvasId, 'Precipitació Múltiples Dies', 0, false, false, 1, sumConfig, null);
                    setupPopupEvents(estacio, 35, sumConfig, null);
                });
            } // <--- 1. TANQUEM EL IF
        }); // <--- 2. TANQUEM EL FOREACH I EL PARÈNTESI

        lastSumatoriResult = finalDataArray;

    } catch (error) { // <--- 3. ARA EL CATCH JA ÉS CORRECTE
        console.error("Error al mostrar el sumatori de precipitació:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

/**
 * Crea una icona de barba de vent (Wind Barb).
 * - Si el vent és < 0.5 m/s: Dibuixa símbol de CALMA (Cercle).
 * - Si el vent és >= 0.5 m/s: Dibuixa la barba orientada.
 */
function createWindBarbIcon(speed_ms, direction) {
    // 1. Càlculs de base
    const speedKmh = speed_ms * 3.6;
    const color = getWindColor(speedKmh);
    const knots = speed_ms * 1.94384;

    // 2. Configuració de Mida
    const scale = 2.0;

    // --- CAS ESPECIAL: CALMA (Vent < 0.5 m/s) ---
    // --- CAS ESPECIAL: CALMA (Vent < 0.5 m/s) ---
    if (speed_ms < 0.5) {
        // Cercle exterior (Anell de color amb vora fina negra)
        // Radi 3 * scale és prou gran per veure's però no gegant
        const outerRing = `<circle cx="0" cy="0" r="${3 * scale}" fill="none" stroke="${color}" stroke-width="${1.5 * scale}" />`;

        // Contorn negre fi per l'exterior de l'anell (perquè es vegi sobre blanc)
        const outerBorder = `<circle cx="0" cy="0" r="${3.8 * scale}" fill="none" stroke="black" stroke-width="${0.5 * scale}" />`;

        // Puntet central petit
        const centerDot = `<circle cx="0" cy="0" r="${0.8 * scale}" fill="black" />`;

        const svgCalm = `
            <div class="wind-barb-icon-wrapper" style="transform: rotate(0deg);">
                <svg class="wind-barb-svg" viewBox="-20 -20 40 40" style="overflow: visible;">
                    ${outerBorder}
                    ${outerRing}
                    ${centerDot}
                </svg>
            </div>`;

        return L.divIcon({
            html: svgCalm,
            className: 'wind-barb-icon-container',
            iconSize: [40, 40], // Mida del contenidor reduïda
            iconAnchor: [20, 20]
        });
    }

    // --- CAS NORMAL: AMB VENT (Shaft + Barbs) ---

    const shaftHeight = 18 * scale;
    const barbWidth = 1.5 * scale;
    const outlineWidth = barbWidth + 2.0;

    let pathsBlack = '';
    let pathsColor = '';

    let pY = shaftHeight;
    let remainingKnots = Math.round(knots / 5) * 5;

    // A) Banderoles (Triangles) - 50 nusos
    while (remainingKnots >= 50) {
        const p1 = `${7 * scale} ${pY - (2.5 * scale)}`;
        const p2 = `0 ${pY - (5 * scale)}`;
        const pathD = `M 0 ${pY} L ${p1} L ${p2} Z`;

        pathsBlack += `<path d="${pathD}" fill="black" stroke="black" stroke-width="${outlineWidth / 2}" stroke-linejoin="round" />`;
        pathsColor += `<path d="${pathD}" fill="${color}" stroke="none" />`;

        pY -= (6 * scale);
        remainingKnots -= 50;
    }

    // B) Barbes Llargues (Línies) - 10 nusos
    while (remainingKnots >= 10) {
        const endX = 8 * scale;
        const endY = pY + (3 * scale);

        pathsBlack += `<line x1="0" y1="${pY}" x2="${endX}" y2="${endY}" stroke="black" stroke-width="${outlineWidth}" stroke-linecap="round" />`;
        pathsColor += `<line x1="0" y1="${pY}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="${barbWidth}" stroke-linecap="round" />`;

        pY -= (3.5 * scale);
        remainingKnots -= 10;
    }

    // C) Mitja Barba - 5 nusos
    if (remainingKnots >= 5) {
        const endX = 4 * scale;
        const endY = pY + (1.5 * scale);

        pathsBlack += `<line x1="0" y1="${pY}" x2="${endX}" y2="${endY}" stroke="black" stroke-width="${outlineWidth}" stroke-linecap="round" />`;
        pathsColor += `<line x1="0" y1="${pY}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="${barbWidth}" stroke-linecap="round" />`;
    }

    // D) Tija Principal
    const shaftBlack = `<line x1="0" y1="0" x2="0" y2="${shaftHeight}" stroke="black" stroke-width="${outlineWidth}" stroke-linecap="round" />`;
    const shaftColor = `<line x1="0" y1="0" x2="0" y2="${shaftHeight}" stroke="${color}" stroke-width="${barbWidth}" stroke-linecap="round" />`;

    // E) Punt d'Estació (Petit)
    const stationDot = `<circle cx="0" cy="0" r="${1.0 * scale}" fill="${color}" stroke="black" stroke-width="1.5" />`;

    // 4. Rotació
    // Si hi ha vent, rotem. Si la direcció ve null, posem 0.
    const rotation = (direction || 0) + 180;

    // 5. Muntatge final
    const viewSize = 40 * scale;
    const svg = `
        <div class="wind-barb-icon-wrapper" style="transform: rotate(${rotation}deg); transform-origin: center center;">
            <svg class="wind-barb-svg" viewBox="-${viewSize / 2} -${10 * scale} ${viewSize} ${shaftHeight + (20 * scale)}" style="overflow: visible;">
                ${shaftBlack}
                ${pathsBlack}
                ${shaftColor}
                ${pathsColor}
                ${stationDot}
            </svg>
        </div>`;

    return L.divIcon({
        html: svg,
        className: 'wind-barb-icon-container',
        iconSize: [50, 50],
        iconAnchor: [25, 25]
    });
}

/**
 * ★ VERSIÓ FINAL AMB GRÀFICS: Mostra la variació d'una variable ★
 * Ara inclou la lògica per obrir el gràfic de barres (Televishow) al popup.
 */
async function displayVariation(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

    const isHistoric = targetDate !== null;
    const dateForDay = isHistoric ? targetDate : new Date();

    if (!isHistoric) { lastCheckedTimestamp = findLatestSmcTimestamp(new Date()); }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'variation',
        timestamp: dateForDay
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Carregant ${config.name}...`) }).addTo(dataMarkersLayer);

    let todayDataRaw, yesterdayDataRaw;

    try {
        if (config.comparison === 'daily_summary') {
            // Lògica per a resums diaris (Tmax, Tmin...)
            const startOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
            const endOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));
            const startOfYesterday = new Date(startOfToday.getTime() - (24 * 60 * 60 * 1000));
            const endOfYesterday = new Date(endOfToday.getTime() - (24 * 60 * 60 * 1000));
            [todayDataRaw, yesterdayDataRaw] = await Promise.all([
                fetchSmcDailySummary(config.base_id, config.summary, startOfToday, endOfToday),
                fetchSmcDailySummary(config.base_id, config.summary, startOfYesterday, endOfYesterday)
            ]);

        } else { // 'instant' -> AQUÍ ENTRA LA NEU (1h, 3h...)
            const timestampAvui = isHistoric ? roundToSemiHourly(new Date(targetDate)) : findLatestSmcTimestamp(new Date());
            const timeshiftMs = (config.timeshift_hours || 24) * 60 * 60 * 1000;
            const timestampAnterior = new Date(timestampAvui.getTime() - timeshiftMs);

            const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
            const metadata = await $.getJSON(urlMetadades);
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));

            const [todayValues, yesterdayValues] = await Promise.all([
                fetchSmcInstant(config.base_id, timestampAvui),
                fetchSmcInstant(config.base_id, timestampAnterior)
            ]);

            const processInstantData = (data) => data.map(d => ({ ...d, ...estacionsMap.get(d.codi_estacio) })).filter(d => d.lat);
            todayDataRaw = { data: processInstantData(todayValues) };
            yesterdayDataRaw = { data: processInstantData(yesterdayValues) };
        }

        const todayValuesMap = new Map(todayDataRaw.data.map(d => [d.codi_estacio, parseFloat(d.valor || d.valor_lectura)]));

        const finalData = yesterdayDataRaw.data.map(estacioAnterior => {
            const codiEstacio = estacioAnterior.codi_estacio;
            if (todayValuesMap.has(codiEstacio)) {
                const valorAvui = todayValuesMap.get(codiEstacio);
                const valorAnterior = parseFloat(estacioAnterior.valor || estacioAnterior.valor_lectura);
                if (!isNaN(valorAvui) && !isNaN(valorAnterior)) {
                    // Calculem la diferència i retornem l'objecte complet
                    return { ...estacioAnterior, valor: valorAvui - valorAnterior };
                }
            }
            return null;
        }).filter(d => d !== null);

        dataMarkersLayer.clearLayers();
        if (finalData.length === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades coincidents' }) }).addTo(dataMarkersLayer);
        }

        // NOU: Aplicar filtres (si n'hi ha)
        const filteredData = applyDataFilters(finalData);

        filteredData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;

            // Selecció intel·ligent del color
            let color;
            if (config.base_id === 34) {
                color = getPressureTrendColor(value);
            } else if (config.base_id === 38) { // NEU
                color = getSnowVariationColor(value);
            } else {
                color = getVariationColor(value); // Temperatura
            }

            let textColor = '#000000';
            // Lògica de text blanc per a valors extrems
            if (config.base_id === 38) { // Neu
                if (value > 10 || value < -10) textColor = '#FFFFFF';
            } else if (config.base_id !== 34) { // Temp
                if (value > 8 || value < -8) textColor = '#FFFFFF';
            }

            const formattedValue = (value > 0 ? '+' : '') + value.toFixed(config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18], iconAnchor: [15, 9]
            });

            const marker = L.marker([estacio.lat, estacio.lon], { icon: icon }).addTo(dataMarkersLayer);

            // ★★★ AQUÍ ESTÀ LA CLAU PER AL GRÀFIC ★★★
            // Comprovem si és una estació SMC per activar el gràfic
            if (estacio.source === 'smc' || !estacio.source) {

                // Preparem l'objecte estació amb el valor calculat per al títol del popup
                estacio.valor = value;

                // Usem l'ID base (ex: 38 per neu, 32 per temp) per demanar les dades històriques
                const chartVarId = config.base_id;

                // 1. Generem l'HTML del popup amb el canvas
                const popupHTML = generateChartPopupHTML(estacio, chartVarId, config);

                marker.bindPopup(popupHTML, { maxWidth: 360, className: 'chart-popup' });

                // 2. Afegim l'event per carregar el gràfic quan s'obri
                marker.on('popupopen', () => {
                    const canvasId = `chart-${estacio.codi_estacio}`;

                    loadStationChart(
                        estacio.codi_estacio,
                        chartVarId, // Passem l'ID base (38)
                        canvasId,
                        config.name,
                        24,
                        false,
                        false,
                        1,
                        { ...config, lat: estacio.lat, lon: estacio.lon }, // Passem la config completa perquè detecti 'comparison: instant'
                        dateForDay
                    );

                    setupPopupEvents(estacio, chartVarId, config, dateForDay);
                });

            } else {
                // Fallback per si no és SMC
                marker.bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`);
            }
        });

    } catch (error) {
        console.error("Error a displayVariation:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error carregant les dades' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// ===================================================================
// SECCIÓ DE LA CAPA DE VENT (VERSIÓ NETA I REFACTORITZADA)
// ===================================================================

const convergencesLayer = L.layerGroup({ pane: 'convergenciaPane' });
const stationDivergencePolygonsLayer = L.layerGroup();
const stationConvergencePolygonsLayer = L.layerGroup();
const stationHumidityMapLayer = L.layerGroup();
let windArrowsLayer = L.layerGroup({ pane: 'convergenciaPane' });
let areArrowsVisible = true;
let isLoadingWind = false;
let windUpdateInterval = null;
let windUpdateTimeout = null;

// --- Funcions de càrrega de dades (Globals) ---

async function loadAemetData() {
    const apiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";
    const urlInicial = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
    try {
        const res1 = await fetch(urlInicial, { headers: { 'api_key': apiKey, 'accept': 'application/json' } });
        const info = await res1.json();
        if (info.estado !== 200) throw new Error(info.descripcion);
        const res2 = await fetch(info.datos);
        const rawData = await res2.json();
        return processAemetData(rawData);
    } catch (error) {
        console.error("Error AEMET:", error);
        return { data: [], timestamp: null };
    }
}

function processAemetData(data) {
    const BBOX_CAT = { minLat: 40.5, maxLat: 42.9, minLon: 0.1, maxLon: 3.4 };
    const estacionsCat = data.filter(d => d.lat >= BBOX_CAT.minLat && d.lat <= BBOX_CAT.maxLat && d.lon >= BBOX_CAT.minLon && d.lon <= BBOX_CAT.maxLon);
    if (estacionsCat.length === 0) return { data: [], timestamp: null };

    const ultimaDataAemet = estacionsCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsCat[0].fint);
    const dadesFinals = estacionsCat.filter(d => d.fint === ultimaDataAemet);

    const processedData = dadesFinals.map(estacio => {
        // ★ CANVI CLAU: Triem velocitat o ratxa ★
        let speed;
        if (windDataType === 'gust') {
            speed = estacio.vmax; // Ratxa màxima
        } else {
            speed = estacio.vv;   // Velocitat mitjana
        }

        const direction = estacio.dv;

        if (typeof speed === 'undefined' || typeof direction === 'undefined') return null;

        const angleRad = (270 - direction) * (Math.PI / 180);

        let td = null, mr = null, qnh = null;
        if (estacio.ta !== undefined && estacio.hr !== undefined && estacio.hr > 0) {
            const T = estacio.ta;
            const RH = estacio.hr;
            const a = 17.27;
            const b = 237.7;
            const alpha = ((a * T) / (b + T)) + Math.log(RH / 100.0);
            td = (b * alpha) / (a - alpha);
            const es = 6.112 * Math.exp((17.67 * td) / (td + 243.5));
            mr = 622 * (es / (1000 - es));
        }

        if (estacio.pres !== undefined && estacio.ta !== undefined && estacio.alt !== undefined) {
            const h = estacio.alt;
            const T_k = estacio.ta + 273.15;
            qnh = estacio.pres * Math.pow(1 - (0.0065 * h) / (T_k + 0.0065 * h), -5.257);
        }

        return { lat: estacio.lat, lon: estacio.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), rh: estacio.hr, td: td, mr: mr, pres: qnh, prec: (estacio.prec || 0), nom: estacio.ubi };
    }).filter(d => d !== null);

    return { data: processedData, timestamp: ultimaDataAemet };
}

function loadSmcData(targetDate = null) {
    return new Promise((resolve) => {
        // Si passem una data (històric), la fem servir. Si no, busquem l'última disponible (directe).
        // Utilitzem findLatestSmcTimestamp per arrodonir als minuts correctes (:00 o :30)
        const baseDate = targetDate ? new Date(targetDate) : new Date();
        const targetTimestamp = findLatestSmcTimestamp(baseDate);

        const yyyy = targetTimestamp.getUTCFullYear();
        const mm = String(targetTimestamp.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(targetTimestamp.getUTCDate()).padStart(2, '0');
        const hh = String(targetTimestamp.getUTCHours()).padStart(2, '0');
        const mi = String(targetTimestamp.getUTCMinutes()).padStart(2, '0');
        const finalTimestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        let variableCodes;
        if (windDataType === 'gust') {
            variableCodes = [50, 51, 53, 54, 56, 57, 33, 32, 35, 34];
            console.log(`[VENT+THERMO+P] Carregant RATXES, HR, T, PR, QNH...`);
        } else {
            variableCodes = [30, 31, 46, 47, 48, 49, 33, 32, 35, 34];
            console.log(`[VENT+THERMO+P] Carregant VENT, HR, T, PR, QNH...`);
        }

        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));

            const requests = variableCodes.map(code => {
                const url = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${code}&_=${Date.now()}`;
                return $.getJSON(url).catch(() => null);
            });

            $.when(...requests).done((...responses) => {
                const datasets = responses.map(r => r ? r[0] : null);
                const smcWindData = processSmcData(datasets, estacionsMap);
                resolve({ data: smcWindData, timestamp: finalTimestampString });
            });
        }).fail(() => resolve({ data: [], timestamp: null }));
    });
}

function processSmcData(datasets, estacionsMap) {
    const [wind10m, dir10m, wind2m, dir2m, wind6m, dir6m, humitat, temperatura, precipitacio, pressio] = datasets;
    const allWind = [wind10m, wind6m, wind2m];
    const allDir = [dir10m, dir6m, dir2m];
    const processedStations = new Set();
    const smcWindData = [];

    const humMap = humitat ? new Map(humitat.map(h => [h.codi_estacio, parseFloat(h.valor_lectura)])) : new Map();
    const tempMap = temperatura ? new Map(temperatura.map(t => [t.codi_estacio, parseFloat(t.valor_lectura)])) : new Map();
    const precMap = precipitacio ? new Map(precipitacio.map(p => [p.codi_estacio, parseFloat(p.valor_lectura)])) : new Map();
    const presMap = pressio ? new Map(pressio.map(p => [p.codi_estacio, parseFloat(p.valor_lectura)])) : new Map();

    allWind.forEach((windBlock, idx) => {
        if (!windBlock) return;
        const dirBlock = allDir[idx];
        if (!dirBlock) return;
        const dirMap = new Map(dirBlock.map(d => [d.codi_estacio, parseFloat(d.valor_lectura)]));

        windBlock.forEach(w => {
            const stationCode = w.codi_estacio;
            if (processedStations.has(stationCode) || !dirMap.has(stationCode)) return;
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo) {
                const speed = parseFloat(w.valor_lectura);
                const direction = dirMap.get(stationCode);
                const angleRad = (270 - direction) * (Math.PI / 180);
                const hr = humMap.get(stationCode);
                const t = tempMap.get(stationCode);
                const prec = precMap.get(stationCode) || 0;
                let pres = presMap.get(stationCode);

                let td = null, mr = null, qnh = null;
                if (t !== undefined && hr !== undefined && hr > 0) {
                    const a = 17.27;
                    const b = 237.7;
                    const alpha = ((a * t) / (b + t)) + Math.log(hr / 100.0);
                    td = (b * alpha) / (a - alpha);
                    const es = 6.112 * Math.exp((17.67 * td) / (td + 243.5));
                    mr = 622 * (es / (1000 - es));
                }

                if (pres !== undefined && t !== undefined && estacioInfo.altitud !== undefined) {
                    const h = estacioInfo.altitud;
                    const T_k = t + 273.15;
                    qnh = pres * Math.pow(1 - (0.0065 * h) / (T_k + 0.0065 * h), -5.257);
                }

                smcWindData.push({ lat: estacioInfo.lat, lon: estacioInfo.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), rh: hr, td: td, mr: mr, pres: qnh, prec: prec, codi_estacio: stationCode, nom: estacioInfo.nom });
                processedStations.add(stationCode);
            }
        });
    });
    return smcWindData;
}


let windColorOption = 'black'; // Opció per defecte
let windDataType = 'avg'; // Valors possibles: 'avg' (Mitjana) o 'gust' (Ratxa)
let windAnimationMode = 'particles'; // 'particles' o 'tv-arrows'
let windParticleMultiplier = 30; // Nombre de partícules (divisor)
let windVelocityScale = 0.010;   // Escala de velocitat
let windParticleAge = 2300;      // Edat de la partícula
let windLineWidth = 1.5;         // Gruix de la línia (Ajustat a 1.5 per defecte)
let activeGeoJsonLayer = null; // Per saber quina capa estem editant
let lastWindData = []; // Per cachejar l'última dada de vent i no haver de fer fetch als sliders
let tvWindLayer = null; // Instància de l'animació TV

/**
 * CAPA PERSONALITZADA TVWindLayer:
 * Representació de vent estil televisió amb fletxes que es mouen.
 */
L.TVWindLayer = L.Layer.extend({
    options: {
        numArrows: 1500,
        maxAge: 100,
        scale: 1.2,
        color: 'white'
    },

    initialize: function (grid, options) {
        L.setOptions(this, options);
        this._grid = grid;
        this._header = grid[0].header;
        this._particles = [];
        this._animationId = null;
        this._dpr = window.devicePixelRatio || 1;
    },

    onAdd: function (map) {
        this._map = map;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-wind-tv-layer');
        this._canvas.style.pointerEvents = 'none';
        this._canvas.style.opacity = '0.9';
        const pane = this.options.pane || 'overlayPane';
        map.getPane(pane).appendChild(this._canvas);

        map.on('moveend', this._reset, this);
        map.on('zoomstart', this._hide, this);
        map.on('zoomend', this._reset, this);
        map.on('resize', this._reset, this);

        this._reset();
        this._initParticles();
        this._startAnimation();
    },

    onRemove: function (map) {
        if (this._canvas) L.DomUtil.remove(this._canvas);
        if (this._animationId) cancelAnimationFrame(this._animationId);
        map.off('moveend', this._reset, this);
        map.off('zoomstart', this._hide, this);
        map.off('zoomend', this._reset, this);
        map.off('resize', this._reset, this);
    },

    _hide: function () {
        if (this._canvas) this._canvas.style.display = 'none';
    },

    _reset: function () {
        if (!this._map || !this._canvas) return;
        this._canvas.style.display = 'block';
        const size = this._map.getSize();
        const dpr = this._dpr;
        // Canvas HiDPI: renderitzem a la resolució nativa del dispositiu
        // per evitar l'upscaling del navegador que causa shimmer/vibració
        this._canvas.width = size.x * dpr;
        this._canvas.height = size.y * dpr;
        this._canvas.style.width = size.x + 'px';
        this._canvas.style.height = size.y + 'px';
        this._logicalWidth = size.x;
        this._logicalHeight = size.y;
        const pos = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, pos);
    },

    _initParticles: function (optionalNum) {
        this._particles = [];
        const baseLife = 6000; // Passem a 6 segons per evitar desaparicions brutes
        const num = optionalNum || Math.floor(2500 / (windParticleMultiplier / 30));
        for (let i = 0; i < num; i++) {
            this._particles.push({
                ...this._createParticle(baseLife),
                age: Math.floor(Math.random() * baseLife)
            });
        }
    },

    setParticleMultiplier: function (m) {
        const num = Math.floor(2500 / (m / 30));
        // Només reiniciem si el canvi és significatiu per no tallar la fluïdesa
        if (Math.abs(this._particles.length - num) > 100) {
            this._initParticles(num);
        }
    },

    _createParticle: function (maxLife = 6000) {
        const bounds = this._map.getBounds();
        return {
            lat: bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth()),
            lon: bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest()),
            age: 0,
            maxAge: maxLife + Math.random() * 1500 // Variació entre 6s i 7.5s
        };
    },

    _getWindAt: function (lat, lon) {
        const uField = this._grid[0].data;
        const vField = this._grid[1].data;

        // El grid és 25 (lat) x 37 (lon)
        // Lat: 42.9 -> 40.5 (pas -0.1)
        // Lon: 0.1 -> 3.7 (pas 0.1)

        // Coordenades del grid ("índexs flotants")
        const fi = (this._header.la1 - lat) / this._header.dy;
        const fj = (lon - this._header.lo1) / this._header.dx;

        // Bilinear Interpolation: busquem els 4 punts veïns
        const i0 = Math.floor(fi);
        const i1 = i0 + 1;
        const j0 = Math.floor(fj);
        const j1 = j0 + 1;

        if (i0 < 0 || i1 >= this._header.ny || j0 < 0 || j1 >= this._header.nx) return null;

        // Pesos per a la interpolació
        const di = fi - i0;
        const dj = fj - j0;

        const getVal = (field, i, j) => field[i * this._header.nx + j];

        // Interpolació per a U i V
        const interpolate = (field) => {
            const v00 = getVal(field, i0, j0);
            const v01 = getVal(field, i0, j1);
            const v10 = getVal(field, i1, j0);
            const v11 = getVal(field, i1, j1);
            return v00 * (1 - di) * (1 - dj) +
                v01 * (1 - di) * dj +
                v10 * di * (1 - dj) +
                v11 * di * dj;
        };

        return { u: interpolate(uField), v: interpolate(vField) };
    },

    _startAnimation: function () {
        const self = this;
        const ctx = this._canvas.getContext('2d');
        let lastTime = performance.now();

        function frame(time) {
            if (!self._canvas) return;
            const dt = time - lastTime;
            lastTime = time;

            const dpr = self._dpr;
            const w = self._logicalWidth;
            const h = self._logicalHeight;

            // Resetem la transformació i netejem a resolució nativa
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, self._canvas.width, self._canvas.height);
            // Escalem al DPR perquè tot el codi de dibuix treballi en píxels CSS lògics
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // Passem dt per fer l'animació independent dels frames
            self._updateAndDraw(ctx, dt > 100 ? 16 : dt, w, h);
            self._animationId = requestAnimationFrame(frame);
        }
        frame(performance.now());
    },

    _updateAndDraw: function (ctx, dt, canvasW, canvasH) {
        const self = this;
        const color = windColorOption === 'intensity' ? null : (windColorOption === 'white' ? 'white' : 'black');

        // Pas angular per a quantització (~3.6° = PI/50)
        // Això assegura que el rasteritzat de cada fletxa es manté estable
        // mentre es mou, perquè l'angle no canvia fins que la diferència
        // supera els ~3.6°. La precisió visual és imperceptible.
        const ANGLE_STEP = Math.PI / 50; // 100 angles discrets en 360°

        this._particles.forEach(p => {
            const wind = self._getWindAt(p.lat, p.lon);
            if (!wind || p.age > p.maxAge) {
                Object.assign(p, self._createParticle(p.maxAge));
                p.age = 0;
                return;
            }

            // Factor de velocitat dinàmic equilibrat
            const speedFact = windVelocityScale * 12;
            const moveStep = dt / 16;

            // CORRECCIÓ DE PROJECCIÓ (Mercator 42N): 
            // 1 grau Lon és aprox 0.743 vegades 1 grau Lat a Catalunya
            // Per tant, el pas Lon ha de ser 1.34 vegades major per a la mateixa velocitat en km
            const lonCorr = 1.345;

            p.lat += wind.v * speedFact * 0.001 * moveStep;
            p.lon += wind.u * speedFact * 0.001 * moveStep * lonCorr;
            p.age += dt;

            const point = self._map.latLngToContainerPoint([p.lat, p.lon]);
            // Coordenades en píxels CSS lògics (sense arrodonir: el canvas HiDPI
            // gestiona el sub-pixel correctament a resolució nativa)
            const px = point.x;
            const py = point.y;
            // Ampliem marges de dibuix per evitar talls bruscos
            if (px < -50 || px > canvasW + 50 || py < -50 || py > canvasH + 50) {
                Object.assign(p, self._createParticle(p.maxAge));
                return;
            }

            const speed = Math.sqrt(wind.u * wind.u + wind.v * wind.v);

            // Quantització angular: arrodonim l'angle a passos discrets
            // per evitar que el rasteritzat de la fletxa canviï cada frame
            const rawAngle = Math.atan2(-wind.v, wind.u);
            const angle = Math.round(rawAngle / ANGLE_STEP) * ANGLE_STEP;

            if (speed < 0.14) return;

            // Fade de cicle de vida
            let opacity = 1.0;
            const fadeIn = 1200;
            const fadeOut = 1200;
            if (p.age < fadeIn) opacity = p.age / fadeIn;
            else if (p.age > p.maxAge - fadeOut) opacity = (p.maxAge - p.age) / fadeOut;

            // Fade de seguretat a les vores del mapa
            const m = 40; // marge en píxels
            let edgeOpacity = 1.0;
            if (px < m) edgeOpacity = Math.max(0, px / m);
            else if (px > canvasW - m) edgeOpacity = Math.max(0, (canvasW - px) / m);
            if (py < m) edgeOpacity = Math.min(edgeOpacity, Math.max(0, py / m));
            else if (py > canvasH - m) edgeOpacity = Math.min(edgeOpacity, Math.max(0, (canvasH - py) / m));

            opacity *= edgeOpacity;

            self._drawArrow(ctx, px, py, angle, speed, opacity, color);
        });
    },

    _drawArrow: function (ctx, x, y, angle, speed, opacity, fixedColor) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        // GEOMETRIA DINÀMICA: Reduïm la mida si la densitat és molt alta per no saturar
        const densityFactor = Math.max(0.5, Math.min(1.0, windParticleMultiplier / 30));
        const totalLength = Math.min(12 + speed * 1.8, 42) * (windLineWidth / 2) * densityFactor;
        const headLength = totalLength * 0.38;
        const headWidth = Math.min(6 + speed * 0.5, 14) * (windLineWidth / 2) * densityFactor;
        const bodyWidthAtHead = headWidth * 0.42;

        let baseColor = fixedColor || this._getColorForSpeed(speed * 3.6);
        if (baseColor === 'black') baseColor = '#000000';
        if (baseColor === 'white') baseColor = '#ffffff';

        ctx.globalAlpha = opacity;

        // 1. DIBUIX DEL COS (Falca degradada)
        // Va des d'un punt gairebé invisible a la cua fins a l'amplada de la unió
        const bodyGrad = ctx.createLinearGradient(-totalLength, 0, totalLength - headLength, 0);
        bodyGrad.addColorStop(0, 'transparent');
        bodyGrad.addColorStop(1, baseColor);

        ctx.beginPath();
        ctx.moveTo(-totalLength, 0); // Cua (punt)
        ctx.lineTo(totalLength - headLength, bodyWidthAtHead / 2);
        ctx.lineTo(totalLength - headLength, -bodyWidthAtHead / 2);
        ctx.closePath();
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // 2. DIBUIX DEL CAP (Triangle definit)
        // El cap neix a la unió i acaba a la punta
        ctx.beginPath();
        ctx.moveTo(totalLength, 0); // Punta
        ctx.lineTo(totalLength - headLength, headWidth / 2); // Ala superior
        ctx.lineTo(totalLength - headLength, -headWidth / 2); // Ala inferior
        ctx.closePath();
        ctx.fillStyle = baseColor;
        ctx.fill();

        ctx.restore();
    },

    _getColorForSpeed: function (s) {
        if (s < 10) return "#a1d3fc";
        if (s < 20) return "#3b82f6";
        if (s < 40) return "#10b981";
        if (s < 60) return "#fbbf24";
        if (s < 80) return "#f97316";
        return "#ef4444";
    }
});




// ARA, substitueix la funció sencera.
let cachedWindGrid = null;
let lastInterpolationRef = null;

function displayCombinedWindData(combinedData, colorOption = 'black') {
    const rows = 125, cols = 185;
    const latitudep = Array.from({ length: rows }, (_, i) => 43.0 - i * 0.02);
    const longitudep = Array.from({ length: cols }, (_, i) => 0.1 + i * 0.02);
    windArrowsLayer.clearLayers();

    if (combinedData.length === 0) {
        convergencesLayer.clearLayers();
        const msg = createLoadingIcon('Dades de vent no disponibles');
        L.marker(map.getCenter(), { icon: msg }).addTo(convergencesLayer);
        return;
    }

    let windgbr;
    if (combinedData === lastInterpolationRef && cachedWindGrid) {
        windgbr = cachedWindGrid;
    } else {
        // 1. Interpolació de dades a un grid regular (Micro-Resolució a 0.02º per a fidelitat total)
        // Catalunya aprox: Lat 40.5->43.0 (125 punts), Lon 0.1->3.8 (185 punts)
        function fastDistSq(lat1, lon1, lat2, lon2) {
            const dLat = lat2 - lat1;
            const dLon = lon2 - lon1;
            return dLat * dLat + dLon * dLon * 0.55;
        }

        const distLimitSq = 0.2;

        const valorx = [], valory = [];
        const valorRh = [], valorTd = [], valorMr = [];
        const valorPres = [], valorPrec = [];
        const maskValid = new Uint8Array(latitudep.length * longitudep.length);
        const stations = combinedData.map(d => ({ lat: d.lat, lon: d.lon, u: d.u, v: d.v, rh: d.rh, td: d.td, mr: d.mr, pres: d.pres, prec: d.prec }));

        let idxGrid = 0;
        for (let j = 0; j < latitudep.length; j++) {
            const gridLat = latitudep[j];
            for (let k = 0; k < longitudep.length; k++) {
                const gridLon = longitudep[k];
                let sumU = 0, sumV = 0, sumW = 0;
                let sumRh = 0, sumTd = 0, sumMr = 0, sumWThermo = 0;
                let sumPres = 0, sumWPres = 0;
                let sumPrec = 0, sumWPrec = 0;
                let minDSq = 999;

                for (let i = 0; i < stations.length; i++) {
                    const s = stations[i];
                    const dSq = fastDistSq(gridLat, gridLon, s.lat, s.lon);
                    if (dSq < minDSq) minDSq = dSq;

                    if (dSq < distLimitSq) {
                        const w = 1 / (dSq * dSq * dSq + 0.000001);
                        sumU += s.u * w; sumV += s.v * w; sumW += w;
                        if (s.rh !== undefined && s.rh !== null && s.mr !== null) {
                            sumRh += s.rh * w; sumTd += s.td * w; sumMr += s.mr * w; sumWThermo += w;
                        }
                        if (s.pres !== undefined && s.pres !== null) {
                            sumPres += s.pres * w; sumWPres += w;
                        }
                        if (s.prec !== undefined && s.prec !== null) {
                            sumPrec += s.prec * w; sumWPrec += w;
                        }
                    }
                }

                // Emmascarar zones allunyades d'estacions (aprox. més de 30-35km = dSq > 0.08)
                maskValid[idxGrid++] = minDSq < 0.08 ? 1 : 0;

                valorx.push(sumW ? sumU / sumW : 0);
                valory.push(sumW ? sumV / sumW : 0);
                valorRh.push(sumWThermo ? sumRh / sumWThermo : 0);
                valorTd.push(sumWThermo ? sumTd / sumWThermo : 0);
                valorMr.push(sumWThermo ? sumMr / sumWThermo : 0);
                valorPres.push(sumWPres ? sumPres / sumWPres : null);
                valorPrec.push(sumWPrec ? sumPrec / sumWPrec : 0);
            }
        }

        const header = { la1: latitudep[0], lo1: longitudep[0], dx: 0.02, dy: 0.02, nx: 185, ny: 125 };
        windgbr = [
            { header: { ...header, parameterCategory: 2, parameterNumber: 2 }, data: valorx },
            { header: { ...header, parameterCategory: 2, parameterNumber: 3 }, data: valory }
        ];

        cachedWindGrid = windgbr;
        lastInterpolationRef = combinedData;

        // -- CÀLCUL DE CONVERGÈNCIA FRONT-END --
        stationConvergencePolygonsLayer.clearLayers();
        if (typeof turf !== 'undefined' && turf.isobands) {
            let rawConv = new Float32Array(rows * cols);
            let rawVort = new Float32Array(rows * cols);
            let rawSpeed = new Float32Array(rows * cols);
            let rawMfc = new Float32Array(rows * cols);
            let rawDiv = new Float32Array(rows * cols);

            // 1. Càlcul de la convergència crua amb gap=2
            const gap = 2;
            const cosLat = 0.75;
            for (let j = 0; j < rows; j++) {
                for (let k = 0; k < cols; k++) {
                    const idx = j * cols + k;

                    // Velocitat mitjana
                    const u = valorx[idx];
                    const v = valory[idx];
                    rawSpeed[idx] = Math.sqrt(u * u + v * v);

                    if (maskValid[idx] === 1 && k >= gap && k < cols - gap && j >= gap && j < rows - gap) {
                        let dudx = (valorx[idx + gap] - valorx[idx - gap]) / cosLat;
                        let dvdy = valory[(j - gap) * cols + k] - valory[(j + gap) * cols + k];

                        let cvg = -(dudx + dvdy) / (2 * gap);
                        rawConv[idx] = cvg;

                        // MFC Proxy: Si l'aire està actuant convergentment, multipliquem-ho per la quantitat d'aigua arrossegada
                        // Normalitzat a /6.0 per tal que els llindars gràfics [1.5, 3.0] segueixin funcionant i el taronja aparegui correctament.
                        rawMfc[idx] = cvg > 0 ? (cvg * Math.max(0.1, valorMr[idx]) / 6.0) : 0;
                        rawDiv[idx] = cvg < 0 ? (-cvg) : 0; // Agafem la divergència (subsidència en valor absolut)

                        let dvdx = (valory[idx + gap] - valory[idx - gap]) / cosLat;
                        let dudy = valorx[(j - gap) * cols + k] - valorx[(j + gap) * cols + k];
                        rawVort[idx] = (dvdx - dudy) / (2 * gap);
                    } else {
                        rawConv[idx] = 0;
                        rawVort[idx] = 0;
                        rawMfc[idx] = 0;
                        rawDiv[idx] = 0;
                    }
                }
            }

            // 2. Filtre de Suavitzat (Box Blur) a sobre del MFC i DIV
            let smoothMfc = new Float32Array(rows * cols);
            let smoothDiv = new Float32Array(rows * cols);
            const blurRadius = 2; // Ràdio de suavitzat
            for (let pass = 0; pass < 2; pass++) { // 2 assecades de suavitzat per vora rodona
                let sourceMfc = (pass === 0) ? rawMfc : smoothMfc.slice();
                let sourceDiv = (pass === 0) ? rawDiv : smoothDiv.slice();
                for (let j = 0; j < rows; j++) {
                    for (let k = 0; k < cols; k++) {
                        let sumMfc = 0, sumDiv = 0, count = 0;
                        for (let dj = -blurRadius; dj <= blurRadius; dj++) {
                            for (let dk = -blurRadius; dk <= blurRadius; dk++) {
                                let nj = j + dj, nk = k + dk;
                                if (nj >= 0 && nj < rows && nk >= 0 && nk < cols) {
                                    sumMfc += sourceMfc[nj * cols + nk];
                                    sumDiv += sourceDiv[nj * cols + nk];
                                    count++;
                                }
                            }
                        }
                        smoothMfc[j * cols + k] = sumMfc / count;
                        smoothDiv[j * cols + k] = sumDiv / count;
                    }
                }
            }

            // 3. Generem la graella de Turf (Oest-Est, Sud-Nord)
            let points = [];
            for (let k = 0; k < cols; k++) {
                for (let j = rows - 1; j >= 0; j--) {
                    let mfcVar = smoothMfc[j * cols + k];
                    points.push(turf.point([longitudep[k], latitudep[j]], { convergence: mfcVar }));
                }
            }

            const pointGrid = turf.featureCollection(points);

            // 4. Llindars Classificadors "All-In-One" per a Tempestologia
            // Com hem suavitzat, els becs màxims han baixat d'intensitat. Abaixem els llindars.
            const breaks = [0.4, 0.8, 1.5, 3.0, 100];

            try {
                const isobands = turf.isobands(pointGrid, breaks, { zProperty: 'convergence' });
                const convStyle = function (feature) {
                    let val = parseFloat(feature.properties.convergence.split('-')[0]);
                    let color, weight, fillOpacity;

                    if (val >= 3.0) {
                        color = "#9c27b0"; weight = 3; fillOpacity = 0.55; // Severa (Morat) - Risc Imminent
                    } else if (val >= 1.5) {
                        color = "#e53935"; weight = 2; fillOpacity = 0.45; // Forta (Vermell) 
                    } else if (val >= 0.8) {
                        color = "#fb8c00"; weight = 1.5; fillOpacity = 0.35; // Moderada (Taronja)
                    } else {
                        color = "#fdd835"; weight = 1; fillOpacity = 0.25; // Feble (Groc) - Línea base
                    }

                    return {
                        color: color,
                        weight: weight,
                        dashArray: '4, 4',
                        fillColor: color,
                        fillOpacity: fillOpacity
                    };
                };

                L.geoJSON(isobands, {
                    style: convStyle,
                    onEachFeature: function (feature, layer) {
                        let valObj = feature.properties.convergence;
                        let minVal = parseFloat(valObj.split('-')[0]);

                        let nomIntensitat = "Feble";
                        let gravetatColor = "#fdd835";
                        if (minVal >= 3.0) { nomIntensitat = "SEVERA"; gravetatColor = "#9c27b0"; }
                        else if (minVal >= 1.5) { nomIntensitat = "Forta"; gravetatColor = "#e53935"; }
                        else if (minVal >= 0.8) { nomIntensitat = "Moderada"; gravetatColor = "#fb8c00"; }

                        try {
                            const centroid = turf.centroid(feature);
                            const lon = centroid.geometry.coordinates[0];
                            const lat = centroid.geometry.coordinates[1];
                            const area = (turf.area(feature) / 1000000).toFixed(1); // km2

                            // Geometria (Línia vs Nucli)
                            const bbox = turf.bbox(feature);
                            const dx = bbox[2] - bbox[0];
                            const dy = (bbox[3] - bbox[1]) / 0.75; // Lat adjust
                            const ratio = Math.max(dx, dy) / (Math.min(dx, dy) + 0.00001);

                            let strType = ratio > 2.5 ? "Línia de cisallament (Front)" : "Nucli Convergent";
                            if (area > 200) strType = "Front Regional Estès";
                            if (area < 10) strType = "Micro-convergència";

                            // Propietats O(1) del centre (Vorticitat, Vent, Thermo, P, Prec)
                            const j = Math.floor((latitudep[0] - lat) / 0.02);
                            const k = Math.floor((lon - longitudep[0]) / 0.02);
                            let vVort = 0, vSpd = 0, vRh = 0, vTd = 0, vMr = 0, vPres = null, vPrec = 0;
                            if (j >= 0 && j < rows && k >= 0 && k < cols) {
                                vVort = rawVort[j * cols + k];
                                vSpd = rawSpeed[j * cols + k];
                                vRh = valorRh[j * cols + k];
                                vTd = valorTd[j * cols + k];
                                vMr = valorMr[j * cols + k];
                                vPres = valorPres[j * cols + k];
                                vPrec = valorPrec[j * cols + k];
                            }

                            let rotacio = "Neutre (Sense rotació)";
                            let rotCat = "<span style='color:#777;'>---</span>";
                            if (vVort > 0.8) { rotacio = "Ciclònica"; rotCat = "<span style='color:red;'>⚠️ Afavoreix tempestes (Gir)</span>"; }
                            else if (vVort < -0.8) { rotacio = "Anticiclònica"; rotCat = "<span style='color:blue;'>Estable (Divergència en alçada)</span>"; }

                            // Visualització Humitat (Ara Termodinàmica de MR/Td)
                            let termodinamicText = "Sense dades";
                            let colorHum = "#777";
                            if (vMr > 0 && vTd !== null) {
                                termodinamicText = `Td: ${vTd.toFixed(1)}ºC | ${vMr.toFixed(1)} g/kg`;
                                if (vTd > 18) colorHum = "#1565c0"; // Aire tropical / Suor
                                else if (vTd > 14) colorHum = "#00bcd4"; // Humit
                                else if (vTd < 5) colorHum = "#fb8c00"; // Sec 
                            }

                            // Outflow Boundary Check
                            let lluviaText = vPrec > 0.1 ? `<b style="color:#0288d1;">${vPrec.toFixed(1)} mm</b>` : 'Sec (0 mm)';
                            let estTypeSuffix = vPrec > 0.1 ? ' <strong style="color:#0288d1; font-size: 11px;">(Outflow Boundary possible)</strong>' : '';

                            const html = `
                                <div style="min-width: 210px; font-family: 'Outfit', sans-serif;">
                                    <div style="border-bottom: 2px solid ${gravetatColor}; padding-bottom: 5px; margin-bottom: 8px;">
                                        <h4 style="margin:0; font-weight:700;">ZONA CONVERGENT</h4>
                                        <span style="font-size:0.85em; color:${gravetatColor}; font-weight:600;">Índex MFC ${nomIntensitat}</span>
                                    </div>
                                    <p style="margin:4px 0; font-size:13px;"><b>Estructura:</b> ${strType}${estTypeSuffix}</p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Àrea afectada:</b> ${area} km²</p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Pressió QNH:</b> ${vPres ? vPres.toFixed(1) + ' hPa' : 'No const.'}</p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Precipitació ass.:</b> ${lluviaText}</p>
                                    <hr style="margin:4px 0; border:0; border-top:1px solid #ddd;">
                                    <p style="margin:4px 0; font-size:13px;"><b>Vent interior (mitjana):</b> ${(vSpd * 3.6).toFixed(1)} km/h</p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Humitat Absoluta:</b> <b style="color:${colorHum}">${termodinamicText}</b></p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Cisallament (Rotació):</b> ${rotacio} <br>${rotCat}</p>
                                </div>
                            `;

                            layer.bindPopup(html);
                        } catch (e) {
                            layer.bindPopup(`<b>Convergència:</b> ${valObj} <br>Intensitat: ${nomIntensitat}`);
                        }
                    }
                }).addTo(stationConvergencePolygonsLayer);
            } catch (err) {
                console.warn("Turf isobands calculation failed", err);
            }

            // -- CÀLCUL I VISUALITZACIÓ DE DIVERGÈNCIA (SUBSIDÈNCIA) --
            stationDivergencePolygonsLayer.clearLayers();
            let pointsDiv = [];
            for (let k = 0; k < (typeof cols !== 'undefined' ? cols : 185); k++) {
                for (let j = (typeof rows !== 'undefined' ? rows : 125) - 1; j >= 0; j--) {
                    let divVar = smoothDiv[j * cols + k];
                    pointsDiv.push(turf.point([longitudep[k], latitudep[j]], { divergence: divVar }));
                }
            }

            const pointGridDiv = turf.featureCollection(pointsDiv);
            const breaksDiv = [0.4, 0.8, 1.5, 3.0, 100];

            try {
                const isobandsDiv = turf.isobands(pointGridDiv, breaksDiv, { zProperty: 'divergence' });
                const divStyle = function (feature) {
                    let val = parseFloat(feature.properties.divergence.split('-')[0]);
                    let color, weight, fillOpacity;

                    if (val >= 3.0) {
                        color = "#01579b"; weight = 2; fillOpacity = 0.55;
                    } else if (val >= 1.5) {
                        color = "#0288d1"; weight = 1.5; fillOpacity = 0.45;
                    } else if (val >= 0.8) {
                        color = "#29b6f6"; weight = 1; fillOpacity = 0.35;
                    } else {
                        color = "#81d4fa"; weight = 0.5; fillOpacity = 0.25;
                    }

                    return {
                        color: color,
                        weight: weight,
                        fillColor: color,
                        fillOpacity: fillOpacity
                    };
                };

                L.geoJSON(isobandsDiv, {
                    style: divStyle,
                    onEachFeature: function (feature, layer) {
                        layer.on('click', function (e) {
                            let val = parseFloat(feature.properties.divergence.split('-')[0]);
                            let nomIntensitat = "Feble";
                            let gravetatColor = "#81d4fa";
                            if (val >= 3.0) { nomIntensitat = "Extrema"; gravetatColor = "#01579b"; }
                            else if (val >= 1.5) { nomIntensitat = "Forta"; gravetatColor = "#0288d1"; }
                            else if (val >= 0.8) { nomIntensitat = "Moderada"; gravetatColor = "#29b6f6"; }

                            const bounds = layer.getBounds();
                            const center = bounds.getCenter();

                            let areaD = turf.area(feature) / 1000000;
                            areaD = Math.round(areaD);

                            const html = `
                                <div style="min-width: 210px; font-family: 'Outfit', sans-serif;">
                                    <div style="border-bottom: 2px solid ${gravetatColor}; padding-bottom: 5px; margin-bottom: 8px;">
                                        <h4 style="margin:0; font-weight:700;">ZONA DIVERGENT</h4>
                                        <span style="font-size:0.85em; color:${gravetatColor}; font-weight:600;">Intensitat ${nomIntensitat}</span>
                                    </div>
                                    <p style="margin:4px 0; font-size:13px;"><b>Efecte:</b> Subsidència atmosfèrica</p>
                                    <p style="margin:4px 0; font-size:13px;"><b>Àrea afectada:</b> ${areaD} km²</p>
                                    <p style="margin:4px 0; font-size:12px; color:#555;"><i>Corrents descendents. Inhibició total de núvols i tempestes. Föhn.</i></p>
                                </div>
                            `;
                            L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
                        });
                    }
                }).addTo(stationDivergencePolygonsLayer);
            } catch (err) {
                console.warn("Turf isobands DIV failed", err);
            }

            // -- MAPPING HUMITAT RELATIVA (Suport a les Convergències) --
            stationHumidityMapLayer.clearLayers();
            let pointsRh = [];
            for (let k = 0; k < cols; k++) {
                for (let j = rows - 1; j >= 0; j--) {
                    let rh = valorRh[j * cols + k];
                    pointsRh.push(turf.point([longitudep[k], latitudep[j]], { humidity: Math.max(0.1, rh) }));
                }
            }

            const pointGridRh = turf.featureCollection(pointsRh);
            const breaksRh = [0.1, 40, 60, 80, 95, 101];

            try {
                const isobandsRh = turf.isobands(pointGridRh, breaksRh, { zProperty: 'humidity' });
                const rhStyle = function (feature) {
                    let minVal = parseFloat(feature.properties.humidity.split('-')[0]);
                    let color = "transparent", fillOpacity = 0;
                    if (minVal >= 95) { color = "#0d47a1"; fillOpacity = 0.55; } // Extra-humit
                    else if (minVal >= 80) { color = "#1565c0"; fillOpacity = 0.45; } // Humit
                    else if (minVal >= 60) { color = "#00bcd4"; fillOpacity = 0.25; } // Moderat
                    else if (minVal >= 0.1) { color = "#fb8c00"; fillOpacity = 0.25; } // Sec < 40%

                    return {
                        color: color,
                        weight: 0, // Sense vores, només farciment de transició
                        fillColor: color,
                        fillOpacity: fillOpacity
                    };
                };
                L.geoJSON(isobandsRh, { style: rhStyle, interactive: false }).addTo(stationHumidityMapLayer);
            } catch (err) {
                console.warn("Turf isobands RH failed", err);
            }
        }
    }

    if (windAnimationMode === 'tv-arrows') {
        // Mode TV: Netegem velocityLayer si n'hi ha, i mantenim tvWindLayer persistent
        if (velocityLayer) {
            convergencesLayer.removeLayer(velocityLayer);
            velocityLayer = null;
        }

        if (!tvWindLayer) {
            tvWindLayer = new L.TVWindLayer(windgbr);
            convergencesLayer.addLayer(tvWindLayer);
        } else {
            tvWindLayer._grid = windgbr;
            tvWindLayer._header = windgbr[0].header;
            tvWindLayer.setParticleMultiplier(windParticleMultiplier); // Actualitza densitat dinàmicament
            if (!convergencesLayer.hasLayer(tvWindLayer)) convergencesLayer.addLayer(tvWindLayer);
        }
        hideMapLoader();
    } else {
        // Mode Partícules: Netegem tvWindLayer si n'hi ha i creem velocityLayer
        if (tvWindLayer) {
            convergencesLayer.removeLayer(tvWindLayer);
            tvWindLayer = null;
        }

        convergencesLayer.clearLayers(); // Neteja total per refrescar velocity

        let finalColorScale;
        if (colorOption === 'intensity') {
            finalColorScale = generateVelocityColorScale();
        } else if (colorOption === 'white') {
            finalColorScale = ["#FFFFFF"];
        } else {
            finalColorScale = ["#000000"];
        }

        velocityLayer = L.velocityLayer({
            displayValues: true,
            data: windgbr,
            minVelocity: 0,
            maxVelocity: 30,
            velocityScale: windVelocityScale,
            particleAge: windParticleAge,
            lineWidth: windLineWidth,
            particleMultiplier: 1 / windParticleMultiplier,
            colorScale: finalColorScale,
            pane: 'convergenciaPane'
        });
        convergencesLayer.addLayer(velocityLayer);
        hideMapLoader();
    }
}

function generateVelocityColorScale() {
    const scale = [];
    // Generem colors per a velocitats de 0 a 120 km/h (o més)
    // La llibreria interpolarà entre aquests colors
    const maxSpeed = 120;
    const steps = 20; // Quants passos de color volem

    for (let i = 0; i <= steps; i++) {
        const speed = (i / steps) * maxSpeed;
        scale.push(getWindColor(speed));
    }
    return scale;
}

// --- Funció principal i controladors d'esdeveniments de la capa de vent ---

// --- GESTIÓ DEL MODEL AROME (AQUESTA PART ÉS NOVA) ---
const aromeManager = {
    validTimes: [],
    currentIndex: 0,
    isActive: false,
    opacity: 0.8,
    panel: null,
    slider: null,
    label: null,

    async init() {
        // Inicialització tardana dels elements del DOM
        if (!this.panel) this.panel = document.getElementById('arome-controls-panel');
        if (!this.slider) this.slider = document.getElementById('arome-time-slider');
        if (!this.label) this.label = document.getElementById('arome-time-label');

        if (this.validTimes.length > 0) return; // Ja carregat

        const Lib = window.openmeteo || window.OMWeatherMapLayer;
        if (Lib) {
            if (!openMeteoLeafletAdapter) {
                openMeteoLeafletAdapter = Lib.addLeafletProtocolSupport(L);
            }
            // Generem colors un cop
            const temps = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46];
            const colors = temps.map(t => {
                const rgba = getTempRgbaColor(t);
                const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), (match[4] ? parseFloat(match[4]) : 1)];
                return [255, 255, 255, 1];
            });
            const baseSettings = Lib.defaultOmProtocolSettings || {};
            openMeteoLeafletAdapter.addProtocol('om', Lib.omProtocol, {
                ...baseSettings,
                worker: { ...(baseSettings.worker || {}), useSAB: false },
                colorScales: { temperature_2m: { type: 'breakpoint', unit: '°C', breakpoints: temps, colors: colors } }
            });
        }

        try {
            const res = await fetch("https://openmeteo.s3.amazonaws.com/data_spatial/meteofrance_arome_france_hd/latest.json");
            const data = await res.json();
            this.validTimes = data.valid_times;
            console.log("AROME validTimes carregades:", this.validTimes.length, "passos");

            if (this.slider) {
                this.slider.max = this.validTimes.length - 1;
                this.slider.value = 0;
                this.slider.oninput = () => {
                    this.currentIndex = parseInt(this.slider.value);
                    this.updateLayer();
                    this.updateLabel();
                };
            }

            // Listeners per als botons de navegació
            document.getElementById('arome-prev')?.addEventListener('click', () => {
                if (this.currentIndex > 0) {
                    this.currentIndex--;
                    this.slider.value = this.currentIndex;
                    this.updateLayer();
                    this.updateLabel();
                }
            });
            document.getElementById('arome-next')?.addEventListener('click', () => {
                if (this.currentIndex < this.validTimes.length - 1) {
                    this.currentIndex++;
                    this.slider.value = this.currentIndex;
                    this.updateLayer();
                    this.updateLabel();
                }
            });
            document.getElementById('close-arome-controls')?.addEventListener('click', () => {
                map.removeLayer(openMeteoAromeLayer);
            });

            this.updateLabel();
        } catch (e) {
            console.error("Error inicialitzant AROME metadata:", e);
        }

        // Opacity slider
        const opSlider = document.getElementById('arome-opacity-slider');
        const opValue = document.getElementById('arome-opacity-value');
        if (opSlider) {
            opSlider.value = this.opacity;
            if (opValue) opValue.textContent = Math.round(this.opacity * 100) + '%';
            opSlider.oninput = () => {
                this.opacity = parseFloat(opSlider.value);
                if (opValue) opValue.textContent = Math.round(this.opacity * 100) + '%';
                // Apliquem opacitat a totes les capes internes
                openMeteoAromeLayer.eachLayer(l => { if (l.setOpacity) l.setOpacity(this.opacity); });
            };
        }
    },

    updateLabel() {
        if (this.label && this.validTimes[this.currentIndex]) {
            const date = new Date(this.validTimes[this.currentIndex]);
            this.label.textContent = date.toLocaleString('ca-ES', {
                weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        }
    },

    async start() {
        console.log("Iniciant capa AROME...");
        this.isActive = true;
        await this.init();
        if (this.panel) this.panel.style.display = 'flex';
        this.updateLayer();
    },

    stop() {
        console.log("Aturant capa AROME...");
        this.isActive = false;
        if (this.panel) this.panel.style.display = 'none';
        openMeteoAromeLayer.clearLayers();
    },

    updateLayer() {
        if (!this.isActive || this.validTimes.length === 0) return;

        // Debouncing per no saturar la xarxa
        if (this._updateTimeout) clearTimeout(this._updateTimeout);

        this._updateTimeout = setTimeout(() => {
            const timestamp = this.validTimes[this.currentIndex];
            console.log("Forçant actualització AROME a:", timestamp, "(Índex:", this.currentIndex + ")");

            // Netegem la capa interna del grup
            openMeteoAromeLayer.clearLayers();

            const Lib = window.openmeteo || window.OMWeatherMapLayer;
            if (!Lib) return;

            // Actualitzem protocol amb la configuració de colors per si la llibreria ho necessita
            const temps = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46];
            const colors = temps.map(t => {
                const rgba = getTempRgbaColor(t);
                const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), (match[4] ? parseFloat(match[4]) : 1)];
                return [255, 255, 255, 1];
            });

            const baseSettings = Lib.defaultOmProtocolSettings || {};
            openMeteoLeafletAdapter.addProtocol('om', Lib.omProtocol, {
                ...baseSettings,
                worker: { ...(baseSettings.worker || {}), useSAB: false },
                colorScales: {
                    temperature_2m: {
                        type: 'breakpoint', unit: '°C', breakpoints: temps, colors: colors
                    }
                }
            });

            // Construïm una URL absolutament nova per cada petició
            // L'ordre dels paràmetres i el random a la base ajuden a saltar-se el caché
            const omUrl = `https://openmeteo.s3.amazonaws.com/data_spatial/meteofrance_arome_france_hd/latest.json?time_step=valid_times_${this.currentIndex}&variable=temperature_2m&time=${timestamp}&v=${Date.now()}`;

            const tileLayer = openMeteoLeafletAdapter.createTileLayer('om://' + omUrl, {
                opacity: this.opacity,
                updateWhenIdle: false,
                updateWhenZooming: true,
                maxNativeZoom: 14,
                minNativeZoom: 4
            });

            tileLayer.addTo(openMeteoAromeLayer);

            // Truc final: fem un mini-moviment de mapa i tornem per forçar el redibuix de les tiles
            map.invalidateSize({ animate: false });
            map.panBy([0, 1], { animate: false });
            setTimeout(() => {
                map.panBy([0, -1], { animate: false });
            }, 50);

        }, 180);
    }
};

// Listeners directament sobre el LayerGroup per màxima fiabilitat
openMeteoAromeLayer.on('add', () => aromeManager.start());
openMeteoAromeLayer.on('remove', () => aromeManager.stop());

// --- GESTIÓ DEL MODEL ECMWF (AQUESTA PART ÉS NOVA) ---
const ecmwfManager = {
    validTimes: [],
    currentIndex: 0,
    isActive: false,
    panel: null,
    slider: null,
    label: null,

    async init() {
        // Inicialització tardana dels elements del DOM
        if (!this.panel) this.panel = document.getElementById('ecmwf-controls-panel');
        if (!this.slider) this.slider = document.getElementById('ecmwf-time-slider');
        if (!this.label) this.label = document.getElementById('ecmwf-time-label');

        if (this.validTimes.length > 0) return; // Ja carregat

        const Lib = window.openmeteo || window.OMWeatherMapLayer;
        if (Lib) {
            if (!openMeteoLeafletAdapter) {
                openMeteoLeafletAdapter = Lib.addLeafletProtocolSupport(L);
            }
            // Generem colors un cop
            const temps = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46];
            const colors = temps.map(t => {
                const rgba = getTempRgbaColor(t);
                const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), (match[4] ? parseFloat(match[4]) : 1)];
                return [255, 255, 255, 1];
            });
            const baseSettings = Lib.defaultOmProtocolSettings || {};
            openMeteoLeafletAdapter.addProtocol('om', Lib.omProtocol, {
                ...baseSettings,
                worker: { ...(baseSettings.worker || {}), useSAB: false },
                colorScales: { temperature_850hPa: { type: 'breakpoint', unit: '°C', breakpoints: temps, colors: colors } }
            });
        }

        try {
            const res = await fetch("https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs025/latest.json");
            const data = await res.json();
            this.validTimes = data.valid_times;
            console.log("ECMWF validTimes carregades:", this.validTimes.length, "passos");

            if (this.slider) {
                this.slider.max = this.validTimes.length - 1;
                this.slider.value = 0;
                this.slider.oninput = () => {
                    this.currentIndex = parseInt(this.slider.value);
                    this.updateLayer();
                    this.updateLabel();
                };
            }

            // Listeners per als botons de navegació
            document.getElementById('ecmwf-prev')?.addEventListener('click', () => {
                if (this.currentIndex > 0) {
                    this.currentIndex--;
                    this.slider.value = this.currentIndex;
                    this.updateLayer();
                    this.updateLabel();
                }
            });
            document.getElementById('ecmwf-next')?.addEventListener('click', () => {
                if (this.currentIndex < this.validTimes.length - 1) {
                    this.currentIndex++;
                    this.slider.value = this.currentIndex;
                    this.updateLayer();
                    this.updateLabel();
                }
            });
            document.getElementById('close-ecmwf-controls')?.addEventListener('click', () => {
                map.removeLayer(openMeteoEcmwfLayer);
            });

            this.updateLabel();
        } catch (e) {
            console.error("Error inicialitzant ECMWF metadata:", e);
        }

        // Opacity slider
        const opSlider = document.getElementById('ecmwf-opacity-slider');
        const opValue = document.getElementById('ecmwf-opacity-value');
        if (opSlider) {
            opSlider.value = this.opacity;
            if (opValue) opValue.textContent = Math.round(this.opacity * 100) + '%';
            opSlider.oninput = () => {
                this.opacity = parseFloat(opSlider.value);
                if (opValue) opValue.textContent = Math.round(this.opacity * 100) + '%';
                openMeteoEcmwfLayer.eachLayer(l => { if (l.setOpacity) l.setOpacity(this.opacity); });
            };
        }
    },

    updateLabel() {
        if (this.label && this.validTimes[this.currentIndex]) {
            const date = new Date(this.validTimes[this.currentIndex]);
            this.label.textContent = date.toLocaleString('ca-ES', {
                weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        }
    },

    async start() {
        console.log("Iniciant capa ECMWF...");
        this.isActive = true;
        await this.init();
        if (this.panel) this.panel.style.display = 'flex';
        this.updateLayer();
    },

    stop() {
        console.log("Aturant capa ECMWF...");
        this.isActive = false;
        if (this.panel) this.panel.style.display = 'none';
        openMeteoEcmwfLayer.clearLayers();
    },

    updateLayer() {
        if (!this.isActive || this.validTimes.length === 0) return;

        if (this._updateTimeout) clearTimeout(this._updateTimeout);

        this._updateTimeout = setTimeout(() => {
            const timestamp = this.validTimes[this.currentIndex];
            console.log("Forçant actualització ECMWF a:", timestamp, "(Índex:", this.currentIndex + ")");

            openMeteoEcmwfLayer.clearLayers();

            const Lib = window.openmeteo || window.OMWeatherMapLayer;
            if (!Lib) return;

            const temps = [-20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46];
            const colors = temps.map(t => {
                const rgba = getTempRgbaColor(t);
                const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3]), (match[4] ? parseFloat(match[4]) : 1)];
                return [255, 255, 255, 1];
            });

            const baseSettings = Lib.defaultOmProtocolSettings || {};
            openMeteoLeafletAdapter.addProtocol('om', Lib.omProtocol, {
                ...baseSettings,
                worker: { ...(baseSettings.worker || {}), useSAB: false },
                colorScales: {
                    temperature_850hPa: {
                        type: 'breakpoint', unit: '°C', breakpoints: temps, colors: colors
                    }
                }
            });

            const omUrl = `https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs025/latest.json?time_step=valid_times_${this.currentIndex}&variable=temperature_850hPa&time=${timestamp}&v=${Date.now()}`;

            const tileLayer = openMeteoLeafletAdapter.createTileLayer('om://' + omUrl, {
                opacity: this.opacity,
                updateWhenIdle: false,
                updateWhenZooming: true,
                maxNativeZoom: 14,
                minNativeZoom: 4
            });

            tileLayer.addTo(openMeteoEcmwfLayer);

            map.invalidateSize({ animate: false });
            map.panBy([0, 1], { animate: false });
            setTimeout(() => {
                map.panBy([0, -1], { animate: false });
            }, 50);

        }, 180);
    }
};

// Listeners ECMWF
openMeteoEcmwfLayer.on('add', () => ecmwfManager.start());
openMeteoEcmwfLayer.on('remove', () => ecmwfManager.stop());

// Funció antiga startAromeMapLayer (ja no cal que s'invoqui directament des del menú de variables tipus "Ràdio")
function startAromeMapLayer() {
    // Si l'usuari la tria des del menú vell (opcional), simplement l'afegim al mapa com un overlay
    if (!map.hasLayer(openMeteoAromeLayer)) {
        openMeteoAromeLayer.addTo(map);
    }
}

function startWindLayer(targetDate = null) {
    // Evitem solapaments, però permetem recàrrega si canviem de data
    if (isLoadingWind) return;
    isLoadingWind = true;
    console.log("Iniciant càrrega de dades de vent...");

    if (!velocityLayer) {
        convergencesLayer.clearLayers();
        L.marker(map.getCenter(), { icon: createLoadingIcon('Carregant vent...') }).addTo(convergencesLayer);
    }

    // 1. Preparem les promeses de dades
    const smcPromise = loadSmcData(targetDate);

    // 2. GESTIÓ D'AEMET:
    let aemetPromise;
    if (targetDate) {
        aemetPromise = Promise.resolve({ data: [], timestamp: null });
    } else {
        aemetPromise = loadAemetData();
    }

    Promise.all([smcPromise, aemetPromise]).then(([smcResult, aemetResult]) => {
        let allData = [];
        if (smcResult.data && smcResult.data.length > 0) allData.push(...smcResult.data);
        const smcTime = smcResult.timestamp ? new Date(smcResult.timestamp + 'Z').getTime() : 0;
        const aemetTime = aemetResult.timestamp ? new Date(aemetResult.timestamp).getTime() : 0;

        if (aemetResult.data.length > 0) {
            if (smcTime > 0) {
                if (Math.abs(smcTime - aemetTime) < 30 * 60 * 1000) allData.push(...aemetResult.data);
            } else {
                allData.push(...aemetResult.data);
            }
        }

        lastWindData = allData; // Guardem a la memòria cau
        displayCombinedWindData(allData, windColorOption);
        isLoadingWind = false;
    }).catch((err) => {
        console.error("Error carregant vent:", err);
        isLoadingWind = false;
        hideMapLoader();
    });
}

// Funció lleugera per només repintar amb els paràmetres actualitzats (sense fetch)
function refreshWindLayer() {
    if (lastWindData && lastWindData.length > 0) {
        displayCombinedWindData(lastWindData, windColorOption);
    }
}

// Funció per planificar la propera actualització
function scheduleNextWindUpdate() {
    // Esborrem qualsevol temporitzador que ja existeixi
    if (windUpdateTimeout) clearTimeout(windUpdateTimeout);

    const now = new Date();
    const currentMinutes = now.getMinutes();
    let nextUpdate = new Date(now);

    if (currentMinutes < 18) {
        // La pròxima actualització és el minut 18 de l'hora actual
        nextUpdate.setMinutes(18, 0, 0);
    } else if (currentMinutes < 48) {
        // La pròxima actualització és el minut 48 de l'hora actual
        nextUpdate.setMinutes(48, 0, 0);
    } else {
        // La pròxima actualització és el minut 18 de la següent hora
        nextUpdate.setHours(now.getHours() + 1, 18, 0, 0);
    }

    const timeToWait = nextUpdate.getTime() - now.getTime();
    console.log(`Planificant la pròxima actualització de convergències en ${timeToWait / 1000} segons.`);

    windUpdateTimeout = setTimeout(() => {
        // Un cop el temps s'ha esgotat, actualitzem el vent
        startWindLayer();
        // I tornem a planificar la següent actualització
        scheduleNextWindUpdate();
    }, timeToWait);
}

// Modificació de la teva funció `on('add', ...)`
convergencesLayer.on('add', function () {
    startWindLayer();
    scheduleNextWindUpdate();
});

// Modificació de la teva funció `on('remove', ...)`
convergencesLayer.on('remove', function () {
    if (windUpdateTimeout) {
        clearTimeout(windUpdateTimeout);
        windUpdateTimeout = null;
    }
    if (velocityLayer || isLoadingWind) {
        convergencesLayer.clearLayers();
        velocityLayer = null;
        isLoadingWind = false;
    }
});


// ===============================================================

// AFEGEIX AQUESTA LÍNIA JUST A SOTA
const windBarbsLayer = L.layerGroup({ pane: 'convergenciaPane' }).addTo(map);

// ===============================================================

const styledBaseLayers = [
    {
        groupName: "Mapes Principals",
        layers: {
            "OpenStreetMap": baseLayers["OpenStreetMap"],
            "Topografia": baseLayers["Topografia"],
            "Satèl·lit": baseLayers["Satèl·lit"],
            "Meteocat": baseLayers["Meteocat"],
            "ICGC Relleu": baseLayers["ICGC Relleu"],
            "Relleu amb color": baseLayers["Base Relleu - Color"],
            "Fosc": baseLayers["Fosc"]
        }
    },
    {
        groupName: "Mapes ICGC (Topogràfics)",
        layers: {
            "Topogràfic (WMS)": baseLayers["Topografic ICGC"],
            "Estàndard General": baseLayers["ICGC (JSON) Estàndard General"],
            "Estàndard Simplificat": baseLayers["ICGC (JSON) Estàndard Simplificat"],
            "Gris": baseLayers["ICGC (JSON) Gris"],
            "Fosc": baseLayers["ICGC (JSON) Fosc"],
            "Meteocat gris": baseLayers["Base Meteocat (JSON)"],
            "Relleu Maritim": baseLayers["Relleu maritim"],
        }
    },
    {
        groupName: "Mapes ICGC (Ortofotos)",
        layers: {
            "Orto Híbrida": baseLayers["ICGC (JSON) Orto Híbrida"],
            "Orto Estàndard": baseLayers["ICGC (JSON) Orto Estàndard"],
            "Orto amb Xarxa Viària": baseLayers["ICGC (JSON) Orto amb Xarxa Viària"],
            "Orto Estàndard Gris": baseLayers["ICGC (JSON) Orto Estàndard Gris"]
        }
    },
    {
        groupName: "Mapes ICGC (Administratius)",
        layers: {
            "Límits Administratius": baseLayers["ICGC (JSON) Límits Administratius"],
            "Delimitació Estàndard": baseLayers["ICGC (JSON) Delimitació Estàndard"],
            "Delimitació Gris": baseLayers["ICGC (JSON) Delimitació Gris"]
        }
    },
    {
        groupName: "Altres Fons",
        layers: {
            "Lidar": baseLayers["Lidar"],
            "Blanc": baseLayers["Blanc"]
        }
    }
];


// Pre-declarem les capes de llamps perquè el menú les pugui trobar
const lightningLayerGroup = L.layerGroup({ pane: 'llampsPane' });
const historicLightningLayerGroup = L.layerGroup({ pane: 'llampsPane' });
const xddeLayerGroup = L.layerGroup({ pane: 'llampsPane' });
const idwTriggerLayer = setupIDWSystem();


// ===================================================================
// CAPES DE TRÀNSIT (SCT) - AFEGIDES DINÀMICAMENT
// ===================================================================

// ===================================================================
// SENYALS V16 (DGT/SCT 3.0)
// ===================================================================

// Funció per descodificar dades V16 (XOR amb clau utf-8)
function decodeV16(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    const k = new TextEncoder().encode("utf-8");

    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i) ^ k[i % k.length];
    }

    return new TextDecoder().decode(out);
}

// Funció per crear la capa de senyals V16
function createV16Layer() {
    // Create a LayerGroup to hold the markers
    const layerGroup = L.layerGroup();

    // Define icons - Adjusted height as requested (32x24)
    const iconActive = L.icon({
        iconUrl: 'v16_activa.png',
        iconSize: [32, 24],
        iconAnchor: [16, 12],
        popupAnchor: [0, -12]
    });

    const iconInactive = L.icon({
        iconUrl: 'v16_apagada.png',
        iconSize: [32, 24],
        iconAnchor: [16, 12],
        popupAnchor: [0, -12]
    });

    // Translation dictionary
    const translations = {
        "Creciente": "Creixent",
        "Decreciente": "Decreixent",
        "Norte": "Nord",
        "Sur": "Sud",
        "Este": "Est",
        "Oeste": "Oest",
        "Noreste": "Nord-est",
        "Noroeste": "Nord-oest",
        "Sureste": "Sud-est",
        "Suroeste": "Sud-oest",
        "Cataluña": "Catalunya",
        "Aragón": "Aragó",
        "Comunidad Valenciana": "València",
        "Francia": "França",
        "Desconocido": "Desconegut"
    };

    function t(text) {
        return translations[text] || text;
    }

    // Function to fetch and update data
    function fetchData() {
        // console.log("Fetching V16 data...");
        fetch('https://v16-worker.v16.workers.dev/api/v16')
            .then(response => response.text()) // Get raw text
            .then(rawText => {
                try {
                    // Decode the response
                    if (!rawText || rawText.includes('Forbidden') || rawText.includes('<html')) {
                        console.warn("V16 server returned an error or restricted content. Skipping update.");
                        return;
                    }
                    const decodedText = decodeV16(rawText);
                    const data = JSON.parse(decodedText);

                    // Clear existing markers
                    layerGroup.clearLayers();

                    if (data.balizas && Array.isArray(data.balizas)) {
                        data.balizas.forEach(signal => {
                            if (signal.lat && signal.lon) {
                                // Determine icon based on status
                                const isInactive = signal.status !== 'active';
                                const icon = isInactive ? iconInactive : iconActive;
                                const statusColor = isInactive ? '#999' : '#FFA500';

                                // Format fields
                                const sentido = t(signal.sentido) || '-';
                                const orientacion = t(signal.orientacion) || '-';
                                const comunidad = t(signal.comunidad) || '-';
                                const provincia = t(signal.provincia) || '-'; // Usually implies same name except Lérida/Lleida etc if needed

                                const marker = L.marker([signal.lat, signal.lon], { icon: icon });

                                const popupContent = `
                                    <div style="font-family: Arial, sans-serif; min-width: 250px;">
                                        <h3 style="margin: 0 0 8px 0; color: ${statusColor}; border-bottom: 2px solid ${statusColor}; padding-bottom: 4px;">
                                            ${isInactive ? 'Senyal V16 (Inactiu)' : '⚠️ Senyal V16 Actiu'}
                                        </h3>
                                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                            <tr><td style="color: #666; padding: 2px 0;">Carretera:</td><td><b>${signal.carretera || '-'}</b></td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">PK:</td><td><b>${signal.pk || '-'}</b></td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Sentit:</td><td>${sentido}</td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Orientació:</td><td>${orientacion}</td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Municipi:</td><td>${signal.municipio || '-'}</td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Província:</td><td>${provincia}</td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Comunitat:</td><td>${comunidad}</td></tr>
                                            <tr><td style="color: #666; padding: 2px 0;">Des de:</td><td>${new Date(signal.firstSeen).toLocaleString()}</td></tr>
                                        </table>
                                        <small style="color: #999; margin-top: 8px; display: block; text-align: right;">Última act.: ${new Date(signal.lastSeen).toLocaleTimeString()}</small>
                                    </div>
                                `;

                                marker.bindPopup(popupContent);
                                layerGroup.addLayer(marker);
                            }
                        });
                        console.log(`V16 Layer updated: ${data.balizas.length} signals found.`);
                    }
                } catch (e) {
                    console.error("Error decoding or parsing V16 data:", e);
                }
            })
            .catch(err => console.error("Error fetching V16 data:", err));
    }

    // Fetch immediately
    fetchData();

    // Refresh every 60 seconds
    setInterval(fetchData, 60000);

    return layerGroup;
}

// Funció per integrar avisos SMP de Meteocat (Avís de Situació Meteorològica de Perill)
// Funció per integrar avisos SMP de Meteocat (Avís de Situació Meteorològica de Perill)
function createMeteocatLayer() {
    // --- UI CONTROL & STATE MANAGEMENT ---

    // Internal State
    let smpData = null; // Full JSON response
    let selectedMeteorFilter = 'Tots'; // 'Tots' or specific meteor name

    // Dates Management
    const today = new Date();
    // Helper to format Date to YYYY-MM-DD
    const formatDateISO = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };
    // Helper to format Date to YYYYMMDD (for URL)
    const formatDateURL = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}${mm}${dd}`;
    };

    let selectedDate = new Date(today); // Default to today
    let selectedSlotIndex = 0; // 0=00-06, 1=06-12, 2=12-18, 3=18-24 (Default: current slot)

    // Summary Panel State
    let isSummaryPanelOpen = false;
    let tempCache = null;
    let tempCacheKey = null;
    let tempCacheTime = null;
    let isFetchingTemps = false;

    function toggleMeteocatSummaryPanel() {
        let summaryPanel = document.getElementById('meteo-smp-summary-panel');
        if (!summaryPanel) {
            summaryPanel = createSummaryPanelDOM();
        }
        
        if (summaryPanel.style.display === 'none') {
            summaryPanel.style.display = 'block';
            isSummaryPanelOpen = true;
            updateMeteocatSummaryPanel();
        } else {
            summaryPanel.style.display = 'none';
            isSummaryPanelOpen = false;
        }
    }

    function createSummaryPanelDOM() {
        const panel = L.DomUtil.create('div', 'leaflet-control');
        panel.id = 'meteo-smp-summary-panel';
        document.body.appendChild(panel);
        
        panel.innerHTML = `
            <div id="smp-summary-header" style="display:flex; justify-content:space-between; align-items:center; cursor:move; border-bottom:2px solid rgba(0, 0, 0, 0.1); padding-bottom:5px; margin-bottom:10px;">
                <h4 style="margin:0; font-size:14px; font-weight:600; display:flex; align-items:center; gap:5px;">📋 Resum d'Avisos i Graus</h4>
                <button id="smp-summary-close-btn" style="background:none; border:none; cursor:pointer; font-size:20px; color:#555; line-height:1;">×</button>
            </div>
            <div id="smp-summary-content">
                <div class="smp-summary-section">
                    <div class="smp-summary-title">Avisos Vigents</div>
                    <div id="smp-summary-warnings" class="smp-summary-warning-list"></div>
                </div>
                <div class="smp-summary-section">
                    <div class="smp-summary-title" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>Graus (Estacions XEMA)</span>
                        <button id="smp-summary-refresh-temps" class="smp-summary-refresh-btn" title="Actualitzar temperatures">🔄</button>
                    </div>
                    <div id="smp-summary-temperatures">
                        <div style="text-align:center; padding:10px; color:#aaa; font-size:11px;">Carregant dades de temperatura...</div>
                    </div>
                </div>
            </div>
        `;
        
        L.DomEvent.disableClickPropagation(panel);
        L.DomEvent.disableScrollPropagation(panel);
        
        panel.querySelector('#smp-summary-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
            isSummaryPanelOpen = false;
        });
        
        panel.querySelector('#smp-summary-refresh-temps').addEventListener('click', () => {
            fetchSummaryTemperatures(true);
        });
        
        makeDraggable(panel, panel.querySelector('#smp-summary-header'));
        
        return panel;
    }

    function updateMeteocatSummaryPanel() {
        const panel = document.getElementById('meteo-smp-summary-panel');
        if (!panel || panel.style.display === 'none') return;
        
        const warningsContainer = panel.querySelector('#smp-summary-warnings');
        if (!warningsContainer) return;
        
        const targetDateISO = formatDateISO(selectedDate);
        const selectedPeriod = ["00-06", "06-12", "12-18", "18-00"][selectedSlotIndex];
        
        const activeMeteorsMap = {};
        
        if (smpData && Array.isArray(smpData)) {
            smpData.forEach(episode => {
                if (episode.avisos) {
                    episode.avisos.forEach(avis => {
                        if (avis.evolucions) {
                            avis.evolucions.forEach(evolucio => {
                                const dateAvis = evolucio.dia.split('T')[0];
                                if (dateAvis === targetDateISO) {
                                    if (evolucio.periodes) {
                                        evolucio.periodes.forEach(periode => {
                                            const isMatchedPeriod = (periode.nom === selectedPeriod);
                                            const isShortTerm = (periode.nom === "Curt termini" || periode.nom.includes("h"));
                                            
                                            if (isMatchedPeriod || isShortTerm) {
                                                if (periode.afectacions) {
                                                    periode.afectacions.forEach(afectacio => {
                                                        const id = parseInt(afectacio.idComarca, 10);
                                                        const nivell = parseInt(afectacio.perill, 10);
                                                        const meteorName = episode.meteor ? episode.meteor.nom : "Avís";
                                                        
                                                        if (!activeMeteorsMap[meteorName]) {
                                                            activeMeteorsMap[meteorName] = { maxLevel: 0, comarques: new Set() };
                                                        }
                                                        
                                                        if (nivell > activeMeteorsMap[meteorName].maxLevel) {
                                                            activeMeteorsMap[meteorName].maxLevel = nivell;
                                                        }
                                                        activeMeteorsMap[meteorName].comarques.add(id);
                                                    });
                                                }
                                            }
                                        });
                                    }
                                }
                            });
                        } else if (avis.afectacions) {
                            const dateAvis = avis.dataInici ? avis.dataInici.split('T')[0] : "";
                            if (dateAvis === targetDateISO) {
                                avis.afectacions.forEach(afectacio => {
                                    const id = parseInt(afectacio.idComarca, 10);
                                    const nivell = parseInt(afectacio.perill, 10);
                                    const meteorName = episode.meteor ? episode.meteor.nom : "Temps violent";
                                    
                                    if (!activeMeteorsMap[meteorName]) {
                                        activeMeteorsMap[meteorName] = { maxLevel: 0, comarques: new Set() };
                                    }
                                    
                                    if (nivell > activeMeteorsMap[meteorName].maxLevel) {
                                        activeMeteorsMap[meteorName].maxLevel = nivell;
                                    }
                                    activeMeteorsMap[meteorName].comarques.add(id);
                                });
                            }
                        }
                    });
                }
            });
        }
        
        const activeMeteors = Object.keys(activeMeteorsMap);
        if (activeMeteors.length === 0) {
            warningsContainer.innerHTML = `<div style="text-align:center; padding:10px; color:var(--text-muted); font-style:italic;">No hi ha avisos actius en aquesta franja.</div>`;
        } else {
            let html = '';
            
            const comarcaNames = {};
            if (typeof comarquesGeojson !== 'undefined') {
                comarquesGeojson.features.forEach(f => {
                    const id = parseInt(f.properties.CODICOMAR, 10);
                    comarcaNames[id] = f.properties.NOMCOMAR;
                });
            }
            
            activeMeteors.forEach(meteorName => {
                const info = activeMeteorsMap[meteorName];
                const icon = getMeteorIcon(meteorName);
                
                let levelColor = '#FFFF00';
                if (info.maxLevel >= 5) levelColor = '#FF0000';
                else if (info.maxLevel >= 3) levelColor = '#FFA500';
                
                const badgeStyle = `background:${levelColor}; color:${info.maxLevel >= 3 ? 'white' : 'black'}; padding:1px 5px; border-radius:4px; font-weight:bold; font-size:10px;`;
                
                const namesList = Array.from(info.comarques).map(id => comarcaNames[id] || `Comarca ${id}`).sort();
                const namesTooltip = namesList.join(', ');
                const comarquesCount = namesList.length;
                
                html += `
                    <div class="smp-summary-item">
                        <div class="smp-summary-item-left">
                            <span style="font-size:14px;">${icon}</span>
                            <span>${meteorName}</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span class="smp-summary-comarques-badge" title="${namesTooltip}">${comarquesCount} com. ℹ️</span>
                            <span style="${badgeStyle}">Grau ${info.maxLevel}/6</span>
                        </div>
                    </div>
                `;
            });
            warningsContainer.innerHTML = html;
        }
        
        fetchSummaryTemperatures();
    }

    function fetchSummaryTemperatures(forceRefresh = false) {
        const panel = document.getElementById('meteo-smp-summary-panel');
        if (!panel || panel.style.display === 'none') return;
        
        const tempContainer = panel.querySelector('#smp-summary-temperatures');
        if (!tempContainer) return;
        
        const cacheKey = formatDateISO(selectedDate);
        const isToday = formatDateISO(new Date()) === cacheKey;
        const now = Date.now();
        
        if (!forceRefresh && tempCache && tempCacheKey === cacheKey && (!isToday || (now - tempCacheTime < 300000))) {
            renderTemperatures(tempCache);
            return;
        }
        
        if (isFetchingTemps) return;
        isFetchingTemps = true;
        
        tempContainer.innerHTML = `
            <div style="text-align:center; padding:15px; color:var(--text-muted); display:flex; flex-direction:column; align-items:center; gap:8px;">
                <div style="width:16px; height:16px; border:2px solid var(--accent-blue); border-top:2px solid transparent; border-radius:50%; animation:spin 1s linear infinite;"></div>
                <span>Carregant dades de la xarxa XEMA...</span>
            </div>
        `;
        
        // CSS rules inside summary panel for spinners
        if (!document.getElementById('smp-spinner-style')) {
            const style = document.createElement('style');
            style.id = 'smp-spinner-style';
            style.innerHTML = `
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `;
            document.head.appendChild(style);
        }
        
        fetchSmcData(32, selectedDate)
            .then(result => {
                isFetchingTemps = false;
                if (result && result.data && result.data.length > 0) {
                    tempCache = result.data;
                    tempCacheKey = cacheKey;
                    tempCacheTime = Date.now();
                    renderTemperatures(tempCache);
                } else {
                    tempContainer.innerHTML = `<div style="text-align:center; padding:10px; color:#ff6b6b; font-style:italic;">No s'han pogut carregar les temperatures.</div>`;
                }
            })
            .catch(err => {
                isFetchingTemps = false;
                console.error("Error fetching summary temperatures:", err);
                tempContainer.innerHTML = `<div style="text-align:center; padding:10px; color:#ff6b6b; font-style:italic;">Error carregant temperatures.</div>`;
            });
    }

    function renderTemperatures(data) {
        const panel = document.getElementById('meteo-smp-summary-panel');
        if (!panel || panel.style.display === 'none') return;
        
        const tempContainer = panel.querySelector('#smp-summary-temperatures');
        if (!tempContainer) return;
        
        const validStations = data.map(s => {
            const val = parseFloat(s.valor);
            return { ...s, tempNum: val };
        }).filter(s => !isNaN(s.tempNum));
        
        if (validStations.length === 0) {
            tempContainer.innerHTML = `<div style="text-align:center; padding:10px; color:var(--text-muted); font-style:italic;">Sense dades de temperatura per aquesta data.</div>`;
            return;
        }
        
        let maxStation = validStations[0];
        let minStation = validStations[0];
        let sum = 0;
        
        validStations.forEach(s => {
            if (s.tempNum > maxStation.tempNum) maxStation = s;
            if (s.tempNum < minStation.tempNum) minStation = s;
            sum += s.tempNum;
        });
        
        const avgTemp = (sum / validStations.length).toFixed(1);
        
        tempContainer.innerHTML = `
            <div class="smp-summary-temp-grid">
                <div class="smp-summary-temp-box">
                    <div class="smp-summary-temp-label">🔥 Temp. Màxima</div>
                    <div class="smp-summary-temp-value">\${maxStation.tempNum.toFixed(1)} °C</div>
                    <div class="smp-summary-temp-station" title="\${maxStation.nom}">\${maxStation.nom}</div>
                </div>
                <div class="smp-summary-temp-box">
                    <div class="smp-summary-temp-label">❄️ Temp. Mínima</div>
                    <div class="smp-summary-temp-value">\${minStation.tempNum.toFixed(1)} °C</div>
                    <div class="smp-summary-temp-station" title="\${minStation.nom}">\${minStation.nom}</div>
                </div>
                <div class="smp-summary-temp-box full-width">
                    <div class="smp-summary-temp-label">📊 Mitjana Catalunya</div>
                    <div class="smp-summary-temp-value" style="margin-top:0;">\${avgTemp} °C</div>
                </div>
            </div>
            <div style="text-align:right; font-size:9px; color:var(--text-muted); margin-top:6px; opacity:0.8;">
                Dades de \${validStations.length} estacions
            </div>
        `;
    }

    // Determine default slot based on current hour
    const currentHour = new Date().getHours();
    if (currentHour >= 6 && currentHour < 12) selectedSlotIndex = 1;
    else if (currentHour >= 12 && currentHour < 18) selectedSlotIndex = 2;
    // Note: API returns "18-00" for the night slot
    else if (currentHour >= 18) selectedSlotIndex = 3;

    // Dynamic Date Labels
    const dateLabels = [];
    const days = ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'];
    const targetDates = []; // Store Date objects for the 3 buttons

    for (let i = 0; i < 3; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        targetDates.push(new Date(d)); // Clone

        const dayStr = String(d.getDate()).padStart(2, '0');
        const monthStr = String(d.getMonth() + 1).padStart(2, '0');
        let label = (i === 0) ? `Avui` : (i === 1) ? `Demà` : days[d.getDay()];
        dateLabels.push(`${label} <span style="font-size:10px; opacity:0.7;">${dayStr}/${monthStr}</span>`);
    }

    // --- ICONS MAPPING ---
    const getMeteorIcon = (name) => {
        const n = name.toLowerCase();
        // Standard Emojis as requested
        if (n.includes('neu')) return '❄️';
        if (n.includes('vent')) return '💨';
        if (n.includes('pluja') || n.includes('intensitat') || n.includes('acumulació')) return '🌧️';
        if (n.includes('mar') || n.includes('costan')) return '🌊';
        if (n.includes('fred') || n.includes('baix')) return '🥶';
        if (n.includes('calor nocturna') || n.includes('nocturna')) return '🌡️🌃';
        if (n.includes('calor') || n.includes('temperatura') || n.includes('altes')) return '🌡️☀️';
        if (n.includes('violent') || n.includes('tempesta')) return '🌪️';
        return '⚠️'; // Default
    };

    // Create the Control
    const smpControl = L.control({ position: 'bottomright' });

    smpControl.onAdd = function (map) {
        const div = L.DomUtil.create('div', 'leaflet-control');
        div.id = 'meteo-smp-control';

        // --- DRAGGABLE SETUP ---
        // We use Leaflet's built-in L.Draggable
        const draggable = new L.Draggable(div);
        draggable.enable();

        // HTML Structure
        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h4 style="cursor:move;">Avisos Meteocat</h4>
                <button id="smp-close-btn" style="background:none; border:none; cursor:pointer; font-size:20px; color:#555;">×</button>
            </div>
            
            <div class="smp-group">
                <span class="smp-label">Dia</span>
                <div class="smp-buttons" id="smp-day-buttons">
                    <button class="smp-btn active" data-idx="0">${dateLabels[0]}</button>
                    <button class="smp-btn" data-idx="1">${dateLabels[1]}</button>
                    <button class="smp-btn" data-idx="2">${dateLabels[2]}</button>
                </div>
            </div>

            <div class="smp-group">
                <span class="smp-label">Franja Horària</span>
                <div class="smp-buttons" id="smp-slot-buttons">
                    <button class="smp-btn" data-slot="0">00-06</button>
                    <button class="smp-btn" data-slot="1">06-12</button>
                    <button class="smp-btn" data-slot="2">12-18</button>
                    <button class="smp-btn" data-slot="3">18-24</button>
                </div>
            </div>

            <!-- NEW: Meteor Filter -->
            <div class="smp-group" id="smp-meteors-group" style="display:none;">
                <span class="smp-label">Tipus d'Avís</span>
                <div class="smp-buttons" id="smp-meteor-buttons" style="flex-wrap: wrap;">
                    <!-- Dynamically populated -->
                </div>
            </div>

            <div class="smp-legend">
                <span><span class="smp-dot" style="background:#FFFF00;"></span>1-2</span>
                <span><span class="smp-dot" style="background:#FFA500;"></span>3-4</span>
                <span><span class="smp-dot" style="background:#FF0000;"></span>5-6</span>
            </div>
            <div id="smp-loading" style="display:none; text-align:center; margin-top:5px; font-size:10px; color:#aaa;">Carregant dades...</div>
            <div id="smp-error" style="display:none; text-align:center; margin-top:5px; font-size:10px; color:#ff6b6b;"></div>
            <button id="smp-summary-toggle-btn" class="smp-btn" style="margin-top: 10px; background: rgba(0, 122, 255, 0.1); color: #007aff; border: 1px solid rgba(0, 122, 255, 0.2); font-weight: bold; width: 100%; display: flex; align-items: center; justify-content: center; gap: 5px;">
                📋 Resum i Graus
            </button>
        `;

        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        // --- LISTENERS ---

        // Close Button
        const closeBtn = div.querySelector('#smp-close-btn');
        closeBtn.addEventListener('click', function () {
            div.style.display = 'none';
            const summaryPanel = document.getElementById('meteo-smp-summary-panel');
            if (summaryPanel) summaryPanel.style.display = 'none';
            isSummaryPanelOpen = false;
        });

        // Summary Toggle Button
        const summaryToggleBtn = div.querySelector('#smp-summary-toggle-btn');
        summaryToggleBtn.addEventListener('click', function () {
            toggleMeteocatSummaryPanel();
        });

        // Day Buttons
        const dayBtns = div.querySelectorAll('#smp-day-buttons .smp-btn');
        dayBtns.forEach(btn => {
            btn.addEventListener('click', function (e) {
                dayBtns.forEach(b => b.classList.remove('active'));
                this.classList.add('active');

                const idx = parseInt(this.dataset.idx);
                selectedDate = targetDates[idx]; // Update selected Date
                selectedMeteorFilter = 'Tots'; // Reset filter when changing date

                // TRIGGER NEW FETCH FOR THE SELECTED DATE
                fetchData(selectedDate);
            });
        });

        // Slot Buttons
        const slotBtns = div.querySelectorAll('#smp-slot-buttons .smp-btn');
        // Set initial active slot
        if (slotBtns[selectedSlotIndex]) {
            slotBtns.forEach(b => b.classList.remove('active'));
            slotBtns[selectedSlotIndex].classList.add('active');
        }

        slotBtns.forEach(btn => {
            btn.addEventListener('click', function (e) {
                slotBtns.forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                selectedSlotIndex = parseInt(this.dataset.slot);
                updateLayerStyle(); // Just re-style, logic handles filtering
            });
        });

        return div;
    };

    smpControl.addTo(map);

    // --- DATA FETCHING ---

    function fetchData(dateObj) {
        if (!dateObj) dateObj = new Date(); // Default today

        const loadingEl = document.getElementById('smp-loading');
        if (loadingEl) loadingEl.style.display = 'block';
        const errorEl = document.getElementById('smp-error');
        if (errorEl) errorEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';

        // Construct URL for the SPECIFIC DATE
        const urlDateParam = formatDateURL(dateObj);
        const url = `https://static-m.meteo.cat/ginys/pronostic/smp/episodisOberts/avisos-episodis-oberts-${urlDateParam}.json`;

        console.log("Fetching Meteocat data for:", url);

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log("Meteocat Data Loaded:", data);
                smpData = data;
                if (loadingEl) loadingEl.style.display = 'none';
                updateLayerStyle();
            })
            .catch(err => {
                console.error("Fetch Failed:", err);
                if (loadingEl) loadingEl.style.display = 'none';
                if (errorEl) {
                    errorEl.innerHTML = "No hi ha avisos per aquesta data.";
                    errorEl.style.display = 'block';
                }
                // Clear map on error
                smpData = [];
                updateLayerStyle();
            });
    }

    // --- MAPPING LOGIC ---

    function updateLayerStyle() {
        // Reset current warnings map used for processing
        // Structure: comarcaId -> [warningObject1, warningObject2, ...]
        const currentWarnings = {};
        const availableMeteors = new Set();

        // Target ISO String for matching (YYYY-MM-DD...)
        const targetDateISO = formatDateISO(selectedDate);

        if (smpData && Array.isArray(smpData)) {
            // Define the target period name based on selected slot index
            const selectedPeriod = ["00-06", "06-12", "12-18", "18-00"][selectedSlotIndex];

            smpData.forEach(episode => {
                if (episode.avisos) {
                    episode.avisos.forEach(avis => {
                        if (avis.evolucions) {
                            const dataEmisio = new Date(avis.dataEmisio).getTime();

                            avis.evolucions.forEach(evolucio => {
                                // Check Date match (ignoring time for 'dia')
                                const dateAvis = evolucio.dia.split('T')[0];
                                if (dateAvis === targetDateISO) {
                                    // Check Period match
                                    if (evolucio.periodes) {
                                        evolucio.periodes.forEach(periode => {
                                            const isMatchedPeriod = (periode.nom === selectedPeriod);
                                            const isShortTerm = (periode.nom === "Curt termini" || periode.nom.includes("h"));

                                            if (isMatchedPeriod || isShortTerm) {
                                                if (periode.afectacions) {
                                                    periode.afectacions.forEach(afectacio => {
                                                        const id = parseInt(afectacio.idComarca, 10);
                                                        const nivell = parseInt(afectacio.perill, 10);
                                                        const meteorName = episode.meteor ? episode.meteor.nom : "Avís";
                                                        const llindar = afectacio.llindar || evolucio.llindar1 || "-";

                                                        availableMeteors.add(meteorName);
                                                        if (!currentWarnings[id]) currentWarnings[id] = [];

                                                        const existingIndex = currentWarnings[id].findIndex(w => w.meteor === meteorName);
                                                        if (existingIndex !== -1) {
                                                            if (dataEmisio > currentWarnings[id][existingIndex].dataEmisio) {
                                                                currentWarnings[id][existingIndex] = { nivell, meteor: meteorName, comentari: evolucio.comentari || "Sense comentari", llindar, dia: evolucio.dia, dataEmisio };
                                                            }
                                                        } else {
                                                            currentWarnings[id].push({ nivell, meteor: meteorName, comentari: evolucio.comentari || "Sense comentari", llindar, dia: evolucio.dia, dataEmisio });
                                                        }
                                                    });
                                                }
                                            }
                                        });
                                    }
                                }
                            });
                        } else if (avis.afectacions) {
                            // CASE FOR SHORT-TERM / SEVERE WEATHER (Direct afectacions in avis object)
                            const dataEmisio = new Date(avis.dataEmisio).getTime();
                            const dateAvis = avis.dataInici ? avis.dataInici.split('T')[0] : "";

                            if (dateAvis === targetDateISO) {
                                avis.afectacions.forEach(afectacio => {
                                    const id = parseInt(afectacio.idComarca, 10);
                                    const nivell = parseInt(afectacio.perill, 10);
                                    const meteorName = episode.meteor ? episode.meteor.nom : "Temps violent";
                                    const llindar = afectacio.llindar || avis.llindar1 || "-";

                                    availableMeteors.add(meteorName);
                                    if (!currentWarnings[id]) currentWarnings[id] = [];

                                    const existingIndex = currentWarnings[id].findIndex(w => w.meteor === meteorName);
                                    if (existingIndex !== -1) {
                                        if (dataEmisio > currentWarnings[id][existingIndex].dataEmisio) {
                                            currentWarnings[id][existingIndex] = { nivell, meteor: meteorName, comentari: avis.comentari || "Avís Curt Termini", llindar, dia: avis.dataInici, dataEmisio };
                                        }
                                    } else {
                                        currentWarnings[id].push({ nivell, meteor: meteorName, comentari: avis.comentari || "Avís Curt Termini", llindar, dia: avis.dataInici, dataEmisio });
                                    }
                                });
                            }
                        }
                    });
                }
            });
        }

        // --- UPDATE METEOR FILTER UI ---
        const meteorGroup = document.getElementById('smp-meteors-group');
        const meteorButtonsContainer = document.getElementById('smp-meteor-buttons');

        if (meteorGroup && meteorButtonsContainer) {
            if (availableMeteors.size > 0) {
                meteorGroup.style.display = 'block';
                meteorButtonsContainer.innerHTML = '';

                const meteorsArray = ['Tots', ...Array.from(availableMeteors).sort()];

                meteorsArray.forEach(mName => {
                    const btn = document.createElement('button');
                    btn.className = 'smp-btn';
                    if (selectedMeteorFilter === mName) btn.classList.add('active');
                    const iconDisplay = mName === 'Tots' ? 'Tots' : `${getMeteorIcon(mName)} ${mName}`;
                    btn.innerHTML = iconDisplay;

                    btn.addEventListener('click', () => {
                        selectedMeteorFilter = mName;
                        updateLayerStyle();
                    });

                    meteorButtonsContainer.appendChild(btn);
                });
            } else {
                meteorGroup.style.display = 'none';
            }
        }


        layer.eachLayer(function (l) {
            const feature = l.feature;
            const idComarca = parseInt(feature.properties.CODICOMAR, 10);
            let warningsList = currentWarnings[idComarca] || [];

            // FILTER & SORT WARNINGS
            let finalWarning = null;
            let warningsToDisplay = [];

            if (warningsList.length > 0) {
                // Always sort by level descending (highest danger first)
                warningsList.sort((a, b) => b.nivell - a.nivell);

                if (selectedMeteorFilter === 'Tots') {
                    finalWarning = warningsList[0]; // Highest level determines color
                    warningsToDisplay = warningsList; // Show all in popup
                } else {
                    // Find specific
                    finalWarning = warningsList.find(w => w.meteor === selectedMeteorFilter);
                    if (finalWarning) {
                        warningsToDisplay = [finalWarning]; // Show only this one
                    }
                }
            }

            if (finalWarning) {
                // --- 1. STYLE: Determine Color based on Highest Level ---
                let color = '#FFFF00'; // Default Level 1-2
                if (finalWarning.nivell >= 5) color = '#FF0000'; // Red
                else if (finalWarning.nivell >= 3) color = '#FFA500'; // Orange

                // --- 2. STYLE: Continuous Black Thin Line ---
                l.setStyle({
                    fillColor: color,
                    weight: 1,           // Fina
                    opacity: 1,
                    color: '#000000',    // Negre
                    dashArray: null,     // Continua (sense guions)
                    fillOpacity: 0.6
                });

                // --- 3. POPUP CONTENT ---
                let popupHtml = `<div style="font-family: Arial, sans-serif; min-width: 250px; font-size:13px;">`;

                // Header (Comarca Name)
                popupHtml += `<h3 style="margin:0 0 10px 0; font-size:15px; border-bottom:1px solid #ddd; padding-bottom:5px;">${feature.properties.NOMCOMAR}</h3>`;

                warningsToDisplay.forEach(w => {
                    const iconSvg = getMeteorIcon(w.meteor);

                    // Determine sub-color for this item
                    let itemColor = '#FFFF00';
                    if (w.nivell >= 5) itemColor = '#FF0000';
                    else if (w.nivell >= 3) itemColor = '#FFA500';

                    // Probability Logic
                    let probText = "Desconeguda";
                    if ([1, 4].includes(w.nivell)) probText = "10% - 30% (Baixa)";
                    else if ([2, 5].includes(w.nivell)) probText = "30% - 70% (Mitjana)";
                    else if ([3, 6].includes(w.nivell)) probText = "> 70% (Alta)";

                    popupHtml += `
                    <div style="background:var(--bg-card); border-left: 4px solid ${itemColor}; padding: 8px; margin-bottom: 8px; border-radius: 0 4px 4px 0; box-shadow: 0 1px 2px var(--glass-shadow);">
                        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
                             <div style="display:flex; align-items:center; font-weight:bold; font-size:14px; color:var(--text-main);">
                                <span style="font-size:16px; margin-right:6px;">${iconSvg}</span> ${w.meteor}
                             </div>
                             <span style="background:${itemColor}; color:${w.nivell >= 3 ? 'white' : 'black'}; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:12px;">${w.nivell}/6</span>
                        </div>
                        
                        <div style="font-size:12px; color:var(--text-secondary); line-height:1.4;">
                            <div style="margin-bottom:2px;"><b>Probabilitat:</b> ${probText}</div>
                            <div style="margin-bottom:2px;"><b>Llindar:</b> ${w.llindar}</div>
                            <div style="font-style:italic; color:var(--text-muted); margin-top:4px;">"${w.comentari}"</div>
                        </div>
                    </div>`;
                });

                popupHtml += `</div>`;
                l.bindPopup(popupHtml);

            } else {
                l.setStyle({ fillColor: 'transparent', weight: 0, opacity: 0, fillOpacity: 0 });
                l.closePopup();
                l.unbindPopup();
            }
        });

        if (typeof updateMeteocatSummaryPanel === 'function') {
            updateMeteocatSummaryPanel();
        }
    }

    if (typeof comarquesGeojson === 'undefined') {
        console.error("comarquesGeojson not loaded!");
        return L.layerGroup();
    }

    const layer = L.geoJson(comarquesGeojson, {
        style: { fillColor: 'transparent', weight: 0 },
        pane: 'comarquesPane', // Ensure it stays above radar/satellite
        onEachFeature: function (feature, layer) { }
    });

    layer.on('add', function () {
        const ctrl = document.getElementById('meteo-smp-control');
        if (ctrl) ctrl.style.display = 'block';
        if (!smpData) fetchData(selectedDate); // Fetch currently selected date
    });

    layer.on('remove', function () {
        const ctrl = document.getElementById('meteo-smp-control');
        if (ctrl) ctrl.style.display = 'none';
        const summaryPanel = document.getElementById('meteo-smp-summary-panel');
        if (summaryPanel) summaryPanel.style.display = 'none';
        isSummaryPanelOpen = false;
        layer.eachLayer(l => l.closePopup());
    });

    return layer;
}

const sctWmsUrl = "https://mct.gencat.cat/sct-gis/gwc/service/wms";

// 1. Retencions (RT)
// 1. Funció Helper per crear grups de capes per zoom (Evita error 400 WMS)
// 1. Funció Helper per crear UNA sola capa WMS dinàmica (SOLUCIÓ ZOOM)
function createSctTrafficLayer(type, opacity = 0.8) {
    // Estenem la classe WMS per modificar l'URL a cada petició de tesela
    const SctWmsLayer = L.TileLayer.WMS.extend({
        getTileUrl: function (coords) {
            // Calculem el zoom de la tesela
            const zoom = coords.z;
            let layerSuffix = 'z0'; // Valor per defecte

            // Seleccionem la capa correcta segons el zoom
            if (zoom >= 0 && zoom <= 8) layerSuffix = 'z0';
            else if (zoom === 9) layerSuffix = 'z1';
            else if (zoom === 10) layerSuffix = 'z2';
            else if (zoom === 11) layerSuffix = 'z3';
            else if (zoom === 12) layerSuffix = 'z4';
            else if (zoom >= 13 && zoom <= 14) layerSuffix = 'z5';
            else if (zoom >= 15) layerSuffix = 'z6';

            // Construïm el nom de la capa WMS
            const layerName = `cite:mct2_v_${type}_${layerSuffix}`;

            // Actualitzem els paràmetres WMS de la instància abans de generar l'URL
            this.wmsParams.layers = layerName;

            // Cridem al mètode original per generar l'URL
            return L.TileLayer.WMS.prototype.getTileUrl.call(this, coords);
        }
    });

    return new SctWmsLayer(sctWmsUrl, {
        layers: `cite:mct2_v_${type}_z0`, // Capa inicial per defecte (no importa gaire, es sobreescriu)
        format: 'image/png',
        transparent: true,
        opacity: opacity,
        minZoom: 0,
        maxZoom: 20,
        attribution: '© Servei Català de Trànsit'
    });
}

// 2. Creació de les capes usant la funció helper
// 2. Creació de les capes usant la funció helper
const transitRetencionsLayer = createSctTrafficLayer('rt', 0.9);
// const transitCongestioLayer = createSctTrafficLayer('nc', 0.8); // ELIMINADA (Només eren etiquetes)
const transitObresLayer = createSctTrafficLayer('ob', 0.9);
const transitMeteoLayer = createSctTrafficLayer('mt', 0.9);
const v16Layer = createV16Layer();
const meteocatLayer = createMeteocatLayer(); // <-- NOVA CAPA SMP

// 3. Capa Google Traffic (Substitut de la capa de colors)
const googleTrafficLayer = L.tileLayer('https://mt0.google.com/vt?lyrs=h,traffic&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    minZoom: 0,
    opacity: 1,
    attribution: '© Google'
});


// 2. Organitzem les capes de superposició (overlays) en grups
const styledOverlays = [
    {
        groupName: "RADAR PRO (MTA)",
        expanded: false,
        layers: {
            "OPERA (Europa)": proRadarLayers.eurad,
            "Météo-France": proRadarLayers.frcomp
        }
    },
    {
        groupName: "Radar i convergències",
        expanded: false, // Aquest grup començarà obert
        layers: {
            "Convergències Vent": convergencesLayer,
            "Zones de Convergència": stationConvergencePolygonsLayer,
            "Zones de Divergència": stationDivergencePolygonsLayer,
            "Mapa Humitat Interpolada": stationHumidityMapLayer,
            "PoN sense corregir": plujaneu_layer,
            "CAPPI sense corregir": radar_layer,
            "Opera Radar (RainViewer)": rainviewer_layer,
            "Windy Radar": windy_radar_layer,
            "MeteoFrance (5min)": meteofrance_radar_layer,
            "CAPPI intern": cappi_intern_layer,
            "Llarg abast intern": cappi_llarg_abast_layer
        }
    },
    {
        groupName: "Llamps (Temps Real)",
        expanded: false,
        layers: {
            "Llamps (Directe, Històric i Cèl·lules)": lightningLayerGroup,
            "Meteocat XDDE (NT+NN)": xddeLayerGroup
        }
    },
    {
        groupName: "Satèl·lit MTG",
        expanded: false,
        layers: { ...satelliteMenuLayers }
    },
    {
        groupName: "🌍 Models AI (S3)",
        expanded: false,
        layers: {
            "AROME Temperatura (AI)": openMeteoAromeLayer,
            "ECMWF Temp. 850hPa (AI)": openMeteoEcmwfLayer
        }
    },
    {
        groupName: "Interpolació temperatura",
        expanded: false,
        layers: {
            "Temperatura Actual": interpolationTactualLayer,
            "Temperatura Màxima": L.layerGroup(),
            "Variació T. Màxima": interpolationTvarLayer,
            "Temperatura Mínima": interpolationTminLayer,
            "🛠️ GENERAR IDW": idwTriggerLayer
        }
    },
    {
        groupName: "Capes ACA (Acumulacions)",
        expanded: false,
        layers: aca_layers
    },
    {
        groupName: "Informació Geogràfica",
        expanded: false, // Aquest grup també començarà obert
        layers: {
            "Xarxa Hidrogràfica": xarxaHidrograficaLayer,
            "Comarques": comarquesLayer,
            "Municipis": municipisGeojsonLayer,
            "Mon": contornMonGeolayer,
            "Límits Món (Detall)": monLayer, // <-- AFEGEIX AQUESTA LÍNIA AQUÍ
            "Live Cams": advancedCamerasLayer,
            "Incendis actuals ": actuacionsUrgentsLayer,
            "Pla Alfa Municipal": plaAlfaLayer,
            "Incendis actuals ": actuacionsUrgentsLayer,
            "Pla Alfa Municipal": plaAlfaLayer,
            "Zones Perill Allaus": wmsLayer,
            "Avisos Meteocat (SMP)": meteocatLayer
        }
    },

    {
        groupName: "Estat Trànsit",
        expanded: false,
        layers: {
            "Google Traffic": googleTrafficLayer,
            "Retencions (RT)": transitRetencionsLayer,
            "Incidències Meteorològiques": transitMeteoLayer,
            "Obres (OB)": transitObresLayer,
            "Senyals V16 (Incidències)": v16Layer
        }
    }
];


// 3. Creem el control amb l'opció de començar TANCAT
const styledLayerControl = L.Control.styledLayerControl(styledBaseLayers, styledOverlays, {
    collapsed: true, // <-- CANVIAT A TRUE
    position: 'topright',
    exclusive: true // Només un grup obert alhora
});
map.addControl(styledLayerControl);



const sumatoriControls = document.getElementById('sumatori-controls');


// Aquesta és la versió corregida
document.getElementById('calculate-sum-btn').addEventListener('click', async () => {
    await displayPrecipitationSum();

    if (document.getElementById('tables-panel').style.display === 'flex') {
        generateDataTable();
    }
});

document.getElementById('close-sum-btn').addEventListener('click', () => {
    sumatoriControls.style.display = 'none';
});
document.getElementById('toggle-auto-refresh-btn').addEventListener('click', toggleAutoRefresh);

// ★ SUBSTITUEIX LA TEVA FUNCIÓ 'refreshCurrentVariableView' PER AQUESTA COMPLETA ★
function refreshCurrentVariableView() {
    const activeMenuItem = document.querySelector('#meteo-controls .submenu li.active[data-variable-key]');
    if (!activeMenuItem) { return; }

    const variableKey = activeMenuItem.dataset.variableKey;
    const config = VARIABLES_CONFIG[variableKey];
    if (!config) { return; }

    const dateToUse = historicModeTimestamp;

    // Netejar la capa de barbes de vent per evitar que es quedin posades al canviar de variable
    if (typeof windBarbsLayer !== 'undefined') windBarbsLayer.clearLayers();

    // ACTUALITZACIÓ XDDE (Llamps Meteocat)
    // Si la capa està activa, demanem refrescar la data.
    if (typeof xddeLightningManager !== 'undefined' && xddeLightningManager.isActive) {
        xddeLightningManager.fetchXDDEData();
    }

    // ★★★ BLOC NOU PER ACTUALITZAR EL VENT EN HISTÒRIC ★★★
    // Si la capa de convergències està activa (visible al mapa), l'hem de refrescar
    // independentment de quina variable d'estacions tinguis seleccionada.
    if (map.hasLayer(convergencesLayer)) {
        // Netegem la capa per indicar càrrega
        convergencesLayer.clearLayers();
        // Cridem la funció passant-li la data històrica (o null si és directe)
        startWindLayer(dateToUse);
    }

    // 1. Cas especial: Sumatori (té la seva pròpia lògica de filtre)
    if (variableKey === 'sumatori_precipitacio') {
        const allData = lastSumatoriResult;
        if (!allData || allData.length === 0) return;

        const filteredData = applyDataFilters(allData);

        dataMarkersLayer.clearLayers();
        if (filteredData.length === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades (o estan filtrades)' }) }).addTo(dataMarkersLayer);
            return;
        }

        filteredData.forEach(estacio => {
            const totalSum = estacio.valor;
            if (totalSum > 0) {
                const color = getPrecipitationSumColor(totalSum);
                const formattedValue = formatValueForLabel(totalSum, 1);
                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18], iconAnchor: [15, 9]
                });
                L.marker([estacio.lat, estacio.lon], { icon: icon })
                    .bindPopup(`<b>${estacio.nom}</b><br>Suma Precipitació: ${formattedValue} mm`)
                    .addTo(dataMarkersLayer);
            }
        });
        return;
    }

    // 2. Distribuïdor principal segons el tipus de capa
    if (config.isSpecial) {
        displayRovellonsIndex(config, dateToUse);
    }
    // --- AQUESTES SÓN LES 3 LÍNIES QUE FALTAVEN ---
    else if (config.isEcowitt) {
        displayEcowittPrecipitation();
    }
    else if (config.isWeatherComSemiHourly) {
        displayWeatherComSemiHourlyPrecipitation();
    }
    else if (config.isWeatherComTemp) {
        displayWeatherComTemperature();
    }
    else if (config.isWeatherCom) {
        displayWeatherComPrecipitation();
    }
    // -----------------------------------------------
    else if (config.isNightSummary) {
        displayNightHumidexMin(config, dateToUse);
    } else if (config.comparison) {
        displayVariation(config, dateToUse);
    } else if (config.summary) {
        displaySummaryVariable(config, dateToUse);
    } else if (config.isWindBarb) {
        displayWindBarb(config, dateToUse);
    } else if (config.isSimpleWind) {
        displaySimpleWind(config, dateToUse);
    } else if (config.isHybrid) {
        displayDewPoint(config, dateToUse);
    } else if (config.isPercentile) {
        displayPercentileVariable(config);
    } else if (config.isCalculated) {
        displayCalculatedVariable(config, dateToUse);
    } else {
        // Per defecte (Meteocat/Aemet)
        displayVariable(variableKey, dateToUse);
    }
}

/**
 * Arrodoneix un objecte Date a l'interval de 30 minuts anterior més proper (xx:00 o xx:30).
 * @param {Date} date - L'objecte Date per arrodonir.
 * @returns {Date} L'objecte Date ja arrodonit.
 */
function roundToSemiHourly(date) {
    const minutes = date.getUTCMinutes(); // Canviat a getUTCMinutes
    date.setUTCSeconds(0, 0);             // Canviat a setUTCSeconds
    if (minutes >= 30) {
        date.setUTCMinutes(30);           // Canviat a setUTCMinutes
    } else {
        date.setUTCMinutes(0);            // Canviat a setUTCMinutes
    }
    return date;
}

/**
 * Funció centralitzada per actualitzar el text d'informació de temps.
 * Aquesta versió mostra els intervals de 30 minuts tant en mode directe com en històric
 * per a les dades semihoràries, i mostra la data per als resums diaris.
 */
function updateHistoricDisplay(info) {
    const display = document.getElementById('historic-time-display');

    if (!info || !info.timestamp) {
        display.textContent = 'MODE DIRECTE';
        return;
    }

    const d = info.timestamp;
    const dateString = `${fillTo(d.getUTCDate(), 2)}/${fillTo(d.getUTCMonth() + 1, 2)}/${d.getUTCFullYear()}`;

    // La lògica principal ara es basa en el tipus de dada
    switch (info.type) {
        case 'instant':
        case 'wind_barb':
        case 'simple_wind':
        case 'hybrid':
        case 'calculated_instant':
            // Aquestes són dades d'interval (semihoràries)
            const startTime = d;
            const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // Afegeix 30 minuts
            const startTimeString = `${fillTo(startTime.getUTCHours(), 2)}:${fillTo(startTime.getUTCMinutes(), 2)}`;
            const endTimeString = `${fillTo(endTime.getUTCHours(), 2)}:${fillTo(endTime.getUTCMinutes(), 2)}`;

            if (info.mode === 'historic') {
                // En mode històric, incloem la data a la descripció de l'interval
                display.textContent = `Interval ${dateString} ${startTimeString} - ${endTimeString} UTC`;
            } else { // Mode 'live'
                display.textContent = `Dades interval ${startTimeString} - ${endTimeString} UTC`;
            }
            break;

        case 'summary':
        case 'variation':
        case 'calculated_summary':
            // Aquestes són dades de resum diari. La presentació és la mateixa en directe i en històric.
            display.textContent = `Dades del ${dateString}`;
            break;

        case 'climatologia_mensual':
        case 'anomalia_clima':
        case 'climatologia_precip_mensual':
        case 'anomalia_precip_mensual':
            display.textContent = `Mitjana de ${getNomMes(d.getMonth())} de ${d.getFullYear()}`;
            break;

        default:
            // Fallback per a qualsevol cas no contemplat
            display.textContent = 'MODE DIRECTE';
    }
}


// ======================================================
// LÒGICA FINAL PER ALS CONTROLS DE TEMPS A LA BARRA SUPERIOR
// ======================================================

const historicControls = document.getElementById('historic-controls-container');
const historicDisplay = document.getElementById('historic-time-display');
const historicPicker = document.getElementById('historic-datetime-picker');
const timeButtons = historicControls.querySelectorAll('.time-buttons button');
const returnLiveBtn = document.getElementById('time-return-live');

// Funció CLAU: Activa o desactiva els botons segons si estem en mode històric
// Funció CLAU: Activa o desactiva els botons segons si estem en mode històric
function updateControlState() {
    const isHistoric = historicModeTimestamp !== null;

    if (isHistoric) {
        returnLiveBtn.classList.add('active');
        returnLiveBtn.textContent = 'DIRECTE'; // Canviem el text per claredat
        returnLiveBtn.title = 'Tornar al Directe';
        // El text del display ara s'actualitza des de les funcions display...
    } else {
        returnLiveBtn.classList.remove('active');
        returnLiveBtn.textContent = 'DIRECTE';
        returnLiveBtn.title = 'Estàs en mode directe';
        // El text del display també s'actualitza des de les funcions display...
    }
}

// ======================================================
// SOLUCIÓ NATIVA I DEFINITIVA PER OBRIR EL CALENDARI
// ======================================================

document.getElementById('historic-calendar-btn').addEventListener('click', function () {
    const historicPicker = document.getElementById('historic-datetime-picker');

    // La funció moderna per obrir el selector de forma explícita
    if (historicPicker.showPicker) {
        try {
            console.log("Intentant obrir el calendari amb showPicker()...");
            historicPicker.showPicker();
        } catch (error) {
            // Aquesta alternativa pot funcionar si showPicker() falla per alguna raó
            console.error("showPicker() ha fallat. Provant amb focus(). Error:", error);
            historicPicker.focus();
        }
    } else {
        // Si el navegador és antic i no suporta showPicker(),
        // intentem el mètode de 'focus', que a vegades funciona.
        console.log("showPicker() no suportat. Provant amb focus()...");
        historicPicker.focus();
    }
});

/**
 * VERSIÓ FINAL CORREGIDA: Mou el temps en mode històric de manera precisa.
 */

function moveTimeAndUpdate(minutes) {
    // Si estem en mode directe, el primer clic estableix l'hora
    // de les dades actuals com a punt de partida.
    if (historicModeTimestamp === null) {
        historicModeTimestamp = findLatestSmcTimestamp(new Date());
    }

    // Ara, apliquem el canvi de temps utilitzant UTC
    historicModeTimestamp.setUTCMinutes(historicModeTimestamp.getUTCMinutes() + minutes);

    // I finalment, refresquem la vista i els controls
    refreshCurrentVariableView();
    updateControlState();
}


// --- Assignació d'esdeveniments als botons ---

document.getElementById('time-jump-back-24h').addEventListener('click', () => moveTimeAndUpdate(-24 * 60));
document.getElementById('time-step-back').addEventListener('click', () => moveTimeAndUpdate(-30));
document.getElementById('time-step-fwd').addEventListener('click', () => moveTimeAndUpdate(30));
document.getElementById('time-jump-fwd-24h').addEventListener('click', () => moveTimeAndUpdate(24 * 60));

// ===================================================================
// AFEGEIX AQUEST BLOC NOU PER ALS BOTONS DE FRAME
// ===================================================================
document.getElementById('prev-frame-btn').addEventListener('click', () => {
    const slider = document.getElementById('range-slider');
    let currentValue = parseInt(slider.value, 10);
    if (currentValue > 0) {
        slider.value = currentValue - 1;
        // Simulem un esdeveniment 'input' per refrescar el mapa
        slider.dispatchEvent(new Event('input'));
    }
});

document.getElementById('next-frame-btn').addEventListener('click', () => {
    const slider = document.getElementById('range-slider');

    // Funcions de Paginació (Play/Stop/Següent)
    let currentValue = parseInt(slider.value, 10);
    let maxValue = parseInt(slider.max, 10);
    if (currentValue < maxValue) {
        slider.value = currentValue + 1;
        // Simulem un esdeveniment 'input' per refrescar el mapa
        slider.dispatchEvent(new Event('input'));
    }
});

// === TÀCTIL MÒBIL: EVITAR QUE LEAFLET ARROSSEGI EL MAPA ALS SLIDERS ===
document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('range-slider');
    if (slider) {
        slider.addEventListener('touchstart', function (e) {
            e.stopPropagation();
        }, { passive: true });

        slider.addEventListener('touchmove', function (e) {
            e.stopPropagation();
        }, { passive: true });

        slider.addEventListener('touchend', function (e) {
            e.stopPropagation();
        }, { passive: true });
    }
});
// ===================================================================
// FI DEL BLOC NOU
// ===================================================================

// ===================================================================
// NOVA LÒGICA PER A LA PRECÀRREGA DE 'TILES'
// ===================================================================

/**
 * Funció que precàrrega tots els 'tiles' visibles per a cada pas del 'slider'.
 */
async function preloadAllFrames() {
    const preloadBtn = document.getElementById('preload-btn');
    if (preloadBtn.classList.contains('loading')) return; // Evitem execucions múltiples

    // 1. Trobem quina capa de temps està activa
    const activeLayer = timeDependentLayers.find(layer => map.hasLayer(layer));
    if (!activeLayer || !activeLayer._tiles || range_values.length === 0) {
        alert("Activa primer una capa de radar o satèl·lit per poder fer la precàrrega.");
        return;
    }

    console.log(`Iniciant precàrrega per a la capa activa...`);
    preloadBtn.classList.add('loading');
    preloadBtn.textContent = '...';

    const totalFrames = range_values.length;
    let loadedCount = 0;

    // 2. Recorrem tots els passos del 'slider'
    for (let i = 0; i < totalFrames; i++) {
        const timestampData = range_values[i];
        const tilePromises = [];

        // 3. Per a cada pas, recorrem els 'tiles' que estan visibles al mapa ARA
        for (const key in activeLayer._tiles) {
            const tile = activeLayer._tiles[key];

            // Simulem les dades de temps per a la funció getTileUrl
            range_element.value = i;
            const imageUrl = activeLayer.getTileUrl(tile.coords);

            // 4. Creem una promesa per a cada imatge
            if (imageUrl) {
                const promise = new Promise((resolve) => {
                    const img = new Image();
                    img.onload = resolve;
                    img.onerror = resolve; // Resolem igualment per no aturar el procés
                    img.src = imageUrl;
                });
                tilePromises.push(promise);
            }
        }

        // Esperem que totes les imatges d'AQUEST pas de temps es descarreguin
        await Promise.all(tilePromises);

        loadedCount++;
        const percent = Math.round((loadedCount / totalFrames) * 100);
        preloadBtn.textContent = `${percent}%`;
        console.log(`Precàrrega: ${percent}% completat.`);
    }

    // Tornem el slider a la seva posició original
    range_element.value = range_element.max;
    range_element.dispatchEvent(new Event('input'));

    preloadBtn.classList.remove('loading');
    preloadBtn.textContent = '✅'; // Èxit!
    console.log("Precàrrega finalitzada!");

    setTimeout(() => {
        preloadBtn.textContent = '📥';
    }, 2500);
}

// Assignem la funció al botó
document.getElementById('preload-btn').addEventListener('click', preloadAllFrames);

historicPicker.addEventListener('change', () => {
    if (historicPicker.value) {
        // AFEGIM 'Z' AL FINAL DEL STRING.
        // Això força al constructor de Date a interpretar el temps com a UTC,
        // ignorant la zona horària local del navegador.
        historicModeTimestamp = roundToSemiHourly(new Date(historicPicker.value + 'Z'));

        updateControlState();
        refreshCurrentVariableView();
    }
});

returnLiveBtn.addEventListener('click', () => {
    if (historicModeTimestamp !== null) {
        historicModeTimestamp = null;
        updateControlState();
        refreshCurrentVariableView(); // Això cridarà la funció display corresponent, que actualitzarà el text
    }
});


/* ======================================================
   Event Listeners i funcions addicionals
   ====================================================== */
document.getElementById('play-button').addEventListener('click', toggleAnimation);



// NOU: Funció per comprovar si hi ha dades noves disponibles
function checkForNewData() {
    // 1. No actualitzem si l'animació està en marxa per no molestar l'usuari
    if (isPlaying) {
        return;
    }

    // 2. Guardem l'últim temps que coneixem
    if (range_values.length === 0) return;
    const lastKnownTimestamp = range_values[range_values.length - 1].utctime;

    // 3. Generem la llista de temps que HI HAURIA D'HAVER ara mateix
    const new_range_values = setRangeValues();
    if (new_range_values.length === 0) return;
    const newLatestTimestamp = new_range_values[new_range_values.length - 1].utctime;

    // 4. Comprovem si ha aparegut un nou interval de temps
    if (newLatestTimestamp > lastKnownTimestamp) {
        console.log("Noves dades horàries detectades. Actualitzant línia de temps...");

        // 5. Si hi ha novetats, actualitzem tot el sistema
        range_values = new_range_values; // Actualitzem la llista de temps global
        range_element.max = range_values.length - 1; // Actualitzem el màxim del slider
        range_element.value = range_element.max;     // Movem el slider a l'última posició

        // Simulem un 'input' per refrescar les capes del mapa amb la nova hora
        const event = new Event('input');
        range_element.dispatchEvent(event);
    }
}

// REEMPLAÇA LA TEVA FUNCIÓ 'toggleAnimation' PER AQUESTA VERSIÓ MÉS ROBUSTA
function toggleAnimation() {
    const playButton = document.getElementById('play-button');
    isPlaying = !isPlaying;
    playButton.textContent = isPlaying ? '⏸️' : '▶️';

    if (isPlaying) {
        function frame() {
            if (!isPlaying) return;

            // --- LOGICA STOP & GO ---
            // Comprovem si alguna capa de satèl·lit encara té teules pendents de càrrega
            const isAnyLayerBusy = timeDependentLayers.some(layer =>
                layer instanceof L.TileLayer.WMS.NoFlicker && map.hasLayer(layer) && layer._loadingTiles > 0
            );

            if (isAnyLayerBusy) {
                // Si encara estem carregant, re-intentem en 250ms sense canviar de frame
                animationInterval = setTimeout(frame, 250);
                return;
            }

            let currentStep = parseInt(range_element.value);

            // La condició ara utilitza la longitud dinàmica de l'array, que és més correcte.
            currentStep = (currentStep >= range_values.length - 1) ? 0 : currentStep + 1;

            range_element.value = currentStep;

            // Simulem un 'input' per refrescar totes les capes necessàries.
            const event = new Event('input');
            range_element.dispatchEvent(event);

            const delay = (currentStep === range_values.length - 1) ? pauseOnLastFrame : animationSpeed;
            animationInterval = setTimeout(frame, delay);
        }
        frame(); // Iniciem l'animació
    } else {
        clearTimeout(animationInterval);
    }
}


// Funció per crear el GIF (utilitzant html2canvas)
function createGIF() {
    if (captureInProgress) return;
    captureInProgress = true;

    if (isPlaying) toggleAnimation();

    const targetWidth = document.documentElement.clientWidth;
    const targetHeight = document.documentElement.clientHeight;

    gif = new GIF({
        workers: 2,
        quality: 4,
        width: targetWidth,
        height: targetHeight,
        transparent: 0xFFFFFFFF,
        workerScript: gifWorkerUrl
    });

    let currentStep = 0;
    const originalValue = range_element.value;

    async function captureFrame() {
        if (currentStep >= totalGifFrames) {
            gif.render();
            return;
        }

        map.dragging.disable();
        map.zoomControl.disable();
        map.scrollWheelZoom.disable();

        range_element.value = currentStep;
        timeDependentLayers.forEach(layer => { if (map.hasLayer(layer) && typeof layer.refresh === 'function') layer.refresh(); });
        setDateText(range_values[currentStep]);

        await new Promise(resolve => setTimeout(resolve, 300));

        try {
            const canvas = await html2canvas(document.documentElement, {
                useCORS: true, logging: true, windowWidth: targetWidth, windowHeight: targetHeight, scale: 1
            });
            gif.addFrame(canvas, { delay: gifFrameDelay });
            updateProgress((++currentStep / totalGifFrames) * 100);
            captureFrame();
        } catch (error) {
            console.error("Error:", error);
            captureInProgress = false;
        } finally {
            map.dragging.enable();
            map.zoomControl.enable();
            map.scrollWheelZoom.enable();
        }
    }

    captureFrame();

    gif.on('finished', (blob) => {
        range_element.value = originalValue;
        timeDependentLayers.forEach(layer => { if (map.hasLayer(layer) && typeof layer.refresh === 'function') layer.refresh(); });
        setDateText(range_values[originalValue]);

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'animacio-meteo.gif';
        a.click();
        URL.revokeObjectURL(url);
        captureInProgress = false;
    });
}

// Modificar l'event de canvi de capa base per opacitat
map.on('baselayerchange', function (event) {
    const isBlanc = event.layer === baseLayers.Blanc;
    timeDependentLayers.forEach(layer => {
        if (map.hasLayer(layer)) {
            layer.setOpacity(isBlanc ? 1 : 0.85);
        }
    });
});

document.addEventListener('DOMContentLoaded', function () {

    // Conjunt per rastrejar quines llegendes l'usuari ha tancat manualment
    let manuallyClosedLegends = new Set();

    // ----- Funció "Mestra" per a la Visibilitat de Totes les Llegendes -----
    function updateAllLegendsVisibility() {
        const plujaLegend = document.getElementById('pluja-legend');
        const radarLegend = document.getElementById('radar-legend');
        const sequedatLegend = document.getElementById('sequedat-legend');
        const fireriskLegend = document.getElementById('firerisk-legend');
        const rovellonsLegend = document.getElementById('rovellons-legend');

        if (!plujaLegend || !radarLegend || !sequedatLegend || !fireriskLegend || !rovellonsLegend) return;

        // Mostrar les llegendes relacionades amb les capes ACTIVES del mapa principal,
        // però NOMÉS si l'usuari no les ha tancat manualment.
        if (map.hasLayer(plujaneu_layer) && !manuallyClosedLegends.has('pluja-legend')) {
            plujaLegend.style.display = 'block';
        } else {
            plujaLegend.style.display = 'none';
        }

        const isAnyRadarActive = map.hasLayer(radar_layer) ||
            map.hasLayer(windy_radar_layer) ||
            map.hasLayer(rainviewer_layer) ||
            map.hasLayer(cappi_intern_layer) ||
            map.hasLayer(cappi_llarg_abast_layer) ||
            map.hasLayer(proRadarLayers.eurad) ||
            map.hasLayer(proRadarLayers.frcomp);

        if (isAnyRadarActive && !manuallyClosedLegends.has('radar-legend')) {
            radarLegend.style.display = 'block';
        } else {
            radarLegend.style.display = 'none';
        }

        sequedatLegend.style.display = (currentVariableKey === 'calc_dryness_index' && !manuallyClosedLegends.has('sequedat-legend')) ? 'block' : 'none';
        fireriskLegend.style.display = (currentVariableKey === 'calc_fire_risk_semihourly' && !manuallyClosedLegends.has('firerisk-legend')) ? 'block' : 'none';
        rovellonsLegend.style.display = (currentVariableKey === 'calc_rovellons_index' && !manuallyClosedLegends.has('rovellons-legend')) ? 'block' : 'none';
    }

    // ----- Assignació d'Events a les Capes del Mapa -----
    plujaneu_layer.on('add remove', updateAllLegendsVisibility);
    radar_layer.on('add remove', updateAllLegendsVisibility);
    windy_radar_layer.on('add remove', updateAllLegendsVisibility);
    rainviewer_layer.on('add remove', updateAllLegendsVisibility);
    cappi_intern_layer.on('add remove', updateAllLegendsVisibility);
    cappi_llarg_abast_layer.on('add remove', updateAllLegendsVisibility);
    proRadarLayers.eurad.on('add remove', updateAllLegendsVisibility);
    proRadarLayers.frcomp.on('add remove', updateAllLegendsVisibility);

    // ----- Gestor de Clics del Menú Principal -----
    // ----- Gestor de Clics del Menú Principal -----
    document.getElementById('meteo-controls').addEventListener('click', function (event) {
        if (event.target.closest('#historic-controls-container')) return;

        // NO fem preventDefault si s'està clicant un input (com el calendari) o un botó intern
        const isInput = event.target.tagName.toLowerCase() === 'input';
        const isButton = event.target.tagName.toLowerCase() === 'button';

        const target = event.target.closest('[data-variable-key]');

        // Si hem clicat un input del calendari (encara que estigui dins d'un li), el deixem funcionar
        if (isInput) return;

        if (!target) return;

        if (!isButton && !isInput) {
            event.preventDefault(); // Només preveiem el default pels enllaços normals <a>
        }

        // Amaguem panells específics per defecte
        const sumatoriControls = document.getElementById('sumatori-controls');
        if (sumatoriControls) sumatoriControls.style.display = 'none';

        // ★ NOU: Amaguem el panell d'estadístiques globals per defecte
        const globalPanel = document.getElementById('global-stats-panel');
        if (globalPanel) globalPanel.style.display = 'none';

        // Gestió de la classe 'active' als botons
        document.querySelectorAll('#meteo-controls li, #meteo-controls a').forEach(el => el.classList.remove('active'));
        let activeElement = target.closest('li') || target;
        if (activeElement) {
            activeElement.classList.add('active');
            const mainMenuItem = activeElement.closest('.main-menu-item');
            if (mainMenuItem) mainMenuItem.querySelector('a').classList.add('active');
        }

        const variableKey = target.dataset.variableKey;
        console.log("Click Menu:", variableKey);
        currentVariableKey = variableKey;

        // Netejar la capa de barbes de vent per evitar que es quedin posades al canviar de variable
        if (typeof windBarbsLayer !== 'undefined') windBarbsLayer.clearLayers();

        // Netejar la capa d'Open-Meteo si existia al canviar a qualsevol altra cosa des del menú
        if (openMeteoAromeLayer) {
            map.removeLayer(openMeteoAromeLayer);
        }

        // ★ Visualització de Zones d'Allaus
        if (variableKey === 'allaus_zones') {
            displayAllausZones();
            updateAllLegendsVisibility();
            return;
        }

        updateAllLegendsVisibility();

        // Cas especial: Sumatori
        if (variableKey === 'sumatori_precipitacio') {
            if (sumatoriControls) sumatoriControls.style.display = 'flex';
            dataMarkersLayer.clearLayers();
            return;
        }

        const config = VARIABLES_CONFIG[variableKey];
        if (!config) return;

        const dateToUse = historicModeTimestamp;

        // --- ENCAMINAMENT SEGONS EL TIPUS DE VARIABLE ---

        // 1. Variables Especials (Rovellons)
        if (config.isSpecial) {
            displayRovellonsIndex(config, dateToUse);
        }
        // ★ 2. NOU: Temperatura Mitjana en Curs (Calculada)
        else if (config.isCalculatedMean) {
            displayRealtimeMean(config, dateToUse);
        }
        // ★ 3. NOU: Temperatura Mitjana Oficial (Històrica)
        else if (config.isGlobalAvg && !config.isCalculatedMean) {
            // Per ara la tractem com una variable de resum normal, 
            // però ja tenim el 'if' preparat per si volem fer càlculs globals en el futur.
            displaySummaryVariable(config, dateToUse);
        }
        else if (config.isSpecialRanking) {
            displayRankingMap(config);
        }
        // 4. Fonts Externes (Ecowitt, Weather.com)
        else if (config.isEcowitt) displayEcowittPrecipitation();
        else if (config.isWeatherComSemiHourly) displayWeatherComSemiHourlyPrecipitation();
        else if (config.isWeatherCom) displayWeatherComPrecipitation();
        else if (config.isWeatherComTemp) displayWeatherComTemperature();

        // 5. Resums i Comparacions
        else if (config.isNightSummary) displayNightHumidexMin(config, dateToUse);
        else if (config.comparison) displayVariation(config, dateToUse);
        else if (config.summary) displaySummaryVariable(config, dateToUse);

        // 6. Vents i Híbrids
        else if (config.isWindBarb) displayWindBarb(config, dateToUse);
        else if (config.isSimpleWind) displaySimpleWind(config, dateToUse);
        else if (config.isHybrid) displayDewPoint(config, dateToUse);

        // 7. Percentils i Càlculs
        else if (config.isClimatologia) displayClimatologia(config, dateToUse);
        else if (config.isAnomaliaClima) displayAnomaliaClima(config, dateToUse);
        else if (config.isClimatologiaPrecip) displayClimatologiaPrecip(config, dateToUse);
        else if (config.isAnomaliaPrecip) displayAnomaliaPrecip(config, dateToUse);
        else if (config.isPercentile) displayPercentileVariable(config);
        else if (config.isCalculated) displayCalculatedVariable(config, dateToUse);

        // 8. Per defecte (Variables estàndard SMC/Aemet)
        else displayVariable(variableKey, dateToUse);
    });

    // ----- Lògica per als Botons d'Alertes XEMA -----
    const alertBtn = document.getElementById('alert-btn');
    const alertPanel = document.getElementById('alert-panel');
    const closeAlertPanelBtn = document.getElementById('close-alert-panel');
    const alertIntensityBtn = document.getElementById('alert-intensity-btn');
    const alertAccumulationBtn = document.getElementById('alert-accumulation-btn');

    if (alertBtn && alertPanel && closeAlertPanelBtn && alertIntensityBtn && alertAccumulationBtn) {
        alertBtn.addEventListener('click', () => { alertPanel.style.display = 'block'; });
        closeAlertPanelBtn.addEventListener('click', () => { alertPanel.style.display = 'none'; });
        alertIntensityBtn.addEventListener('click', () => { displayAlerts('alert_intensity'); });
        alertAccumulationBtn.addEventListener('click', () => { displayAlerts('alert_accumulation'); });
    }

    // ----- Arrossegar Panells -----
    const drawingPanel = document.getElementById('drawing-panel');
    const avisosPanel = document.getElementById('avisos-comarques-panel');
    if (drawingPanel) makeDraggable(drawingPanel, document.getElementById('drawing-panel-header'));
    if (avisosPanel) makeDraggable(avisosPanel, document.getElementById('avisos-panel-header'));

    const llegendaPluja = document.getElementById('pluja-legend');
    const llegendaRadar = document.getElementById('radar-legend');
    const llegendaSequedat = document.getElementById('sequedat-legend');
    const llegendaIncendis = document.getElementById('firerisk-legend');
    const llegendaRovellons = document.getElementById('rovellons-legend');
    const animControls = document.getElementById('animation-controls-container');

    if (llegendaPluja) makeDraggable(llegendaPluja, llegendaPluja.querySelector('.legend-header'));
    if (llegendaRadar) makeDraggable(llegendaRadar, llegendaRadar.querySelector('.llegenda-header'));
    if (llegendaSequedat) makeDraggable(llegendaSequedat, llegendaSequedat.querySelector('.legend-header'));
    if (llegendaIncendis) makeDraggable(llegendaIncendis, llegendaIncendis.querySelector('.legend-header'));
    if (llegendaRovellons) makeDraggable(llegendaRovellons, llegendaRovellons.querySelector('.legend-header'));
    if (animControls) makeDraggable(animControls);

    document.querySelectorAll('.close-legend').forEach(button => {
        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            const legendToClose = this.closest('.legend, .llegenda');
            if (legendToClose) {
                legendToClose.style.display = 'none';

                // Guardem l'ID d'aquesta llegenda com a "tancada manualment"
                if (legendToClose.id) {
                    manuallyClosedLegends.add(legendToClose.id);
                }
            }
        });
    });

    // Quan activem una nora capa MANUALMENT, volem que LA SEVA llegenda sí que es mostri.
    // Ho podem fer "netejant" el registre de tancament d'aquella llegenda en concret:
    const varsDropdownList = document.querySelectorAll('.arxiu-dropdown-content li, .dropdown-content li, .variable-select');
    varsDropdownList.forEach(item => {
        item.addEventListener('click', () => {
            // Netejar la llista de llegendes tancades per defecte quan canviem de mode manualment
            manuallyClosedLegends.clear();
            // updateAllLegendsVisibility() ja saltarà pels events del mapa
        });
    });

    updateAllLegendsVisibility();
});

// ======================================================
// FUNCIONALITAT PER AL NOU BOTÓ DE NETEJA
// ======================================================

// Aquest és el codi corregit
document.getElementById('clear-data-btn').addEventListener('click', function () {
    dataMarkersLayer.clearLayers();
    windBarbsLayer.clearLayers();

    // ===== LÍNIA CLAU AFEGIDA =====
    currentVariableKey = null; // Resetejem la variable per "oblidar" l'última capa
    // ================================

    document.querySelectorAll('#meteo-controls li.active, #meteo-controls a.active').forEach(el => {
        el.classList.remove('active');
    });
    console.log("S'han netejat les etiquetes i la variable activa.");
});

/**
 * VERSIÓ DEFINITIVA I UNIFICADA PER MOSTRAR ALERTES (AMB MODE HISTÒRIC I DISSENY UNIFICAT)
 * Mostra alertes de precipitació (intensitat o acumulació) basant-se en una configuració.
 * @param {string} variableKey - La clau de la variable d'alerta ('alert_intensity' o 'alert_accumulation').
 */
async function displayAlerts(variableKey) {
    if (isLoadingData) return;
    isLoadingData = true;

    const config = VARIABLES_CONFIG[variableKey];
    if (!config) {
        console.error(`Configuració d'alerta no trobada per a: ${variableKey}`);
        isLoadingData = false;
        return;
    }

    dataMarkersLayer.clearLayers();
    document.getElementById('alert-panel').style.display = 'none';
    L.marker(map.getCenter(), { icon: createLoadingIcon(`Buscant ${config.name}...`) }).addTo(dataMarkersLayer);

    // <-- CANVI CLAU 1: INTEGRACIÓ AMB EL MODE HISTÒRIC -->
    // Comprovem si estem en mode històric. Si no, utilitzem la data actual.
    const dateForQuery = historicModeTimestamp || new Date();

    const startOfDay = new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForQuery.getUTCFullYear(), dateForQuery.getUTCMonth(), dateForQuery.getUTCDate(), 23, 59, 59, 999));

    try {
        const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
        const stationsInAlert = result.data.filter(station => parseFloat(station.valor) >= config.alertThreshold);

        if (stationsInAlert.length === 0) {
            dataMarkersLayer.clearLayers();
            const friendlyDate = `${dateForQuery.getDate()}/${dateForQuery.getMonth() + 1}/${dateForQuery.getFullYear()}`;
            L.marker(map.getCenter(), { icon: createLoadingIcon(`No hi ha alertes per a la data ${friendlyDate}.`) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3500);
            return;
        }

        dataMarkersLayer.clearLayers();
        stationsInAlert.forEach(estacio => {
            const estacioInfo = { lat: estacio.lat, lon: estacio.lon, nom: estacio.nom };
            const value = parseFloat(estacio.valor);

            if (estacioInfo && !isNaN(value)) {
                const color = (config.summary === 'max') ? getSemihorariaPrecipColor(value) : getDailyPrecipitationColor(value);

                // ★ NOVA LÍNIA: Color blanc si supera 100mm
                const textColor = value > 80 ? '#FFFFFF' : '#000000';

                const icon = L.divIcon({
                    className: 'temp-label',
                    // ★ AFEGEIX 'color: ${textColor}' A L'HTML
                    html: `<div style="background-color: ${color}; color: ${textColor}; width: 100%; height: 100%; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${value.toFixed(1)}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                const popupTitle = (config.summary === 'max') ? "Intensitat Màxima (30min)" : "Acumulació Diària";

                // Mantenim la paraula "ALERTA" al popup per donar context
                L.marker([estacioInfo.lat, estacioInfo.lon], { icon })
                    .bindPopup(`<b>${estacioInfo.nom}</b><br><span style="color:red; font-weight:bold;">ALERTA</span><br>${popupTitle}: <b>${value.toFixed(1)} mm</b>`)
                    .addTo(dataMarkersLayer);
            }
        });

    } catch (error) {
        console.error(`Error buscant alertes per ${config.name}:`, error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta d\'alertes' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

let analisisPolygon = null; // Variable global per guardar el polígon actiu
let lightningChart = null;  // Variable global per al gràfic

/**
 * VERSIÓ SENSE EL CRITERI DE PERSISTÈNCIA.
 * Més sensible i ràpid, però amb més risc de falses alarmes.
 */
function detectarSaltsHistòrics(recomptes, sigmaThreshold = 2.0, flashRateThreshold = 8) {
    const saltsDetectats = [];
    const periodeCalculBins = 7; // 14 minuts de referència
    const minLlampsPerBin = 10;

    // Aquesta vegada, el bucle pot anar fins al final de l'array
    for (let i = periodeCalculBins; i < recomptes.length; i++) {
        const dadesReferencia = recomptes.slice(i - periodeCalculBins, i);
        const suma = dadesReferencia.reduce((a, b) => a + b, 0);
        const mitjana = suma / dadesReferencia.length;

        if (mitjana < 1) continue;

        const diferenciaQuadrada = dadesReferencia.map(valor => Math.pow(valor - mitjana, 2));
        const variancia = diferenciaQuadrada.reduce((a, b) => a + b, 0) / dadesReferencia.length;
        const desviacioEstandard = Math.sqrt(variancia);

        if (desviacioEstandard < 1) continue;

        const llindarEstadistic = mitjana + (sigmaThreshold * desviacioEstandard);
        const valorActual = recomptes[i];
        const taxaDeLlampsActual = valorActual / 2;

        // Comprovem les condicions del salt (sense la persistència)
        if (valorActual > llindarEstadistic && valorActual >= minLlampsPerBin && taxaDeLlampsActual >= flashRateThreshold) {

            // =================================================================
            // S'HA ELIMINAT LA COMPROVACIÓ DE PERSISTÈNCIA.
            // El salt es confirma a l'instant si compleix les altres condicions.
            // =================================================================
            const sigma = (valorActual - mitjana) / desviacioEstandard;
            saltsDetectats.push({ index: i, sigma: sigma });
        }
    }
    return saltsDetectats;
}

/**
 * Fusiona les dades històriques amb les de temps real per tenir un conjunt de dades complet.
 */
function getCombinedLightningData() {
    const combinedStrikes = new Map();
    const now = Date.now();
    const timeCutoff = now - (120 * 60 * 1000); // Finestra de 120 minuts (màxim disponible al servidor)

    // Si la capa XDDE està activa, USEM NOMÉS LES DADES XDDE per a l'anàlisi de cèl·lules
    if (xddeLightningManager && xddeLightningManager.isActive) {
        xddeLightningManager.strikeMarkers.forEach((strike, id) => {
            if (strike.timestamp >= timeCutoff) {
                combinedStrikes.set(id, strike);
            }
        });
        return combinedStrikes;
    }

    // 1. Afegeix les dades històriques (filtrades a 120 minuts per seguretat)
    realtimeLightningManager.historicStrikes.forEach((strike, id) => {
        if (strike.timestamp >= timeCutoff) {
            combinedStrikes.set(id, strike);
        }
    });

    // 2. Afegeix NOMÉS les dades en temps real que siguin més recents que 120 minuts
    realtimeLightningManager.strikeMarkers.forEach((markerData, id) => {
        if (markerData.timestamp >= timeCutoff) {
            const strikeId = `rt-${id}`;
            if (!combinedStrikes.has(strikeId)) {
                combinedStrikes.set(strikeId, {
                    lat: markerData.marker.getLatLng().lat,
                    lon: markerData.marker.getLatLng().lng,
                    timestamp: markerData.timestamp
                });
            }
        }
    });

    return combinedStrikes;
}

// ===================================================================
// NOU SISTEMA AUTOMÀTIC DE DETECCIÓ DE LIGHTNING JUMP (Basat en F17)
// ===================================================================

// Capa de Leaflet per dibuixar les cèl·lules detectades
const cellulesTempestaLayer = L.layerGroup({ pane: 'poligonsPane' }).addTo(map);
const ljIconsLayer = L.layerGroup({ pane: 'iconesPane' }).addTo(map);


/**
 * 1. RASTERITZACIÓ: Converteix una llista de llamps en una graella.
 * @param {Map} historicStrikes - El mapa de llamps històrics.
 * @param {number} resolution - La mida de cada cel·la de la graella (en graus).
 * @returns {Map} - Un mapa on cada clau és "lat_lon" i el valor és un array de llamps.
 */
function rasteritzarLlamps(historicStrikes) {
    const grid = new Map();
    historicStrikes.forEach(llamp => {
        const gridX = Math.floor(llamp.lon / RASTER_RESOLUTION);
        const gridY = Math.floor(llamp.lat / RASTER_RESOLUTION);
        const key = `${gridX}_${gridY}`;

        if (!grid.has(key)) {
            grid.set(key, { strikes: [], coords: { lon: gridX * RASTER_RESOLUTION, lat: gridY * RASTER_RESOLUTION } });
        }
        grid.get(key).strikes.push(llamp);
    });
    return grid;
}

/**
 * 2. IDENTIFICACIÓ DE CÈL·LULES (VERSIÓ REFINADA)
 * Agrupa píxels actius adjacents amb un llindar de llamps més baix.
 */
function identificarCelules(grid) {
    const celules = [];
    const visited = new Set();

    grid.forEach((value, key) => {
        if (!visited.has(key) && value.strikes.length > 1) {
            const novaCelula = {
                id: `cell-${Date.now()}-${celules.length}`,
                strikes: [],
                pixels: []
            };
            const queue = [key];
            visited.add(key);

            while (queue.length > 0) {
                const currentKey = queue.shift();
                const [x, y] = currentKey.split('_').map(Number);

                novaCelula.strikes.push(...grid.get(currentKey).strikes);
                novaCelula.pixels.push(grid.get(currentKey).coords);

                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const neighborKey = `${x + dx}_${y + dy}`;
                        if (grid.has(neighborKey) && !visited.has(neighborKey) && grid.get(neighborKey).strikes.length > 1) {
                            visited.add(neighborKey);
                            queue.push(neighborKey);
                        }
                    }
                }
            }

            // CANVI CLAU: Reduïm el llindar de 20 a 10 per a més sensibilitat
            if (novaCelula.strikes.length > 10) {
                celules.push(novaCelula);
            }
        }
    });
    return celules;
}

/**
 * VERSIÓ FINAL AMB FILTRE D'ACTIVITAT MÉS ESTRICTE
 */
function analitzarCadaCelula(celules, totesLesDades) {
    const now = Date.now();
    const totalMinutes = 120;
    const bins = totalMinutes / 2;
    const tempsLimitActivitat = now - (20 * 60 * 1000);

    // Llindar mínim de llamps per considerar una cèl·lula activa
    const MINIM_LLAMPS_PER_ACTIVITAT = 3; // Més sensible (abans 5)

    celules.forEach(cell => {
        cell.pixelKeys = new Set(cell.pixels.map(p => {
            const gridX = Math.floor(p.lon / RASTER_RESOLUTION);
            const gridY = Math.floor(p.lat / RASTER_RESOLUTION);
            return `${gridX}_${gridY}`;
        }));
        cell.recomptesComplets = new Array(bins).fill(0);
        cell.recomptesNN = new Array(bins).fill(0); // Track NN strikes per bin
    });

    totesLesDades.forEach(llamp => {
        const gridX = Math.floor(llamp.lon / RASTER_RESOLUTION);
        const gridY = Math.floor(llamp.lat / RASTER_RESOLUTION);
        const key = `${gridX}_${gridY}`;
        const cellCorresponent = celules.find(c => c.pixelKeys.has(key));
        if (cellCorresponent) {
            const ageMinutes = Math.floor((now - llamp.timestamp) / 60000);
            if (ageMinutes < totalMinutes) {
                const binIndex = bins - 1 - Math.floor(ageMinutes / 2);
                if (binIndex >= 0 && binIndex < bins) {
                    cellCorresponent.recomptesComplets[binIndex]++;
                    if (llamp.tipus === 'nn') {
                        cellCorresponent.recomptesNN[binIndex]++;
                    }
                }
            }
        }
    });

    celules.forEach(cell => {
        // =================================================================
        // NOU CÀLCUL D'ACTIVITAT MÉS ESTRICTE
        // =================================================================
        const llampsRecents = cell.strikes.filter(llamp => llamp.timestamp >= tempsLimitActivitat);
        cell.esActiva = llampsRecents.length >= MINIM_LLAMPS_PER_ACTIVITAT;
        // Guardem el recompte per mostrar-lo al popup
        cell.llampsUltims20min = llampsRecents.length;
        // =================================================================

        const MINUTS_MINIMS_PER_ANALISI_LJ = 10; // Reduït de 14 a 10 per detectar-ho abans
        if (cell.trajectoria && cell.trajectoria.length >= MINUTS_MINIMS_PER_ANALISI_LJ) {
            cell.saltN1 = detectarSaltsHistòrics(cell.recomptesComplets, 1.5, 6);
            cell.saltN2 = detectarSaltsHistòrics(cell.recomptesComplets, 2.0, 10);
        } else {
            cell.saltN1 = [];
            cell.saltN2 = [];
        }

        const dadesTendencia = cell.recomptesComplets.slice(-15);
        if (dadesTendencia.length > 5) {
            const tendencia = calcularTendenciaLineal(dadesTendencia);
            const taxaMitjanaRecent = dadesTendencia.reduce((a, b) => a + b, 0) / (dadesTendencia.length * 2);
            if (tendencia > 0.15) {
                cell.faseDelCicle = 'Creixement / Intensificació';
            } else if (tendencia < -0.15) {
                cell.faseDelCicle = 'Dissipació';
            } else if (taxaMitjanaRecent > 10) {
                cell.faseDelCicle = 'Maduració';
            } else {
                cell.faseDelCicle = 'Estable / Dèbil';
            }
        } else {
            cell.faseDelCicle = 'Cicle de vida curt';
        }
    });

    return celules;
}

/**
 * VERSIÓ REFORÇADA: Manté un registre de totes les cèl·lules seguides per no perdre-les
 * quan es debiliten temporalment.
 */
function analitzarTempestesRetrospectivament(dadesCompletes) {
    console.log("Iniciant anàlisi RETROSPECTIVA (versió reforçada)...");

    const ara = Date.now();
    const intervalMinuts = 2;
    const totalPassos = 120 / intervalMinuts;

    let celulesPrevies = [];
    const registreTotalDeCelules = new Map(); // Un mapa per guardar totes les cèl·lules úniques pel seu ID

    for (let i = 0; i < totalPassos; i++) {
        const tempsFiPas = ara - ((totalPassos - 1 - i) * intervalMinuts * 60000);
        const tempsIniciPas = tempsFiPas - (10 * 60 * 1000);

        // console.log(`Pas ${i+1}/${totalPassos}: analitzant llamps entre ${new Date(tempsIniciPas).toLocaleTimeString()} i ${new Date(tempsFiPas).toLocaleTimeString()}`);

        const llampsDelPas = new Map();
        dadesCompletes.forEach((llamp, id) => {
            if (llamp.timestamp >= tempsIniciPas && llamp.timestamp < tempsFiPas) {
                llampsDelPas.set(id, llamp);
            }
        });

        const graella = rasteritzarLlamps(llampsDelPas);
        let celulesActualsPas = identificarCelules(graella);

        if (celulesActualsPas.length > 0) {
            celulesActualsPas = ferSeguimentDeCelules(celulesActualsPas, celulesPrevies);

            // Guardem o actualitzem cada cèl·lula seguida en el nostre registre total
            celulesActualsPas.forEach(cell => {
                registreTotalDeCelules.set(cell.id, cell);
            });

            celulesPrevies = celulesActualsPas;
        }
    }

    const celulesFinals = Array.from(registreTotalDeCelules.values());

    if (celulesFinals.length > 0) {
        console.log(`Anàlisi retrospectiva completada. Total de cèl·lules seguides: ${celulesFinals.length}.`);
        const celulesAnalitzades = analitzarCadaCelula(celulesFinals, dadesCompletes);
        visualitzarCelules(celulesAnalitzades);
        celulesAnteriors = celulesAnalitzades; // <-- CRUCIAL: Guardem l'estat per al seguiment SMC futur
        updateLightningStats();
    } else {
        console.log("Anàlisi retrospectiva: No s'han trobat cèl·lules significatives.");
        celulesAnteriors = [];
        cellulesTempestaLayer.clearLayers();
        ljIconsLayer.clearLayers();
        updateLightningStats();
    }
}


/**
 * VERSIÓ FINAL AVANÇADA: Retorna la desviació de la direcció per a un factor d'eixamplament dinàmic.
 */
function calcularTrajectoriaFutura(celula, minutsAnalisi = 15, minutsProjeccio = 60) {
    // La funció es manté igual fins al càlcul de moviments
    const trajectoria = celula.trajectoria;
    if (!trajectoria || trajectoria.length < 2) return null;
    const puntsRecents = trajectoria.slice(-minutsAnalisi);
    if (puntsRecents.length < 2) return null;
    let totalDistanciaKm = 0, totalTempsMinuts = 0, moviments = [];
    for (let i = 0; i < puntsRecents.length - 1; i++) {
        const puntA = turf.point(puntsRecents[i]);
        const puntB = turf.point(puntsRecents[i + 1]);
        const distanciaSegment = turf.distance(puntA, puntB, { units: 'kilometers' });
        if (distanciaSegment > 0.01) {
            const direccioSegment = turf.bearing(puntA, puntB);
            totalDistanciaKm += distanciaSegment;
            totalTempsMinuts += 1;
            moviments.push({ distancia: distanciaSegment, direccio: direccioSegment });
        }
    }
    if (totalTempsMinuts === 0) return null;

    const velocitatKmPerMinut = totalDistanciaKm / totalTempsMinuts;
    const velocitatKmh = velocitatKmPerMinut * 60;
    const VELOCITAT_MAXIMA_REALISTA_KMH = 150;
    if (velocitatKmh > VELOCITAT_MAXIMA_REALISTA_KMH) {
        console.warn(`Velocitat irreal detectada (${velocitatKmh.toFixed(0)} km/h). Descartant projecció.`);
        return null;
    }

    let sumaX = 0, sumaY = 0;
    moviments.forEach(mov => {
        sumaX += Math.cos(mov.direccio * Math.PI / 180);
        sumaY += Math.sin(mov.direccio * Math.PI / 180);
    });
    const direccioMitjana = (Math.atan2(sumaY, sumaX) * 180 / Math.PI + 360) % 360;

    // NOU: Càlcul de la desviació estàndard de la direcció
    const direccions = moviments.map(m => m.direccio);
    const n = direccions.length;
    const mitjanaDir = direccioMitjana; // Usem la mitjana vectorial ja calculada
    // Calculem la desviació tenint en compte la naturalesa circular dels angles
    const variancia = direccions.reduce((acc, dir) => {
        let diff = Math.abs(dir - mitjanaDir);
        if (diff > 180) diff = 360 - diff; // Corregim per la distància més curta en un cercle
        return acc + diff * diff;
    }, 0) / n;
    const desviacioDireccio = Math.sqrt(variancia);

    if (velocitatKmh < 1) return null;

    const puntFinal = turf.point(puntsRecents[puntsRecents.length - 1]);
    return {
        puntInicial: puntFinal,
        velocitatKmh: velocitatKmh.toFixed(0),
        direccio: direccioMitjana.toFixed(0),
        desviacioDireccio: desviacioDireccio, // <-- NOU VALOR RETORNAT
        velocitatKmPerMinut: velocitatKmPerMinut
    };
}

/**
 * NOVA FUNCIÓ AUXILIAR: Calcula el pendent d'una tendència lineal (regressió lineal).
 * @param {number[]} dades - Un array de valors numèrics.
 * @returns {number} El pendent de la línia de tendència.
 */
function calcularTendenciaLineal(dades) {
    const n = dades.length;
    if (n < 2) return 0; // No es pot calcular la tendència amb menys de 2 punts

    let sumaX = 0, sumaY = 0, sumaXY = 0, sumaXX = 0;
    for (let i = 0; i < n; i++) {
        sumaX += i;
        sumaY += dades[i];
        sumaXY += i * dades[i];
        sumaXX += i * i;
    }

    const pendent = (n * sumaXY - sumaX * sumaY) / (n * sumaXX - sumaX * sumaX);
    return isNaN(pendent) ? 0 : pendent;
}

/**
 * NOVA FUNCIÓ: Busca la comarca on es troba un punt geogràfic.
 * @param {object} point - Un punt de Turf.js.
 * @returns {string} El nom de la comarca o 'Desconeguda'.
 */
function findComarca(point) {
    if (typeof comarquesGeojson !== 'undefined') {
        for (const comarca of comarquesGeojson.features) {
            if (turf.booleanPointInPolygon(point, comarca.geometry)) {
                return comarca.properties.NOMCOMAR;
            }
        }
    }
    return 'Desconeguda';
}

/**
 * NOVA FUNCIÓ: Processa la cua d'alertes per mostrar-les una darrere l'altra.
 */
function processAlertQueue() {
    // Si la cua no està buida I no s'està mostrant ja una alerta...
    if (alertQueue.length > 0 && !isAlertAnimating) {
        isAlertAnimating = true; // Bloquegem per evitar superposicions
        const cellToAlert = alertQueue.shift(); // Traiem la primera alerta de la cua

        // Cridem a la funció de l'animació i li passem una funció 'callback'
        // que s'executarà quan l'animació acabi.
        triggerStormAlert(cellToAlert, () => {
            isAlertAnimating = false; // Desbloquegem
            processAlertQueue();      // Intentem processar la següent alerta de la cua
        });
    }
}

/**
 * VERSIÓ ACTUALITZADA: L'alerta ara dura 5 segons.
 */
function triggerStormAlert(cell, onCompleteCallback) {
    const overlay = document.getElementById('storm-alert-overlay');
    if (!overlay) {
        if (onCompleteCallback) onCompleteCallback();
        return;
    }

    const alertTitle = document.getElementById('alert-title');
    const alertLocation = document.getElementById('alert-location');
    const alertStrikes = document.getElementById('alert-strikes');

    const isSevere = cell.saltN2.some(s => s.index >= 50);
    const levelText = isSevere ? "Sever (N2)" : "Moderat (N1)";
    const locationName = findComarca(cell.centroide);
    const strikesCount = cell.recomptesComplets.slice(-5).reduce((a, b) => a + b, 0);

    alertTitle.textContent = `Nova Alerta: Temps Violent ${levelText}`;
    alertLocation.textContent = locationName;
    alertStrikes.textContent = strikesCount;

    overlay.classList.add('visible');

    // CANVI: L'alerta s'amaga automàticament després de 5 segons
    setTimeout(() => {
        overlay.classList.remove('visible');
        setTimeout(() => {
            if (onCompleteCallback) onCompleteCallback();
        }, 500);
    }, 5000); // <-- Canviat a 5000

    overlay.onclick = () => {
        overlay.classList.remove('visible');
        if (onCompleteCallback) {
            const tempCallback = onCompleteCallback;
            onCompleteCallback = null;
            setTimeout(() => tempCallback(), 500);
        }
    };
}


/**
 * VERSIÓ FINAL AMB FILTRE GEOGRÀFIC PER A LES ALERTES
 */
function visualitzarCelules(celulesAnalitzades) {
    cellulesTempestaLayer.clearLayers();
    ljIconsLayer.clearLayers();
    const ljIcon = L.icon({ iconUrl: 'imatges/LJ.png', iconSize: [35, 35], iconAnchor: [17, 17], popupAnchor: [0, -17] });

    let newAlertsFound = false;

    celulesAnalitzades.forEach(cell => {
        if (!cell.esActiva) return;

        const teSaltN2Històric = cell.saltN2.length > 0;
        const teSaltN1Històric = cell.saltN1.length > 0;
        const points = cell.pixels.map(p => [p.lon, p.lat]);
        if (points.length < 3) return;
        const featureCollection = turf.featureCollection(points.map(p => turf.point(p)));
        const hull = turf.convex(featureCollection);
        if (!hull) return;

        const llindarIndexRecent = 50;
        const saltN2Actiu = cell.saltN2.some(s => s.index >= llindarIndexRecent);
        const saltN1Actiu = cell.saltN1.some(s => s.index >= llindarIndexRecent);

        const isNowInAlert = saltN2Actiu || saltN1Actiu;
        const wasAlreadyAlerted = alertedStormIds.has(cell.id);

        // ==================================================================================
        // NOU FILTRE GEOGRÀFIC PER A LES ALERTES
        // ==================================================================================
        if (isNowInAlert && !wasAlreadyAlerted) {
            if (!cell.centroide) cell.centroide = turf.centroid(hull);
            const lon = cell.centroide.geometry.coordinates[0];
            const lat = cell.centroide.geometry.coordinates[1];

            // Comprovem si la cèl·lula està dins del requadre definit
            const isInBounds = lat <= 43.4 && lat >= 39.6 && lon <= 5.0 && lon >= -1.2;

            if (isInBounds) {
                alertQueue.push(cell);
                alertedStormIds.add(cell.id);
                newAlertsFound = true;

                setTimeout(() => {
                    alertedStormIds.delete(cell.id);
                }, 30 * 60 * 1000);
            }
        }
        // ==================================================================================

        let estilPoligon, popupText, mostraIcona = false;
        if (saltN2Actiu) {
            estilPoligon = { color: '#ff0000', weight: 3, fillOpacity: 0.4, lj: 'Sever (N2)' };
            popupText = `<b><span style="color:red;">LJ Sever (N2) ACTIU</span></b>`;
            mostraIcona = true;
        } else if (saltN1Actiu) {
            estilPoligon = { color: '#ff8c00', weight: 2, fillOpacity: 0.35, lj: 'Moderat (N1)' };
            popupText = `<b><span style="color:darkorange;">LJ Sensible (N1) ACTIU</span></b>`;
            mostraIcona = true;
        } else if (teSaltN2Històric) {
            estilPoligon = { color: '#9400D3', weight: 2, fillOpacity: 0.25, lj: 'Post-Salt Sever' };
            popupText = `<b>Estat: Post-Salt Sever (N2)</b>`;
        } else if (teSaltN1Històric) {
            estilPoligon = { color: '#D2691E', weight: 2, fillOpacity: 0.25, lj: 'Post-Salt Moderat' };
            popupText = `<b>Estat: Post-Salt Sensible (N1)</b>`;
        } else {
            estilPoligon = { color: '#0095f9', weight: 2, fillOpacity: 0.2, lj: 'Activa' };
            popupText = `<b>Estat: Activa</b>`;
        }

        const poligonLayer = L.geoJSON(hull, { style: estilPoligon });
        const recompteUltims10min = cell.recomptesComplets.slice(-5).reduce((a, b) => a + b, 0);
        const popupContent = `<b>Cèl·lula de Tempesta</b><br>${popupText}<br><hr style="margin: 4px 0;"><b>Fase del cicle:</b> ${cell.faseDelCicle || 'Indeterminada'}<br><b>Llamps (últims 20 min):</b> ${cell.llampsUltims20min}<br><b>Llamps (últims 10 min):</b> ${recompteUltims10min}<br><em>(Fes clic per veure l'historial)</em>`;
        poligonLayer.bindPopup(popupContent).on('click', () => {
            const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i * 2}m`);
            const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
            mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats, cell.recomptesNN);
        });
        cellulesTempestaLayer.addLayer(poligonLayer);

        if (cell.trajectoria && cell.trajectoria.length > 1) {
            const trajectoriaLatLng = cell.trajectoria.map(coords => [coords[1], coords[0]]);
            L.polyline(trajectoriaLatLng, { color: 'white', weight: 2, opacity: 0.7, dashArray: '5, 5' }).addTo(cellulesTempestaLayer);
        }

        if (mostraIcona) {
            if (!cell.centroide) cell.centroide = turf.centroid(hull);
            const centroidCoords = [cell.centroide.geometry.coordinates[1], cell.centroide.geometry.coordinates[0]];
            L.marker(centroidCoords, { icon: ljIcon }).addTo(ljIconsLayer).bindPopup(popupContent).on('click', () => {
                const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i * 2}m`);
                const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
                mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats, cell.recomptesNN);
            });
        }

        const MINUTS_MINIMS_DE_TRAJECTORIA = 14;
        if (!cell.trajectoria || cell.trajectoria.length < MINUTS_MINIMS_DE_TRAJECTORIA) return;

        const projeccio = calcularTrajectoriaFutura(cell);
        if (projeccio) {
            const { puntInicial, velocitatKmh, direccio, desviacioDireccio, velocitatKmPerMinut } = projeccio;
            let factorEixamplament = 1.5 + (desviacioDireccio / 15);
            factorEixamplament = Math.min(factorEixamplament, 3);
            const bbox = turf.bbox(featureCollection);
            const ampleEstimat = turf.distance(turf.point([bbox[0], bbox[1]]), turf.point([bbox[2], bbox[1]]), { units: 'kilometers' });
            const radiInicial = Math.max(ampleEstimat / 2, 4);
            const puntFinal60min = turf.destination(puntInicial, velocitatKmPerMinut * 60, parseFloat(direccio));
            const radiFinal60min = radiInicial * factorEixamplament;
            const v1 = turf.destination(puntInicial, radiInicial, parseFloat(direccio) - 90).geometry.coordinates;
            const v2 = turf.destination(puntInicial, radiInicial, parseFloat(direccio) + 90).geometry.coordinates;
            const v3 = turf.destination(puntFinal60min, radiFinal60min, parseFloat(direccio) + 90).geometry.coordinates;
            const v4 = turf.destination(puntFinal60min, radiFinal60min, parseFloat(direccio) - 90).geometry.coordinates;
            const poligonCon = turf.polygon([[v1, v2, v3, v4, v1]]);
            const conLayer = L.geoJSON(poligonCon, { style: { color: estilPoligon.color, weight: 1.5, opacity: 0.8, fillColor: estilPoligon.color, fillOpacity: 0.1, } });
            const popupConeContent = `<b>Projecció a 1 Hora</b><hr><b>Estat tempesta:</b> ${estilPoligon.lj}<br><b>Velocitat estimada:</b> ${velocitatKmh} km/h<br><b>Direcció:</b> ${direccio}°<br><b>Incertesa (desv. dir.):</b> ${desviacioDireccio.toFixed(1)}°<br><b>Factor eixamplament:</b> ${factorEixamplament.toFixed(1)}x`;
            conLayer.bindPopup(popupConeContent);
            conLayer.addTo(cellulesTempestaLayer);
            [15, 30, 45, 60].forEach(minuts => {
                const puntCentral = turf.destination(puntInicial, velocitatKmPerMinut * minuts, parseFloat(direccio));
                const radiActual = radiInicial * (1 + (factorEixamplament - 1) * (minuts / 60));
                const pEsquerra = turf.destination(puntCentral, radiActual, parseFloat(direccio) - 90);
                const pDreta = turf.destination(puntCentral, radiActual, parseFloat(direccio) + 90);
                L.polyline([pEsquerra.geometry.coordinates.reverse(), pDreta.geometry.coordinates.reverse()], { color: estilPoligon.color, weight: 1.5, opacity: 0.9 }).addTo(cellulesTempestaLayer);
                const iconaTemps = L.divIcon({ className: 'temps-projeccio-label', html: `<span>+${minuts}'</span>`, iconSize: [40, 20], iconAnchor: [20, 10] });
                L.marker(pDreta.geometry.coordinates, { icon: iconaTemps }).addTo(cellulesTempestaLayer);
            });
            const popupOriginal = poligonLayer.getPopup();
            if (popupOriginal) {
                const contingutOriginal = popupOriginal.getContent();
                const nouContingut = `${contingutOriginal}<hr style="margin: 4px 0;">Moviment: <b>${velocitatKmh} km/h</b> (${direccio}°)`;
                poligonLayer.setPopupContent(nouContingut);
            }
        }
    });

    if (newAlertsFound) {
        processAlertQueue();
    }
}

/**
 * FUNCIÓ DE SEGUIMENT INCREMENTAL (PER A LES ACTUALITZACIONS CONTÍNUES)
 */
function analitzarTempestesSMC() {
    console.log("Iniciant anàlisi incremental de cèl·lules...");
    const dadesCompletes = getCombinedLightningData();

    // Filtrem per llamps recents per identificar les cèl·lules actuals
    const now = Date.now();
    const tempsLimit = now - (20 * 60 * 1000); // Finestra de 20 min per activitat
    const llampsRecents = new Map();
    dadesCompletes.forEach((llamp, id) => {
        if (llamp.timestamp >= tempsLimit) {
            llampsRecents.set(id, llamp);
        }
    });

    const graella = rasteritzarLlamps(llampsRecents);
    let celulesActuals = identificarCelules(graella);

    // Les seguim basant-nos en l'estat global anterior
    celulesActuals = ferSeguimentDeCelules(celulesActuals, celulesAnteriors);

    // Les analitzem (aquí s'aplicarà el filtre de 14 min per al LJ)
    const celulesAnalitzades = analitzarCadaCelula(celulesActuals, dadesCompletes);

    visualitzarCelules(celulesAnalitzades);

    // Guardem l'estat actual per a la propera actualització
    celulesAnteriors = celulesAnalitzades;
}

/**
 * Compares current cells with previous ones to give them
 * a persistent identity (tracking).
 * @param {Array} celulesActuals - The cells detected in the current minute.
 * @param {Array} celulesAnteriors - The cells from the previous analysis.
 * @returns {Array} The current cells with their history and ID inherited.
 */
function ferSeguimentDeCelules(celulesActuals, celulesAnteriors) {
    // Inicialitzem el centroide de totes les cèl·lules actuals
    celulesActuals.forEach(actual => {
        actual.centroide = turf.centroid(turf.featureCollection(actual.pixels.map(p => turf.point([p.lon, p.lat]))));
    });

    if (celulesAnteriors.length === 0) {
        // Si no hi ha historial, aquesta és la primera aparició. Creem la seva trajectòria inicial.
        celulesActuals.forEach(actual => {
            actual.trajectoria = [actual.centroide.geometry.coordinates];
        });
        return celulesActuals;
    }

    const celulesSeguides = celulesActuals.map(actual => {
        let millorCandidat = null;
        let distanciaMinima = Infinity;

        celulesAnteriors.forEach(anterior => {
            if (!anterior.centroide) return;
            const distancia = turf.distance(actual.centroide, anterior.centroide);
            if (distancia < distanciaMinima) {
                distanciaMinima = distancia;
                millorCandidat = anterior;
            }
        });

        if (millorCandidat && distanciaMinima < 7) {
            actual.id = millorCandidat.id;
            const baseTrajectoria = Array.isArray(millorCandidat.trajectoria) ? millorCandidat.trajectoria : [];
            actual.trajectoria = [...baseTrajectoria, actual.centroide.geometry.coordinates];
        } else {
            // És una cèl·lula nova, creem la seva trajectòria inicial
            actual.trajectoria = [actual.centroide.geometry.coordinates];
        }
        return actual;
    });

    return celulesSeguides;
}

/**
 * FUNCIÓ ORQUESTRADORA PRINCIPAL (VERSIÓ REFINADA)
 * Executa el procés filtrant primer per llamps recents.
 */
function analitzarTempestesSMC() {
    console.log("Iniciant anàlisi de cèl·lules ACTIVES amb seguiment...");
    const dadesCompletes = getCombinedLightningData();

    const now = Date.now();
    const tempsLimit = now - (20 * 60 * 1000);

    const llampsRecents = new Map();
    dadesCompletes.forEach((llamp, id) => {
        if (llamp.timestamp >= tempsLimit) {
            llampsRecents.set(id, llamp);
        }
    });

    const graella = rasteritzarLlamps(llampsRecents);
    let celulesActuals = identificarCelules(graella);

    celulesActuals = ferSeguimentDeCelules(celulesActuals, celulesAnteriors);

    const celulesAnalitzades = analitzarCadaCelula(celulesActuals, dadesCompletes);
    visualitzarCelules(celulesAnalitzades);

    // Guardem les cèl·lules analitzades per a la propera iteració
    celulesAnteriors = celulesAnalitzades;
    console.log(`Anàlisi completada. S'han trobat ${celulesAnalitzades.length} cèl·lules actives.`);
}

/**
 * VERSIÓ FINAL: Analitza un polígon dibuixat manualment utilitzant
 * el mateix motor d'anàlisi que el sistema automàtic.
 */
function analitzarLightningJump() {
    if (!analisisPolygon) {
        // Si per alguna raó no hi ha polígon, amaguem el gràfic.
        document.getElementById('lightning-jump-overlay').style.display = 'none';
        return;
    }

    console.log("Iniciant anàlisi en mode MANUAL amb el nou algorisme...");

    // 1. Obtenim TOTES les dades (històriques + temps real)
    const dadesCompletes = getCombinedLightningData();

    // 2. Filtrem els llamps que cauen dins del polígon manual
    const llampsDinsDelPoligon = [];
    dadesCompletes.forEach(llamp => {
        const punt = turf.point([llamp.lon, llamp.lat]);
        if (turf.booleanPointInPolygon(punt, analisisPolygon)) {
            llampsDinsDelPoligon.push(llamp);
        }
    });

    // 3. Creem una "cèl·lula de tempesta virtual" amb els llamps filtrats
    //    Li donem una estructura semblant a les cèl·lules automàtiques.
    const celulaManual = {
        strikes: llampsDinsDelPoligon,
        // Definim els píxels a partir dels llamps per poder fer l'anàlisi retrospectiva
        pixels: llampsDinsDelPoligon.map(l => ({ lon: l.lon, lat: l.lat }))
    };

    // 4. Utilitzem el NOU motor d'anàlisi sobre aquesta cèl·lula virtual
    // Passem un array amb la nostra única cèl·lula i les dades completes
    const celulaAnalitzada = analitzarCadaCelula([celulaManual], dadesCompletes)[0];

    // 5. Mostrem el gràfic amb els resultats de l'anàlisi actualitzada
    const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i * 2}m`);
    const saltsCombinats = [...celulaAnalitzada.saltN2, ...celulaAnalitzada.saltN1];
    mostrarGrafic(labels, celulaAnalitzada.recomptesComplets, saltsCombinats, celulaAnalitzada.recomptesNN);
}

/**
 * VERSIÓ FINAL: Dibuixa el gràfic, gestiona els colors per intensitat,
 * la icona de llamp i la interactivitat de la finestra.
 */
function mostrarGrafic(labels, data, saltsDetectats = [], recomptesNN = []) {
    if (lightningChart) {
        lightningChart.destroy();
    }

    const overlay = document.getElementById('lightning-jump-overlay');
    const container = document.getElementById('lightning-jump-chart-container');
    overlay.style.display = 'flex';
    const ctx = document.getElementById('lightningJumpChart').getContext('2d');

    function getColorPerSalt(sigma) {
        if (sigma >= 4) return { bg: 'rgba(189, 48, 243, 0.7)', border: 'rgba(189, 48, 243, 1)' };
        if (sigma >= 3) return { bg: 'rgba(255, 20, 20, 0.7)', border: 'rgba(255, 20, 20, 1)' };
        return { bg: 'rgba(255, 114, 53, 0.7)', border: 'rgba(255, 114, 53, 1)' };
    }

    const saltsMap = new Map(saltsDetectats.map(s => [s.index, s.sigma]));

    // Dataset for Total Strikes
    const datasets = [{
        label: 'Total Llamps/min',
        data: data,
        borderColor: 'rgba(0, 149, 249, 1)',
        backgroundColor: 'rgba(0, 149, 249, 0.2)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).bg : 'rgba(0, 149, 249, 1)'),
        pointBorderColor: data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).border : 'white'),
        pointRadius: data.map((_, index) => saltsMap.has(index) ? 6 : 3),
        pointHoverRadius: data.map((_, index) => saltsMap.has(index) ? 8 : 5)
    }];

    // Dataset for Intracloud Strikes (NN)
    const showNN = recomptesNN && recomptesNN.length > 0 && Math.max(...recomptesNN) > 0;
    if (showNN) {
        datasets.push({
            label: 'Llamps NN/min (Intracloud)',
            data: recomptesNN,
            borderColor: 'rgba(168, 85, 247, 1)', // Purple
            backgroundColor: 'rgba(168, 85, 247, 0.2)',
            borderWidth: 2,
            borderDash: [5, 5],
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 4
        });
    }

    lightningChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { ticks: { maxRotation: 90, minRotation: 90, autoSkip: true, maxTicksLimit: 20 } },
                y: { beginAtZero: true, title: { display: true, text: 'Nre. de llamps' } }
            },
            plugins: {
                legend: { display: false },
                lightningJumpIcon: { jumps: saltsDetectats }
            }
        }
    });

    document.getElementById('close-chart-btn').onclick = () => {
        overlay.style.display = 'none';
        container.classList.remove('modal-view');
        if (lightningChart) {
            lightningChart.destroy();
            lightningChart = null;
        }
    };

    document.getElementById('toggle-chart-size-btn').onclick = () => {
        container.classList.toggle('modal-view');
    };
}

/**
 * Troba el timestamp de satèl·lit (múltiple de 10) més proper a una data donada.
 * @param {Date} targetDate - La data de referència (del radar).
 * @returns {Date} La data del satèl·lit més propera.
 */
function findClosestSatTimestamp(targetDate) {
    const date = new Date(targetDate.getTime());
    const minutes = date.getUTCMinutes();
    const closestMultipleOf10 = Math.round(minutes / 10) * 10;

    date.setUTCMinutes(closestMultipleOf10, 0, 0);

    // Si l'arrodoniment ens fa passar a l'hora següent
    if (closestMultipleOf10 === 60) {
        date.setUTCHours(date.getUTCHours() + 1);
        date.setUTCMinutes(0);
    }

    return date;
}

/**
 * Funció de descompressió LZW per a les dades de Blitzortung.org.
 * Aquesta funció converteix la cadena de text ofuscada en un JSON llegible.
 */
function lzw_decode(str) {
    let dict = {};
    let data = (str + "").split("");
    let currChar = data[0];
    let oldPhrase = currChar;
    let out = [currChar];
    let code = 256;
    let phrase;
    for (let i = 1; i < data.length; i++) {
        let currCode = data[i].charCodeAt(0);
        if (currCode < 256) {
            phrase = data[i];
        } else {
            phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
        }
        out.push(phrase);
        currChar = phrase.charAt(0);
        dict[code] = oldPhrase + currChar;
        code++;
        oldPhrase = phrase;
    }
    return out.join("");
}

// ===================================================================
// GESTOR DE LLAMPS EN TEMPS REAL I HISTÒRIC (VERSIÓ DEFINITIVA)
// Reemplaça tot el teu objecte 'realtimeLightningManager' per aquest.
// ===================================================================
const realtimeLightningManager = {
    isActive: false,
    currentMode: 'realtime_only',
    // Propietats per als dos sockets
    socketLm: null, // Per a LightningMaps.org
    socketBo: null, // Per a Blitzortung.org
    strikeMarkers: new Map(),
    updateInterval: null,
    layerGroup: lightningLayerGroup,

    // Propietats per a les dades històriques i les capes de resum
    historicStrikes: new Map(),
    historicLayerGroup: historicLightningLayerGroup,
    historicUpdateInterval: null,
    timeFilterMinutes: 120,
    layer1h: null,
    layer24h: null,
    MAX_AGE_MINS: 30,
    heatmapMode: false,
    audioAlertsActive: false,
    lastAudioTime: 0,

    // Inicia el mòdul de llamps i connecta a les dues fonts
    start: function () {
        if (this.isActive) return;
        console.log("Iniciant mòdul de llamps (amb dues fonts)...");
        this.isActive = true;
        this.connect();
        this.updateInterval = setInterval(() => this.updateMarkers(), 5000);

        // Reiniciem el mode històric si és el que teníem seleccionat
        if (this.currentMode === 'historic') {
            this.isInitialHistoricLoad = true;
            this.startHistoricMode();
        }
    },

    // Atura el mòdul i tanca les dues connexions
    // SUBSTITUEIX LA TEVA FUNCIÓ 'stop' PER AQUESTA:
    stop: function () {
        if (!this.isActive) return;
        console.log("Aturant mòdul de llamps.");
        this.isActive = false;

        this.stopHistoricMode();

        // Aturem les connexions
        if (this.socketLm) this.socketLm.close();
        if (this.socketBo) this.socketBo.close();
        this.socketLm = null;
        this.socketBo = null;

        // Aturem els intervals d'actualització
        if (this.updateInterval) clearInterval(this.updateInterval);
        this.updateInterval = null;
        if (this.historicUpdateInterval) {
            clearInterval(this.historicUpdateInterval);
            this.historicUpdateInterval = null;
        }

        // Tanquem el popup si està obert
        const popup = document.getElementById('lightning-popup');
        if (popup) popup.remove();

        // Netejar polígons i icones d'anàlisi de tempesta
        if (typeof cellulesTempestaLayer !== 'undefined') cellulesTempestaLayer.clearLayers();
        if (typeof ljIconsLayer !== 'undefined') ljIconsLayer.clearLayers();
        celulesAnteriors = [];
    },

    // Funció orquestradora que inicia les dues connexions
    connect: function () {
        this.connectLightningMaps();
        this.connectBlitzortung();
    },

    // Connexió a LightningMaps.org (sense canvis)
    connectLightningMaps: function () {
        // ... (Aquesta funció es queda exactament com estava)
        if (this.socketLm && this.socketLm.readyState < 2) return;
        const wsUrl = 'wss://live2.lightningmaps.org:443/';
        this.socketLm = new WebSocket(wsUrl);
        this.socketLm.onopen = () => {
            console.log("WS LightningMaps: Connectat.");
            this.sendBoundsSubscription();
        };
        this.socketLm.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.k) {
                this.socketLm.send(`{"k":${(data.k * 3604) % 7081 * new Date().getTime() / 100}}`);
                return;
            }
            if (data.strokes) data.strokes.forEach(s => this.addStrike(s));
        };
        this.socketLm.onclose = () => console.log("WS LightningMaps: Tancat.");
        this.socketLm.onerror = (error) => console.error("WS LightningMaps Error:", error);
    },

    // VERSIÓ CORREGIDA per connectar-se a Blitzortung.org
    connectBlitzortung: function () {
        if (this.socketBo && this.socketBo.readyState < 2) return;
        const wsUrl = 'wss://ws1.blitzortung.org/';
        this.socketBo = new WebSocket(wsUrl);

        // PISTA 1: Enviar un missatge de salutació (handshake) en connectar
        this.socketBo.onopen = () => {
            console.log("WS Blitzortung: Connectat.");
            this.socketBo.send('{"a":111}');
        };

        this.socketBo.onmessage = (event) => {
            // PISTA 2: Descomprimir les dades abans de processar-les
            const decompressedData = lzw_decode(event.data);
            const rawData = JSON.parse(decompressedData);

            // Aquesta funció ara rebrà el JSON net
            const decodedStrike = this.decodeBlitzortungStrike(rawData);
            if (decodedStrike) {
                this.addStrike(decodedStrike);
            }
        };
        this.socketBo.onclose = () => console.log("WS Blitzortung: Tancat.");
        this.socketBo.onerror = (error) => console.error("WS Blitzortung Error:", error);
    },

    // Funció per extreure les dades del JSON ja descomprimit
    decodeBlitzortungStrike: function (data) {
        if (data.lat !== undefined && data.lon !== undefined) {
            const id = `bo-${data.time}-${data.lat}-${data.lon}`;
            return {
                id: id,
                lat: data.lat,
                lon: data.lon,
                pol: data.pol || 0, // Polaritat
                mag: data.mag || 0  // Magnitud (kA)
            };
        }
        return null;
    },

    // Funció unificada per afegir qualsevol llamp al mapa
    addStrike: function (strike) {
        if (this.strikeMarkers.has(strike.id) || !strike.lat || !strike.lon) return;

        if (this.audioAlertsActive) {
            const center = map.getCenter();
            const distKm = map.distance(center, L.latLng(strike.lat, strike.lon)) / 1000;
            if (distKm < 20) {
                this.playAudioAlert();
            }
        }

        // CORRECCIÓ: Especifiquem el 'pane' correcte aquí
        const flashStyle = { radius: 30, fillColor: "#FFFFFF", fillOpacity: 0.8, weight: 0, pane: 'llampsPane' };

        const marker = L.circleMarker([strike.lat, strike.lon], flashStyle);
        const markerData = {
            marker: marker,
            timestamp: new Date().getTime(),
            pol: strike.pol || 0,
            mag: strike.mag || 0,
            isCat: findComarca(turf.point([strike.lon, strike.lat])) !== 'Desconeguda'
        };
        this.strikeMarkers.set(strike.id, markerData);
        this.layerGroup.addLayer(marker);

        setTimeout(() => { if (this.strikeMarkers.has(strike.id)) this.updateMarkerStyle(markerData, 0); }, 250);
        this.createExpandingCircle(strike.lat, strike.lon);
        updateLightningStats();
    },

    // Funcions per a la visualització dels llamps en temps real
    updateMarkers: function () {
        const now = new Date().getTime();

        // El temps màxim de vida ara depèn del valor del slider quan el mode històric està actiu
        // Si no està en mode històric, es manté el màxim de 30 minuts.
        const maxAgeMins = this.currentMode === 'historic' ? this.timeFilterMinutes : this.MAX_AGE_MINS;

        this.strikeMarkers.forEach((markerData, strikeId) => {
            const ageMins = (now - markerData.timestamp) / 60000;
            if (ageMins > maxAgeMins) {
                this.layerGroup.removeLayer(markerData.marker);
                this.strikeMarkers.delete(strikeId);
                updateLightningStats();
            } else {
                // L'estil dels llamps en temps real continua basant-se en l'escala de 30 min
                this.updateMarkerStyle(markerData, ageMins);
            }
        });
    },

    updateMarkerStyle: function (markerData, ageMins = 0) {
        const color = this.getColorForAge(ageMins);

        let styleParams = {};
        if (this.heatmapMode) {
            styleParams = {
                radius: 12 + (12 * (1 - (ageMins / this.MAX_AGE_MINS))),
                fillColor: color,
                color: 'transparent',
                fillOpacity: 0.15,
                opacity: 0,
                weight: 0,
                className: 'lightning-heatmap-marker'
            };
        } else {
            styleParams = {
                fillColor: color,
                color: "#000000",
                fillOpacity: 0.9,
                opacity: 0.9,
                weight: 0.5,
                radius: Math.max(0.5, 4 - (ageMins / (this.currentMode === 'historic' ? this.timeFilterMinutes : this.MAX_AGE_MINS)) * 3),
                className: ''
            };
        }
        markerData.marker.setStyle(styleParams);
    },

    getColorForAge: function (ageMins) {
        // Colors més progressius (colors més clars/blancs els més recents, taronja/vermell els vells)
        if (ageMins < 1) return '#FFFFFF';
        if (ageMins < 3) return '#FFFFCC'; // Groc molt pàl·lid
        if (ageMins < 5) return '#FFFF00';
        if (ageMins < 10) return '#FFCC00';
        if (ageMins < 20) return '#FFA500';
        return '#FF4500'; // Vermell clar en lloc de fosc
    },

    playAudioAlert: function () {
        const now = Date.now();
        if (this.lastAudioTime && (now - this.lastAudioTime) < 2000) return; // Debounce 2 sec
        this.lastAudioTime = now;

        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.type = 'triangle';
            oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // La5
            oscillator.frequency.exponentialRampToValueAtTime(110, audioCtx.currentTime + 0.3);

            gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            oscillator.start();
            oscillator.stop(audioCtx.currentTime + 0.8);
        } catch (e) { console.error("Could not play audio alert", e); }
    },

    refreshStyles: function () {
        const now = new Date().getTime();
        this.strikeMarkers.forEach((markerData) => {
            const ageMins = (now - markerData.timestamp) / 60000;
            this.updateMarkerStyle(markerData, ageMins);
        });
        if (this.currentMode === 'historic') {
            this.updateHistoricMarkers();
        }
    },

    createExpandingCircle: function (lat, lon) {
        const circle = L.circle([lat, lon], { radius: 1, color: 'black', weight: 2, opacity: 0.8, fill: false, interactive: false, pane: 'markerPane' }).addTo(this.layerGroup);
        let currentRadius = 1;
        const animation = setInterval(() => {
            currentRadius += (currentRadius < 5000) ? 800 : 1000;
            const currentOpacity = 0.8 * (1 - (currentRadius / 45000));
            if (currentOpacity <= 0) {
                this.layerGroup.removeLayer(circle);
                clearInterval(animation);
            } else {
                circle.setRadius(currentRadius);
                circle.setStyle({ opacity: currentOpacity });
            }
        }, 20);
    },

    sendBoundsSubscription: function () {
        if (!this.isActive || !this.socketLm || this.socketLm.readyState !== 1) return;
        const bounds = map.getBounds();
        this.socketLm.send(JSON.stringify({ "v": 24, "a": 4, "i": {}, "p": [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] }));
    },

    // Totes les funcions per a les dades històriques i resum
    toggleHistoricLayers: function (option) {
        this.currentMode = option;

        if (option !== 'historic') this.stopHistoricMode();
        if (this.layer1h && map.hasLayer(this.layer1h)) this.layer1h.removeFrom(map);
        if (this.layer24h && map.hasLayer(this.layer24h)) this.layer24h.removeFrom(map);

        switch (option) {
            case 'historic':
                this.startHistoricMode();
                break;
            case 'realtime_plus_1h':
                if (!this.layer1h) this.layer1h = L.tileLayer('https://tiles.lightningmaps.org/?x={x}&y={y}&z={z}&s=256&t=5', { maxZoom: 16, zIndex: 100, opacity: 0.7 });
                this.layer1h.addTo(map);
                break;
            case 'realtime_plus_24h':
                if (!this.layer24h) this.layer24h = L.tileLayer('https://tiles.lightningmaps.org/?x={x}&y={y}&z={z}&s=256&t=6', { maxZoom: 16, zIndex: 100, opacity: 0.7 });
                this.layer24h.addTo(map);
                break;
            case 'none':
                this.stopHistoricMode();
                break;
        }
    },

    startHistoricMode: function () {
        console.log("Iniciant mode històric de llamps.");
        this.historicLayerGroup.addTo(map);
        this.fetchHistoricLightning();
        if (this.historicUpdateInterval) clearInterval(this.historicUpdateInterval);
        this.historicUpdateInterval = setInterval(() => this.fetchHistoricLightning(), 60000);
    },

    stopHistoricMode: function () {
        console.log("Aturant mode històric de llamps.");
        this.historicLayerGroup.removeFrom(map);
        if (this.historicUpdateInterval) {
            clearInterval(this.historicUpdateInterval);
            this.historicUpdateInterval = null;
        }
        this.isInitialHistoricLoad = true; // <-- REINICIEM EL FLAG AQUÍ
    },

    isInitialHistoricLoad: true,

    fetchHistoricLightning: async function () {
        console.log("Actualitzant dades històriques de llamps...");
        // ... (la part inicial que obté les dades de l'API es manté igual)
        const urls = [];
        for (let i = 0; i < 24; i++) { // 24 folders * 5min = 120 minuts
            const folderName = String(i).padStart(2, '0');
            urls.push(`https://meteo-api.projecte4estacions.com/api/blitzortung/dades-historiques/${folderName}`);
        }
        console.log("URLs a consultar:", urls.length);
        try {
            const responses = await Promise.all(urls.map(url => fetch(url).then(res => res.json()).catch(err => {
                console.error("Error en fetch de folder:", url, err);
                return [];
            })));
            const allStrikes = responses.flat();
            const newHistoricStrikes = new Map();
            const now = new Date();
            const timeCutoff = now.getTime() - (120 * 60 * 1000); // Capturem 120 minuts
            allStrikes.forEach(strike => {
                const strikeTime = new Date(strike[2] + 'Z').getTime();
                if (strikeTime >= timeCutoff) {
                    const lat = strike[1];
                    const lon = strike[0];
                    const strikeId = `${lon}_${lat}_${strike[2]}`;
                    const isCat = findComarca(turf.point([lon, lat])) !== 'Desconeguda';
                    newHistoricStrikes.set(strikeId, { lat: lat, lon: lon, timestamp: strikeTime, isCat: isCat });
                }
            });

            this.historicStrikes = newHistoricStrikes;
            console.log(`Processats ${this.historicStrikes.size} llamps històrics.`);
            this.updateHistoricMarkers();
            updateLightningStats();

            // ======================================================
            // NOVA LÒGICA HÍBRIDA
            // ======================================================
            if (isAutoDetectMode) {
                if (this.isInitialHistoricLoad) {
                    console.log("Executant anàlisi retrospectiu inicial...");
                    analitzarTempestesRetrospectivament(getCombinedLightningData());
                    this.isInitialHistoricLoad = false; // Marquem que la càrrega inicial ja s'ha fet
                } else {
                    console.log("Executant anàlisi incremental...");
                    analitzarTempestesSMC(); // En les següents actualitzacions, fem la versió lleugera
                }
            } else if (typeof analisisPolygon !== 'undefined' && analisisPolygon) {
                console.log("Executant analitzarLightningJump...");
                analitzarLightningJump();
            }
        } catch (error) {
            console.error("Error obtenint dades històriques de llamps:", error);
        }
    },

    // Dins de l'objecte realtimeLightningManager
    updateHistoricMarkers: function () {
        this.historicLayerGroup.clearLayers();
        const now = new Date().getTime();
        const timeFilterMs = this.timeFilterMinutes * 60 * 1000;
        this.historicStrikes.forEach(strike => {
            const ageMs = now - strike.timestamp;
            if (ageMs <= timeFilterMs) {
                const ageMins = ageMs / 60000;
                const color = this.getHistoricColorForAge(ageMins);
                let radius, weight, opacity, fillOpacity;

                if (this.heatmapMode) {
                    radius = 12 + (12 * (1 - (ageMins / this.timeFilterMinutes)));
                    weight = 0;
                    opacity = 0;
                    fillOpacity = 0.15;
                } else {
                    radius = 4 - (ageMins / 120) * 2.5; // Mida petita
                    weight = 0.5;
                    opacity = 0.9;
                    fillOpacity = 0.9;
                }

                const marker = L.circleMarker([strike.lat, strike.lon], {
                    radius: radius,
                    fillColor: color,
                    color: this.heatmapMode ? 'transparent' : '#000000',
                    weight: weight,
                    opacity: opacity,
                    fillOpacity: fillOpacity,
                    className: this.heatmapMode ? 'lightning-heatmap-marker' : '',
                    pane: 'llampsPane'
                });
                this.historicLayerGroup.addLayer(marker);
            }
        });
    },

    getHistoricColorForAge: function (ageMins) {
        if (ageMins < 5) return '#FFFFFF';
        if (ageMins < 15) return '#FFFFCC';
        if (ageMins < 30) return '#FFFF00';
        if (ageMins < 60) return '#FFA500';
        if (ageMins < 90) return '#FF4500';
        return '#8B0000'; // Vermell molt fosc
    },

    setTimeFilter: function (minutes) {
        this.timeFilterMinutes = minutes;
        this.updateHistoricMarkers();
    }
};

// ===================================================================
// XARXA DETECCIÓ DESCÀRREGUES ELÈCTRIQUES (XDDE METEOCAT)
// ===================================================================
const xddeLightningManager = {
    isActive: false,
    updateInterval: null,
    strikeMarkers: new Map(),
    layerGroup: xddeLayerGroup,
    lastFetchKey: null,
    isInitialHistoricLoad: true, // Nova bandera per a l'anàlisi retrospectiu

    showLoadingXDDE: function () {
        if (!document.getElementById('xdde-loading-toast')) {
            const toast = document.createElement('div');
            toast.id = 'xdde-loading-toast';
            toast.className = 'fixed top-4 right-4 bg-white border-l-4 border-purple-500 shadow-xl rounded px-4 py-3 flex items-center space-x-3 z-[9999] transition-opacity duration-300';
            toast.innerHTML = `
                <svg class="animate-spin h-5 w-5 text-purple-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <div class="flex flex-col">
                    <span class="text-xs font-bold text-slate-800 uppercase tracking-wider">Meteocat XDDE</span>
                    <span class="text-[10px] text-slate-500">Descarregant llamps oficials...</span>
                </div>
            `;
            document.body.appendChild(toast);
        }
    },

    hideLoadingXDDE: function () {
        const toast = document.getElementById('xdde-loading-toast');
        if (toast) {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }
    },

    start: function () {
        if (this.isActive) return;
        console.log("Iniciant mòdul XDDE Meteocat...");
        this.isActive = true;
        this.layerGroup.addTo(map);
        this.fetchXDDEData();
        // Update every 2 minutes
        this.updateInterval = setInterval(() => this.fetchXDDEData(), 120000);
    },

    stop: function () {
        if (!this.isActive) return;
        console.log("Aturant mòdul XDDE Meteocat.");
        this.isActive = false;
        this.lastFetchKey = null; // Resetejem la clau de cache
        this.layerGroup.removeFrom(map);
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        // Reprocessar les cel·les tornant a Blitzortung
        if (isAutoDetectMode) {
            analitzarTempestesSMC();
        } else if (typeof analisisPolygon !== 'undefined' && analisisPolygon) {
            analitzarLightningJump();
        }
    },

    fetchXDDEData: async function () {
        const now = new Date();
        const twoHoursAgo = new Date(now.getTime() - (125 * 60 * 1000)); // 2h i 5min de marge

        // Helper function per formatar dates i hores pel Meteocat
        const formatLocalYYYYMMDD = (d) => {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        };
        const formatLocalHHMMSS = (d) => {
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return `T${hh}:${mm}:${ss}`;
        };

        const fromDateStr = formatLocalYYYYMMDD(twoHoursAgo);
        const fromTimeStr = formatLocalHHMMSS(twoHoursAgo);
        const toDateStr = formatLocalYYYYMMDD(now);
        const toTimeStr = formatLocalHHMMSS(now);

        console.log(`XDDE Query Setup (Últimes 2h) -> [${fromDateStr} ${fromTimeStr}] fins [${toDateStr} ${toTimeStr}]`);


        try {
            this.showLoadingXDDE();

            // Peticionem les dades NT i NN per a la finestra de 2 hores
            const ntPromise = this.requestXDDE(fromDateStr, fromTimeStr, toDateStr, toTimeStr, 'nt').then(text => this.parseXDDEText(text, 'nt')).catch(e => { console.error("Error NT:", e); return []; });
            const nnPromise = this.requestXDDE(fromDateStr, fromTimeStr, toDateStr, toTimeStr, 'nn').then(text => this.parseXDDEText(text, 'nn')).catch(e => { console.error("Error NN:", e); return []; });
            const [llampsNT, llampsNN] = await Promise.all([ntPromise, nnPromise]);

            console.log(`Total resultats XDDE - NT: ${llampsNT.length}, NN: ${llampsNN.length}`);
            const dades = [...llampsNT, ...llampsNN];

            this.updateMapMarkers(dades);

            // ANALISI DE CEL·LULES I PROJECCIONS
            if (isAutoDetectMode) {
                if (this.isInitialHistoricLoad) {
                    console.log("XDDE: Executant anàlisi retrospectiva inicial per a projeccions...");
                    analitzarTempestesRetrospectivament(getCombinedLightningData());
                    this.isInitialHistoricLoad = false;
                } else {
                    analitzarTempestesSMC(); // Incrementals
                }
            } else if (typeof analisisPolygon !== 'undefined' && analisisPolygon) {
                analitzarLightningJump();
            }

        } catch (e) {
            console.error("Error processant XDDE:", e);
        } finally {
            this.hideLoadingXDDE();
        }
    },

    requestXDDE: async function (fromDate, fromTime, toDate, toTime, type) {
        const params = new URLSearchParams();
        params.append('fromDate', fromDate); params.append('fromTime', fromTime);
        params.append('toDate', toDate); params.append('toTime', toTime);
        params.append('tipus_informe', 'llistat'); params.append('veure_dades_electriques', 'on');
        params.append('veure_latlon', 'on'); params.append('veure_detalls', 'si');
        params.append('submitButton', 'Submit');

        if (type === 'nt') {
            params.append('tipus_descarrega_nuvol_terra', 'on');
        } else if (type === 'nn') {
            params.append('tipus_descarrega_nuvol_nuvol', 'on');
        }

        const baseUrl = 'http://www.meteocatclients.com/webs_clients/includes/informe_xdde.php';

        try {
            const response = await fetch(baseUrl, {
                method: 'POST',
                body: params,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const text = await response.text();

            if (text.includes('Data i hora')) {
                return text;
            }
            console.error(`XDDE [${type}] Resposta buida o invàlida (Longitud: ${text.length})`);
            throw new Error(`Resposta no vàlida per tipus ${type}`);
        } catch (e) {
            console.error("Error direct HTTP XDDE:", e);
            return "";
        }
    },

    parseXDDEText: function (text, requestedType) {
        if (!text) return [];
        const lines = text.split('\n');
        const result = [];
        let skipped = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.includes('Data i hora')) continue;
            const parts = line.split(/\s+/);
            if (parts.length >= 11) {
                // Recuperem el tipus confiant en el que hem demanat (nt/nn)
                // perquè en el llistat el Meteocat igualment posa "nt" o "nn"
                const tipusMetCat = parts[2].toLowerCase();
                // Utilitzem requestedType per defecte, o el que digui el registre 
                const tipusDefinitiu = tipusMetCat === 'nt' || tipusMetCat === 'nn' ? tipusMetCat : requestedType;

                result.push({
                    id: `xdde-${parts[0]}-${parts[1]}-${parts[3]}-${parts[4]}`,
                    timestamp: new Date(parts[0] + ' ' + parts[1]).getTime(),
                    tipus_original: parts[2], // nt / nn
                    tipus: tipusDefinitiu,
                    lat: parseFloat(parts[3]),
                    lon: parseFloat(parts[4]),
                    ka: parts[10]
                });
            } else {
                skipped++;
            }
        }
        console.log(`XDDE Parse [${requestedType}]: Processats=${result.length}, Ignorats per format curt=${skipped}`);
        return result;
    },

    updateMapMarkers: function (dades) {
        this.layerGroup.clearLayers();
        this.strikeMarkers = new Map();

        // En XDDE (especialment fent cerques) ens interessa veure TOT l'historial del dia o l'episodi
        // sense filtrar per edat (com a llamps.html on es pinten tots els vinculats a la cèl·lula o query)
        console.log(`Pintant ${dades.length} llamps XDDE al mapa (Sense restricció d'edat)`);

        dades.forEach(l => {
            this.strikeMarkers.set(l.id, l);
            // El patró de colors original:
            // NT Positiu > 0 = Vermell (#ef4444)
            // NT Negatiu <= 0 = Blau (#3b82f6)
            // NN = Lila (#a855f7)
            const color = l.tipus === 'nt' ? (parseFloat(l.ka) > 0 ? '#ef4444' : '#3b82f6') : '#a855f7';
            L.circleMarker([l.lat, l.lon], {
                radius: l.tipus === 'nt' ? 4 : 2,
                fillColor: color,
                color: l.tipus === 'nt' ? '#fff' : color,
                weight: 1,
                fillOpacity: 0.8,
                pane: 'llampsPane'
            }).addTo(this.layerGroup);
        });
    }
};

map.on('overlayadd', function (e) {
    if (e.name === "Meteocat XDDE (NT+NN)") {
        xddeLightningManager.start();
    }
});
map.on('overlayremove', function (e) {
    if (e.name === "Meteocat XDDE (NT+NN)") {
        xddeLightningManager.stop();
    }
});

// ===================================================================
// SINCRONITZACIÓ DE DATES XDDE AMB EL MAPA
// ===================================================================

// 1. Escoltar canvis en el calendari de l'historial principal
const historicDateInput = document.getElementById('historic-datetime-picker');
if (historicDateInput) {
    historicDateInput.addEventListener('change', function () {
        if (xddeLightningManager.isActive) {
            console.log("Sincronitzant dates XDDE Meteocat amb el calendari històric...");
            xddeLightningManager.fetchXDDEData();
        }
    });
}

// 2. Escoltar els clics en els botons globals de canvi de dia de SMC (Avisos)
// Aquests botons assignen a la variable global 'selectedDate'
document.addEventListener('click', function (e) {
    // Utilitzem un delegat per capturar els botons ja que apareixen dinàmicament
    if (e.target.closest('#smp-day-buttons .smp-btn')) {
        if (xddeLightningManager.isActive) {
            console.log("Refrescant XDDE en clicar en un botó de data d'SMC...");
            // Posem un petit delay per assegurar-nos que 'selectedDate' s'ha actualitzat al fitxer JS
            setTimeout(() => {
                xddeLightningManager.fetchXDDEData();
            }, 100);
        }
    }
});

// ======================================================
// PAS FINAL I CRUCIAL: ACTUALITZAR LA VISTA AL MOURE EL MAPA
// Afegeix aquest bloc al final de tot del teu fitxer.
// ======================================================
map.on('moveend zoomend', () => {
    // Si el mòdul de llamps està actiu, li diem que enviï les noves coordenades.
    if (realtimeLightningManager.isActive) {
        realtimeLightningManager.sendBoundsSubscription();
    }
});


const satelliteControls = document.getElementById('satellite-controls-container');
const satelliteOpacitySlider = document.getElementById('satellite-opacity-slider');

// Variable per guardar quina capa de satèl·lit està activa
let activeSatelliteLayer = null;

// Funció genèrica per actualitzar l'opacitat de la capa activa
function updateOpacity() {
    if (activeSatelliteLayer) {
        activeSatelliteLayer.setOpacity(satelliteOpacitySlider.value);
    }
    // Per a la capa AROME (que ara és un LayerGroup)
    if (openMeteoAromeLayer) {
        openMeteoAromeLayer.eachLayer(layer => {
            if (typeof layer.setOpacity === 'function') {
                layer.setOpacity(satelliteOpacitySlider.value);
            }
        });
    }
}


// Quan mous el slider... cridem a la funció genèrica
satelliteOpacitySlider.addEventListener('input', updateOpacity);
// FI DEL BLOC NOU ----------------------------------------------

// =================================================================
// MILLORA 2: ACTUALITZACIÓ AUTOMÀTICA EN MOURE EL MAPA
// =================================================================
map.on('moveend', function () {
    // Comprovem quina de les capes "Express" està activa
    if (currentVariableKey === 'weathercom_precip') {
        displayWeatherComPrecipitation();
    } else if (currentVariableKey === 'weathercom_precip_semihourly') {
        displayWeatherComSemiHourlyPrecipitation();
    } else if (currentVariableKey === 'ecowitt_precip') { // <-- AFEGEIX AQUEST BLOC
        displayEcowittPrecipitation();
    }
    else if (currentVariableKey === 'weathercom_temp') {
        displayWeatherComTemperature();
    }
});

// =================================================================
// LÒGICA FINAL I UNIFICADA PER AL PANELL DE TAULES (VERSIÓ CORREGIDA)
// (Soluciona error 'NaN' en valors 0 i refresca en canviar de variable)
// =================================================================

document.addEventListener('DOMContentLoaded', () => {
    const tablesBtn = document.getElementById('tables-menu-btn');
    const tablesPanel = document.getElementById('tables-panel');
    const closeTablesBtn = document.getElementById('close-tables-panel');
    const tablesContent = document.getElementById('tables-content');
    const copyBtn = document.getElementById('copy-table-btn');

    if (!tablesBtn || !tablesPanel || !closeTablesBtn || !copyBtn) return;

    let currentSortBy = 'valor';
    let currentSortDirection = 'desc';
    let sortedVisibleStations = [];

    // ★ REEMPLAÇA LA TEVA VERSIÓ D'AQUESTA FUNCIÓ PER AQUESTA CORREGIDA ★
    async function fetchDataForCurrentVariable() {
        // 1. Cas especial: Sumatori (ja té les dades guardades)
        if (currentVariableKey === 'sumatori_precipitacio') {
            return lastSumatoriResult;
        }

        const config = VARIABLES_CONFIG[currentVariableKey];
        if (!config) return [];

        // ★ AQUESTA ÉS LA LÍNIA QUE FALTAVA I CAUSAVA L'ERROR: ★
        const dateToUse = historicModeTimestamp;

        // === Lògica per a l'Índex de Rovellons ===
        if (config.isSpecial) {
            const dateForQuery = dateToUse || new Date();
            const endDate = new Date(dateForQuery);
            const startDate = new Date(dateForQuery);
            startDate.setDate(startDate.getDate() - 20);

            const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
            const metadata = await $.getJSON(urlMetadades);
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));

            const promises = [];
            for (let i = 0; i < 20; i++) {
                const currentDate = new Date(startDate);
                currentDate.setDate(currentDate.getDate() + i);
                const startOfDay = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate(), 0, 0, 0, 0));
                const endOfDay = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate(), 23, 59, 59, 999));

                promises.push(fetchSmcDailySummary(35, 'sum', startOfDay, endOfDay));
                promises.push(fetchSmcDailySummary(42, 'min', startOfDay, endOfDay));
                promises.push(fetchSmcDailySummary(40, 'max', startOfDay, endOfDay));
                promises.push(fetchTrueDailyData(1505, currentDate));
                promises.push(fetchTrueDailyData(1504, currentDate));
                promises.push(fetchTrueDailyData(1503, currentDate));
            }
            const results = await Promise.all(promises);

            const stationAnalysis = new Map();
            results.forEach((result, index) => {
                if (!result || !result.data) return;
                const dataTypeIndex = index % 6;
                result.data.forEach(d => {
                    const stationId = d.codi_estacio;
                    if (!stationAnalysis.has(stationId)) stationAnalysis.set(stationId, { precipData: [], tminData: [], tmaxData: [], wind2mData: [], wind6mData: [], wind10mData: [] });
                    const value = parseFloat(d.valor || d.valor_lectura);
                    if (!isNaN(value)) {
                        const s = stationAnalysis.get(stationId);
                        if (dataTypeIndex === 0) s.precipData.push(value);
                        else if (dataTypeIndex === 1) s.tminData.push(value);
                        else if (dataTypeIndex === 2) s.tmaxData.push(value);
                        else if (dataTypeIndex === 3) s.wind2mData.push(value * 3.6);
                        else if (dataTypeIndex === 4) s.wind6mData.push(value * 3.6);
                        else if (dataTypeIndex === 5) s.wind10mData.push(value * 3.6);
                    }
                });
            });

            const finalData = [];
            stationAnalysis.forEach((data, stationId) => {
                const stationInfo = estacionsMap.get(stationId);
                if (!stationInfo || data.precipData.length < 15) return;

                let puntsPluja = 0, puntsTempNoc = 0, penalitzacioTmax = 0, penalitzacioVent = 0, puntsLluna = 0;
                const precipTotal = data.precipData.reduce((a, b) => a + b, 0);
                if (precipTotal > 100) puntsPluja = 50; else if (precipTotal > 75) puntsPluja = 45; else if (precipTotal > 50) puntsPluja = 40; else if (precipTotal > 30) puntsPluja = 30; else if (precipTotal > 20) puntsPluja = 20;

                const diesFreds = data.tminData.filter(t => t < 5).length;
                const diesCalids = data.tminData.filter(t => t > 15).length;
                let basePuntsTemp = 0;
                if (diesFreds <= 1) basePuntsTemp += 20; else if (diesFreds <= 3) basePuntsTemp += 10;
                if (diesCalids <= 3) basePuntsTemp += 20; else if (diesCalids <= 6) basePuntsTemp += 10;
                puntsTempNoc = basePuntsTemp;

                const diesCalor = data.tmaxData.filter(t => t > 25).length;
                penalitzacioTmax = -Math.min(20, diesCalor * 5);

                let diesVent = 0;
                let dadesVentASumar = null, llindarVent = 15;
                if (data.wind2mData.length > 0) { dadesVentASumar = data.wind2mData; llindarVent = 8; }
                else if (data.wind6mData.length > 0) { dadesVentASumar = data.wind6mData; llindarVent = 12; }
                else if (data.wind10mData.length > 0) { dadesVentASumar = data.wind10mData; llindarVent = 15; }
                if (dadesVentASumar) diesVent = dadesVentASumar.filter(v => v > llindarVent).length;
                penalitzacioVent = -Math.min(20, diesVent * 5);

                const FASES_BONUS = ['🌖 Gibosa Minvant', '🌗 Quart Minvant', '🌘 Minvant'];
                const CICLE_LUNAR = 29.530588853; const DATA_NOVA_CONEGUDA = 2451549.5;
                const araEnDiesJulians = (Date.now() / 86400000) - 0.5 + 2440588;
                const faseActual = ((araEnDiesJulians - DATA_NOVA_CONEGUDA) / CICLE_LUNAR) % 1;
                const faseText = ['🌑 Nova', '🌒 Creixent', '🌓 Quart Creixent', '🌔 Gibosa Creixent', '🌕 Plena', '🌖 Gibosa Minvant', '🌗 Quart Minvant', '🌘 Minvant'][Math.floor(faseActual * 8)];
                if (FASES_BONUS.includes(faseText)) puntsLluna = 10;

                let score = puntsPluja + puntsTempNoc + penalitzacioTmax + penalitzacioVent + puntsLluna;
                const finalScore = Math.max(0, Math.min(100, Math.round(score)));
                finalData.push({ ...stationInfo, codi_estacio: stationId, valor: finalScore });
            });
            return finalData;
        }

        // === Lògica per a les variables de Percentils ===
        if (config.isPercentile) {
            const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%2C%0A%20%20%60altitud%60";
            const metadata = await $.getJSON(urlMetadades);
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud), altitud: parseFloat(est.altitud) }]));
            const percentileData = [];
            for (const stationCode in dadesPercentils) {
                const stationInfo = estacionsMap.get(stationCode);
                const value = dadesPercentils[stationCode][config.valueKey];
                if (stationInfo && value !== undefined) {
                    percentileData.push({ ...stationInfo, codi_estacio: stationCode, valor: value });
                }
            }
            return percentileData;
        }

        // === Lògica per a resums diaris (Màximes, Mínimes, etc.) ===
        if (config.summary && !config.comparison) {
            const dateForDay = dateToUse || new Date();
            const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
            const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));

            if (currentVariableKey === 'wind_gust_daily_ms' || currentVariableKey === 'wind_gust_daily_kmh') {
                const gust_ids = [50, 53, 56];
                const promises = gust_ids.map(id => fetchSmcDailySummary(id, 'max', startOfDay, endOfDay));
                const results = await Promise.all(promises);
                const finalGustData = new Map();
                results.forEach(result => {
                    (result.data || []).forEach(station => {
                        const valor = parseFloat(station.valor || station.valor_lectura);
                        if (!isNaN(valor)) {
                            if (!finalGustData.has(station.codi_estacio) || valor > finalGustData.get(station.codi_estacio).valor_max) {
                                finalGustData.set(station.codi_estacio, { ...station, valor_max: valor });
                            }
                        }
                    });
                });
                return Array.from(finalGustData.values()).map(d => ({ ...d, valor: d.valor_max * (config.conversion || 1) }));
            }

            const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
            return (result.data || []).map(d => ({ ...d, valor: parseFloat(d.valor) * (config.conversion || 1) }));
        }

        // === Lògica per a variables calculades, híbrides i de comparació ===
        if (config.isCalculated || config.isHybrid || config.comparison) {
            const getSourceData = (sourceKey) => {
                if (sourceKey === 'percentils') return Promise.resolve({ key: sourceKey, data: dadesPercentils });
                const sourceConfig = VARIABLES_CONFIG[sourceKey];
                const dataType = sourceKey === 'wind' ? 'speed' : (sourceKey === 'wind_gust' ? 'gust' : null);

                if (dataType) return fetchAllWindData(dataType, dateToUse).then(data => ({ key: sourceKey, data }));

                if (sourceConfig && sourceConfig.summary) {
                    const dateForDay = dateToUse || new Date();
                    const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
                    const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));
                    return fetchSmcDailySummary(sourceConfig.id, sourceConfig.summary, startOfDay, endOfDay).then(res => ({ key: sourceKey, data: res.data }));
                }
                const timestampToUse = dateToUse ? new Date(dateToUse) : findLatestSmcTimestamp(new Date());
                return fetchSmcData(sourceConfig.id, timestampToUse).then(res => ({ key: sourceKey, data: res.data }));
            };

            const sourceKeys = (config.sources || []).length > 0 ? config.sources : [config.base_id];
            const sourcePromises = sourceKeys.map(getSourceData);

            if (config.comparison) {
                const baseTimestamp = dateToUse ? new Date(dateToUse) : findLatestSmcTimestamp(new Date());
                const timeshiftMs = (config.timeshift_hours || 24) * 60 * 60 * 1000;
                const pastTimestamp = new Date(baseTimestamp.getTime() - timeshiftMs);
                sourcePromises.push(fetchSmcData(config.base_id, pastTimestamp).then(res => ({ key: 'past_data', data: res.data })));
            }

            const sourceResults = await Promise.all(sourcePromises);
            const mergedData = new Map();

            sourceResults.forEach(result => {
                if (!result || !result.data) return;
                if (result.key === 'percentils') {
                    Object.keys(result.data).forEach(stationCode => {
                        if (!mergedData.has(stationCode)) mergedData.set(stationCode, { codi_estacio: stationCode });
                        mergedData.get(stationCode).percentils = result.data[stationCode];
                    });
                    return;
                }
                result.data.forEach(stationData => {
                    const stationId = stationData.codi_estacio || `${stationData.lat},${stationData.lon}`;
                    if (!mergedData.has(stationId)) mergedData.set(stationId, { nom: stationData.nom, lat: stationData.lat, lon: stationData.lon, codi_estacio: stationData.codi_estacio });
                    const station = mergedData.get(stationId);
                    if (result.key === 'past_data') {
                        station[result.key] = parseFloat(stationData.valor);
                    } else if (result.key === 'wind' || result.key === 'wind_gust') {
                        station[result.key] = stationData;
                    } else {
                        station[result.key] = parseFloat(stationData.valor || stationData.valor_lectura);
                    }
                });
            });

            const finalData = [];
            mergedData.forEach(station => {
                let finalValue = null;
                if (config.comparison) {
                    const nowKey = Object.keys(VARIABLES_CONFIG).find(key => VARIABLES_CONFIG[key].id === config.base_id && !VARIABLES_CONFIG[key].summary);
                    const nowValue = station[nowKey]; const pastValue = station['past_data'];
                    if (nowValue !== undefined && pastValue !== undefined) finalValue = nowValue - pastValue;
                } else {
                    const hasAllData = (config.sources || []).every(key => station[key] !== undefined);
                    if (hasAllData) finalValue = config.calculation(station);
                }
                if (finalValue !== null && !isNaN(finalValue)) finalData.push({ ...station, valor: finalValue });
            });
            return finalData;
        }

        // === Lògica per a vent simple ===
        if (config.isSimpleWind) {
            const dataType = (config.base_id === 30) ? 'speed' : 'gust';
            const timestampToUse = dateToUse ? new Date(dateToUse) : findLatestSmcTimestamp(new Date());
            const windData = await fetchAllWindData(dataType, timestampToUse);
            return windData.map(d => ({ ...d, valor: d.speed_ms * config.conversion }));
        }

        // === Lògica per defecte per a variables instantànies ===
        const timestampToUse = dateToUse ? new Date(dateToUse) : findLatestSmcTimestamp(new Date());
        const result = await fetchSmcData(config.id, timestampToUse);
        return (result.data || []).map(d => ({ ...d, valor: parseFloat(d.valor) }));
    }

    async function generateDataTable() {
        if (!currentVariableKey) {
            tablesContent.innerHTML = '<p>Si us plau, selecciona primer una variable del menú per veure les dades.</p>';
            copyBtn.style.display = 'none';
            return;
        }
        tablesContent.innerHTML = '<p>Carregant dades de les estacions visibles...</p>';
        const config = VARIABLES_CONFIG[currentVariableKey];
        const mapBounds = map.getBounds();

        const allStationsData = await fetchDataForCurrentVariable();

        const visibleStations = allStationsData.filter(station => station.lat && station.lon && mapBounds.contains(L.latLng(station.lat, station.lon)));

        if (visibleStations.length === 0) {
            tablesContent.innerHTML = '<p>No hi ha estacions visibles en aquesta zona del mapa per a la variable seleccionada.</p>';
            copyBtn.style.display = 'none';
            sortedVisibleStations = [];
            return;
        }

        visibleStations.sort((a, b) => {
            let valA, valB;
            if (currentSortBy === 'nom') {
                valA = a.nom.toLowerCase(); valB = b.nom.toLowerCase();
            } else {
                valA = a.valor; valB = b.valor;
                if (valA === null || typeof valA === 'undefined' || isNaN(valA)) return 1;
                if (valB === null || typeof valB === 'undefined' || isNaN(valB)) return -1;
            }
            if (valA < valB) return currentSortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return currentSortDirection === 'asc' ? 1 : -1;
            return 0;
        });

        sortedVisibleStations = visibleStations;
        copyBtn.style.display = 'block';

        const nomHeaderClass = `sortable ${currentSortBy === 'nom' ? 'sorted-' + currentSortDirection : ''}`;
        const valorHeaderClass = `sortable ${currentSortBy === 'valor' ? 'sorted-' + currentSortDirection : ''}`;
        let tableHTML = `<table><thead><tr><th class="${nomHeaderClass}" data-sort-by="nom">Estació</th><th class="${valorHeaderClass}" data-sort-by="valor">${config.name} (${config.unit})</th></tr></thead><tbody>`;

        visibleStations.forEach(station => {
            const formattedValue = (station.valor !== null && typeof station.valor !== 'undefined') ? formatValueForLabel(station.valor, config.decimals) : 'N/D';
            tableHTML += `<tr><td>${station.nom}</td><td>${formattedValue}</td></tr>`;
        });

        tableHTML += '</tbody></table>';
        tablesContent.innerHTML = tableHTML;
    }

    // ===== MODIFICACIÓ CLAU: AFEGIM EL REFresc AUTOMÀTIC A L'EVENT DEL MENÚ PRINCIPAL =====
    const menuControls = document.getElementById('meteo-controls');
    if (menuControls) {
        menuControls.addEventListener('click', () => {
            // Esperem un instant perquè la variable 'currentVariableKey' s'actualitzi
            setTimeout(() => {
                if (tablesPanel.style.display === 'flex') {
                    generateDataTable();
                }
            }, 100);
        });
    }

    tablesBtn.addEventListener('click', (e) => {
        e.preventDefault();
        currentSortBy = 'valor';
        currentSortDirection = 'desc';
        tablesPanel.style.display = 'flex';
        generateDataTable();
    });

    closeTablesBtn.addEventListener('click', () => {
        tablesPanel.style.display = 'none';
    });

    tablesContent.addEventListener('click', (e) => {
        const header = e.target.closest('th[data-sort-by]');
        if (!header) return;
        const sortBy = header.dataset.sortBy;
        if (currentSortBy === sortBy) {
            currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortBy = sortBy;
            currentSortDirection = (sortBy === 'valor') ? 'desc' : 'asc';
        }
        generateDataTable();
    });

    copyBtn.addEventListener('click', () => {
        if (sortedVisibleStations.length === 0) return;
        const config = VARIABLES_CONFIG[currentVariableKey];
        const top5Stations = sortedVisibleStations.slice(0, 5);
        let textToCopy = `#Projecte4Estacions\n\n📊 ${config.name}:\n`;
        top5Stations.forEach(station => {
            const formattedValue = formatValueForLabel(station.valor, config.decimals);
            textToCopy += `${station.nom} - ${formattedValue} ${config.unit}\n`;
        });
        navigator.clipboard.writeText(textToCopy).then(() => {
            const originalText = copyBtn.innerHTML;
            copyBtn.innerHTML = "✅ Copiat!";
            copyBtn.style.backgroundColor = '#17a2b8';
            setTimeout(() => {
                copyBtn.innerHTML = originalText;
                copyBtn.style.backgroundColor = '#28a745';
            }, 2000);
        }).catch(err => console.error('Error en copiar les dades: ', err));
    });

    makeDraggable(tablesPanel, document.getElementById('tables-panel-header'));

    map.on('moveend', () => {
        if (tablesPanel.style.display === 'flex') {
            generateDataTable();
        }
    });

    // ======================================================
    // MISSIÓ ESPECIAL: CONTROL DE VELOCITAT I PANELL DRAGGABLE
    // ======================================================

    // 1. Lògica dels botons de velocitat
    // ======================================================
    // MISSIÓ ESPECIAL: CONTROL DE VELOCITAT CÍCLIC (3 en 1)
    // ======================================================

    const speedBtn = document.getElementById('speed-toggle-btn');

    // Definim els 3 estats de velocitat en ordre de cicle
    // Ordre: Normal -> Ràpid -> Lent -> (torna a començar)
    const speedStates = [
        { id: 'normal', delay: 130, icon: '🚶', label: 'Normal' },
        { id: 'fast', delay: 50, icon: '🐇', label: 'Ràpid' },
        { id: 'slow', delay: 400, icon: '🐢', label: 'Lent' }
    ];

    let currentSpeedIndex = 0; // Comencem amb 'normal' (posició 0 de l'array)

    if (speedBtn) {
        speedBtn.addEventListener('click', () => {
            // 1. Passem al següent estat (fent la volta amb el mòdul %)
            currentSpeedIndex = (currentSpeedIndex + 1) % speedStates.length;
            const newState = speedStates[currentSpeedIndex];

            // 2. Apliquem la velocitat
            animationSpeed = newState.delay;

            // 3. Actualitzem la icona i el títol del botó
            speedBtn.innerText = newState.icon;
            speedBtn.title = `Velocitat: ${newState.label}`;

            // Opcional: Efecte visual petit al clicar
            speedBtn.style.transform = "scale(0.9)";
            setTimeout(() => speedBtn.style.transform = "scale(1)", 100);

            console.log(`Velocitat canviada a: ${newState.label} (${newState.delay}ms)`);
        });
    }

    // 2. Fer draggable el panell de l'hora
    // IMPORTANT: Canvia 'time-display-panel' per l'ID real del DIV que conté l'hora
    const timePanel = document.getElementById('plujaoneu-text')?.parentElement || document.getElementById('time-display-container');

    if (timePanel) {
        // Li donem estil per indicar que es pot moure
        timePanel.style.cursor = 'move';
        timePanel.title = "Arrossega'm!";

        // Utilitzem la teva funció makeDraggable existent
        makeDraggable(timePanel);
        console.log("Panell de l'hora activat per arrossegar!");
    } else {
        console.warn("No s'ha trobat el panell de l'hora per fer-lo draggable. Revisa l'ID.");
    }

    // ===================================================================
    // NOU: Lògica per al panell de control del vent
    // ===================================================================

    const windControlsPanel = document.getElementById('wind-controls-panel');

    convergencesLayer.on('add', function () {
        startWindLayer(historicModeTimestamp);
        windControlsPanel.style.display = 'block';
        scheduleNextWindUpdate();
    });

    convergencesLayer.on('remove', function () {
        windControlsPanel.style.display = 'none';
    });

    const windControlsContent = document.getElementById('wind-controls-content');
    const minimizeBtn = document.getElementById('minimize-wind-controls');

    // Fem que el panell sigui arrossegable des de la capçalera
    if (windControlsPanel && document.getElementById('wind-controls-header')) {
        makeDraggable(windControlsPanel, document.getElementById('wind-controls-header'));
    }

    document.getElementById('close-wind-controls').addEventListener('click', () => {
        windControlsPanel.style.display = 'none';
    });

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            const isMinimized = windControlsPanel.classList.toggle('minimized');
            windControlsContent.style.display = isMinimized ? 'none' : 'flex';
            minimizeBtn.textContent = isMinimized ? '+' : '−';

            // Si estem maximitzant, eliminem l'amplada fixa que hagi pogut posar el draggable
            if (!isMinimized) {
                windControlsPanel.style.removeProperty('width');
            }
        });
    }

    // 1. Botons de TIPUS (Mitjana vs Ratxes)
    document.querySelectorAll('.wind-type-btn').forEach(button => {
        button.addEventListener('click', function () {
            windDataType = this.dataset.type;
            document.querySelectorAll('.wind-type-btn').forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');

            // ★ CORRECCIÓ: Passem la data històrica si existeix ★
            startWindLayer(historicModeTimestamp);
        });
    });

    // 2. Botons de COLOR i MODE
    document.querySelectorAll('.wind-mode-btn').forEach(button => {
        button.addEventListener('click', function () {
            windAnimationMode = this.dataset.mode;
            document.querySelectorAll('.wind-mode-btn').forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');
            refreshWindLayer();
        });
    });

    document.querySelectorAll('.wind-color-btn').forEach(button => {
        button.addEventListener('click', function () {
            windColorOption = this.dataset.color;
            document.querySelectorAll('.wind-color-btn').forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');

            // ★ CORRECCIÓ: Passem la data històrica si existeix ★
            startWindLayer(historicModeTimestamp);
        });
    });

    // 3. Sliders de PARTÍCULES, ESCALA, EDAT I GRUIX
    const multiplierSlider = document.getElementById('wind-multiplier-slider');
    const multiplierVal = document.getElementById('wind-multiplier-val');
    multiplierSlider.addEventListener('input', function () {
        windParticleMultiplier = parseInt(this.value);
        multiplierVal.textContent = windParticleMultiplier;
        refreshWindLayer(); // <--- REPINTRAR SENSE FETCH
    });

    const scaleSlider = document.getElementById('wind-scale-slider');
    const scaleVal = document.getElementById('wind-scale-val');
    scaleSlider.addEventListener('input', function () {
        windVelocityScale = parseFloat(this.value);
        scaleVal.textContent = windVelocityScale.toFixed(3);
        refreshWindLayer();
    });

    const ageSlider = document.getElementById('wind-age-slider');
    const ageVal = document.getElementById('wind-age-val');
    ageSlider.addEventListener('input', function () {
        windParticleAge = parseInt(this.value);
        ageVal.textContent = windParticleAge;
        refreshWindLayer();
    });

    const widthSlider = document.getElementById('wind-width-slider');
    const widthVal = document.getElementById('wind-width-val');
    widthSlider.addEventListener('input', function () {
        windLineWidth = parseFloat(this.value);
        widthVal.textContent = windLineWidth.toFixed(1);
        refreshWindLayer();
    });

    // Fem que el panell es pugui arrossegar
    makeDraggable(windControlsPanel, document.getElementById('wind-controls-header'));

    // ===================================================================
    // FI DE LA NOVA CAPA DE VENT
    // ===================================================================

    // ===================================================================
    // NOU: Lògica per al panell d'estils GeoJSON
    // ===================================================================

    const geoJsonStylePanel = document.getElementById('geojson-style-panel');
    const layerNameLabel = document.getElementById('geojson-layer-name');
    const colorPicker = document.getElementById('geojson-color-picker');
    const weightSlider = document.getElementById('geojson-weight-slider');
    const weightValueLabel = document.getElementById('geojson-weight-value');
    const opacitySlider = document.getElementById('geojson-opacity-slider');
    const opacityValueLabel = document.getElementById('geojson-opacity-value');
    const closeGeoJsonBtn = document.getElementById('close-geojson-style');

    // Funció que llegeix els controls i actualitza la capa activa
    function updateActiveGeoJsonStyle() {
        if (!activeGeoJsonLayer) return;

        const newColor = colorPicker.value;
        const newWeight = parseFloat(weightSlider.value);
        const newOpacity = parseFloat(opacitySlider.value);

        // Actualitzem les etiquetes dels sliders
        weightValueLabel.textContent = newWeight.toFixed(1);
        opacityValueLabel.textContent = Math.round(newOpacity * 100);

        // Apliquem l'estil a la capa de Leaflet
        activeGeoJsonLayer.setStyle({
            color: newColor,
            weight: newWeight,
            opacity: newOpacity
        });
    }

    // Funció per mostrar i configurar el panell
    function showGeoJsonPanel(layer, name) {
        activeGeoJsonLayer = layer;
        layerNameLabel.textContent = name;

        // Llegim l'estil actual de la capa (si en té)
        const currentStyle = layer.options.style || {};
        colorPicker.value = currentStyle.color || '#333333';
        weightSlider.value = currentStyle.weight || 1;
        opacitySlider.value = currentStyle.opacity || 1;

        // Actualitzem les etiquetes
        weightValueLabel.textContent = weightSlider.value;
        opacityValueLabel.textContent = Math.round(opacitySlider.value * 100);

        geoJsonStylePanel.style.display = 'block';
    }

    // Connectem els controls a la funció d'actualització
    colorPicker.addEventListener('input', updateActiveGeoJsonStyle);
    weightSlider.addEventListener('input', updateActiveGeoJsonStyle);
    opacitySlider.addEventListener('input', updateActiveGeoJsonStyle);

    // NOU: Lògica per als botons de color ràpid
    document.querySelectorAll('.quick-color-btn').forEach(button => {
        button.addEventListener('click', function () {
            const color = this.dataset.color;

            // 1. Actualitzem el selector de color principal
            colorPicker.value = color;

            // 2. Cridem a la funció que actualitza el mapa
            updateActiveGeoJsonStyle();
        });
    });

    // Botó de tancar
    closeGeoJsonBtn.addEventListener('click', () => {
        geoJsonStylePanel.style.display = 'none';
        activeGeoJsonLayer = null; // Deixem d'editar
    });

    // Fem que el panell sigui arrossegable
    makeDraggable(geoJsonStylePanel, document.getElementById('geojson-style-header'));

    // ===================================================================
    // NOU (PAS 3): Lògica per al panell d'Opacitat General
    // ===================================================================

    const opacityPanel = document.getElementById('opacity-panel');
    const toggleOpacityBtn = document.getElementById('toggle-opacity-panel-btn');
    const closeOpacityBtn = document.getElementById('close-opacity-panel');
    const radarSlider = document.getElementById('radar-opacity-slider');
    const radarValueLabel = document.getElementById('radar-opacity-value');
    const labelsSlider = document.getElementById('labels-opacity-slider');
    const labelsValueLabel = document.getElementById('labels-opacity-value');
    const labelSizeSlider = document.getElementById('label-size-slider');
    const labelSizeValue = document.getElementById('label-size-value');

    // Carregar tamany guardat
    const savedLabelScale = localStorage.getItem('stationLabelScale') || '1.0';
    document.documentElement.style.setProperty('--station-label-scale', savedLabelScale);
    if (labelSizeSlider) {
        labelSizeSlider.value = savedLabelScale;
        labelSizeValue.textContent = savedLabelScale;
    }

    // Llista de totes les capes de "radar" o mapes de temps que vols controlar
    const allRadarLayers = [
        plujaneu_layer,
        radar_layer,
        windy_radar_layer,
        rainviewer_layer,
        cappi_intern_layer,
        cappi_llarg_abast_layer,
        proRadarLayers.eurad,
        proRadarLayers.frcomp
        // Nota: Les capes de satèl·lit ja tenen el seu propi control
    ];

    // Botó per obrir/tancar el panell des del menú lateral
    toggleOpacityBtn.addEventListener('click', () => {
        const isVisible = opacityPanel.style.display === 'block';
        opacityPanel.style.display = isVisible ? 'none' : 'block';
    });

    // Botó per tancar el panell (la 'X')
    closeOpacityBtn.addEventListener('click', () => {
        opacityPanel.style.display = 'none';
    });

    // Slider del Radar
    radarSlider.addEventListener('input', () => {
        const newOpacity = parseFloat(radarSlider.value);
        radarValueLabel.textContent = Math.round(newOpacity * 100);

        // Apliquem l'opacitat a totes les capes de la llista
        allRadarLayers.forEach(layer => {
            // Comprovem si la capa té un mètode setOpacity (capes de Tile)
            if (typeof layer.setOpacity === 'function') {
                layer.setOpacity(newOpacity);
            }
            // Comprovem si és un LayerGroup (com les capes graella)
            else if (typeof layer.eachLayer === 'function') {
                layer.eachLayer(function (sublayer) {
                    if (typeof sublayer.setOpacity === 'function') {
                        sublayer.setOpacity(newOpacity);
                    }
                });
            }
        });
    });

    // Slider de les Etiquetes
    labelsSlider.addEventListener('input', () => {
        const newOpacity = parseFloat(labelsSlider.value);
        labelsValueLabel.textContent = Math.round(newOpacity * 100);

        // Totes les etiquetes (números, barbes) viuen al 'markerPane' i 'shadowPane'.
        // Canviant l'opacitat del 'pane', les afectem a totes.
        const markerPane = map.getPane('markerPane');
        if (markerPane) {
            markerPane.style.opacity = newOpacity;
        }
    });

    // Slider del Tamany de les Etiquetes
    if (labelSizeSlider) {
        labelSizeSlider.addEventListener('input', () => {
            const newScale = labelSizeSlider.value;
            labelSizeValue.textContent = newScale;
            document.documentElement.style.setProperty('--station-label-scale', newScale);
            localStorage.setItem('stationLabelScale', newScale);
        });
    }

    // Fem el panell arrossegable
    makeDraggable(opacityPanel, document.getElementById('opacity-panel-header'));

    // ===================================================================
    // NOU: Lògica per al panell de Filtres de Dades
    // ===================================================================

    const filterPanel = document.getElementById('filter-panel');
    const toggleFilterBtn = document.getElementById('toggle-filter-panel-btn');
    const closeFilterBtn = document.getElementById('close-filter-panel');

    const filterValueMin = document.getElementById('filter-value-min');
    const filterValueMax = document.getElementById('filter-value-max');
    const filterAltMin = document.getElementById('filter-altitude-min');
    const filterAltMax = document.getElementById('filter-altitude-max');

    const applyFiltersBtn = document.getElementById('apply-filters-btn');
    const resetFiltersBtn = document.getElementById('reset-filters-btn');

    // Botó per obrir/tancar el panell des del menú lateral
    toggleFilterBtn.addEventListener('click', () => {
        const isVisible = filterPanel.style.display === 'block';
        filterPanel.style.display = isVisible ? 'none' : 'block';
    });

    // Botó per tancar el panell (la 'X')
    closeFilterBtn.addEventListener('click', () => {
        filterPanel.style.display = 'none';
    });

    // Botó d'APLICAR
    applyFiltersBtn.addEventListener('click', () => {
        // 1. Llegim els valors dels inputs
        activeDataFilters.valueMin = filterValueMin.value ? parseFloat(filterValueMin.value) : null;
        activeDataFilters.valueMax = filterValueMax.value ? parseFloat(filterValueMax.value) : null;
        activeDataFilters.altMin = filterAltMin.value ? parseFloat(filterAltMin.value) : null;
        activeDataFilters.altMax = filterAltMax.value ? parseFloat(filterAltMax.value) : null;

        console.log("Filtres aplicats:", activeDataFilters);

        // 2. Refresquem la capa de dades actual amb els filtres nous
        refreshCurrentVariableView();
    });

    // Botó de NETEJAR
    resetFiltersBtn.addEventListener('click', () => {
        // 1. Resetejem els valors dels inputs
        filterValueMin.value = '';
        filterValueMax.value = '';
        filterAltMin.value = '';
        filterAltMax.value = '';

        // 2. Resetejem l'objecte global
        activeDataFilters = { valueMin: null, valueMax: null, altMin: null, altMax: null };

        console.log("Filtres netejats.");

        // 3. Refresquem la capa de dades actual
        refreshCurrentVariableView();
    });

    // Fem el panell arrossegable
    makeDraggable(filterPanel, document.getElementById('filter-panel-header'));

    map.on('overlayadd', function (e) {
        if (e.name === 'Temperatura Màxima') {
            mostrarMapaTemperaturaPNG();
        }

        // Si la capa activada és una de satèl·lit individual
        if (allSatelliteLayers.includes(e.layer)) {
            activeSatelliteLayer = e.layer;
            satelliteControls.style.display = 'flex';
            updateOpacity();
        }
        if (e.layer === realtimeLightningManager.layerGroup) {
            stopAllDataLayers(); // Atura altres dades (ex: temp.)
            realtimeLightningManager.start(); // Inicia els llamps
            createLightningPopup(); // Mostra el panell d'opcions
        }

        // --- NOU BLOC PER AL PANELL D'ESTILS ---
        if (e.layer === comarquesLayer) {
            showGeoJsonPanel(e.layer, "Comarques");
        } else if (e.layer === municipisGeojsonLayer) {
            showGeoJsonPanel(e.layer, "Municipis");
        } else if (e.layer === monLayer) {
            showGeoJsonPanel(e.layer, "Món (Detall)");
        } else if (e.layer === contornMonGeolayer) {
            showGeoJsonPanel(e.layer, "Món");
        }
        // --- FI DEL NOU BLOC ---
    });

    map.on('overlayremove', function (e) {
        if (e.name === 'Temperatura Màxima') {
            amagarMapaTemperaturaPNG();
        }

        // Si la capa desactivada és una de satèl·lit individual
        if (allSatelliteLayers.includes(e.layer) && activeSatelliteLayer === e.layer) {
            satelliteControls.style.display = 'none';
            activeSatelliteLayer = null;
        }

        if (e.layer === realtimeLightningManager.layerGroup) {
            realtimeLightningManager.stop();
        }

        // --- NOU BLOC PER AL PANELL D'ESTILS ---
        // Si la capa que tanquem és la que estàvem editant, amaguem el panell
        if (e.layer === activeGeoJsonLayer) {
            geoJsonStylePanel.style.display = 'none';
            activeGeoJsonLayer = null;
        }
        // --- FI DEL NOU BLOC ---
    });

});

// ===================================================================
// BLOC FINAL PER A LA CAPA DE TEMPERATURA PNG
// Enganxa tot aquest bloc al teu pluja_neu.js
// ===================================================================

// Variable global per a guardar la capa
let capaTemperaturaPNG = null;

// Funció per a mostrar el mapa PNG
async function mostrarMapaTemperaturaPNG() {
    if (capaTemperaturaPNG && map.hasLayer(capaTemperaturaPNG)) {
        map.removeLayer(capaTemperaturaPNG);
    }
    try {
        console.log("Carregant límits del mapa de temperatura...");
        const cacheBuster = `?v=${new Date().getTime()}`;
        const response = await fetch(`mapa_temperatura_bounds.json${cacheBuster}`);
        if (!response.ok) {
            throw new Error('No s\'ha pogut carregar el fitxer de límits (bounds).');
        }
        const imageBounds = await response.json();
        const imageUrl = `mapa_tmin.png${cacheBuster}`;

        console.log("Mostrant la capa PNG de temperatura.");
        capaTemperaturaPNG = L.imageOverlay(imageUrl, imageBounds, {
            opacity: 0.9,
            interactive: false
        }).addTo(map);

        capaTemperaturaPNG.bringToFront();
    } catch (error) {
        console.error("Error al mostrar el mapa de temperatura PNG:", error);
    }
}

// Funció per a amagar el mapa PNG
function amagarMapaTemperaturaPNG() {
    if (capaTemperaturaPNG && map.hasLayer(capaTemperaturaPNG)) {
        map.removeLayer(capaTemperaturaPNG);
        console.log("Capa PNG de temperatura amagada.");
    }
}

// ===================================================================
// GESTORS FINALS I UNIFICATS PER AL CONTROL D'OPACITAT (VERSIÓ CORREGIDA)
// ===================================================================

const allSatelliteLayers = [
    eumetsatLayer,
    eumetsat_ir_layer,
    eumetsat_hrvis_layer,
    ...Object.values(satelliteMenuLayers)
];

// ===================================================================
// SISTEMA DE GRÀFICS (VERSIÓ FINAL + VENT EN KM/H I COLORS)
// ===================================================================

let activeChartInstance = null;
let modalChartInstance = null;

// Plugin personalitzat per dibuixar Barbes de Vent al gràfic
const windBarbChartPlugin = {
    id: 'windBarbs',
    afterDatasetsDraw: (chart, args, options) => {
        const ctx = chart.ctx;
        const meta = chart.getDatasetMeta(0);
        const data = meta.data;
        const windData = chart.data.datasets[0].windData;

        if (!windData) return;

        ctx.save();
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1.2; // Línia una mica més fina (era 1.5)

        // Decimació intel·ligent
        const step = Math.max(1, Math.floor(data.length / (chart.width / 30)));

        data.forEach((point, index) => {
            if (index % step !== 0) return;

            const wd = windData[index];
            if (!wd || wd.dir === undefined || wd.speedMs === undefined) return;

            const x = point.x;
            // Les apropem una mica més a la línia (era -15)
            const y = point.y - 12;

            const speedKnots = wd.speedMs * 1.94384;
            const direction = wd.dir;

            drawCanvasWindBarb(ctx, x, y, speedKnots, direction);
        });

        ctx.restore();
    }
};

// Funció auxiliar de dibuix al Canvas (VERSIÓ REDUÏDA "PETITONETES")
function drawCanvasWindBarb(ctx, x, y, knots, direction) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((direction + 180) * Math.PI / 180);

    // Tija principal (Shaft) - Més curta (18px en lloc de 25px)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 18);
    ctx.stroke();

    // Comencem a dibuixar des de dalt de la tija
    let p = { x: 0, y: 18 };
    let remainingKnots = Math.round(knots / 5) * 5;

    // Triangles (50 nusos) - Més compactes
    while (remainingKnots >= 50) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 7, p.y - 2.5); // Més estret
        ctx.lineTo(p.x, p.y - 5);
        ctx.fill();
        p.y -= 6; // Menys espai entre símbols
        remainingKnots -= 50;
    }
    // Barbes llargues (10 nusos) - Més curtes
    while (remainingKnots >= 10) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 8, p.y + 3); // Curta i inclinada
        ctx.stroke();
        p.y -= 3.5; // Espaiat ajustat
        remainingKnots -= 10;
    }
    // Barbes curtes (5 nusos) - La meitat
    if (remainingKnots >= 5) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 4, p.y + 1.5);
        ctx.stroke();
    }

    ctx.restore();
}

// ======================================================
// 1. DEFINICIÓ D'ESCALES DE COLORS (POSA-HO A L'INICI)
// ======================================================

// Escala per a ACUMULACIÓ DIÀRIA (La línia dent de serra)
const valors_diaria_arr = [0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 100, 150, 200];
const colors_diaria_arr = [
    "#a1d3fc", "#51b5fa", "#0095f9", "#106e2b", "#008126", "#00c42c", "#44e534",
    "#8fd444", "#91ea32", "#ffee47", "#ecd336", "#fd5523", "#ff7235", "#ff9a67", "#ff486f",
    "#ff214e", "#c30617", "#85030f", "#5b1670", "#bd30f3", "#bd30f3"
];

// Escala per a PRECIPITACIÓ SEMIHORÀRIA (Les barres)
// Basada en la teva funció getSemihorariaPrecipColor
const valors_semi_arr = [0.1, 1, 2.5, 5, 10, 15, 25, 40];
const colors_semi_arr = [
    '#ddddddff', // <= 0.1
    "#a1d3fc", // < 1
    "#51b5fa", // < 2.5
    "#0095f9", // < 5
    "#00c42c", // < 10
    "#ffee47", // < 15
    "#ff7235", // < 25
    "#ff214e", // < 40
    "#bd30f3"  // > 40
];

// Funció auxiliar per mantenir la teva lògica de barres individuals
function getIntensityColor(mm) {
    if (mm <= 0.1) return '#ddddddff';
    if (mm < 1) return "#a1d3fc";
    if (mm < 2.5) return "#51b5fa";
    if (mm < 5) return "#0095f9";
    if (mm < 10) return "#00c42c";
    if (mm < 15) return "#ffee47";
    if (mm < 25) return "#ff7235";
    if (mm < 40) return "#ff214e";
    return "#bd30f3";
}

// Funció per obtenir el gradient vertical de la pluja acumulada
function getPrecipitationGradient(ctx, chartArea, scales) {
    if (!chartArea) return '#0095f9';
    const yAxis = scales.y;
    // Evitem errors si maxScale és 0 o undefined
    const maxVal = yAxis.max || 1;
    const maxScale = Math.max(maxVal, 0.1);

    // Gradient de baix (0) a dalt (max)
    // Nota: En Canvas, y=0 és dalt. Però getPixelForValue gestiona la conversió.
    const gradient = ctx.createLinearGradient(0, yAxis.getPixelForValue(0), 0, yAxis.getPixelForValue(maxScale));

    // Color base (0mm)
    gradient.addColorStop(0, colors_diaria_arr[0]);

    for (let i = 0; i < valors_diaria_arr.length; i++) {
        const val = valors_diaria_arr[i];
        const col = colors_diaria_arr[i];
        let offset = val / maxScale;

        // Només afegim el color si cau dins del rang visual del gràfic (0 a 1)
        if (offset >= 0 && offset <= 1) {
            gradient.addColorStop(offset, col);
        }
    }
    return gradient;
}

async function loadStationChart(codiEstacio, variableId, canvasId, variableName, hours = 24, isModal = false, useGradient = false, conversionFactor = 1, config = {}, targetDate = null) {
    const ctxCanvas = document.getElementById(canvasId);
    if (!ctxCanvas) return;

    // Gestió d'instàncies de ChartJS al Dashboard per no esborrar-les
    if (canvasId.startsWith('dash-chart-')) {
        if (!window.dashCharts) window.dashCharts = {};
        if (window.dashCharts[canvasId]) {
            window.dashCharts[canvasId].destroy();
        }
    } else {
        // Neteja instàncies anteriors
        if (isModal) {
            if (modalChartInstance) { modalChartInstance.destroy(); modalChartInstance = null; }
        } else {
            if (activeChartInstance) { activeChartInstance.destroy(); activeChartInstance = null; }
        }
    }

    // Loader
    const parent = ctxCanvas.parentElement;
    parent.querySelectorAll('.chart-loader').forEach(e => e.remove());
    const loader = document.createElement('div');
    loader.className = 'chart-loader';
    loader.innerHTML = '⏳ Carregant...';
    loader.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); font-size:12px; background:rgba(255,255,255,0.9); padding:5px 10px; border-radius:4px; pointer-events:none; box-shadow:0 2px 4px rgba(0,0,0,0.1);';
    parent.appendChild(loader);

    // --- 1. IDENTIFICACIÓ DE VARIABLES ---
    const varIdNum = Number(variableId);

    // Identificadors bàsics
    const isDailyAccumulation = (varIdNum === 35 && (config.summary === 'sum' || config.isDailyAccumulation));
    const isSemiHourlyPrecip = (varIdNum === 35 && !isDailyAccumulation);
    const isIntensity = (varIdNum === 72);
    const isAccumulation12UTC = (isSemiHourlyPrecip && config.accumulateFrom12UTC === true);

    const isTemp = (varIdNum == 32 || varIdNum == 40 || varIdNum == 42);
    const isHumidity = (varIdNum == 33 || varIdNum == 3 || varIdNum == 44);
    const isPressure = (varIdNum == 34 || varIdNum == 1 || varIdNum == 2);
    const isSnowDepth = (varIdNum == 38 && !config.comparison); // Gruix absolut

    // ★ NOU: Detectem si és una variació de neu (tendència)
    const isSnowVariation = (varIdNum == 38 && config.comparison === 'instant');

    const isWind = (typeof WIND_DIR_RELATION !== 'undefined' && WIND_DIR_RELATION.hasOwnProperty(varIdNum)) || config.isWind;

    // --- 2. CÀLCUL DE DATES (MODE HISTÒRIC O LIVE) ---
    const referenceDate = targetDate ? new Date(targetDate) : new Date();
    let startDate = new Date(referenceDate);

    // Si necessitem calcular diferències (variació neu) o acumulats, agafem marge extra
    if (isDailyAccumulation || isAccumulation12UTC || isSnowVariation) {
        const daysToFetch = Math.ceil(hours / 24) + 1;
        startDate.setUTCHours(0, 0, 0, 0);
        startDate.setUTCDate(startDate.getUTCDate() - daysToFetch);
    } else {
        startDate.setHours(startDate.getHours() - hours);
    }
    const isoStart = startDate.toISOString().slice(0, 19) + '.000';

    // --- 3. FETCH DE DADES ---
    const isSumatoriChart = config.isSumatoriChart === true;

    // Si és sumatori de precipitació de diversos dies, fem una crida específica agrupada per dies
    if (isSumatoriChart) {
        const sumIsoStart = config.sumStartDate.toISOString().slice(0, 19);
        const endDay = new Date(config.sumEndDate);
        endDay.setUTCHours(23, 59, 59, 999);
        const sumIsoEnd = endDay.toISOString().slice(0, 19);

        // Agafem dades de la variable 35 agrupades per dia (ja hi ha un gruix calculat per l'API de fallback)
        const urlSumatori = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT%20date_trunc_ymd(data_lectura)%20as%20dia,sum(valor_lectura)%20as%20valor%20WHERE%20codi_estacio='${codiEstacio}'%20AND%20codi_variable='35'%20AND%20data_lectura%20>=%20'${sumIsoStart}'%20AND%20data_lectura%20<=%20'${sumIsoEnd}'%20GROUP%20BY%20dia&_=${Date.now()}`;

        try {
            const sumData = await $.getJSON(urlSumatori);
            loader.remove();

            if (!sumData || sumData.length === 0) {
                const ctx = ctxCanvas.getContext('2d');
                ctxCanvas.width = ctxCanvas.clientWidth; ctxCanvas.height = ctxCanvas.clientHeight;
                ctx.clearRect(0, 0, ctxCanvas.width, ctxCanvas.height);
                ctx.font = "bold 14px Arial"; ctx.fillStyle = "#888"; ctx.textAlign = "center";
                ctx.fillText("Sense dades disponibles", ctxCanvas.width / 2, ctxCanvas.height / 2);
                return;
            }

            const labels = [];
            const values = [];
            const barColors = [];

            sumData.forEach(d => {
                const dateObj = new Date(d.dia);
                const diaStr = String(dateObj.getDate()).padStart(2, '0');
                const mesStr = String(dateObj.getMonth() + 1).padStart(2, '0');
                labels.push(`${diaStr}/${mesStr}`);

                const val = parseFloat(d.valor);
                values.push(val);
                barColors.push(getPrecipitationSumColor(val));
            });

            // Configuració del gràfic de barres per dies
            const datasetConfig = {
                type: 'bar',
                label: 'Precipitació (mm)',
                data: values,
                backgroundColor: barColors,
                borderColor: barColors,
                borderWidth: 1,
                barPercentage: 0.8,
                categoryPercentage: 0.9,
            };

            const chartConfigOptions = {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [datasetConfig]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 500 },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) { return `${context.parsed.y.toFixed(1)} mm`; }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: 'rgba(200, 200, 200, 0.2)' },
                            title: { display: true, text: 'mm' }
                        },
                        x: {
                            grid: { display: false }
                        }
                    }
                }
            };

            const newChart = new Chart(ctxCanvas, chartConfigOptions);

            if (isModal) {
                modalChartInstance = newChart;
            } else if (canvasId.startsWith('dash-chart')) {
                window.dashCharts[canvasId] = newChart;
            } else {
                activeChartInstance = newChart;
            }
            return; // Acabem aquí pel sumatori
        } catch (error) {
            console.error("Error carregant gràfic sumatori:", error);
            loader.innerHTML = 'Error de dades';
            return;
        }
    }

    // --- EXECUCIÓ NORMAL PER LES ALTRES VARIABLES ---

    // Si és neu, demanem la variable 38 tant si és gruix com variació
    const queryId = (isDailyAccumulation || isSemiHourlyPrecip) ? 35 : varIdNum;

    const urlMain = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT data_lectura, valor_lectura WHERE codi_estacio='${codiEstacio}' AND codi_variable='${queryId}' AND data_lectura >= '${isoStart}' ORDER BY data_lectura ASC LIMIT 8000&_=${Date.now()}`;

    try {
        const dataMain = await $.getJSON(urlMain);

        let windDirectionData = [];
        if (isWind && dataMain.length > 0) {
            const dirVarId = WIND_DIR_RELATION[varIdNum];
            if (dirVarId) {
                const urlDir = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?$query=SELECT data_lectura, valor_lectura WHERE codi_estacio='${codiEstacio}' AND codi_variable='${dirVarId}' AND data_lectura >= '${isoStart}' ORDER BY data_lectura ASC LIMIT 5000&_=${Date.now()}`;
                try { windDirectionData = await $.getJSON(urlDir); } catch (e) { }
            }
        }

        loader.remove();

        const hasObservations = (dataMain && dataMain.length > 0);
        const safeDataMain = hasObservations ? dataMain : [];

        const dirMap = new Map();
        if (isWind && windDirectionData) windDirectionData.forEach(d => dirMap.set(d.data_lectura, parseFloat(d.valor_lectura)));

        let labels = [];
        let values = [];
        const windExtraData = [];
        let barBackgroundColors = [];
        let barBorderColors = [];
        let isForecastArray = [];

        let currentSum = 0;
        let lastSeenDay = null;
        let lastSeenHour = null;

        const cutoffDate = new Date(referenceDate);
        cutoffDate.setHours(cutoffDate.getHours() - hours);

        // --- 4. PROCESSAMENT DE DADES ---
        safeDataMain.forEach(d => {
            const date = new Date(d.data_lectura);
            const valRaw = parseFloat(d.valor_lectura);
            let valToPush = valRaw * conversionFactor;

            // Lògica Acumulació
            if (isDailyAccumulation) {
                const currentDay = date.getUTCDate();
                if (lastSeenDay !== null && currentDay !== lastSeenDay) currentSum = 0;
                lastSeenDay = currentDay;
                currentSum += valRaw;
                valToPush = currentSum;
            } else if (isAccumulation12UTC) {
                const currentHourUTC = date.getUTCHours();
                if (lastSeenHour !== null && lastSeenHour < 12 && currentHourUTC >= 12) currentSum = 0;
                lastSeenHour = currentHourUTC;
                currentSum += valRaw;
                valToPush = currentSum;
            }

            // Nota: Per a la variació de neu, guardem TOTS els valors primer per calcular diferències després
            if (isSnowVariation || (date >= cutoffDate && date <= referenceDate)) {
                const dia = String(date.getDate()).padStart(2, '0');
                const hora = String(date.getHours()).padStart(2, '0');
                const min = String(date.getMinutes()).padStart(2, '0');

                // Si és variació, guardem la data completa per filtrar després
                labels.push(isSnowVariation ? date : ((hours > 24) ? `${dia} ${hora}:${min}` : `${hora}:${min}`));
                values.push(valToPush);
                isForecastArray.push(false);

                if (!isDailyAccumulation && !isSnowVariation && (isSemiHourlyPrecip || isIntensity)) {
                    const color = getIntensityColor(valToPush);
                    barBackgroundColors.push(color);
                    barBorderColors.push(color);
                }

                if (isWind) {
                    windExtraData.push({ speedMs: valOriginal = valRaw, dir: dirMap.get(d.data_lectura) });
                }
            }
        });

        // --- LOOKUP COORDINATES AND FETCH AROME FORECAST IF REQUESTED ---
        let lat = config.lat;
        let lon = config.lon;
        if (!lat || !lon) {
            const meta = typeof metadadesEstacions !== 'undefined' && metadadesEstacions.get(codiEstacio);
            if (meta && meta.coordenades) {
                lat = meta.coordenades.latitud;
                lon = meta.coordenades.longitud;
            }
        }

        if (config.showForecast && lat && lon) {
            try {
                let aromeVar = null;
                if (isTemp) {
                    aromeVar = 'temperature_2m';
                } else if (isHumidity) {
                    aromeVar = 'relative_humidity_2m';
                } else if (isPressure) {
                    aromeVar = 'pressure_msl';
                } else if (isWind) {
                    const isGust = (varIdNum === 50 || variableName.toLowerCase().includes('ratxa') || (config.name && config.name.toLowerCase().includes('ratxa')));
                    aromeVar = isGust ? 'wind_gusts_10m' : 'wind_speed_10m';
                } else if (isDailyAccumulation || isSemiHourlyPrecip || isIntensity) {
                    aromeVar = 'precipitation';
                } else if (isSnowDepth || isSnowVariation) {
                    aromeVar = 'snow_depth';
                }

                if (aromeVar) {
                    let aromeVars = [aromeVar];
                    if (isWind) {
                        aromeVars.push('wind_direction_10m');
                    }

                    let windUnitParam = '';
                    if (isWind) {
                        const isKmh = (conversionFactor > 1 || config.unit === 'km/h');
                        windUnitParam = isKmh ? '&wind_speed_unit=kmh' : '&wind_speed_unit=ms';
                    }

                    const aromeUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${aromeVars.join(',')}&models=arome_france&forecast_days=2&timezone=Europe%2FMadrid${windUnitParam}`;
                    const aromeRes = await $.getJSON(aromeUrl);
                    if (aromeRes && aromeRes.hourly) {
                        const times = aromeRes.hourly.time;
                        const valuesArome = aromeRes.hourly[aromeVar];
                        const dirsArome = isWind ? aromeRes.hourly.wind_direction_10m : null;

                        const lastHistDate = dataMain.length > 0 ? new Date(dataMain[dataMain.length - 1].data_lectura) : new Date();

                        let forecastSum = isDailyAccumulation ? currentSum : 0;
                        let lastSeenForecastDay = lastHistDate.getUTCDate();

                        for (let i = 0; i < times.length; i++) {
                            const fDate = new Date(times[i]);
                            if (fDate > lastHistDate) {
                                isForecastArray.push(true);

                                const dia = String(fDate.getDate()).padStart(2, '0');
                                const hora = String(fDate.getHours()).padStart(2, '0');
                                const min = String(fDate.getMinutes()).padStart(2, '0');
                                const label = isSnowVariation ? fDate : ((hours > 24) ? `${dia} ${hora}:${min}` : `${hora}:${min}`);

                                labels.push(label);

                                let val = parseFloat(valuesArome[i]);
                                if (isNaN(val)) val = 0;

                                if (isSnowDepth || isSnowVariation) {
                                    val = val * 100; // convert to cm
                                }

                                if (isDailyAccumulation) {
                                    const currentDay = fDate.getUTCDate();
                                    if (currentDay !== lastSeenForecastDay) {
                                        forecastSum = 0;
                                    }
                                    lastSeenForecastDay = currentDay;
                                    forecastSum += val;
                                    val = forecastSum;
                                }

                                values.push(val);

                                if (!isDailyAccumulation && !isSnowVariation && (isSemiHourlyPrecip || isIntensity)) {
                                    const baseColor = getIntensityColor(val);
                                    let forecastColor = baseColor;
                                    if (baseColor.startsWith('#')) {
                                        if (baseColor.length === 9) {
                                            forecastColor = baseColor.slice(0, 7) + '80';
                                        } else {
                                            forecastColor = baseColor + '80';
                                        }
                                    }
                                    barBackgroundColors.push(forecastColor);
                                    barBorderColors.push(baseColor);
                                }

                                if (isWind) {
                                    windExtraData.push({
                                        speedMs: val,
                                        dir: dirsArome ? parseFloat(dirsArome[i]) : 0
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Error fetching AROME forecast:", err);
            }
        }

        // ★★★ POST-PROCESSAMENT PER A VARIACIÓ DE NEU (Deltas) ★★★
        if (isSnowVariation) {
            const deltaValues = [];
            const deltaLabels = [];
            const newColors = [];
            const deltaIsForecast = [];

            // Comencem a 1 perquè necessitem l'anterior per restar
            for (let i = 1; i < values.length; i++) {
                const dateObj = labels[i]; // Recuperem l'objecte data que hem guardat abans

                // Només processem si està dins del rang visual
                if (dateObj >= cutoffDate && (dateObj <= referenceDate || config.showForecast)) {
                    const diff = values[i] - values[i - 1]; // Diferència amb el pas anterior (30min)

                    deltaValues.push(diff);
                    deltaIsForecast.push(isForecastArray[i]);

                    // Formatem l'etiqueta
                    const dia = String(dateObj.getDate()).padStart(2, '0');
                    const hora = String(dateObj.getHours()).padStart(2, '0');
                    const min = String(dateObj.getMinutes()).padStart(2, '0');
                    deltaLabels.push((hours > 24) ? `${dia} ${hora}:${min}` : `${hora}:${min}`);

                    // Assignem color segons si puja o baixa
                    let color = getSnowVariationColor(diff);
                    if (isForecastArray[i]) {
                        if (color.startsWith('#')) {
                            if (color.length === 9) {
                                color = color.slice(0, 7) + '80';
                            } else {
                                color = color + '80';
                            }
                        }
                    }
                    newColors.push(color);
                }
            }

            // Substituïm els arrays originals pels calculats
            values = deltaValues;
            labels = deltaLabels;
            barBackgroundColors = newColors;
            barBorderColors = newColors;
        }

        if (labels.length === 0) {
            const ctx = ctxCanvas.getContext('2d');
            ctxCanvas.width = ctxCanvas.clientWidth; ctxCanvas.height = ctxCanvas.clientHeight;
            ctx.clearRect(0, 0, ctxCanvas.width, ctxCanvas.height);
            ctx.font = "bold 14px Arial"; ctx.fillStyle = "#888"; ctx.textAlign = "center";
            ctx.fillText("Sense dades disponibles", ctxCanvas.width / 2, ctxCanvas.height / 2);
            return;
        }


        // --- 5. CONFIGURACIÓ DEL GRÀFIC ---
        let datasetConfig = {
            label: variableName,
            data: values,
            windData: windExtraData,
            borderWidth: (isModal && !canvasId.startsWith('dash-chart')) ? 2.5 : 2,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 6,
            forecastStartIndex: isForecastArray.indexOf(true),
            segment: {
                borderDash: (ctx) => {
                    const dataset = ctx.chart && ctx.chart.data && ctx.chart.data.datasets && ctx.chart.data.datasets[ctx.datasetIndex];
                    const idx = dataset ? dataset.forecastStartIndex : -1;
                    return (idx !== undefined && idx !== -1 && ctx.p0DataIndex >= idx - 1) ? [5, 5] : undefined;
                }
            }
        };

        // --- 6. ESTILS ESPECÍFICS PER VARIABLE ---

        // A) PRECIPITACIÓ ACUMULADA
        if (isDailyAccumulation || isAccumulation12UTC) {
            datasetConfig.type = 'line';
            datasetConfig.tension = 0.1;
            datasetConfig.fill = { target: 'origin', above: 'rgba(50, 150, 255, 0.1)' };
            datasetConfig.borderColor = function (context) {
                const { ctx, chartArea, scales } = context.chart;
                return getPrecipitationGradient(ctx, chartArea, scales);
            };
        }
        // B) PRECIPITACIÓ SEMIHORÀRIA
        else if (isSemiHourlyPrecip || isIntensity) {
            datasetConfig.type = 'bar';
            datasetConfig.backgroundColor = barBackgroundColors;
            datasetConfig.borderColor = barBorderColors;
            datasetConfig.borderWidth = 1;
            datasetConfig.barPercentage = 1.0;
            datasetConfig.categoryPercentage = 1.0;
        }
        // ★ C1) VARIACIÓ DE NEU (NOU GRÀFIC DE BARRES) ★
        else if (isSnowVariation) {
            datasetConfig.type = 'bar';
            datasetConfig.backgroundColor = barBackgroundColors; // Colors calculats (blau/marró)
            datasetConfig.borderColor = barBorderColors;
            datasetConfig.borderWidth = 1;
            // Barres una mica separades per veure l'evolució
            datasetConfig.barPercentage = 0.8;
            datasetConfig.categoryPercentage = 0.9;
            datasetConfig.label = "Variació (cm)";
        }
        // C2) GRUIX DE NEU (LÍNIA ORIGINAL)
        else if (isSnowDepth) {
            datasetConfig.fill = { target: 'origin', above: 'rgba(150, 209, 249, 0.2)' };
            datasetConfig.borderColor = function (context) {
                const { ctx, chartArea, scales } = context.chart;
                return getSnowGradient(ctx, chartArea, scales);
            };
        }
        // D) HUMITAT
        else if (isHumidity) {
            datasetConfig.fill = { target: 'origin', above: 'rgba(0, 191, 255, 0.1)' };
            datasetConfig.borderColor = function (context) {
                const { ctx, chartArea, scales } = context.chart;
                if (!chartArea) return '#0000cd';
                const gradient = ctx.createLinearGradient(0, scales.y.getPixelForValue(0), 0, scales.y.getPixelForValue(100));
                gradient.addColorStop(0, 'rgba(188, 143, 143, 1)');
                gradient.addColorStop(0.4, 'rgba(240, 230, 140, 1)');
                gradient.addColorStop(0.6, 'rgba(152, 251, 152, 1)');
                gradient.addColorStop(1, 'rgba(0, 0, 205, 1)');
                return gradient;
            };
        }
        // E) PRESSIÓ
        else if (isPressure) {
            datasetConfig.fill = true;
            datasetConfig.backgroundColor = 'rgba(200, 200, 200, 0.1)';
            datasetConfig.borderColor = function (context) {
                const { ctx, chartArea, scales } = context.chart;
                if (!chartArea) return '#9370db';
                const gradient = ctx.createLinearGradient(0, scales.y.getPixelForValue(980), 0, scales.y.getPixelForValue(1040));
                gradient.addColorStop(0, 'rgba(255, 127, 80, 1)');
                gradient.addColorStop(0.5, 'rgba(144, 238, 144, 1)');
                gradient.addColorStop(1, 'rgba(147, 112, 219, 1)');
                return gradient;
            };
        }
        // F) TEMPERATURA
        else if (isTemp) {
            if (useGradient) {
                datasetConfig.fill = true;
                datasetConfig.backgroundColor = 'rgba(200, 200, 200, 0.1)';
                datasetConfig.borderColor = function (context) {
                    const { ctx, chartArea, scales } = context.chart;
                    if (!chartArea) return null;
                    const gradient = ctx.createLinearGradient(0, scales.y.getPixelForValue(50), 0, scales.y.getPixelForValue(-20));
                    function addStop(val, color) {
                        const pixel = scales.y.getPixelForValue(val);
                        const top = scales.y.getPixelForValue(50);
                        const bottom = scales.y.getPixelForValue(-20);
                        let offset = (pixel - top) / (bottom - top);
                        offset = Math.max(0, Math.min(1, offset));
                        gradient.addColorStop(offset, color);
                    }
                    addStop(48, 'rgba(140, 0, 200, 1)'); addStop(40, 'rgba(225, 0, 150, 1)'); addStop(30, 'rgba(255, 70, 20, 1)');
                    addStop(20, 'rgba(255, 195, 15, 1)'); addStop(10, 'rgba(125, 201, 85, 1)'); addStop(0, 'rgba(0, 200, 235, 1)');
                    addStop(-10, 'rgba(81, 110, 194, 1)'); addStop(-20, 'rgba(69, 39, 160, 1)');
                    return gradient;
                };
            } else {
                datasetConfig.fill = { target: 'origin', above: 'rgba(220, 20, 60, 0.1)', below: 'rgba(0, 100, 255, 0.1)' };
                datasetConfig.borderColor = function (context) {
                    const { ctx, chartArea, scales } = context.chart;
                    if (!chartArea) return null;
                    const gradient = ctx.createLinearGradient(0, scales.y.top, 0, scales.y.bottom);
                    const zeroPixel = scales.y.getPixelForValue(0);
                    let zeroRatio = (zeroPixel - scales.y.top) / (scales.y.bottom - scales.y.top);
                    zeroRatio = Math.min(Math.max(zeroRatio, 0), 1);
                    gradient.addColorStop(0, 'rgba(220, 20, 60, 1)'); gradient.addColorStop(zeroRatio, 'rgba(220, 20, 60, 1)');
                    gradient.addColorStop(zeroRatio, 'rgba(0, 100, 255, 1)'); gradient.addColorStop(1, 'rgba(0, 100, 255, 1)');
                    return gradient;
                };
            }
        }
        // G) VENT
        else if (isWind) {
            datasetConfig.fill = true;
            datasetConfig.backgroundColor = 'rgba(100, 100, 100, 0.1)';
            datasetConfig.borderColor = function (context) {
                const { ctx, chartArea, scales } = context.chart;
                if (!chartArea) return null;
                const maxScale = (conversionFactor > 1) ? 100 : 28;
                const gradient = ctx.createLinearGradient(0, scales.y.getPixelForValue(0), 0, scales.y.getPixelForValue(maxScale));
                gradient.addColorStop(0, 'rgba(200, 200, 200, 1)');
                gradient.addColorStop(0.4, 'rgba(255, 255, 0, 1)');
                gradient.addColorStop(0.8, 'rgba(255, 69, 0, 1)');
                gradient.addColorStop(1, 'rgba(199, 21, 133, 1)');
                return gradient;
            };
        } else {
            datasetConfig.borderColor = '#333';
            datasetConfig.backgroundColor = 'rgba(0,0,0,0.1)';
        }

        // --- 7. CREACIÓ DEL CHART ---
        const chartConfig = {
            type: datasetConfig.type || 'line',
            data: { labels: labels, datasets: [datasetConfig] },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)', displayColors: false,
                        callbacks: {
                            label: (ctx) => {
                                const unit = isWind ? (conversionFactor > 1 ? 'km/h' : 'm/s') : (VARIABLES_CONFIG[currentVariableKey]?.unit || '');
                                let text = `${ctx.parsed.y.toFixed(1)} ${unit}`;
                                const isForecast = ctx.dataset.forecastStartIndex !== undefined && ctx.dataset.forecastStartIndex !== -1 && ctx.dataIndex >= ctx.dataset.forecastStartIndex;
                                if (isForecast) {
                                    text += ' (Prev. AROME)';
                                }
                                const wd = ctx.dataset.windData?.[ctx.dataIndex];
                                if (wd && wd.dir !== undefined) text += ` (${wd.dir.toFixed(0)}°)`;
                                return text;
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { maxTicksLimit: isModal ? 20 : 5, maxRotation: 0 }, grid: { display: false } },
                    y: {
                        border: { dash: [4, 4] }, grid: { color: '#f0f0f0' },
                        // Si autoScale és true, deixem que Chart.JS busqui el millor mínim i màxim. 
                        // Per defecte comencem a zero en neu i precipitació.
                        beginAtZero: (isDailyAccumulation || isSnowDepth || isSemiHourlyPrecip || isAccumulation12UTC || isSnowVariation) && (!config.autoScale)
                    }
                }
            },
            plugins: isWind ? [windBarbChartPlugin] : []
        };

        const newChart = new Chart(ctxCanvas, chartConfig);
        if (canvasId.startsWith('dash-chart-')) {
            if (!window.dashCharts) window.dashCharts = {};
            window.dashCharts[canvasId] = newChart;
        } else if (isModal) {
            modalChartInstance = newChart;
        } else {
            activeChartInstance = newChart;
        }

    } catch (error) { console.error(error); loader.innerHTML = "Error"; }
}

/**
 * Genera l'HTML del popup (SENSE ONCLICK INLINE)
 * Afegim IDs i classes per trobar els elements des de JS després.
 */
function generateChartPopupHTML(estacio, variableId, config) {
    const value = formatValueForLabel(Number(estacio.valor), config.decimals);
    const isTemp = (variableId == 32 || variableId == 40 || variableId == 42);

    const styleButtonHTML = isTemp
        ? `<button class="chart-btn" id="btn-style-${estacio.codi_estacio}" title="Canviar Estil de Línia">🎨</button>`
        : '';

    const favButtonHTML = `<button class="chart-btn" id="btn-fav-${estacio.codi_estacio}" title="Afegir a El Meu Panell" style="font-size:14px; filter: grayscale(100%); transition: all 0.3s; padding: 2px 6px;">⭐</button>`;

    return `
        <div style="text-align:left;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="popup-station-title" style="font-size:15px; color: var(--text-main);">${estacio.nom}</span>
                <div style="display:flex; gap:5px; align-items: center;">
                    ${favButtonHTML}
                    ${styleButtonHTML}
                    <button class="expand-btn" id="btn-expand-${estacio.codi_estacio}" title="Pantalla Completa" style="display: flex; align-items: center; justify-content: center; padding: 4px; width: 28px; height: 28px; border-radius: 6px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                    </button>
                </div>
            </div>
            
            <div style="font-size: 22px; font-weight:bold; margin: 5px 0; color: var(--text-main);">
                ${value}<span style="font-size:14px; color: var(--text-muted); font-weight:normal;"> ${config.unit}</span>
            </div>
            <div style="font-size:11px; color: var(--text-muted); margin-bottom:8px;">${config.name}</div>
        </div>
        ${config.isSumatoriChart ? '' : `
        <div class="chart-controls" id="controls-${estacio.codi_estacio}" data-hours="24" data-style="split" data-forecast="false">
            <button class="chart-btn active" data-hours="24">24h</button>
            <button class="chart-btn" data-hours="48">48h</button>
            <button class="chart-btn" data-hours="168">7 Dies</button>
            <button class="chart-btn forecast-btn" id="btn-forecast-${estacio.codi_estacio}" title="Previsió AROME 🔮">🔮 Prev.</button>
        </div>
        `}

        <div class="chart-container" style="height: 180px;">
            <canvas id="chart-${estacio.codi_estacio}"></canvas>
        </div>
    `;
}

/**
 * Assigna els esdeveniments als botons DESPRÉS d'obrir el popup.
 * CORREGIT: Ara passa 'targetDate' també a la funció openModal.
 */
function setupPopupEvents(estacio, variableId, config, targetDate = null) {
    const container = document.getElementById(`controls-${estacio.codi_estacio}`);
    const expandBtn = document.getElementById(`btn-expand-${estacio.codi_estacio}`);
    const styleBtn = document.getElementById(`btn-style-${estacio.codi_estacio}`);
    const favBtn = document.getElementById(`btn-fav-${estacio.codi_estacio}`);
    const canvasId = `chart-${estacio.codi_estacio}`;
    const chartCanvas = document.getElementById(canvasId);

    // Protecció contra arrossegaments
    if (container) {
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
    }
    if (expandBtn) L.DomEvent.disableClickPropagation(expandBtn);
    if (styleBtn) L.DomEvent.disableClickPropagation(styleBtn);
    if (favBtn) L.DomEvent.disableClickPropagation(favBtn);
    if (chartCanvas) {
        L.DomEvent.disableClickPropagation(chartCanvas);
        L.DomEvent.disableScrollPropagation(chartCanvas);
    }

    // Lògica Botons de Temps (Petit) - només si hi ha controls
    if (container) {
        const buttons = container.querySelectorAll('.chart-btn[data-hours]');
        buttons.forEach(btn => {
            L.DomEvent.disableClickPropagation(btn);
            btn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                buttons.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');

                const hours = e.target.getAttribute('data-hours');
                container.setAttribute('data-hours', hours);

                const currentStyle = container.getAttribute('data-style') === 'gradient';
                const currentForecast = container.getAttribute('data-forecast') === 'true';

                loadStationChart(
                    estacio.codi_estacio,
                    variableId,
                    `chart-${estacio.codi_estacio}`,
                    config.name,
                    hours,
                    false,
                    currentStyle,
                    config.conversion,
                    { ...config, showForecast: currentForecast, lat: estacio.lat, lon: estacio.lon },
                    targetDate // Passem la data al gràfic petit
                );
            });
        });

        // Lògica Botó Previsió (Petit)
        const forecastBtn = document.getElementById(`btn-forecast-${estacio.codi_estacio}`);
        if (forecastBtn) {
            L.DomEvent.disableClickPropagation(forecastBtn);
            forecastBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const isForecast = container.getAttribute('data-forecast') === 'true';
                const newForecast = !isForecast;
                container.setAttribute('data-forecast', newForecast ? 'true' : 'false');
                forecastBtn.classList.toggle('active', newForecast);

                const currentHours = container.getAttribute('data-hours');
                const currentStyle = container.getAttribute('data-style') === 'gradient';

                loadStationChart(
                    estacio.codi_estacio,
                    variableId,
                    canvasId,
                    config.name,
                    currentHours,
                    false,
                    currentStyle,
                    config.conversion,
                    { ...config, showForecast: newForecast, lat: estacio.lat, lon: estacio.lon },
                    targetDate
                );
            });
        }
    }

    // 2. Lògica Botó Estil (Petit)
    if (styleBtn && container) {
        styleBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const isGradient = container.getAttribute('data-style') === 'gradient';
            const newStyle = !isGradient;
            container.setAttribute('data-style', newStyle ? 'gradient' : 'split');
            styleBtn.style.backgroundColor = newStyle ? '#f0e36aff' : '';

            const currentHours = container.getAttribute('data-hours');
            const currentForecast = container.getAttribute('data-forecast') === 'true';

            loadStationChart(
                estacio.codi_estacio,
                variableId,
                canvasId,
                config.name,
                currentHours,
                false,
                newStyle,
                config.conversion,
                { ...config, showForecast: currentForecast, lat: estacio.lat, lon: estacio.lon },
                targetDate
            );
        });
    }

    // 3. Lògica Expandir Pantalla
    if (expandBtn) {
        L.DomEvent.on(expandBtn, 'click', (e) => {
            L.DomEvent.stopPropagation(e);
            e.preventDefault();
            console.log("Expandint gràfic per a:", estacio.nom);
            openModal(estacio, variableId, config, targetDate);
        });
    }

    // 4. Lògica Favorits (Popup Petit)
    if (favBtn) {
        // Inicialitzem estat de la icona
        let userFavorites = JSON.parse(localStorage.getItem('4e_favorites')) || [];
        const isFavorited = userFavorites.some(fav => (typeof fav === 'string' ? fav === estacio.codi_estacio : fav.id === estacio.codi_estacio));

        if (isFavorited) {
            favBtn.style.filter = 'grayscale(0%)';
            favBtn.classList.add('active');
        }

        favBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            let currentFavorites = JSON.parse(localStorage.getItem('4e_favorites')) || [];
            const currentlyFavorited = currentFavorites.some(fav => (typeof fav === 'string' ? fav === estacio.codi_estacio : fav.id === estacio.codi_estacio));

            if (currentlyFavorited) {
                // Eliminar
                currentFavorites = currentFavorites.filter(fav => (typeof fav === 'string' ? fav !== estacio.codi_estacio : fav.id !== estacio.codi_estacio));
                favBtn.style.filter = 'grayscale(100%)';
                favBtn.classList.remove('active');
            } else {
                // Afegir com objecte {id, name}
                currentFavorites.push({ id: estacio.codi_estacio, name: estacio.nom });
                favBtn.style.filter = 'grayscale(0%)';
                favBtn.classList.add('active');

                // Animació de feedback
                favBtn.style.animation = 'popStar 0.4s ease-out';
                setTimeout(() => { favBtn.style.animation = ''; }, 400);

                // També incrustem una caixeta de widget directament.
                let layoutObj = JSON.parse(localStorage.getItem('4e_widget_layout')) || [];
                layoutObj.push({
                    id: estacio.codi_estacio + "_default_" + Math.floor(Math.random() * 1000), // id unica per grid
                    stationId: estacio.codi_estacio,
                    variableId: 32, // Temperatura default
                    interval: 24,
                    x: 0, y: 0, w: 4, h: 4, minW: 3, minH: 3 // auto encabir al dashboard 
                });
                localStorage.setItem('4e_widget_layout', JSON.stringify(layoutObj));
            }
            localStorage.setItem('4e_favorites', JSON.stringify(currentFavorites));

            // També si casualment l'openModal estigués actualitzant-ho globalment
            if (window.checkFavoriteStatus) {
                window.checkFavoriteStatus(estacio.codi_estacio, estacio.nom);
            }
        });
    }
}

/**
 * Obre la finestra modal, genera els botons i carrega el gràfic.
 * CORREGIT: Ara accepta i utilitza 'targetDate' per al mode històric.
 */
function openModal(estacio, variableId, config, targetDate = null) {
    const modal = document.getElementById('chart-modal');
    const title = document.getElementById('modal-title');
    const closeBtn = document.getElementById('close-modal-btn');
    const controlsContainer = document.getElementById('modal-controls');

    // Actualitzem el títol. Si és històric, podríem afegir la data al títol si volguessis.
    title.textContent = `${estacio.nom} - ${config.name}`;
    modal.style.display = 'flex'; // <--- CORRECCIÓ CLAU
    modal.classList.add('visible');

    // Check si aquesta estació està en favorits per actualitzar la ⭐
    if (window.checkFavoriteStatus) {
        window.checkFavoriteStatus(estacio.codi_estacio, estacio.nom);
        // Make sure star is visible in case it was hidden by meteogram
        const favBtn = document.getElementById('favorite-station-btn');
        if (favBtn) favBtn.style.display = 'inline-block';
    }

    // 1. Detectem tipus de variable
    const isTemp = (variableId == 32 || variableId == 40 || variableId == 42);
    const isSnow = (variableId == 38);

    // 2. Generem l'HTML dels botons
    let buttonsHTML = '';
    if (isTemp) {
        buttonsHTML += `<button class="chart-btn" id="btn-modal-style" title="Canviar Estil" style="margin-right:15px; font-size:16px;">🎨</button>`;
    }
    if (isSnow) {
        buttonsHTML += `<button class="chart-btn" id="btn-modal-autoscale" title="Millorar el zoom vertical (Ajustar Rang)" style="margin-right:15px; font-size:11px; font-weight:bold; padding: 5px 10px;">AJUSTAR</button>`;
    }

    // Botó de previsió AROME per al modal
    buttonsHTML += `<button class="chart-btn" id="btn-modal-forecast" title="Previsió AROME 🔮" style="margin-right:15px; font-size:11px; font-weight:bold; padding: 5px 10px;">🔮 PREVISIÓ</button>`;

    buttonsHTML += `
        <button class="chart-btn active" data-hours="24" style="font-size: 14px; padding: 5px 15px;">24h</button>
        <button class="chart-btn" data-hours="48" style="font-size: 14px; padding: 5px 15px;">48h</button>
        <button class="chart-btn" data-hours="168" style="font-size: 14px; padding: 5px 15px;">7 Dies</button>
    `;

    controlsContainer.innerHTML = buttonsHTML;
    controlsContainer.setAttribute('data-style', 'split');
    controlsContainer.setAttribute('data-hours', '24');
    controlsContainer.setAttribute('data-autoscale', 'false');
    controlsContainer.setAttribute('data-forecast', 'false');

    // 3. Assignem lògica als botons de TEMPS del MODAL
    const timeButtons = controlsContainer.querySelectorAll('.chart-btn[data-hours]');
    timeButtons.forEach(btn => {
        btn.onclick = (e) => {
            timeButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const hours = e.target.getAttribute('data-hours');
            controlsContainer.setAttribute('data-hours', hours);

            const currentStyle = controlsContainer.getAttribute('data-style') === 'gradient';
            const currentAuto = controlsContainer.getAttribute('data-autoscale') === 'true';
            const currentForecast = controlsContainer.getAttribute('data-forecast') === 'true';

            loadStationChart(
                estacio.codi_estacio,
                variableId,
                'modal-canvas',
                config.name,
                hours,
                true,
                currentStyle,
                config.conversion,
                { ...config, autoScale: currentAuto, showForecast: currentForecast, lat: estacio.lat, lon: estacio.lon },
                targetDate
            );
        };
    });

    // 4. Botó d'ESTIL
    if (isTemp) {
        const styleBtn = document.getElementById('btn-modal-style');
        styleBtn.onclick = (e) => {
            const isGradient = controlsContainer.getAttribute('data-style') === 'gradient';
            const newStyle = !isGradient;
            controlsContainer.setAttribute('data-style', newStyle ? 'gradient' : 'split');
            styleBtn.style.backgroundColor = newStyle ? '#f0e36aff' : '';

            const currentHours = controlsContainer.getAttribute('data-hours');
            const currentAuto = controlsContainer.getAttribute('data-autoscale') === 'true';
            const currentForecast = controlsContainer.getAttribute('data-forecast') === 'true';

            loadStationChart(
                estacio.codi_estacio,
                variableId,
                'modal-canvas',
                config.name,
                currentHours,
                true,
                newStyle,
                config.conversion,
                { ...config, autoScale: currentAuto, showForecast: currentForecast, lat: estacio.lat, lon: estacio.lon },
                targetDate
            );
        };
    }

    // 5. Botó AJUSTAR Rang (Mínim/Màxim)
    if (isSnow) {
        const autoBtn = document.getElementById('btn-modal-autoscale');
        autoBtn.onclick = (e) => {
            const isAuto = controlsContainer.getAttribute('data-autoscale') === 'true';
            const newAuto = !isAuto;
            controlsContainer.setAttribute('data-autoscale', newAuto ? 'true' : 'false');
            autoBtn.style.backgroundColor = newAuto ? '#3b82f6' : '';
            autoBtn.style.color = newAuto ? 'white' : '';

            const currentHours = controlsContainer.getAttribute('data-hours');
            const currentStyle = controlsContainer.getAttribute('data-style') === 'gradient';
            const currentForecast = controlsContainer.getAttribute('data-forecast') === 'true';

            loadStationChart(
                estacio.codi_estacio,
                variableId,
                'modal-canvas',
                config.name,
                currentHours,
                true,
                currentStyle,
                config.conversion,
                { ...config, autoScale: newAuto, showForecast: currentForecast, lat: estacio.lat, lon: estacio.lon },
                targetDate
            );
        };
    }

    // Lògica Botó Previsió AROME (Modal)
    const forecastBtn = document.getElementById('btn-modal-forecast');
    if (forecastBtn) {
        forecastBtn.onclick = (e) => {
            const isForecast = controlsContainer.getAttribute('data-forecast') === 'true';
            const newForecast = !isForecast;
            controlsContainer.setAttribute('data-forecast', newForecast ? 'true' : 'false');
            
            forecastBtn.classList.toggle('active', newForecast);
            forecastBtn.style.backgroundColor = newForecast ? '#3b82f6' : '';
            forecastBtn.style.color = newForecast ? 'white' : '';

            const currentHours = controlsContainer.getAttribute('data-hours');
            const currentStyle = controlsContainer.getAttribute('data-style') === 'gradient';
            const currentAuto = controlsContainer.getAttribute('data-autoscale') === 'true';

            loadStationChart(
                estacio.codi_estacio,
                variableId,
                'modal-canvas',
                config.name,
                currentHours,
                true,
                currentStyle,
                config.conversion,
                { ...config, autoScale: currentAuto, showForecast: newForecast, lat: estacio.lat, lon: estacio.lon },
                targetDate
            );
        };
    }

    // 5. Càrrega INICIAL del modal
    // ★ PASSEM targetDate AQUÍ ★
    loadStationChart(
        estacio.codi_estacio,
        variableId,
        'modal-canvas',
        config.name,
        24,
        true, // isModal
        false, // useGradient false per defecte
        config.conversion,
        { ...config, lat: estacio.lat, lon: estacio.lon },
        targetDate
    );

    // 6. Tancar
    closeBtn.onclick = () => {
        modal.classList.remove('visible');
        if (modalChartInstance) {
            modalChartInstance.destroy();
            modalChartInstance = null;
        }
    };
}

/* ==================================================================
   MÒDUL IDW "PLUG & PLAY": INTROSPECCIÓ DE CLUSTERS + CROMA BLANC
   ================================================================== */

let idwImageLayer = null;

// 1. SETUP DEL DISPARADOR
function setupIDWSystem() {
    const dummyLayer = L.layerGroup();
    map.on('overlayadd', function (e) {
        if (e.name === '🛠️ GENERAR IDW') {
            setTimeout(() => {
                map.removeLayer(e.layer);
                iniciarAssistentIDW();
            }, 100);
        }
    });
    return dummyLayer;
}

// 2. CONFIGURACIÓ DE COLORS I ESCALA
const CONFIG_IDW = {
    colors: [
        "#a1d3fc", "#51b5fa", "#0095f9", "#106e2b", "#008126", "#00c42c", "#44e534",
        "#8fd444", "#91ea32", "#ffee47", "#ecd336", "#fd5523", "#ff7235", "#ff9a67", "#ff486f",
        "#ff214e", "#c30617", "#85030f", "#5b1670", "#bd30f3"
    ],
    valors: [
        0.1, 0.2, 0.5, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 100, 150, 200
    ],
    maxEscala: 200
};

function obtenirGradientOficial() {
    // ESTRATÈGIA BLANCA: Usem fons blanc per evitar ombres grises
    let gradient = { 0.0: '#ffffff' };

    const TALL_MINIM = 0.2;
    const posTall = TALL_MINIM / CONFIG_IDW.maxEscala;

    // Fins al 0.1 mm tot és blanc
    gradient[(posTall * 0.99).toFixed(6)] = '#ffffff';

    for (let i = 0; i < CONFIG_IDW.colors.length; i++) {
        let valMM = CONFIG_IDW.valors[i];
        if (valMM < TALL_MINIM) continue; // Ignorem valors sota el tall

        let posicio = valMM / CONFIG_IDW.maxEscala;
        if (posicio > 1.0) posicio = 1.0;
        gradient[posicio.toFixed(6)] = CONFIG_IDW.colors[i];
    }
    return gradient;
}

// 3. ASSISTENT
function iniciarAssistentIDW() {
    // Comprovem si hi ha capa de marcadors activa
    if (typeof dataMarkersLayer === 'undefined' || !map.hasLayer(dataMarkersLayer)) {
        alert("Error: Primer has de carregar les estacions al mapa!");
        return;
    }

    const xarxa = prompt("Quina xarxa vols interpolar?\n\n1. Meteocat (Oficial)\n2. Wunderground (Express/Xarxa 4E)");

    if (xarxa === '1' || (xarxa && xarxa.toLowerCase().includes('meteo'))) {
        // false = Agafa tot el mapa
        extraureDadesInteligents(false);
    } else if (xarxa === '2' || (xarxa && xarxa.toLowerCase().includes('wunder'))) {
        alert("MODE EXPRESS\n\n1. Enquadra el mapa.\n2. Prem d'acord per capturar el que hi ha en pantalla.");
        // true = Només el que es veu (Bounds)
        extraureDadesInteligents(true);
    }
}

// 4. EINES D'EXTRACCIÓ INTEL·LIGENT (LA TÈCNICA)
function extraureDadesInteligents(limitarVisió) {
    let puntsRecollits = [];
    const bounds = map.getBounds();
    let totsElsMarcadors = [];

    // --- LA MÀGIA DELS CLUSTERS ---
    // Si és un grup de clusters, té el mètode getAllChildMarkers()
    // Aquest mètode ens torna TOTS els marcadors, encara que estiguin "amagats" dins la bola groga.
    if (dataMarkersLayer.getAllChildMarkers) {
        totsElsMarcadors = dataMarkersLayer.getAllChildMarkers();
        console.log(`Cluster detectat: Analitzant ${totsElsMarcadors.length} estacions amagades...`);
    } else {
        // Si no és cluster, iterem normal
        dataMarkersLayer.eachLayer(m => totsElsMarcadors.push(m));
    }

    totsElsMarcadors.forEach(marker => {
        let valor = null;

        // PRIORITAT 1: Dades internes (GeoJSON properties)
        // Això funciona sempre, encara que el marcador no estigui pintat al mapa
        if (marker.feature && marker.feature.properties && marker.feature.properties.valor !== undefined) {
            valor = parseFloat(marker.feature.properties.valor);
        }
        // PRIORITAT 2: Options (si ho guardes al crear L.marker)
        else if (marker.options && marker.options.valor !== undefined) {
            valor = parseFloat(marker.options.valor);
        }
        // PRIORITAT 3: Text (Només si no hi ha més remei i el marcador és visible)
        else if (marker.getElement()) {
            let text = marker.getElement().innerText;
            text = text.replace('mm', '').replace('LM', '').replace(',', '.').trim();
            valor = parseFloat(text);
        }

        if (valor !== null && !isNaN(valor)) {
            const latLng = marker.getLatLng();

            // Filtre de Visió: Si estem en mode Express, mirem si la coordenada cau dins la pantalla
            if (limitarVisió) {
                if (bounds.contains(latLng)) {
                    puntsRecollits.push([latLng.lat, latLng.lng, valor]);
                }
            } else {
                puntsRecollits.push([latLng.lat, latLng.lng, valor]);
            }
        }
    });

    if (puntsRecollits.length > 3) {
        obrirFiltreValors(puntsRecollits);
    } else {
        alert("No s'han trobat prou dades (" + puntsRecollits.length + "). Revisa que les estacions tinguin la propietat 'valor'.");
    }
}

// 5. UI FILTRE
function obrirFiltreValors(punts) {
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;border-radius:10px;z-index:9999;box-shadow:0 0 20px rgba(0,0,0,0.5);text-align:center;font-family:sans-serif;min-width:300px;`;

    // Detectem el màxim per posar-lo al input per defecte
    const maxDetected = Math.max(...punts.map(p => p[2]));

    div.innerHTML = `
        <h3 style="margin-top:0">Configuració IDW</h3>
        <p>Punts processats: <b>${punts.length}</b></p>
        <div style="margin:15px 0;text-align:left;">
            <label>Mínim: <input type="number" id="idw-min" value="0.1" step="0.1" style="width:70px;float:right"></label><br><br>
            <label>Màxim: <input type="number" id="idw-max" value="${Math.min(maxDetected + 10, 300)}" step="1" style="width:70px;float:right"></label>
        </div>
        <p style="font-size:12px;color:#666;">Nota: Els 0 serveixen per delimitar, però seran transparents.</p>
        <button id="btn-go-idw" style="width:100%;padding:10px;background:#007bff;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">GENERAR</button>
        <button id="btn-cancel-idw" style="width:100%;margin-top:10px;background:transparent;border:none;cursor:pointer;color:#666;">Cancel·lar</button>
    `;
    document.body.appendChild(div);
    document.getElementById('btn-cancel-idw').onclick = () => document.body.removeChild(div);
    document.getElementById('btn-go-idw').onclick = () => {
        const min = parseFloat(document.getElementById('idw-min').value);
        const max = parseFloat(document.getElementById('idw-max').value);
        document.body.removeChild(div);

        // Mantenim els 0 perquè l'IDW sàpiga on NO plou
        const puntsFiltrats = punts.filter(p => p[2] >= 0 && p[2] <= max);
        generarCapaIDW_PNG(puntsFiltrats);
    };
}

// 6. GENERACIÓ FINAL (CROMA BLANC)
function generarCapaIDW_PNG(data) {
    if (idwImageLayer) map.removeLayer(idwImageLayer);

    const gradientCfg = obtenirGradientOficial();

    let tempIdwLayer = L.idwLayer(data, {
        opacity: 1,
        cellSize: 1, // Màxima qualitat
        exp: 5,      // Exponent equilibrat
        max: CONFIG_IDW.maxEscala,
        gradient: gradientCfg
    }).addTo(map);

    const loading = document.createElement('div');
    loading.innerText = "Interpolant...";
    loading.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);background:black;color:white;padding:10px 20px;border-radius:20px;z-index:9999;";
    document.body.appendChild(loading);

    setTimeout(() => {
        try {
            const sourceCanvas = tempIdwLayer._canvas || document.querySelector('.leaflet-overlay-pane canvas:last-child');

            if (sourceCanvas && typeof contornCatGeojson !== 'undefined') {

                const finalCanvas = document.createElement('canvas');
                finalCanvas.width = sourceCanvas.width;
                finalCanvas.height = sourceCanvas.height;
                const ctx = finalCanvas.getContext('2d');

                // A. Forma Catalunya
                dibuixarCatalunyaAlCanvas(ctx, contornCatGeojson);

                // B. Mode Retall
                ctx.globalCompositeOperation = 'source-in';
                ctx.drawImage(sourceCanvas, 0, 0);

                // C. Croma Blanc (Eliminar fons blanc i fer-lo transparent)
                aplicarCromaBlanc(ctx, finalCanvas.width, finalCanvas.height);

                // D. Output
                const imgData = finalCanvas.toDataURL('image/png');
                const bounds = map.getBounds();

                map.removeLayer(tempIdwLayer);

                idwImageLayer = L.imageOverlay(imgData, bounds, {
                    opacity: 0.8,
                    interactive: false,
                    zIndex: 350
                }).addTo(map);
                idwImageLayer.bringToBack();

            } else {
                map.removeLayer(tempIdwLayer);
                alert("Error: No s'ha trobat el contorn o el canvas.");
            }
        } catch (err) {
            console.error(err);
        } finally {
            document.body.removeChild(loading);
        }
    }, 1000);
}

// Funció Croma per eliminar el blanc respectant els colors clars
function aplicarCromaBlanc(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // TALLAR BLANC PUR: R,G,B > 245
        // El teu blau cel és R=161, així que està segur.
        if (r > 245 && g > 245 && b > 245) {
            data[i + 3] = 0; // Transparent
        }
        // Antialiasing suau per grisos molt clars
        else if (r > 220 && g > 220 && b > 240) {
            let blancura = (r + g + b) / 3;
            let novaOpacitat = 255 - ((blancura - 220) * (255 / 35));
            if (novaOpacitat < 0) novaOpacitat = 0;
            data[i + 3] = novaOpacitat;
        }
    }
    ctx.putImageData(imgData, 0, 0);
}

function dibuixarCatalunyaAlCanvas(ctx, geojson) {
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    const geometry = geojson.features ? geojson.features[0].geometry : geojson.geometry;

    function processarCoordenades(coords) {
        if (geometry.type === 'Polygon') {
            coords.forEach(ring => dibuixarAnella(ctx, ring));
        } else if (geometry.type === 'MultiPolygon') {
            coords.forEach(polygon => {
                polygon.forEach(ring => dibuixarAnella(ctx, ring));
            });
        }
    }
    function dibuixarAnella(ctx, ring) {
        if (!ring || ring.length === 0) return;
        let pO = map.latLngToContainerPoint([ring[0][1], ring[0][0]]);
        ctx.moveTo(pO.x, pO.y);
        for (let i = 1; i < ring.length; i++) {
            let p = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
            ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
    }
    processarCoordenades(geometry.coordinates);
    ctx.fill();
}

// ===================================================================================
// AUTO-REFRESC: SISTEMA PER DETECTAR NOVES IMATGES CADA 6 MINUTS
// ===================================================================================



function iniciarAutoRefrescRadar() {
    // Comprovem si hi ha noves imatges cada 60 segons
    console.log("Sistema d'auto-refresc de radar activat.");
    if (intervalAutoRefresc) clearInterval(intervalAutoRefresc);

    intervalAutoRefresc = setInterval(() => {
        buscarNovesImatgesRadar();
    }, 60000); // 60000 ms = 1 minut
}

async function buscarNovesImatgesRadar() {
    // Aquesta funció comprova si hi ha noves imatges disponibles
    // Tant per capes JSON (CAPPI) com per capes calculades (Meteocat Tile)

    try {
        // Obtenim quins serien els intervals si actualitzéssim ara mateix
        const candidateValues = await setRangeValuesAsync();

        // Si la llista actual està buida, no fem res (encara no s'ha iniciat)
        if (!range_values || range_values.length === 0) return;

        // Comprovem si tenim candidats vàlids
        if (candidateValues && candidateValues.length > 0) {
            const latestCandidate = candidateValues[candidateValues.length - 1];
            const currentLatest = range_values[range_values.length - 1];

            // Si l'última imatge candidata és més nova que l'actual...
            if (latestCandidate.utctime > currentLatest.utctime) {
                console.log(`📡 Nova imatge detectada (${new Date(latestCandidate.utctime).toLocaleTimeString()})! Actualitzant slider...`);

                // Guardem l'estat actual de l'usuari
                const currentIndex = parseInt(range_element.value);
                const wasAtEnd = (currentIndex === range_values.length - 1);
                const isUserPlaying = isPlaying; // Variable global d'animació

                // Actualitzem el slider MANTENINT LA CACHE (true)
                await reconfigureTimeSliderAsync(true);

                // GESTIÓ DE POSICIÓ INTEL·LIGENT:
                // Si l'usuari estava mirant l'última imatge ("en directe"),
                // el movem automàticament a la nova última imatge.
                if (wasAtEnd && !isUserPlaying) {
                    range_element.value = range_values.length - 1;
                    range_element.dispatchEvent(new Event('input'));

                    // Opcional: Feedback visual discret
                    /* L.popup({closeButton: false, autoClose: true, className: 'dark-popup'})
                       .setLatLng(map.getCenter())
                       .setContent('Nova imatge disponible 🌧️')
                       .openOn(map); */
                }
                // Si l'usuari estava mirant el passat o reproduint, NO el molestem,
                // simplement el slider s'haurà fet una miqueta més llarg.
            }
        }
    } catch (err) {
        console.error("Error comprovant auto-update radar:", err);
    }
}

// Funció auxiliar per formatar l'hora (si la necessites pel popup)
function formatHora(date) {
    return date.getHours().toString().padStart(2, '0') + ':' +
        date.getMinutes().toString().padStart(2, '0');
}

// --- FUNCIÓ PER CARREGAR EL VENT AROME ---
async function carregarCapaVent() {
    try {
        // Ajusta la ruta si cal ('python/vent_actual.json' al servidor)
        const response = await fetch('vent_actual.json');
        if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);

        const windData = await response.json();

        // Assignem a la variable GLOBAL (sense 'const')
        velocityLayer = L.velocityLayer({
            displayValues: true,
            displayOptions: {
                velocityType: "Vent AROME",
                displayPosition: "bottomleft",
                displayEmptyString: "Sense dades",
                speedUnit: "km/h"
            },
            data: windData,
            minVelocity: 0,
            maxVelocity: 30,
            velocityScale: 0.010,
            particleAge: 2300,
            lineWidth: 2,
            particleMultiplier: 1 / 200,
            colorScale: ["rgba(15, 15, 15, 1)"]
        });

        // Calculem convergències si tens la funció
        if (typeof dibuixarConvergenciesArome === 'function') {
            dibuixarConvergenciesArome(windData);
        }

        console.log("✅ Dades de vent carregades a la variable.");

    } catch (error) {
        console.warn("⚠️ No s'ha pogut carregar el vent (és normal si no has executat el Python):", error);
        // Creem una capa buida perquè el menú no falli
        velocityLayer = L.layerGroup();
    }
}

// Cridem la funció quan el mapa estigui llest
// Si ja estàs dins d'un 'window.addEventListener', posa només la crida a dins.
// carregarCapaVent();

// Inicialització final
setTimeout(() => {
    displayVariable('smc_32');
    const defaultOption = document.querySelector('li[data-variable-key="smc_32"]');
    if (defaultOption) {
        defaultOption.classList.add('active');
        defaultOption.closest('.main-menu-item').querySelector('a').classList.add('active');
    }
}, 500);

setInterval(loadActiveWebcams, 60000);

// ==========================================
// MÒDUL DE METEOGRAMES AVANÇAT (OPEN-METEO + ENSEMBLES)
// ==========================================

let isMeteogramModeActive = false;
let meteogramChart = null;
let currentLat = null;
let currentLon = null;

// Estat de Configuració
let meteoConfig = {
    model: 'arome_france', // Default
    variables: ['temperature_2m', 'precipitation'],
    showEnsembles: false,
    ensembleModel: 'gfs_seamless',
    ensembleVariables: ['temperature_850hPa', 'precipitation']
};

// 0. GLOBAL: Listener per TANCAR MODAL
const globalCloseBtn = document.getElementById('close-modal-btn');
if (globalCloseBtn) {
    globalCloseBtn.addEventListener('click', function () {
        const modal = document.getElementById('chart-modal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('visible');
            const modalContent = modal.querySelector('.modal-content');
            if (modalContent) modalContent.classList.remove('maximized');
            const maxBtn = document.getElementById('maximize-modal-btn');
            if (maxBtn) maxBtn.innerHTML = '🗖';

            // Reset state
            document.getElementById('modal-controls-advanced').style.display = 'none';
            document.getElementById('modal-controls').style.display = 'flex';
        }
    });
}

// 1. Botó Toggle (Barra Lateral)
const meteogramBtn = document.getElementById('toggle-meteogram-btn');
if (meteogramBtn) {
    meteogramBtn.addEventListener('click', function () {
        isMeteogramModeActive = !isMeteogramModeActive;

        if (isMeteogramModeActive) {
            this.style.backgroundColor = '#ffeb3b';
            this.style.color = '#000';
            map.getContainer().style.cursor = 'crosshair';
        } else {
            this.style.backgroundColor = '';
            this.style.color = '';
            map.getContainer().style.cursor = '';
        }
    });
};

// 1b. Map Lock Button
const lockBtn = document.getElementById('lock-map');
let isMapLocked = false;
if (lockBtn) {
    lockBtn.addEventListener('click', function () {
        isMapLocked = !isMapLocked;

        if (isMapLocked) {
            // Disable interactions
            map.dragging.disable();
            map.touchZoom.disable();
            map.doubleClickZoom.disable();
            map.boxZoom.disable();
            map.keyboard.disable();
            if (map.tap) map.tap.disable();

            // Handle Zoom (standard or smooth)
            if (map.smoothWheelZoom) {
                map.smoothWheelZoom.disable();
            } else {
                map.scrollWheelZoom.disable();
            }

            // Visual Feedback
            this.style.backgroundColor = '#d32f2f'; // Red
            this.style.color = 'white';
            this.style.border = '2px solid #b71c1c';
        } else {
            // Enable interactions
            map.dragging.enable();
            map.touchZoom.enable();
            map.doubleClickZoom.enable();
            map.boxZoom.enable();
            map.keyboard.enable();
            if (map.tap) map.tap.enable();

            // Handle Zoom (standard or smooth)
            if (map.smoothWheelZoom) {
                map.smoothWheelZoom.enable();
            } else {
                // Only enable standard zoom if smooth wasn't the intended one
                // But typically if they don't have smooth, they have standard.
                // Checking map options might be safer but this is a good heuristic.
                map.scrollWheelZoom.enable();
            }

            // Reset Visual Feedback
            this.style.backgroundColor = '';
            this.style.color = '';
            this.style.border = '';
        }
    });
}

// 1c. Sandwich Mode (Multiply Blend Mode)
const sandwichBtn = document.getElementById('toggle-sandwich-mode-btn');
if (sandwichBtn) {
    sandwichBtn.addEventListener('click', function () {
        const pane = map.getPane('satellitePane');
        if (pane) {
            const isActive = pane.classList.toggle('sandwich-active');
            if (isActive) {
                this.classList.add('active'); // Feedback visual
                this.style.backgroundColor = '#ff9800';
                this.style.color = 'white';
            } else {
                this.classList.remove('active');
                this.style.backgroundColor = '';
                this.style.color = '';
            }
            console.log("Mode Sandwich:", isActive ? "Activat" : "Desactivat");
        }
    });
}

// 2. Click al Mapa
map.on('click', function (e) {
    if (!isMeteogramModeActive) return;
    currentLat = e.latlng.lat;
    currentLon = e.latlng.lng;
    showMeteogramModal(currentLat, currentLon);
});

// Ajudant: Chips Logic
function updateChipsVisuals() {
    const chips = document.querySelectorAll('.meteo-chip');
    chips.forEach(chip => {
        const input = chip.querySelector('input');
        if (input.checked) chip.classList.add('active');
        else chip.classList.remove('active');
    });
}

function getSelectedVariables(selectorClass) {
    if (!selectorClass) selectorClass = 'var-toggle';
    const checkboxes = document.querySelectorAll(`.${selectorClass}:checked`);
    return Array.from(checkboxes).map(cb => cb.value);
}

// Inicialització dels controls (Events)
// Inicialització dels controls (Events)
function initMeteogramControls() {
    // --- 1. EXISTING LOGIC ---
    // (Ensuring we don't duplicate listeners if called multiple times, ideally this fn should be separate or idempotent)

    // --- NEW TABLE VIEW CONTROLS ---
    const btnChart = document.getElementById('view-mode-chart');
    const btnTable = document.getElementById('view-mode-table');
    const selVar = document.getElementById('table-variable-select');

    if (btnChart) btnChart.onclick = () => { activeViewMode = 'chart'; updateMeteogramViewMode(); };
    if (btnTable) btnTable.onclick = () => { activeViewMode = 'table'; updateMeteogramViewMode(); };
    if (selVar) selVar.onchange = (e) => {
        currentTableVariable = e.target.value;
        if (lastEnsembleData) renderEnsembleTable(lastEnsembleData, lastDetData, currentTableVariable);
    };

    // --- EXISTING TABS LOGIC ---
    // Model Select (Standard)
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.onchange = () => {
            meteoConfig.model = modelSelect.value;
            if (!meteoConfig.showEnsembles) refreshMeteogram();
        };
    }

    // Model Select (ENS)
    const ensModelSelect = document.getElementById('ensemble-model-select');
    if (ensModelSelect) {
        ensModelSelect.onchange = () => {
            meteoConfig.ensembleModel = ensModelSelect.value;
            if (meteoConfig.showEnsembles) refreshMeteogram();
        };
    }

    // Chip Toggles - Logic Universal
    const chips = document.querySelectorAll('.meteo-chip');
    chips.forEach(chip => {
        chip.onclick = (e) => {
            if (e.target.tagName === 'INPUT') return;

            e.preventDefault();
            const input = chip.querySelector('input');
            input.checked = !input.checked;
            updateChipsVisuals();

            // Detectar tipus de chip
            if (input.classList.contains('var-toggle-det')) {
                meteoConfig.variables = getSelectedVariables('var-toggle-det');
                if (!meteoConfig.showEnsembles) refreshMeteogram();
            } else if (input.classList.contains('var-toggle-ens')) {
                meteoConfig.ensembleVariables = getSelectedVariables('var-toggle-ens');
                if (meteoConfig.showEnsembles) refreshMeteogram();
            }
        };
    });

    // Manual inputs listener (backup)
    const inputs = document.querySelectorAll('input[type="checkbox"]');
    inputs.forEach(input => {
        input.onchange = () => {
            updateChipsVisuals();
            if (input.classList.contains('var-toggle-det')) {
                meteoConfig.variables = getSelectedVariables('var-toggle-det');
                if (!meteoConfig.showEnsembles) refreshMeteogram();
            } else if (input.classList.contains('var-toggle-ens')) {
                meteoConfig.ensembleVariables = getSelectedVariables('var-toggle-ens');
                if (meteoConfig.showEnsembles) refreshMeteogram();
            }
        }
    });

    // --- TABS LOGIC ---
    const tabDet = document.getElementById('tab-det');
    const tabEns = document.getElementById('tab-ens');
    const contentDet = document.getElementById('tab-content-det');
    const contentEns = document.getElementById('tab-content-ens');

    const updateTabUI = () => {
        if (!tabDet || !tabEns) return;

        // Reset styles first (allow CSS classes to take over if needed)
        tabDet.classList.remove('active-tab', 'inactive-tab');
        tabEns.classList.remove('active-tab', 'inactive-tab');

        if (meteoConfig.showEnsembles) {
            // ENS Active
            tabEns.classList.add('active-tab');
            tabDet.classList.add('inactive-tab');

            // Fallback styles only if CSS not present, but use CSS vars where possible or just update classes
            // We REMOVE the hardcoded white background so CSS controls it
            tabEns.style.borderBottom = '3px solid #2196f3';
            tabEns.style.color = '#1976D2';
            tabEns.style.background = ''; // Allow CSS

            tabDet.style.borderBottom = '3px solid transparent';
            tabDet.style.color = '#666';
            tabDet.style.background = ''; // Allow CSS

            if (contentDet) contentDet.style.display = 'none';
            if (contentEns) contentEns.style.display = 'block';
        } else {
            // DET Active
            tabDet.classList.add('active-tab');
            tabEns.classList.add('inactive-tab');

            tabDet.style.borderBottom = '3px solid #2196f3';
            tabDet.style.color = '#1976D2';
            tabDet.style.background = ''; // Allow CSS

            tabEns.style.borderBottom = '3px solid transparent';
            tabEns.style.color = '#666';
            tabEns.style.background = ''; // Allow CSS

            if (contentDet) contentDet.style.display = 'block';
            if (contentEns) contentEns.style.display = 'none';
        }
    };

    if (tabDet && tabEns) {
        tabDet.onclick = () => {
            meteoConfig.showEnsembles = false;
            updateTabUI();
            refreshMeteogram();
        };
        tabEns.onclick = () => {
            meteoConfig.showEnsembles = true;
            updateTabUI();
            refreshMeteogram();
        };
    }

    // Init Visuals
    updateTabUI();
}

// 2b. Reverse Geocoding Helper (Nominatim)
async function getLocationName(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=12`;
        const res = await fetch(url, { headers: { 'User-Agent': 'PlujaNeuApp/1.0' } });
        if (!res.ok) return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
        const data = await res.json();

        // Prioritat de noms
        const addr = data.address;
        if (!addr) return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

        let name = addr.village || addr.town || addr.city || addr.hamlet || addr.county || addr.municipality;
        if (name) return name;
        return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    } catch (e) {
        return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }
}

// 3. Mostrar Modal
async function showMeteogramModal(lat, lon) {
    const modal = document.getElementById('chart-modal');
    const modalTitle = document.getElementById('modal-title');
    if (!modal) return;

    modal.style.display = 'flex';
    modalTitle.innerText = `Carregant ubicació...`;

    getLocationName(lat, lon).then(name => {
        modalTitle.innerText = `Predicció: ${name}`;
    });

    // Hide star button for Meteogram (not a station)
    const favBtn = document.getElementById('favorite-station-btn');
    if (favBtn) favBtn.style.display = 'none';

    document.getElementById('modal-controls').style.display = 'none';
    const advControls = document.getElementById('modal-controls-advanced');
    advControls.style.display = 'flex';

    // Reset View to Chart by default
    activeViewMode = 'chart';
    updateMeteogramViewMode();

    initMeteogramControls();
    updateChipsVisuals();

    // Refresh immediately
    refreshMeteogram();
}

// Globals for switching views
let lastEnsembleData = null;
let lastDetData = null;

async function refreshMeteogram() {
    const canvas = document.getElementById('modal-canvas');
    const ctx = canvas.getContext('2d');

    if (meteogramChart) {
        meteogramChart.destroy();
        meteogramChart = null;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "14px Inter, sans-serif";
    ctx.fillStyle = "#666";
    ctx.textAlign = "center";
    ctx.fillText("Carregant dades...", canvas.width / 2, canvas.height / 2);

    try {
        let data, deterministicComparison;
        let isEnsembleMode = meteoConfig.showEnsembles;

        if (isEnsembleMode) {
            // Fetch ENSEMBLE + DETERMINISTIC
            [data, deterministicComparison] = await Promise.all([
                fetchEnsembleData(currentLat, currentLon),
                fetchDeterministicComparison(currentLat, currentLon, meteoConfig.ensembleModel)
            ]);
            // Save for Table View
            lastEnsembleData = data;
            lastDetData = deterministicComparison;
        } else {
            data = await fetchOpenMeteoForecast(currentLat, currentLon);
        }

        if (data) {
            renderMeteogramChart(ctx, data, isEnsembleMode, deterministicComparison);
        }
    } catch (e) {
        console.error(e);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillText("Error de dades", canvas.width / 2, canvas.height / 2);
    }
}

// 4. Fetch Standard
async function fetchOpenMeteoForecast(lat, lon) {
    const params = new URLSearchParams({
        latitude: lat,
        longitude: lon,
        timezone: 'auto',
        models: meteoConfig.model
    });

    let hourlyVars = [...meteoConfig.variables];
    params.append('hourly', hourlyVars.join(','));
    if (!hourlyVars.includes('weathercode')) params.append('hourly', 'weathercode');

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("API KO");
    return await res.json();
}

// 4b. Fetch ENSEMBLES (GFS/ECMWF) - 15 Dies
async function fetchEnsembleData(lat, lon) {
    let ensModel = meteoConfig.ensembleModel || 'gfs_seamless';
    // Use configured variables
    let vars = [...meteoConfig.ensembleVariables];

    // Fallback if empty
    if (vars.length === 0) vars = ['temperature_850hPa'];
    // Ensure all vars are requested

    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&hourly=${vars.join(',')}&models=${ensModel}&timezone=auto&forecast_days=15`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Ensemble API KO");
    return await res.json();
}

// 4c. Fetch Deterministic Comparison (For Overlay)
async function fetchDeterministicComparison(lat, lon, ensembleModel) {
    // Map ensemble model to deterministic model slug
    let detModel = 'gfs_seamless'; // default

    if (ensembleModel === 'ecmwf_ifs025') detModel = 'ecmwf_ifs025';
    if (ensembleModel === 'icon_seamless') detModel = 'icon_seamless';
    if (ensembleModel === 'gem_global') detModel = 'gem_global';
    if (ensembleModel === 'bom_access_global_ensemble') detModel = 'bom_access_global';

    // Vars: same as requested for ensembles
    let vars = [...meteoConfig.ensembleVariables];
    if (vars.length === 0) return null;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars.join(',')}&models=${detModel}&timezone=auto&forecast_days=15`;

    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn("Deterministic comparison fetch failed", e);
        return null;
    }
}

// Helper: Process Ensembles (Percentils)
function getEnsembleStats(hourly, varPrefix) {
    const time = hourly.time;
    // Busquem claus tipus "temperature_850hPa_member01", etc.
    const memberKeys = Object.keys(hourly).filter(k => k.startsWith(varPrefix) && k.includes('_member'));

    const p10 = [];
    const p25 = [];
    const median = [];
    const p75 = [];
    const p90 = [];

    // FIX: Si no hi ha membres (API retorna flat array, e.g. alguns models o fallback), tractem com a single member
    if (memberKeys.length === 0 && hourly[varPrefix]) {
        // Flat Array Logic
        const flatData = hourly[varPrefix];
        for (let i = 0; i < time.length; i++) {
            const v = flatData[i];
            const val = (v !== null && v !== undefined) ? v : 0;
            p10.push(val);
            p25.push(val);
            median.push(val);
            p75.push(val);
            p90.push(val);
        }
        return { time, p10, p25, median, p75, p90 };
    }

    for (let i = 0; i < time.length; i++) {
        const values = [];
        memberKeys.forEach(key => {
            const v = hourly[key][i];
            if (v !== null && v !== undefined) values.push(v);
        });

        values.sort((a, b) => a - b);

        if (values.length === 0) {
            values.push(0); // Fallback
        }

        const getP = (p) => {
            if (values.length === 0) return 0;
            const index = (p / 100) * (values.length - 1);
            const lower = Math.floor(index);
            const upper = Math.ceil(index);
            const weight = index - lower;
            return values[lower] * (1 - weight) + values[upper] * weight;
        };

        p10.push(getP(10));
        p25.push(getP(25));
        median.push(getP(50));
        p75.push(getP(75));
        p90.push(getP(90));
    }

    return { time, p10, p25, median, p75, p90 };
}

// 5. Render Chart Millorat (Multi-Mode)
function renderMeteogramChart(ctx, data, isEnsemble, detData) {
    const hoursCount = isEnsemble ? data.hourly.time.length : 72;
    let datasets = [];
    let labels = [];

    // --- CONFIG ENSEMBLES ---
    if (isEnsemble) {
        const refTime = data.hourly.time;
        labels = refTime.slice(0, hoursCount).map(t => {
            const d = new Date(t);
            return [d.getHours() + 'h', d.toLocaleDateString('ca-ES', { day: 'numeric', month: 'short' })];
        });

        const vars = meteoConfig.ensembleVariables;

        // 1. PRECIPITACIÓ (Fan Chart)
        if (vars.includes('precipitation')) {
            const precipStats = getEnsembleStats(data.hourly, 'precipitation');

            // Fan Layers
            datasets.push({ type: 'line', label: 'Pluja Max (90%)', data: precipStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(33, 150, 243, 0.15)', pointRadius: 0, fill: 'origin', yAxisID: 'yPrecip', order: 20 });
            datasets.push({ type: 'line', label: '_p25_rain', data: precipStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'yPrecip', order: 19 });
            datasets.push({ type: 'line', label: 'Pluja Probable (IQR)', data: precipStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(33, 150, 243, 0.3)', pointRadius: 0, fill: '-1', yAxisID: 'yPrecip', order: 18 });

            // Median (DASHED, Lighter Blue)
            datasets.push({
                type: 'line', label: 'Pluja (Mitjana)',
                data: precipStats.median.slice(0, hoursCount),
                borderColor: '#42a5f5', borderWidth: 2, borderDash: [4, 4], pointRadius: 0,
                fill: false, yAxisID: 'yPrecip', order: 15
            });

            // DETERMINISTIC OVERLAY (Precip) -> SOLID, Dark Blue
            if (detData && detData.hourly.precipitation) {
                datasets.push({
                    type: 'line', label: 'Pluja (Model OP)',
                    data: detData.hourly.precipitation.slice(0, hoursCount),
                    borderColor: '#0d47a1', borderWidth: 2, borderDash: [], pointRadius: 0,
                    fill: false, yAxisID: 'yPrecip', order: 14,
                    tension: 0.1
                });
            }
        }

        // 2. TEMPERATURA 850hPa (Fan Chart)
        if (vars.includes('temperature_850hPa') && (data.hourly.temperature_850hPa || data.hourly.temperature_850hPa_member01)) {
            const tempStats = getEnsembleStats(data.hourly, 'temperature_850hPa');

            // Fan Layers
            datasets.push({ label: 'T. 850hPa (Min 90%)', data: tempStats.p10.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 5, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 850hPa (Màx 90%)', data: tempStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(255, 165, 0, 0.15)', pointRadius: 0, fill: '-1', order: 4, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 850hPa (Min 50%)', data: tempStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 3, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 850hPa (Màx 50%)', data: tempStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(255, 140, 0, 0.4)', pointRadius: 0, fill: '-1', order: 2, yAxisID: 'yTemp' });

            // Median (DASHED, Orange)
            datasets.push({
                label: 'T. 850hPa (Mitjana)',
                data: tempStats.median.slice(0, hoursCount),
                borderColor: '#fb8c00', borderWidth: 2, borderDash: [4, 4], pointRadius: 0,
                tension: 0.4, fill: false, order: 1, yAxisID: 'yTemp'
            });

            // DETERMINISTIC OVERLAY (Temp) -> SOLID, Dark Red/Orange
            if (detData && detData.hourly.temperature_850hPa) {
                datasets.push({
                    label: 'T. 850hPa (Model OP)',
                    data: detData.hourly.temperature_850hPa.slice(0, hoursCount),
                    borderColor: '#d84315', borderWidth: 2, borderDash: [], pointRadius: 0,
                    tension: 0.4, fill: false, order: 0, yAxisID: 'yTemp'
                });
            }
        }



        // 2b. TEMPERATURA 500hPa (Fan Chart)
        if (vars.includes('temperature_500hPa') && (data.hourly.temperature_500hPa || data.hourly.temperature_500hPa_member01)) {
            const tempStats = getEnsembleStats(data.hourly, 'temperature_500hPa');

            datasets.push({ label: 'T. 500hPa (Min 90%)', data: tempStats.p10.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 25, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 500hPa (Màx 90%)', data: tempStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(156, 39, 176, 0.15)', pointRadius: 0, fill: '-1', order: 24, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 500hPa (Min 50%)', data: tempStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 23, yAxisID: 'yTemp' });
            datasets.push({ label: 'T. 500hPa (Màx 50%)', data: tempStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(156, 39, 176, 0.4)', pointRadius: 0, fill: '-1', order: 22, yAxisID: 'yTemp' });

            datasets.push({
                label: 'T. 500hPa (Mitjana)',
                data: tempStats.median.slice(0, hoursCount),
                borderColor: '#8E24AA', borderWidth: 2, borderDash: [4, 4], pointRadius: 0,
                tension: 0.4, fill: false, order: 21, yAxisID: 'yTemp'
            });

            // DETERMINISTIC OVERLAY (Temp 500) -> SOLID, Deep Purple
            if (detData && detData.hourly.temperature_500hPa) {
                datasets.push({
                    label: 'T. 500hPa (Model OP)',
                    data: detData.hourly.temperature_500hPa.slice(0, hoursCount),
                    borderColor: '#4A148C', borderWidth: 2, borderDash: [], pointRadius: 0,
                    tension: 0.4, fill: false, order: 20, yAxisID: 'yTemp'
                });
            }
        }

        // 3. PRESSIÓ (Fan Chart)
        if (vars.includes('pressure_msl') && (data.hourly.pressure_msl_member00 || data.hourly.pressure_msl_member01 || data.hourly.pressure_msl)) {
            const pressStats = getEnsembleStats(data.hourly, 'pressure_msl');

            datasets.push({ label: 'Pressió (Min 90%)', data: pressStats.p10.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'yPress', order: 35 });
            datasets.push({ label: 'Pressió (Màx 90%)', data: pressStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(150, 150, 150, 0.15)', pointRadius: 0, fill: '-1', yAxisID: 'yPress', order: 34 });
            datasets.push({ label: 'Pressió (Min 50%)', data: pressStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'yPress', order: 33 });
            datasets.push({ label: 'Pressió (Màx 50%)', data: pressStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(100, 100, 100, 0.3)', pointRadius: 0, fill: '-1', yAxisID: 'yPress', order: 32 });

            // Median (DASHED, Gray)
            datasets.push({
                label: 'Pressió (Mitjana)',
                data: pressStats.median.slice(0, hoursCount),
                borderColor: '#757575', borderWidth: 2, borderDash: [4, 4], pointRadius: 0,
                tension: 0.4, fill: false, yAxisID: 'yPress', order: 30
            });

            // DETERMINISTIC OVERLAY (Press) -> SOLID, Black
            if (detData && detData.hourly.pressure_msl) {
                datasets.push({
                    label: 'Pressió (Model OP)',
                    data: detData.hourly.pressure_msl.slice(0, hoursCount),
                    borderColor: '#000000', borderWidth: 1.5, borderDash: [], pointRadius: 0,
                    tension: 0.4, fill: false, order: 29, yAxisID: 'yPress'
                });
            }
        }

        // 4. VENT (Fan Chart)
        if (vars.includes('wind_speed_10m') && (data.hourly.wind_speed_10m || data.hourly.wind_speed_10m_member01)) {
            const windStats = getEnsembleStats(data.hourly, 'wind_speed_10m');
            datasets.push({ label: 'Vent (Min 90%)', data: windStats.p10.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 12, yAxisID: 'yWind' });
            datasets.push({ label: 'Vent (Màx 90%)', data: windStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(0, 150, 136, 0.15)', pointRadius: 0, fill: '-1', order: 11, yAxisID: 'yWind' });
            datasets.push({ label: 'Vent (Min 50%)', data: windStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 10, yAxisID: 'yWind' });
            datasets.push({ label: 'Vent (Màx 50%)', data: windStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(0, 150, 136, 0.3)', pointRadius: 0, fill: '-1', order: 9, yAxisID: 'yWind' });
            datasets.push({
                label: 'Vent (Mitjana)', data: windStats.median.slice(0, hoursCount),
                borderColor: '#00796B', borderWidth: 2, borderDash: [4, 4], pointRadius: 0, fill: false, order: 8, yAxisID: 'yWind'
            });
        }

        // 5. CAPE (Fan Chart)
        if (vars.includes('cape') && (data.hourly.cape || data.hourly.cape_member01)) {
            const capeStats = getEnsembleStats(data.hourly, 'cape');
            datasets.push({ label: 'CAPE (Màx Possible)', data: capeStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(255, 235, 59, 0.3)', pointRadius: 0, fill: 'origin', order: 25, yAxisID: 'yEnergy' });
            datasets.push({
                label: 'CAPE (Mitjana)', data: capeStats.median.slice(0, hoursCount),
                borderColor: '#FBC02D', borderWidth: 2, borderDash: [2, 2], pointRadius: 0, fill: false, order: 24, yAxisID: 'yEnergy'
            });
        }

        // 6. SNOWFALL (Fan Chart)
        if (vars.includes('snowfall') && (data.hourly.snowfall || data.hourly.snowfall_member01)) {
            const snowStats = getEnsembleStats(data.hourly, 'snowfall');

            datasets.push({ label: 'Neu (Possible)', data: snowStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(144, 202, 249, 0.4)', pointRadius: 0, fill: 'origin', order: 22, yAxisID: 'ySnow' });
            datasets.push({
                label: 'Neu (Mitjana)', data: snowStats.median.slice(0, hoursCount),
                borderColor: '#1976D2', borderWidth: 2, borderDash: [2, 2], pointRadius: 0, fill: false, order: 21, yAxisID: 'ySnow'
            });
        }

        // 7. FREEZING LEVEL (Fan Chart) - FIX ECMWF MISSING DATA
        if (vars.includes('freezinglevel_height') && (data.hourly.freezinglevel_height || data.hourly.freezinglevel_height_member01)) {
            const frzStats = getEnsembleStats(data.hourly, 'freezinglevel_height');

            datasets.push({ label: 'Cota 0º (Min 90%)', data: frzStats.p10.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 7, yAxisID: 'yHeight' });
            datasets.push({ label: 'Cota 0º (Màx 90%)', data: frzStats.p90.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(96, 125, 139, 0.15)', pointRadius: 0, fill: '-1', order: 6, yAxisID: 'yHeight' });

            datasets.push({ label: 'Cota 0º (Min 50%)', data: frzStats.p25.slice(0, hoursCount), borderColor: 'transparent', pointRadius: 0, fill: false, order: 5, yAxisID: 'yHeight' });
            datasets.push({ label: 'Cota 0º (Màx 50%)', data: frzStats.p75.slice(0, hoursCount), borderColor: 'transparent', backgroundColor: 'rgba(96, 125, 139, 0.35)', pointRadius: 0, fill: '-1', order: 4, yAxisID: 'yHeight' });

            datasets.push({
                label: 'Cota 0º (Mitjana)', data: frzStats.median.slice(0, hoursCount),
                borderColor: '#455A64', borderWidth: 2, borderDash: [4, 4], pointRadius: 0, fill: false, order: 3, yAxisID: 'yHeight'
            });
        }

    } else {
        // --- CONFIG STANDARD (Deterministic 72h) ---
        const hourly = data.hourly;
        labels = hourly.time.slice(0, hoursCount).map(t => {
            const d = new Date(t);
            return `${d.getHours()}h\n${d.getDate()}`;
        });

        if (hourly.temperature_2m) {
            datasets.push({ type: 'line', label: 'Temperatura', data: hourly.temperature_2m.slice(0, hoursCount), borderColor: '#D32F2F', backgroundColor: 'rgba(211, 47, 47, 0.1)', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true, yAxisID: 'yTemp' });
        }
        if (hourly.precipitation) {
            const precipData = hourly.precipitation.slice(0, hoursCount);
            datasets.push({ type: 'bar', label: 'Pluja (mm)', data: precipData, backgroundColor: 'rgba(25, 118, 210, 0.6)', borderColor: 'rgba(25, 118, 210, 1)', borderWidth: 0, borderRadius: 2, yAxisID: 'yPrecip', order: 2 });

            // Accumulation
            let acc = 0;
            const accumData = precipData.map(val => { acc += val; return acc; });
            datasets.push({ type: 'line', label: 'Acumulat (mm)', data: accumData, borderColor: '#0D47A1', borderWidth: 1.5, pointRadius: 0, borderDash: [2, 2], tension: 0.1, fill: false, yAxisID: 'yPrecip', order: 0 });
        }
        if (hourly.wind_speed_10m) {
            datasets.push({ type: 'line', label: 'Vent (km/h)', data: hourly.wind_speed_10m.slice(0, hoursCount), borderColor: '#00796B', borderWidth: 1.5, borderDash: [3, 3], pointRadius: 0, yAxisID: 'yWind', order: 10 });
        }
        if (hourly.wind_gusts_10m) {
            datasets.push({ type: 'line', label: 'Ratxes (km/h)', data: hourly.wind_gusts_10m.slice(0, hoursCount), borderColor: '#004d40', borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'yWind', order: 9 });
        }
        if (hourly.cloud_cover) {
            datasets.push({ type: 'line', label: 'Núvols (%)', data: hourly.cloud_cover.slice(0, hoursCount), borderColor: '#90a4ae', backgroundColor: 'rgba(144, 164, 174, 0.2)', borderWidth: 1, pointRadius: 0, fill: true, yAxisID: 'yCloud', order: 30 });
        }
        if (hourly.snowfall) {
            datasets.push({ type: 'bar', label: 'Neu (cm)', data: hourly.snowfall.slice(0, hoursCount), backgroundColor: 'rgba(144, 202, 249, 0.8)', yAxisID: 'yPrecip', offset: true, order: 25 });
        }
        if (hourly.pressure_msl) {
            datasets.push({ type: 'line', label: 'Pressió', data: hourly.pressure_msl.slice(0, hoursCount), borderColor: '#757575', borderWidth: 1, pointRadius: 0, yAxisID: 'yPress', order: 5 });
        }
    }

    // --- CHART OPTIONS ---
    const hasPress = datasets.some(d => d.yAxisID === 'yPress');

    meteogramChart = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: {
                    display: true,
                    text: isEnsemble ? `Ensembles (${meteoConfig.ensembleModel.toUpperCase()})` : `Predicció: ${meteoConfig.model.toUpperCase()}`,
                    font: { size: 15, family: "system-ui, sans-serif", weight: '600' },
                    color: '#333',
                    padding: { bottom: 15 }
                },
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true, boxWidth: 6, padding: 10, font: { size: 10 },
                        // Show all intervals so user can toggle them (removed Min/Max filter)
                        filter: item => !item.text.startsWith('_')
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#222', bodyColor: '#333', borderColor: 'rgba(0,0,0,0.1)', borderWidth: 1, cornerRadius: 6, padding: 8,
                    callbacks: {
                        label: function (context) {
                            // Show everything in tooltip
                            if (context.dataset.label.startsWith('_')) return null;
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) label += context.parsed.y.toFixed(1);
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: { grid: { display: true, color: 'rgba(0,0,0,0.03)', drawBorder: false }, ticks: { maxTicksLimit: isEnsemble ? 10 : 8, font: { size: 10 }, color: '#666', maxRotation: 0, autoSkip: true } },
                yTemp: { type: 'linear', display: datasets.some(d => d.yAxisID === 'yTemp'), position: 'left', title: { display: true, text: '°C', color: '#e65100', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false } },
                yPrecip: { type: 'linear', display: datasets.some(d => d.yAxisID === 'yPrecip'), position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'mm', color: '#1976D2', font: { size: 10 } } },
                yPress: { type: 'linear', display: hasPress, position: 'right', grid: { display: false }, title: { display: true, text: 'hPa', color: '#616161', font: { size: 10 } } },
                yWind: { type: 'linear', display: datasets.some(d => d.yAxisID === 'yWind'), position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'km/h', color: '#00796B', font: { size: 10 } } },
                yEnergy: { type: 'linear', display: datasets.some(d => d.yAxisID === 'yEnergy'), position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'J/kg', color: '#FBC02D', font: { size: 10 } } },
                ySnow: { type: 'linear', display: datasets.some(d => d.yAxisID === 'ySnow'), position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'cm', color: '#1976D2', font: { size: 10 } } },
                yHeight: { type: 'linear', display: datasets.some(d => d.yAxisID === 'yHeight'), position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'm', color: '#455A64', font: { size: 10 } } },
                yCloud: { type: 'linear', display: false, min: 0, max: 100, position: 'right', grid: { display: false } }
            }
        }
    });
}
// ===================================
// CUSTOM SOUNDING CONTROL
// ===================================
let isSoundingModeActive = false;
let soundingProbeMarker = null;
let soundingChart = null;

const soundingBtn = document.getElementById('toggle-sounding-btn');
const soundingModal = document.getElementById('sounding-modal');
const closeSoundingBtn = document.getElementById('close-sounding-btn');
const soundingTitle = document.getElementById('sounding-title');

// Initialize Draggable Sounding Modal
if (soundingModal && typeof makeDraggable === 'function') {
    // We target the header div for dragging
    // The header is the first child div of soundingModal
    const header = soundingModal.firstElementChild;
    if (header) {
        header.style.cursor = 'move';
        makeDraggable(soundingModal, header);
    }
}

// Initialize Sounding Control
if (soundingBtn) {
    soundingBtn.addEventListener('click', function () {
        isSoundingModeActive = !isSoundingModeActive;

        // Deactivate other modes
        if (isSoundingModeActive) {
            // Disable Meteogram mode if active
            if (typeof isMeteogramModeActive !== 'undefined' && isMeteogramModeActive) {
                document.getElementById('toggle-meteogram-btn').click();
            }

            this.style.backgroundColor = '#e1bee7'; // Light Purple
            this.style.border = '2px solid #8e24aa';

            // Enable Map Click for Sounding
            map.getContainer().style.cursor = 'crosshair';
            map.on('click', onMapClickSounding);

            // Spawn Probe at center (initial feedback)
            const center = map.getCenter();
            spawnSoundingProbe(center.lat, center.lng);

        } else {
            this.style.backgroundColor = '';
            this.style.border = '';
            map.getContainer().style.cursor = '';
            map.off('click', onMapClickSounding);

            removeSoundingProbe();
            if (soundingModal) soundingModal.style.display = 'none';
        }
    });
}

function onMapClickSounding(e) {
    if (!isSoundingModeActive) return;
    spawnSoundingProbe(e.latlng.lat, e.latlng.lng);
    fetchSoundingData(e.latlng.lat, e.latlng.lng);
}

// Minimize Logic
const minimizeSoundingBtn = document.getElementById('minimize-sounding-btn');
const skewtContainer = document.getElementById('skewt-container');

if (minimizeSoundingBtn && skewtContainer) {
    minimizeSoundingBtn.addEventListener('click', () => {
        if (skewtContainer.style.display === 'none') {
            // Restore
            skewtContainer.style.display = 'block';
            soundingModal.style.height = '80vh';
            minimizeSoundingBtn.innerText = '_';
        } else {
            // Minimize
            skewtContainer.style.display = 'none';
            soundingModal.style.height = 'auto'; // Shrink to header
            minimizeSoundingBtn.innerText = '□'; // Square or Expand symbol
        }
    });
}

if (closeSoundingBtn) {
    closeSoundingBtn.addEventListener('click', () => {
        if (soundingModal) {
            soundingModal.style.display = 'none';
            // Also deactivate mode? 
            if (isSoundingModeActive && soundingBtn) soundingBtn.click(); // Toggle off
        }
    });
}

function spawnSoundingProbe(lat, lon) {
    if (soundingProbeMarker) {
        soundingProbeMarker.setLatLng([lat, lon]);
    } else {
        const balloonIcon = L.divIcon({
            html: '<div style="font-size: 24px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);">🎈</div>',
            className: 'sounding-probe-icon',
            iconSize: [30, 30],
            iconAnchor: [15, 30]
        });

        // Click-and-Go: Draggable FALSE
        soundingProbeMarker = L.marker([lat, lon], {
            draggable: false, // User requested disable drag
            icon: balloonIcon,
            zIndexOffset: 1000
        }).addTo(map);

        // Initial fetch handled by caller usually
    }
}

function removeSoundingProbe() {
    if (soundingProbeMarker) {
        map.removeLayer(soundingProbeMarker);
        soundingProbeMarker = null;
    }
}

function renderSoundingChart(profile) {
    const ctx = document.getElementById('sounding-canvas').getContext('2d');

    if (soundingChart) {
        soundingChart.destroy();
    }

    // Pseudo Skew-T Logic
    // X-Axis: Temp (-40 to +40 approx)
    // Y-Axis: Pressure (Inverted Logarithmic ideally, but Linear Inverted works for MVP)

    // Datasets
    const dataTemp = profile.map(p => ({ x: p.temp, y: p.pressure }));
    const dataDew = profile.map(p => ({ x: p.dew, y: p.pressure }));

    // Wind Plugin Logic: Draw wind text/arrows on the right side
    const windPlugin = {
        id: 'windBarbs',
        afterDraw: (chart) => {
            const ctx = chart.ctx;
            const yAxis = chart.scales.y;
            const xAxis = chart.scales.x;
            const rightEdge = chart.chartArea.right;

            ctx.save();
            ctx.textAlign = 'left';
            ctx.font = '10px Arial';
            ctx.fillStyle = '#333';

            profile.forEach(p => {
                const y = yAxis.getPixelForValue(p.pressure);
                if (y > chart.chartArea.top && y < chart.chartArea.bottom) {
                    // Draw Wind Text (Simplified Barb)
                    // e.g. "20km/h ->"
                    // const text = `${Math.round(p.ws)} ${getWindArrow(p.wd)}`;
                    // ctx.fillText(text, rightEdge - 30, y); // Inside chart? No, maybe cleaner inside.

                    // Let's draw it just slightly inside or create padding.
                    // Or explicit arrow drawing
                    drawWindArrow(ctx, rightEdge - 20, y, p.ws, p.wd);
                }
            });
            ctx.restore();
        }
    };

    soundingChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Temperatura (°C)',
                    data: dataTemp,
                    borderColor: '#d32f2f', // Red
                    borderWidth: 2,
                    pointRadius: 2,
                    showLine: true,
                    tension: 0.2
                },
                {
                    label: 'Punt de Rosada (°C)',
                    data: dataDew,
                    borderColor: '#388e3c', // Green
                    borderWidth: 2,
                    pointRadius: 2,
                    showLine: true,
                    tension: 0.2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { right: 40 } // Space for wind barbs
            },
            scales: {
                y: {
                    type: 'logarithmic', // Log Scale for Pressure is more realistic
                    reverse: true, // 1000 bottom, 200 top
                    title: { display: true, text: 'Pressió (hPa)' },
                    min: 200,
                    max: 1000,
                    ticks: {
                        callback: function (value, index, values) {
                            // Show standard levels clearly
                            if ([1000, 850, 700, 500, 300, 200].includes(value)) return value;
                            return null;
                        }
                    }
                },
                x: {
                    type: 'linear',
                    position: 'bottom',
                    title: { display: true, text: 'Temperatura (°C)' },
                    grid: { color: '#eee' },
                    min: -60, // Fixed range helps comparison
                    max: 40
                }
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        title: (items) => `Pressió: ${items[0].parsed.y} hPa`,
                        label: (context) => {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.x !== null) label += context.parsed.x.toFixed(1);
                            return label;
                        }
                    }
                },
                legend: { position: 'bottom' }
            }
        },
        plugins: [windPlugin]
    });
}

async function fetchSoundingData(lat, lon, useFallback = false) {
    if (!soundingModal) return;
    soundingModal.style.display = 'flex';

    // Fix for Minimize Bug: Auto-maximize on new fetch
    // If skewt-container is hidden (minimized), D3 reads 0x0 dimensions and renders nothing.
    const skewtContainer = document.getElementById('skewt-container');
    const minBtn = document.getElementById('minimize-sounding-btn');
    if (skewtContainer && skewtContainer.style.display === 'none') {
        skewtContainer.style.display = 'block';
        soundingModal.style.height = '80vh';
        if (minBtn) minBtn.innerText = '_';
    }
    if (!useFallback) soundingTitle.innerText = `Sondatge: ${lat.toFixed(3)}, ${lon.toFixed(3)} (Carregant AROME...)`;
    else soundingTitle.innerText = `Sondatge: ${lat.toFixed(3)}, ${lon.toFixed(3)} (Carregant Seguretat...)`;

    // Fetch Pressure Level Data (1000hPa -> 200hPa)
    const levels = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200];
    // Note: AROME might not support all these levels in Open-Meteo, but let's try.
    // Standard layers usually work.

    // Variables needed for Skew-T: Temp, Dewpoint, Wind Spd, Wind Dir.
    const vars = levels.map(l => `temperature_${l}hPa,dewpoint_${l}hPa,windspeed_${l}hPa,winddirection_${l}hPa`).join(',');
    // extra vars: cape, lifted_index, freezing_level_height (hourly), snowfall_height
    let extraVars = 'cape,lifted_index,freezing_level_height,snowfall_height';

    // Using AROME France (meteofrance_arome)
    // Fallback logic
    let models = 'arome_france';
    if (useFallback) models = 'icon_eu'; // Fixed: icon_central_europe was invalid

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars},${extraVars}&timezone=auto&forecast_days=1&models=${models}`;

        // 1. Fetch Weather Data (Primary)
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`API Error ${res.status}`);
        }
        const data = await res.json();

        // Find current hour index
        const now = new Date();
        const times = data.hourly.time;
        const nowTime = now.getTime();
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < times.length; i++) {
            const t = new Date(times[i]).getTime();
            const diff = Math.abs(t - nowTime);
            if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
            }
        }

        const timestamp = times[closestIdx].slice(11);
        const modelNameDisplay = useFallback ? 'ICON-EU' : 'AROME';

        // Initial Title (No Location yet)
        soundingTitle.innerText = `Sondatge: ${lat.toFixed(3)}, ${lon.toFixed(3)} (${modelNameDisplay} @ ${timestamp}h)`;

        // Parse Profile
        const profile = levels.map(lvl => {
            return {
                pressure: lvl,
                temp: data.hourly[`temperature_${lvl}hPa`][closestIdx],
                dew: data.hourly[`dewpoint_${lvl}hPa`][closestIdx],
                ws: data.hourly[`windspeed_${lvl}hPa`][closestIdx],
                wd: data.hourly[`winddirection_${lvl}hPa`][closestIdx]
            };
        });

        const safeVal = (arr, idx) => (arr && arr[idx] !== null && arr[idx] !== undefined) ? arr[idx] : null;

        // Calc Fallback Freezing Level from Profile (Interp T=0)
        let calcFreezingLevel = null;
        for (let i = 0; i < profile.length - 1; i++) {
            if (profile[i].temp === null || profile[i].temp === undefined) continue;

            let j = i + 1;
            while (j < profile.length && (profile[j].temp === null || profile[j].temp === undefined)) {
                j++;
            }
            if (j >= profile.length) break;

            const p1 = profile[i].pressure;
            const t1 = profile[i].temp;
            const p2 = profile[j].pressure;
            const t2 = profile[j].temp;

            // Crossing 0 from warm to cold (upwards)
            if (t1 >= 0 && t2 < 0) {
                // Linear Interp
                const frac = (0 - t1) / (t2 - t1);
                const pZero = p1 + frac * (p2 - p1);
                // Convert P to Altitude (Std Atmos)
                // h = 44330 * (1 - (p/1013.25)^0.1903)
                calcFreezingLevel = 44330 * (1 - Math.pow(pZero / 1013.25, 0.1903));
                break; // Take lowest freezing level
            }
        }

        let fl = safeVal(data.hourly.freezing_level_height, closestIdx);
        if (fl === null) fl = calcFreezingLevel;

        let sl = safeVal(data.hourly.snowfall_height, closestIdx);
        // Estimate Snow Level if null: FL - 300m (approx)
        if (sl === null && fl !== null) sl = Math.max(0, fl - 300);

        const meta = {
            location: "Desconegut...", // Placeholder
            model: modelNameDisplay,
            time: timestamp,
            cape: safeVal(data.hourly.cape, closestIdx) || 0,
            lifted_index: safeVal(data.hourly.lifted_index, closestIdx),
            freezing_level: fl,
            snow_level: sl
        };

        // Render Immediately
        let chartInstance = null;
        if (typeof initSkewT === 'function') {
            chartInstance = initSkewT('#skewt-container', profile, meta);
        }

        // 2. Async Geocoding (Update Title Later)
        getLocationName(lat, lon).then(locName => {
            if (locName) {
                soundingTitle.innerText = `Sondatge: ${locName} (${modelNameDisplay} @ ${timestamp}h)`;
                // Optionally update chart meta if needed, but title is enough
            }
        }).catch(err => console.warn("Geocoding failed", err));

    } catch (e) {
        console.error(e);
        if (!useFallback) {
            console.log("AROME failed, trying fallback...");
            fetchSoundingData(lat, lon, true);
        } else {
            soundingTitle.innerText = "Error: Dades no disponibles (" + e.message + ")";
        }
    }
}

// Old Chart.js Render Function Removed / Deprecated
// function renderSoundingChart(profile) { ... }

// --- V3 RECORDER ORCHESTRATOR (Refactored) ---
$(document).ready(function () {
    const recorder = new ScreenRecorder();
    let selectedFormat = 'video';
    let isCropMode = false;

    // --- 1. UI Bindings ---
    // Clean up any potential old bindings first
    $('#record-btn').off('click').on('click', () => {
        if (recorder.isRecording) {
            recorder.stopRecording();
        } else {
            $('#recording-modal').fadeIn(200);
            updateModalUI();
        }
    });

    $('#rec-fullscreen-btn').off('click').click(() => { isCropMode = false; updateModalUI(); });
    $('#rec-crop-btn').off('click').click(() => { isCropMode = true; updateModalUI(); });

    // Format Selection Triggers Flow
    $('#record-webm-btn').off('click').click(() => startFlow('video'));
    $('#record-gif-btn').off('click').click(() => startFlow('gif'));

    $('#close-recording-modal').off('click').click(() => $('#recording-modal').fadeOut(200));

    function updateModalUI() {
        if (isCropMode) {
            $('#rec-crop-btn').css({ border: '2px solid #2196f3', background: '#e3f2fd', color: '#1565c0' });
            $('#rec-fullscreen-btn').css({ border: '2px solid #ddd', background: '#f9f9f9', color: '#666' });
        } else {
            $('#rec-fullscreen-btn').css({ border: '2px solid #2196f3', background: '#e3f2fd', color: '#1565c0' });
            $('#rec-crop-btn').css({ border: '2px solid #ddd', background: '#f9f9f9', color: '#666' });
        }
    }

    // --- 2. Flow Control ---
    async function startFlow(format) {
        selectedFormat = format;
        $('#recording-modal').hide();

        try {
            // A. Get Stream FIRST
            console.log("Requesting stream...");
            const stream = await recorder.initStream();
            console.log("Stream granted:", stream.id);

            if (isCropMode) {
                // B. If Crop -> Show Preview
                showPreview(stream);
            } else {
                // C. If Full -> Start Immediately
                startRecordingProcess(stream, null);
            }
        } catch (err) {
            console.error("Stream cancelled or failed:", err);
            // Show Modal Again if user cancelled (optional, or just alert)
            alert("S'ha cancel·lat la gravació o no s'ha donat permís.");
            $('#recording-modal').show();
        }
    }

    // --- 3. Preview & Crop Logic (Immersive Snapshot) ---
    const $previewOverlay = $('#video-preview-overlay');
    const $previewVideo = $('#preview-video');
    const $previewCanvas = $('#preview-canvas');
    const $drawLayer = $('#preview-drawing-layer');
    const $cropBox = $('#preview-crop-box');

    let startX, startY, isDrawing = false;
    let cropRect = null;

    function showPreview(stream) {
        // --- STEALTH MODE START ---
        // 1. Hide EVERYTHING immediately.
        // The user should see their own clean desktop.
        $('#recording-modal').hide();
        $previewOverlay.hide();
        $('#preview-loading').hide(); // Not used in stealth mode

        const video = $previewVideo[0];
        video.srcObject = stream;

        console.log("Stealth capture starting... waiting 1000ms");

        // 2. Play video internally (user sees nothing yet)
        video.play().then(() => {
            // 3. BLIND WAIT (1000ms)
            // Allow browser UI to settle and 'Sharing' banner to appear.
            setTimeout(() => {
                // 4. CAPTURE SNAPSHOT
                const canvas = $previewCanvas[0];
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // Capture Static Frame

                console.log("Snapshot taken. Showing overlay.");

                // 5. REVEAL OVERLAY (Frozen)
                $previewOverlay.css('display', 'flex');

                // Enable interaction
                $drawLayer.css('pointer-events', 'auto');
                $cropBox.hide();
                cropRect = null;

            }, 1000); // 1 Second stealth wait
        }).catch(e => {
            console.error("Preview play err:", e);
            alert("Error iniciant la captura: " + e.message);
            $('#recording-modal').show();
        });

        // --- DRAWING LOGIC ---
        $drawLayer.off('mousedown mousemove mouseup');

        $drawLayer.on('mousedown', (e) => {
            isDrawing = true;
            startX = e.clientX;
            startY = e.clientY;

            $cropBox.css({
                position: 'fixed',
                left: startX,
                top: startY,
                width: 0,
                height: 0,
                display: 'block'
            });
        });

        $drawLayer.on('mousemove', (e) => {
            if (!isDrawing) return;
            const curX = e.clientX;
            const curY = e.clientY;

            const w = curX - startX;
            const h = curY - startY;

            $cropBox.css({
                left: w < 0 ? curX : startX,
                top: h < 0 ? curY : startY,
                width: Math.abs(w),
                height: Math.abs(h)
            });
        });

        $drawLayer.on('mouseup', () => {
            isDrawing = false;
            cropRect = {
                x: parseInt($cropBox.css('left')),
                y: parseInt($cropBox.css('top')),
                w: parseInt($cropBox.css('width')),
                h: parseInt($cropBox.css('height'))
            };
        });

        $('#cancel-preview-btn').off('click').click(() => {
            if (video.srcObject) {
                video.srcObject.getTracks().forEach(t => t.stop());
            }
            $previewOverlay.hide();
            $('#recording-modal').show();
        });

        $('#confirm-crop-btn').off('click').click(() => {
            if (!cropRect || cropRect.w < 50 || cropRect.h < 50) {
                alert("Selecciona una àrea més gran!");
                return;
            }

            const canvas = $previewCanvas[0];
            const rect = canvas.getBoundingClientRect(); // Visual Dimensions

            // 1. Mouse relative to visual canvas
            const relX = cropRect.x - rect.left;
            const relY = cropRect.y - rect.top;

            // 2. Scale Factor
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            // 3. Apply Scaling to get Intrinsic Video Coordinates
            // Use Math.round to avoid sub-pixel blurring
            const finalCrop = {
                x: Math.round(Math.max(0, relX * scaleX)),
                y: Math.round(Math.max(0, relY * scaleY)),
                w: Math.round(cropRect.w * scaleX),
                h: Math.round(cropRect.h * scaleY)
            };

            // Force Even Dimensions (Codec Requirement for sharpness)
            if (finalCrop.w % 2 !== 0) finalCrop.w -= 1;
            if (finalCrop.h % 2 !== 0) finalCrop.h -= 1;

            // Ensure within bounds
            if (finalCrop.x + finalCrop.w > canvas.width) finalCrop.w = canvas.width - finalCrop.x;
            if (finalCrop.y + finalCrop.h > canvas.height) finalCrop.h = canvas.height - finalCrop.y;

            // Double check evenness after clamp
            if (finalCrop.w % 2 !== 0) finalCrop.w -= 1;
            if (finalCrop.h % 2 !== 0) finalCrop.h -= 1;

            const stream = $previewVideo[0].srcObject;
            // Detach from preview video so it stops playing there, but keep stream alive for recorder
            $previewVideo[0].srcObject = null;
            $previewOverlay.hide();

            startRecordingProcess(stream, finalCrop);
        });
    }

    // --- 4. Final Countdown & Launch ---
    function startRecordingProcess(stream, cropRegion) {
        recorder.onCountdownTick = (sec) => {
            if (sec > 0) {
                $('#countdown-overlay').css('display', 'flex');
                $('#countdown-number').text(sec);
            } else {
                $('#countdown-overlay').hide();
            }
        };
        recorder.startRecording(stream, selectedFormat, cropRegion);
    }
});
// ==========================================
// ENSEMBLE TABLES LOGIC (New Feature)
// ==========================================
let currentTableVariable = 'temperature_850hPa'; // Default
let activeViewMode = 'chart'; // 'chart' or 'table'

// Render the Heatmap Table
function renderEnsembleTable(data, detData, variable) {
    const container = document.getElementById('modal-table-container');
    if (!container) return;

    if (!data || !data.hourly) {
        container.innerHTML = '<div style="padding:20px; text-align:center;">Dades no disponibles</div>';
        return;
    }

    const hourly = data.hourly;
    const time = hourly.time;
    // Filter member keys for this variable
    const memberKeys = Object.keys(hourly).filter(k => k.startsWith(variable) && k.includes('_member'));
    // Sort member keys to be 01, 02...
    memberKeys.sort();

    // Deterministic Data
    let detValues = null;
    if (detData && detData.hourly && detData.hourly[variable]) {
        detValues = detData.hourly[variable];
    }

    // Build Table HTML
    let html = '<div class="ensemble-table-container">';
    html += '<table class="ensemble-table">';

    // HEADER: Time Axis (X)
    html += '<thead>';
    html += '<tr>';
    html += '<th style="text-align:center;">Membres</th>'; // Top-left corner
    for (let i = 0; i < time.length; i++) {
        const t = new Date(time[i]);
        // Format Date: "30/12 12h"
        const dateStr = t.toLocaleDateString('ca-ES', { day: '2-digit', month: '2-digit' }) + '<br>' + t.getHours() + 'h';
        html += `<th>${dateStr}</th>`;
    }
    html += '</tr></thead>';

    // BODY: Members Axis (Y)
    html += '<tbody>';

    // Row 1: Deterministic (Special)
    html += '<tr>';
    html += '<th title="Model determinista d\'alta resolució">DET</th>';
    for (let i = 0; i < time.length; i++) {
        let detVal = detValues ? detValues[i] : (hourly[variable] ? hourly[variable][i] : null);
        if (detVal !== null && detVal !== undefined) {
            const color = getColorForValue(detVal, variable);
            const valFormatted = detVal.toFixed(1);
            html += `<td style="background-color: ${color};" title="DET: ${valFormatted}">${valFormatted}</td>`;
        } else {
            html += `<td style="background-color: #eee;">-</td>`;
        }
    }
    html += '</tr>';

    // Rows 2...N: Ensemble Members
    memberKeys.forEach((key, idx) => {
        const memberNum = idx + 1;
        html += '<tr>';
        html += `<th>M${memberNum}</th>`;

        for (let i = 0; i < time.length; i++) {
            const val = hourly[key][i];
            if (val !== null && val !== undefined) {
                const color = getColorForValue(val, variable);
                const valFormatted = val.toFixed(0); // Usually int for members saves space, or 1 decimal
                html += `<td style="background-color: ${color};" title="M${memberNum}: ${valFormatted}">${valFormatted}</td>`;
            } else {
                html += `<td style="background-color: #eee;"></td>`;
            }
        }
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
}

// Color Scale Logic
function getColorForValue(val, variable) {
    // 1. TEMPERATURE (850, 500, 2m)
    if (variable.includes('temperature')) {
        // -20 (Deep Blue) -> 0 (White) -> 30 (Red)
        if (val <= -20) return '#3f51b5'; // Indigo
        if (val <= -10) return '#2196f3'; // Blue
        if (val <= -5) return '#64b5f6'; // Light Blue
        if (val < 0) return '#bbdefb'; // Very Light Blue
        if (val === 0) return '#ffffff'; // White
        if (val < 5) return '#c8e6c9'; // Pale Green (Cool/Pleasant)
        if (val < 10) return '#fff9c4'; // Pale Yellow
        if (val < 15) return '#ffecb3'; // Amber
        if (val < 20) return '#ffcc80'; // Orange
        if (val < 25) return '#ffab91'; // Deep Orange
        if (val >= 25) return '#ff7043'; // Red
        return '#fff';
    }

    // 2. PRECIPITATION / SNOW
    if (variable.includes('precipitation') || variable.includes('snowfall')) {
        if (val == 0) return '#ffffff';
        if (val < 0.5) return '#e3f2fd';
        if (val < 2) return '#90caf9';
        if (val < 5) return '#42a5f5';
        if (val < 10) return '#1e88e5'; // Blue
        if (val < 20) return '#1565c0'; // Dark Blue
        if (val >= 20) return '#8e24aa'; // Purple (Heavy)
        return '#fff';
    }

    // 3. WIND
    if (variable.includes('wind')) {
        if (val < 10) return '#e0f2f1'; // Teal 50
        if (val < 20) return '#b2dfdb';
        if (val < 40) return '#80cbc4';
        if (val < 60) return '#fb8c00'; // Orange Warning
        if (val < 80) return '#f4511e'; // Deep Orange
        if (val >= 80) return '#d32f2f'; // Red
        return '#ffffff';
    }

    // 4. CAPE
    if (variable.includes('cape')) {
        if (val < 100) return '#ffffff';
        if (val < 500) return '#fffde7'; // Yellow 50
        if (val < 1000) return '#fff59d';
        if (val < 2000) return '#ffcc80'; // Orange
        if (val >= 2000) return '#ff5252'; // Red
        return '#fff';
    }

    // 5. FREEZING LEVEL
    if (variable.includes('freezinglevel')) {
        // Low = Cold (Blue), High = Warm (Red)
        if (val < 500) return '#90caf9';
        if (val < 1000) return '#e3f2fd';
        if (val < 2000) return '#fff';
        if (val < 3000) return '#fff3e0';
        if (val >= 3000) return '#ffcc80';
        return '#fff';
    }

    return '#ffffff';
    return '#ffffff';
}

function getTempRgbaColor(temp) {
    const alpha = 1;
    if (temp < -18) return `rgba(69, 39, 160, ${alpha})`;
    if (temp < -16) return `rgba(86, 54, 163, ${alpha})`;
    if (temp < -14) return `rgba(91, 73, 168, ${alpha})`;
    if (temp < -12) return `rgba(88, 91, 179, ${alpha})`;
    if (temp < -10) return `rgba(81, 110, 194, ${alpha})`;
    if (temp < -8) return `rgba(66, 133, 212, ${alpha})`;
    if (temp < -6) return `rgba(41, 158, 229, ${alpha})`;
    if (temp < -4) return `rgba(13, 179, 238, ${alpha})`;
    if (temp < -2) return `rgba(0, 191, 243, ${alpha})`;
    if (temp < 0) return `rgba(0, 200, 235, ${alpha})`;
    if (temp < 2) return `rgba(20, 209, 203, ${alpha})`;
    if (temp < 4) return `rgba(40, 196, 171, ${alpha})`;
    if (temp < 6) return `rgba(65, 184, 140, ${alpha})`;
    if (temp < 8) return `rgba(90, 189, 110, ${alpha})`;
    if (temp < 10) return `rgba(125, 201, 85, ${alpha})`;
    if (temp < 12) return `rgba(160, 213, 60, ${alpha})`;
    if (temp < 14) return `rgba(195, 225, 45, ${alpha})`;
    if (temp < 16) return `rgba(230, 238, 30, ${alpha})`;
    if (temp < 18) return `rgba(255, 220, 20, ${alpha})`;
    if (temp < 20) return `rgba(255, 195, 15, ${alpha})`;
    if (temp < 22) return `rgba(255, 170, 10, ${alpha})`;
    if (temp < 24) return `rgba(255, 145, 5, ${alpha})`;
    if (temp < 26) return `rgba(255, 120, 0, ${alpha})`;
    if (temp < 28) return `rgba(255, 95, 10, ${alpha})`;
    if (temp < 30) return `rgba(255, 70, 20, ${alpha})`;
    if (temp < 32) return `rgba(250, 50, 40, ${alpha})`;
    if (temp < 34) return `rgba(245, 30, 60, ${alpha})`;
    if (temp < 36) return `rgba(240, 20, 90, ${alpha})`;
    if (temp < 38) return `rgba(235, 10, 120, ${alpha})`;
    if (temp < 40) return `rgba(225, 0, 150, ${alpha})`;
    if (temp < 42) return `rgba(205, 0, 165, ${alpha})`;
    if (temp < 44) return `rgba(185, 0, 180, ${alpha})`;
    if (temp < 46) return `rgba(160, 0, 190, ${alpha})`;
    return `rgba(140, 0, 200, ${alpha})`;
}

function getContrastYIQ(hexcolor) {
    // If hex is not valid, return black
    if (!hexcolor.startsWith('#')) return 'black';
    hexcolor = hexcolor.replace("#", "");
    var r = parseInt(hexcolor.substr(0, 2), 16);
    var g = parseInt(hexcolor.substr(2, 2), 16);
    var b = parseInt(hexcolor.substr(4, 2), 16);
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? 'black' : 'white';
}

// Update View Mode (Chart vs Table)
function updateMeteogramViewMode() {
    const chartCanvas = document.getElementById('modal-canvas');
    const tableContainer = document.getElementById('modal-table-container');
    const tableControls = document.getElementById('table-controls');
    const ensembleChips = document.getElementById('ensemble-chips-container');
    const btnChart = document.getElementById('view-mode-chart');
    const btnTable = document.getElementById('view-mode-table');

    if (activeViewMode === 'table') {
        // Show Table
        chartCanvas.style.display = 'none';
        tableContainer.style.display = 'block';
        tableControls.style.display = 'block';
        ensembleChips.style.display = 'none'; // Hide multi-select in table mode

        btnChart.classList.remove('active');
        btnChart.style.background = 'white';
        btnTable.classList.add('active');
        btnTable.style.background = '#e3f2fd';

        // Populate Select if needed
        updateTableVariableOptions();

        // Render
        if (lastEnsembleData) {
            renderEnsembleTable(lastEnsembleData, lastDetData, currentTableVariable);
        }
    } else {
        // Show Chart
        chartCanvas.style.display = 'block';
        tableContainer.style.display = 'none';
        tableControls.style.display = 'none';
        ensembleChips.style.display = 'flex'; // Restore chips

        btnTable.classList.remove('active');
        btnTable.style.background = 'white';
        btnChart.classList.add('active');
        btnChart.style.background = '#e3f2fd';

        // Re-render chart if needed (usually canvas retains content, but resizing might be needed)
    }
}

function updateTableVariableOptions() {
    const select = document.getElementById('table-variable-select');
    if (!select) return;

    // Clear existing
    select.innerHTML = '';

    const vars = meteoConfig.ensembleVariables;
    const names = {
        'temperature_850hPa': '🌡️ Temp 850hPa',
        'temperature_500hPa': '🌡️ Temp 500hPa',
        'precipitation': '🌧️ Pluja',
        'wind_speed_10m': '💨 Vent 10m',
        'pressure_msl': '📉 Pressió',
        'snowfall': '❄️ Neu',
        'cape': '⚡ CAPE',
        'freezinglevel_height': '🏔️ Cota 0º'
    };

    vars.forEach(v => {
        // Only show checked vars? Or all available? 
        // For now, show all available in config
        const opt = document.createElement('option');
        opt.value = v;
        opt.innerText = names[v] || v;
        if (v === currentTableVariable) opt.selected = true;
        select.appendChild(opt);
    });
}

// ======================================================
// SEGUIMENT AMIC (TRACKING)
// ======================================================
let isTrackingActive = false;
let trackingInterval = null;
let routingControl = null;

// Tracked Users Config & State
// Tracked Users Config & State
// Tracked Users Config & State
// Tracked Users Config & State
const TRACKED_USERS = {
    'jan': {
        currentUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/ubicacions/jan/actual.json',
        historyUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/historial/jan/punts.json',
        name: 'Jan',
        initials: 'JA',
        avatar: 'https://ui-avatars.com/api/?name=Jan&background=6c757d&color=fff&size=128&font-size=0.4',
        marker: null,
        historyPolyline: null,
        lastUpdate: 0,
        data: null,
        showingHistory: false
    },
    'alex': {
        currentUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/ubicacions/alex/actual.json',
        historyUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/historial/alex/punts.json',
        name: 'Àlex',
        initials: 'AL',
        avatar: 'https://ui-avatars.com/api/?name=Alex&background=6c757d&color=fff&size=128&font-size=0.4',
        marker: null,
        historyPolyline: null,
        lastUpdate: 0,
        data: null,
        showingHistory: false
    },
    'raimon': {
        currentUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/ubicacions/raimon/actual.json',
        historyUrl: 'https://radarp4e-default-rtdb.europe-west1.firebasedatabase.app/historial/raimon/punts.json',
        name: 'Raimon',
        initials: 'RA',
        avatar: 'https://ui-avatars.com/api/?name=Raimon&background=6c757d&color=fff&size=128&font-size=0.4',
        marker: null,
        historyPolyline: null,
        lastUpdate: 0,
        data: null,
        showingHistory: false
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // 1. Sidebar Toggle
    const trackBtn = document.getElementById('track-friend-btn');
    const sidebar = document.getElementById('tracking-sidebar');
    const closeSidebarBtn = document.getElementById('close-tracking-sidebar');

    if (trackBtn) {
        trackBtn.addEventListener('click', () => {
            console.log("Track button clicked. Active?", isTrackingActive);
            // Toggle Logic
            if (isTrackingActive) {
                stopTracking();
                sidebar.style.display = 'none';
                trackBtn.style.background = '';
                trackBtn.style.boxShadow = '';
            } else {
                startTracking();
                sidebar.style.display = 'block';
                trackBtn.style.background = 'linear-gradient(135deg, #28a745 0%, #218838 100%)';
                trackBtn.style.boxShadow = '0 0 10px rgba(40, 167, 69, 0.6)';
            }
        });
    }

    if (closeSidebarBtn) {
        closeSidebarBtn.addEventListener('click', () => {
            // Just hide sidebar, keep tracking in background? Or stop? 
            // Requirement says "Mur de la Vergonya" summarizes state, implies it stays open while tracking.
            // If closed, maybe just hide UI but keep tracking? Let's stop to be consistent with toggle.
            sidebar.style.display = 'none';
            if (isTrackingActive) {
                // Determine if we should stop. For now, let's just Close UI
            }
        });
    }

    // 2. Routing & History Controls
    document.getElementById('routing-search-btn')?.addEventListener('click', handleDestSearch);
    document.getElementById('clear-route-btn')?.addEventListener('click', clearRoute);

    document.getElementById('tracking-history-range')?.addEventListener('change', (e) => {
        updateAllTrails(parseFloat(e.target.value));
    });
});



// --- POLLING TRACKING (Clean & Wipe) ---
function startTracking() {
    console.log("Iniciant seguiment (Polling cada 2s)...");
    isTrackingActive = true;

    // Initial fetch
    fetchFriendLocation();

    // Interval
    trackingInterval = setInterval(fetchFriendLocation, 2000);

    renderTrackingSidebar();
    cleanupHistory(); // Maintenance once on start
}

function stopTracking() {
    console.log("Aturant seguiment...");
    isTrackingActive = false;
    if (trackingInterval) clearInterval(trackingInterval);

    Object.values(TRACKED_USERS).forEach(user => {
        if (user.marker) { user.marker.remove(); user.marker = null; }
        if (user.historyPolyline) { user.historyPolyline.remove(); user.historyPolyline = null; }
    });

    clearRoute();
}

async function fetchFriendLocation() {
    if (!isTrackingActive) return;

    try {
        await Promise.all(Object.keys(TRACKED_USERS).map(async (key) => {
            const user = TRACKED_USERS[key];
            if (!user.currentUrl) return;

            // 1. Fetch entire 'current' folder
            try {
                const response = await fetch(user.currentUrl);
                if (!response.ok) return;

                let json = await response.json();
                if (!json) return; // Nothing new

                // 2. Find Latest Entry (Handle Push IDs)
                let latestEntry = null;

                if (json.lat) {
                    latestEntry = json; // Flat object
                } else {
                    // Map of IDs
                    let maxTst = 0;
                    Object.keys(json).forEach(k => {
                        const entry = json[k];
                        if (entry && typeof entry === 'object' && entry.tst > maxTst && entry.lat) {
                            maxTst = entry.tst;
                            latestEntry = entry;
                        }
                    });
                }

                if (latestEntry) {
                    // 3. Update Map
                    console.log(`Dada rebuda de ${user.name}`);
                    updateUserState(key, latestEntry);

                    // 4. MAINTENANCE: Move to History & WIPE 'current'
                    await maintainUserDb(user, latestEntry);
                } else {
                    // Even if we couldn't parse a valid entry, if there's garbage, WIPE IT
                    // to prevent stuck loop?
                    // "modifica el fetch perquè agafi l'objecte, l'analitzi i faci un DELETE... immediatament"
                    // Let's force wipe to ensure clean state if we found *something* but it was weird.
                    await fetch(user.currentUrl, { method: 'DELETE' });
                }

            } catch (err) {
                console.warn(`Error tracking ${user.name}`, err);
            }
        }));

        renderTrackingSidebar();

    } catch (error) {
        console.error("General tracking loop error", error);
    }
}

// Helper: Save copy -> Wipe buffer
async function maintainUserDb(user, latestEntry) {
    try {
        // A. Add to History
        await fetch(user.historyUrl, {
            method: 'POST',
            body: JSON.stringify(latestEntry)
        });

        // B. Wipe 'Current' buffer (DELETE)
        await fetch(user.currentUrl, {
            method: 'DELETE'
        });

    } catch (e) {
        console.error(`DB Maintenance failed for ${user.name}`, e);
    }
}

// ...

function pingUser(userKey) {
    if (!confirm(`Vols demanar una ubicació actualitzada a ${TRACKED_USERS[userKey].name}?`)) return;
    sendUserCommand(userKey, {
        "_type": "cmd",
        "action": "reportLocation"
    });
    alert("Demanada enviada! 🚀");
}

function toggleLiveMode(userKey) {
    const user = TRACKED_USERS[userKey];
    if (!user) return;

    // Toggle state
    user.liveMode = !user.liveMode;

    if (user.liveMode) {
        // TURN ON -> Mode 2
        sendUserCommand(userKey, {
            "_type": "cmd",
            "action": "setConfiguration",
            "configuration": { "mode": 2 }
        });

        // Auto-off timer (20 mins)
        if (user.liveTimeout) clearTimeout(user.liveTimeout);
        user.liveTimeout = setTimeout(() => {
            console.log(`Auto-off Live Mode for ${user.name}`);
            user.liveMode = false;
            sendUserCommand(userKey, {
                "_type": "cmd",
                "action": "setConfiguration",
                "configuration": { "mode": 3 }
            });
            renderTrackingSidebar();
        }, 20 * 60 * 1000);

    } else {
        // TURN OFF -> Mode 3
        sendUserCommand(userKey, {
            "_type": "cmd",
            "action": "setConfiguration",
            "configuration": { "mode": 3 }
        });

        if (user.liveTimeout) {
            clearTimeout(user.liveTimeout);
            user.liveTimeout = null;
        }
    }

    renderTrackingSidebar();
}

// --- HISTORY & CLEANUP ---
async function cleanupHistory() {
    console.log("Netejant historial antic de 24h...");
    const yesterday = Math.floor(Date.now() / 1000) - (24 * 3600);

    for (const key of Object.keys(TRACKED_USERS)) {
        const user = TRACKED_USERS[key];
        if (!user.historyUrl) continue;

        try {
            const res = await fetch(user.historyUrl);
            if (!res.ok) continue;

            const data = await res.json();
            if (!data) continue;

            let updates = {};
            let needsUpdate = false;

            // Firebase returns object map: { "pushId": {data}, ... }
            // Or Array if indices are integers. Usually Map.

            // Reconstruct kept data
            Object.keys(data).forEach(pushId => {
                const entry = data[pushId];
                if (entry.tst > yesterday) {
                    updates[pushId] = entry; // Keep
                } else {
                    needsUpdate = true; // Drop (don't add to updates)
                }
            });

            if (needsUpdate) {
                await fetch(user.historyUrl, {
                    method: 'PUT',
                    body: JSON.stringify(updates)
                });
                console.log(`Historial netejat per ${user.name}`);
            }

        } catch (e) {
            console.warn("Cleanup error:", e);
        }
    }
}

async function toggleUserHistory(userKey) {
    const user = TRACKED_USERS[userKey];
    if (!user) return;

    if (user.showingHistory) {
        // HIDE
        if (user.historyPolyline) {
            map.removeLayer(user.historyPolyline);
            user.historyPolyline = null;
        }
        user.showingHistory = false;
        renderTrackingSidebar();
        return;
    }

    // SHOW
    try {
        const res = await fetch(user.historyUrl);
        const json = await res.json();

        if (!json) { alert("No hi ha historial disponible."); return; }

        const entries = Object.values(json);
        entries.sort((a, b) => a.tst - b.tst);

        const points = entries.map(e => [parseFloat(e.lat), parseFloat(e.lon)]);

        if (points.length > 0) {
            user.historyPolyline = L.polyline(points, {
                color: '#ff5722',
                weight: 4,
                opacity: 0.7,
                lineJoin: 'round'
            }).addTo(map);

            map.fitBounds(user.historyPolyline.getBounds(), { padding: [50, 50] });
        }

        user.showingHistory = true;
        renderTrackingSidebar();

    } catch (e) {
        console.error(e);
        alert("Error carregant historial");
    }
}

function updateUserState(userKey, data) {
    const user = TRACKED_USERS[userKey];

    // 1. Update Data Store
    user.data = data;
    user.lastUpdate = Date.now();

    // 2. Update Map Marker
    const lat = parseFloat(data.lat);
    const lon = parseFloat(data.lon);

    if (isNaN(lat) || isNaN(lon)) return;

    // NOTE: We NO LONGER append to local user.history array for trails automatically.
    // Trails are now on-demand via History button.

    // -- MARKER LOGIC --
    // Prepare Popup Content
    const { batt, vel, tst, alt, conn } = data;
    const updateTime = tst * 1000;
    const now = Date.now();
    const diffMin = (now - updateTime) / 60000;

    // Status Ring Color Logic
    let ringClass = 'status-ring-grey'; // > 15 min or offline
    if (diffMin < 5) ringClass = 'status-ring-green';
    else if (diffMin < 15) ringClass = 'status-ring-yellow';

    const date = new Date(updateTime);
    const timeStr = date.toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
    const speed = vel ? Math.round(vel) : 0;
    let battIcon = '🔋';
    if (batt <= 20) battIcon = '🪫';
    const isOnline = diffMin < 10; // For text label

    const popupContent = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align:center; min-width: 180px;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">
                <b style="font-size:14px; color:#333;">${user.name}</b>
                <span style="font-size:11px; color:#888;">${timeStr}</span>
            </div>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; font-size:13px; color:#444; text-align:left;">
                <div>🏎️ <b>${speed}</b> km/h</div>
                <div style="color:${batt < 20 ? 'red' : 'green'}">${battIcon} <b>${batt}%</b></div>
                <div>🏔️ ${alt} m</div>
                <div>📡 ${conn === 'w' ? 'WiFi' : '4G'}</div>
            </div>

            <div style="margin-top: 8px; padding-top:4px; border-top:1px solid #eee; font-size: 11px; color: #888; text-align:right;">
                <span style="color:${isOnline ? '#28a745' : '#999'};">
                    ${isOnline ? '• En línia' : '• Desconnectat'}
                </span>
            </div>
        </div>
    `;

    // Create custom Avatar Icon
    const avatarIcon = L.divIcon({
        className: 'custom-avatar-icon', // Empty wrapper, style inside
        html: `
            <div class="avatar-marker-container ${ringClass}">
                <img src="${user.avatar}" class="avatar-image" alt="${user.initials}">
            </div>
        `,
        iconSize: [28, 28], // Extra Small
        iconAnchor: [14, 14], // Center
        popupAnchor: [0, -14] // Top center
    });

    if (!user.marker) {
        user.marker = L.marker([lat, lon], { icon: avatarIcon }).addTo(map);
        user.marker.bindPopup(popupContent, { className: 'apple-popup' });
    } else {
        user.marker.setLatLng([lat, lon]);
        user.marker.setIcon(avatarIcon); // Update icon to reflect status change
        user.marker.setZIndexOffset(1000);

        if (user.marker.getPopup()) user.marker.setPopupContent(popupContent);
        else user.marker.bindPopup(popupContent, { className: 'apple-popup' });
    }

    // Update Route if this is the active routing user
    if (activeRouteUser === userKey && routingControl) {
        updateRouteWaypoints([lat, lon], routingDestCoords);
    }
}

function updateAllTrails(hours) {
    Object.keys(TRACKED_USERS).forEach(key => drawUserTrail(key, hours));
}

function drawUserTrail(userKey, hours) {
    const user = TRACKED_USERS[userKey];
    if (!user.allEntries) return;

    const cutoff = (Date.now() / 1000) - (hours * 3600);

    // Filter by timestamp and sort ascending for line drawing
    const trailPoints = user.allEntries
        .filter(e => e.tst >= cutoff)
        .sort((a, b) => a.tst - b.tst) // Oldest first for accurate line
        .map(e => [parseFloat(e.lat), parseFloat(e.lon)]);

    if (!user.trailPolyline) {
        user.trailPolyline = L.polyline(trailPoints, {
            color: userKey === 'jan' ? '#2196f3' : '#ff9800',
            weight: 4,
            opacity: 0.7,
            lineJoin: 'round'
        }).addTo(map);
    } else {
        user.trailPolyline.setLatLngs(trailPoints);
    }
}

// --- REMOTE COMMANDS ---
// --- REMOTE COMMANDS ---






// ... fetch logic ...

// --- SIDEBAR UI ("MUR DE LA VERGONYA") ---
function renderTrackingSidebar() {
    const list = document.getElementById('trackers-list');
    if (!list) return;

    list.innerHTML = ''; // Rebuild

    Object.keys(TRACKED_USERS).forEach(key => {
        const user = TRACKED_USERS[key];
        const data = user.data || {};

        // Status Check (10 mins timeout)
        const tst = data.tst || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        const diff = nowSec - tst;
        const isOnline = diff < 600; // 10 mins

        // Colors
        const batt = data.batt || 0;
        let battColor = '#333';
        if (batt < 20) battColor = '#d32f2f';
        else if (batt < 50) battColor = '#f57c00';
        else battColor = '#2e7d32';

        const vel = data.vel ? Math.round(data.vel) : 0;

        const card = document.createElement('div');
        card.className = `tracker-card ${isOnline ? 'online' : 'offline'} ${activeRouteUser === key ? 'active-user' : ''}`;

        card.innerHTML = `
            <div class="tracker-card-header">
                <div class="tracker-status-indicator">
                    <div class="status-dot ${isOnline ? 'online' : 'offline'}"></div>
                    <span>${user.name}</span>
                </div>
                <div style="font-size:11px; color:#888;">
                   ${isOnline ? 'En línia' : 'Fa ' + Math.round(diff / 60) + ' min'}
                </div>
            </div>
            
            <div class="tracker-details">
                <div style="color:${battColor}">🔋 ${batt}%</div>
                <div>🏎️ ${vel} km/h</div>
            </div>
            
            <!-- Standard Actions -->
            <div class="tracker-actions">
                <button class="tracker-btn btn-center" onclick="centerMapOnUser('${key}')">🎯 Centrar</button>
                <button class="tracker-btn btn-route ${activeRouteUser === key ? 'active' : ''}" onclick="startRouteForUser('${key}')">🚗 Ruta</button>
            </div>

            <!-- History Toggle -->
            <div style="margin-top:6px;">
                <button class="tracker-btn" style="width:100%; background:${user.showingHistory ? '#ffe0b2' : '#f0f0f0'}; color:${user.showingHistory ? '#e65100' : '#333'};" onclick="toggleUserHistory('${key}')">
                    🗺️ ${user.showingHistory ? "Amagar Recorregut" : "Recorregut Avui"}
                </button>
            </div>
            

        `;
        list.appendChild(card);
    });
}

// Expose to global scope for HTML onclick
window.centerMapOnUser = (key) => {
    const user = TRACKED_USERS[key];
    if (user && user.marker) {
        map.setView(user.marker.getLatLng(), 16);
    }
};

window.startRouteForUser = (key) => {
    const user = TRACKED_USERS[key];
    if (!user || !user.marker) {
        alert("Aquest usuari no té posició encara.");
        return;
    }

    if (!routingDestCoords) {
        alert("Primer has de buscar una destinació a la capçalera!");
        document.getElementById('routing-dest-input').focus();
        return;
    }

    activeRouteUser = key;
    renderTrackingSidebar(); // Update active state styling

    const userPos = user.marker.getLatLng();
    updateRouteWaypoints([userPos.lat, userPos.lng], routingDestCoords);
};

// --- ROUTING LOGIC ---
let activeRouteUser = null;
let routingDestCoords = null; // [lat, lon]
let destinationMarker = null; // Keep track of the destination marker

async function handleDestSearch() {
    const input = document.getElementById('routing-dest-input');
    const query = input.value;
    if (!query) return;

    document.getElementById('routing-search-btn').innerText = '⌛';

    try {
        // Nominatim Geocoding
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lon = parseFloat(data[0].lon);
            routingDestCoords = [lat, lon];

            // Show Routing Box
            const infoBox = document.getElementById('routing-info-box');
            if (infoBox) infoBox.style.display = 'block';
            const routeMeta = document.getElementById('route-meta');
            if (routeMeta) routeMeta.innerText = `Destí: ${data[0].display_name.split(',')[0]} (Selecciona un usuari)`;

            // Remove previous marker if exists
            if (destinationMarker) {
                map.removeLayer(destinationMarker);
            }

            // Add a temp marker for destination
            destinationMarker = L.marker([lat, lon]).addTo(map)
                .bindPopup("<b>Destinació</b><br>" + data[0].display_name.split(',')[0])
                .openPopup();

            map.setView([lat, lon], 13);

        } else {
            alert("No s'ha trobat l'adreça.");
        }
    } catch (e) {
        console.error("Error geocoding:", e);
        alert("Error cercant adreça");
    } finally {
        const btn = document.getElementById('routing-search-btn');
        if (btn) btn.innerText = '🔍';
    }
}

function updateRouteWaypoints(startCoords, endCoords) {
    if (!map) return;

    // Check if Routing Machine is loaded
    if (!L.Routing || !L.Routing.control) {
        console.warn("Leaflet Routing Machine no està carregat correctament.");
        return;
    }

    // Cleanup old control
    if (routingControl) {
        try {
            map.removeControl(routingControl);
        } catch (e) {
            console.warn("Error removing routing control", e);
        }
        routingControl = null;
    }

    try {
        routingControl = L.Routing.control({
            waypoints: [
                L.latLng(startCoords[0], startCoords[1]),
                L.latLng(endCoords[0], endCoords[1])
            ],
            router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1'
            }),
            lineOptions: {
                styles: [{ color: '#2196f3', opacity: 0.8, weight: 6 }]
            },
            createMarker: function () { return null; } // Don't create extra markers
        }).addTo(map);

        routingControl.on('routingerror', function (e) {
            console.warn('Error d\'enrutament:', e.error);
            alert('No s\'ha pogut calcular la ruta. Prova amb altres punts.');
        });
    } catch (e) {
        console.error("Error drawing route:", e);
    }
}
// Auto-hide for other specific layers that don't use dataMarkersLayer
[typeof windBarbsLayer !== 'undefined' ? windBarbsLayer : null,
typeof convergencesLayer !== 'undefined' ? convergencesLayer : null,
typeof wmsLayer !== 'undefined' ? wmsLayer : null]
    .forEach(layerGroup => {
        if (layerGroup) {
            layerGroup.on('layeradd', function (e) {
                const icon = e.layer.options && e.layer.options.icon;
                if (icon && icon.options && icon.options.iconSize && icon.options.iconSize[0] === 0) return;
                hideMapLoader();
            });
        }
    });

// ======================================================
// GENERADOR DE CARDS / INFOGRAFIES 4E (XARXES SOCIALS)
// ======================================================

function initInfografiaCardGenerator() {
    const openBtn = document.getElementById('open-infografia-btn');
    const modal = document.getElementById('infografia-card-modal');
    const closeBtn = document.getElementById('close-infografia-modal');
    const downloadBtn = document.getElementById('btn-download-infografia');
    const copyBtn = document.getElementById('btn-copy-infografia');
    const customTitleInput = document.getElementById('infografia-custom-title');
    const customSubInput = document.getElementById('infografia-custom-subtitle');
    const showTop5Check = document.getElementById('show-top5-check');
    const showAvgCheck = document.getElementById('show-average-check');
    const showWatermarkCheck = document.getElementById('show-watermark-check');
    const formatBtns = document.querySelectorAll('.format-btn');
    const cardElement = document.getElementById('infografia-card-element');

    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        updateInfografiaCardData();
    });

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    // Format buttons (16-9, 1-1, 9-16)
    formatBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            formatBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const format = btn.getAttribute('data-format');
            if (cardElement) {
                cardElement.className = `infografia-card format-${format}`;
            }
        });
    });

    // Inputs & Checkboxes live reflection
    customTitleInput?.addEventListener('input', (e) => {
        const titleEl = document.getElementById('card-main-title');
        if (titleEl) titleEl.innerText = e.target.value.trim() || getDefaultInfografiaTitle();
    });

    customSubInput?.addEventListener('input', (e) => {
        const subEl = document.getElementById('card-sub-title');
        if (subEl) subEl.innerText = e.target.value.trim() || "Dades oficials de la xarxa d'estacions meteorològiques";
    });

    showTop5Check?.addEventListener('change', (e) => {
        const top5Panel = document.getElementById('card-top5-panel');
        if (top5Panel) top5Panel.style.display = e.target.checked ? 'flex' : 'none';
    });

    showAvgCheck?.addEventListener('change', (e) => {
        const avgPill = document.getElementById('card-stat-pill');
        if (avgPill) avgPill.style.display = e.target.checked ? 'block' : 'none';
    });

    showWatermarkCheck?.addEventListener('change', (e) => {
        const watermark = document.querySelector('.card-watermark');
        if (watermark) watermark.style.display = e.target.checked ? 'block' : 'none';
    });

    // Download PNG Action
    downloadBtn?.addEventListener('click', async () => {
        const statusText = document.getElementById('infografia-status-text');
        if (statusText) statusText.innerText = 'Generant PNG...';

        try {
            const canvas = await html2canvas(cardElement, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                backgroundColor: null
            });

            const link = document.createElement('a');
            const dateStr = new Date().toISOString().slice(0, 10);
            link.download = `4E_MeteoMAP_Card_${dateStr}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();

            if (statusText) statusText.innerText = 'Descarregat!';
            setTimeout(() => { if (statusText) statusText.innerText = 'A punt'; }, 3000);
        } catch (err) {
            console.error("Error generant PNG de la card:", err);
            alert("S'ha produït un error al generar la imatge.");
            if (statusText) statusText.innerText = 'Error';
        }
    });

    // Copy PNG Action
    copyBtn?.addEventListener('click', async () => {
        const statusText = document.getElementById('infografia-status-text');
        if (statusText) statusText.innerText = 'Copiant...';

        try {
            const canvas = await html2canvas(cardElement, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                backgroundColor: null
            });

            canvas.toBlob(async (blob) => {
                if (blob && navigator.clipboard && window.ClipboardItem) {
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    if (statusText) statusText.innerText = 'Copiat al porta-retalls! 📋';
                    setTimeout(() => { if (statusText) statusText.innerText = 'A punt'; }, 3000);
                } else {
                    alert("El teu navegador no suporta la còpia directa d'imatges. Utilitza 'Descarregar PNG'.");
                    if (statusText) statusText.innerText = 'No suportat';
                }
            }, 'image/png');
        } catch (err) {
            console.error("Error copiant la imatge:", err);
            alert("No s'ha pogut copiar la imatge.");
            if (statusText) statusText.innerText = 'Error';
        }
    });
}

function getDefaultInfografiaTitle() {
    if (typeof currentVariableKey !== 'undefined' && currentVariableKey && typeof VARIABLES_CONFIG !== 'undefined' && VARIABLES_CONFIG[currentVariableKey]) {
        const config = VARIABLES_CONFIG[currentVariableKey];
        return (config.name || config.title || 'DADES METEOROLÒGIQUES').toUpperCase();
    }
    return "MÀXIMES D'AVUI A CATALUNYA";
}
async function getMapSnapshotDataUrl() {
    const mapEl = document.getElementById('map');
    if (!mapEl) return null;

    // 1. Try leafletImage if available
    if (typeof leafletImage === 'function' && typeof map !== 'undefined' && map) {
        try {
            const dataUrl = await new Promise((resolve) => {
                leafletImage(map, function (err, canvas) {
                    if (!err && canvas) {
                        resolve(canvas.toDataURL('image/png'));
                    } else {
                        resolve(null);
                    }
                });
            });
            if (dataUrl) return dataUrl;
        } catch (e) {
            console.warn("leafletImage failed, falling back to html2canvas with transform flatten:", e);
        }
    }

    // 2. Fallback: html2canvas with leaflet-map-pane transform flattening in onclone
    try {
        const canvas = await html2canvas(mapEl, {
            useCORS: true,
            allowTaint: true,
            scale: 1,
            logging: false,
            onclone: (clonedDoc) => {
                const clonedMap = clonedDoc.getElementById('map');
                if (!clonedMap) return;

                const mapPane = clonedMap.querySelector('.leaflet-map-pane');
                if (!mapPane) return;

                const transformStr = window.getComputedStyle(mapPane).transform;
                if (transformStr && transformStr !== 'none') {
                    let offsetX = 0, offsetY = 0;
                    if (window.DOMMatrix) {
                        const matrix = new DOMMatrix(transformStr);
                        offsetX = matrix.m41;
                        offsetY = matrix.m42;
                    } else {
                        const match = transformStr.match(/matrix\(([^)]+)\)/);
                        if (match) {
                            const parts = match[1].split(',');
                            offsetX = parseFloat(parts[4]) || 0;
                            offsetY = parseFloat(parts[5]) || 0;
                        }
                    }

                    // Reset mapPane transform
                    mapPane.style.transform = 'none';

                    // Flatten transforms onto child panes
                    const panes = mapPane.querySelectorAll('.leaflet-tile-pane, .leaflet-overlay-pane, .leaflet-marker-pane, .leaflet-shadow-pane');
                    panes.forEach(pane => {
                        const childTransform = window.getComputedStyle(pane).transform;
                        if (childTransform && childTransform !== 'none') {
                            if (window.DOMMatrix) {
                                const childMatrix = new DOMMatrix(childTransform);
                                const newX = childMatrix.m41 + offsetX;
                                const newY = childMatrix.m42 + offsetY;
                                pane.style.transform = `translate3d(${newX}px, ${newY}px, 0px)`;
                            } else {
                                const match = childTransform.match(/matrix\(([^)]+)\)/);
                                if (match) {
                                    const parts = match[1].split(',');
                                    const cX = parseFloat(parts[4]) || 0;
                                    const cY = parseFloat(parts[5]) || 0;
                                    pane.style.transform = `translate3d(${cX + offsetX}px, ${cY + offsetY}px, 0px)`;
                                }
                            }
                        } else {
                            pane.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0px)`;
                        }
                    });
                }
            }
        });
        return canvas.toDataURL('image/png');
    } catch (err) {
        console.error("html2canvas map snapshot failed:", err);
        return null;
    }
}

async function updateInfografiaCardData() {
    const cardMainTitle = document.getElementById('card-main-title');
    const customTitleInput = document.getElementById('infografia-custom-title');
    const cardDateStr = document.getElementById('card-date-str');
    const cardTimeStr = document.getElementById('card-time-str');
    const cardCatAvg = document.getElementById('card-cat-avg');
    const top5List = document.getElementById('card-top5-list');
    const top5Label = document.getElementById('top5-title-label');
    const cardMapImg = document.getElementById('card-map-img');
    const statusText = document.getElementById('infografia-status-text');

    if (statusText) statusText.innerText = 'Carregant mapa...';

    // 1. Title & Units
    const defaultTitle = getDefaultInfografiaTitle();
    if (cardMainTitle) {
        cardMainTitle.innerText = (customTitleInput && customTitleInput.value.trim()) ? customTitleInput.value.trim() : defaultTitle;
    }

    // 2. Date & Time
    const historicTimeDisp = document.getElementById('historic-time-display');
    if (historicTimeDisp && historicTimeDisp.innerText && historicTimeDisp.innerText.includes('/')) {
        const parts = historicTimeDisp.innerText.trim().split(' ');
        if (cardDateStr) cardDateStr.innerText = parts[0] || '';
        if (cardTimeStr) cardTimeStr.innerText = parts[1] || '';
    } else {
        const now = new Date();
        if (cardDateStr) cardDateStr.innerText = now.toLocaleDateString('ca-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        if (cardTimeStr) cardTimeStr.innerText = now.toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
    }

    // 3. Average Cat
    const globalStatsVal = document.getElementById('global-stats-value');
    if (globalStatsVal && globalStatsVal.innerText) {
        if (cardCatAvg) cardCatAvg.innerText = globalStatsVal.innerText;
    } else {
        if (cardCatAvg) cardCatAvg.innerText = "--.-";
    }

    // 4. TOP 5 Extraction
    if (top5List) {
        top5List.innerHTML = '';
        const stationList = [];

        // Extract stations from dataMarkersLayer or current map layers
        if (typeof dataMarkersLayer !== 'undefined' && dataMarkersLayer) {
            dataMarkersLayer.eachLayer(layer => {
                if (layer.options && layer.options.stationData) {
                    const st = layer.options.stationData;
                    if (st && st.nom && !isNaN(parseFloat(st.valor))) {
                        stationList.push({ name: st.nom, val: parseFloat(st.valor) });
                    }
                } else if (layer.getTooltip && layer.getTooltip()) {
                    const content = layer.getTooltip().getContent();
                    if (typeof content === 'string') {
                        const match = content.match(/<b>(.*?)<\/b>.*?([\d.-]+)/);
                        if (match) {
                            stationList.push({ name: match[1], val: parseFloat(match[2]) });
                        }
                    }
                }
            });
        }

        // Determine sorting direction (Cold/Min -> Ascending, Max/Precip -> Descending)
        const isMinVariable = (typeof currentVariableKey !== 'undefined' && currentVariableKey && (currentVariableKey.includes('tmin') || currentVariableKey.includes('smc_42') || currentVariableKey.includes('ranking_fred')));
        
        if (isMinVariable) {
            stationList.sort((a, b) => a.val - b.val);
            if (top5Label) top5Label.innerText = "TOP 5 MÉS FRED";
        } else {
            stationList.sort((a, b) => b.val - a.val);
            if (top5Label) top5Label.innerText = "TOP 5 MÉS ALT";
        }

        const top5 = stationList.slice(0, 5);
        if (top5.length > 0) {
            const unit = (typeof currentVariableKey !== 'undefined' && currentVariableKey && typeof VARIABLES_CONFIG !== 'undefined' && VARIABLES_CONFIG[currentVariableKey]?.unit) ? VARIABLES_CONFIG[currentVariableKey].unit : '';
            top5.forEach((st, idx) => {
                const li = document.createElement('li');
                li.className = 'top5-item';
                li.innerHTML = `
                    <span class="top5-rank">#${idx + 1}</span>
                    <span class="top5-name" title="${st.name}">${st.name}</span>
                    <span class="top5-val">${st.val.toFixed(1)} ${unit}</span>
                `;
                top5List.appendChild(li);
            });
        } else {
            top5List.innerHTML = `<li class="top5-item"><span class="top5-name">Dades del mapa...</span></li>`;
        }
    }

    // 5. Map Snapshot Generation
    if (cardMapImg) {
        const snapshotDataUrl = await getMapSnapshotDataUrl();
        if (snapshotDataUrl) {
            cardMapImg.src = snapshotDataUrl;
            if (statusText) statusText.innerText = 'A punt';
        } else {
            if (statusText) statusText.innerText = 'A punt (sense mapa)';
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInfografiaCardGenerator);
} else {
    initInfografiaCardGenerator();
}


