// Crear un worker inline com a Blob per la generació del GIF
var gifWorkerBlob = new Blob([
  `importScripts('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')`
], { type: 'application/javascript' });

var gifWorkerUrl = URL.createObjectURL(gifWorkerBlob);

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
    await carregarMetadadesLocals();
    
    console.log("Arrencada completada. Mostrant la vista per defecte.");

    // Mostrem les dades de les estacions (sense interpolació inicial)
    displayVariable('smc_32');
    
    // Activem el botó del menú per defecte
    const defaultOption = document.querySelector('li[data-variable-key="smc_32"]');
    if(defaultOption) {
        defaultOption.classList.add('active');
        defaultOption.closest('.main-menu-item').querySelector('a').classList.add('active');
    }
});

// ======================================================
// DEFINICIÓ DE PROJECCIONS PERSONALITZADES
// ======================================================
proj4.defs('EPSG:25831', '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

const transformation = new L.Transformation(1, -245124.0621, -1, 4767102.8982);

const crs_25831 = new L.Proj.CRS('EPSG:25831', proj4.defs['EPSG:25831'], {
    transformation: transformation
});

// ======================================================

// AFEGEIX AIXÒ AL PRINCIPI DEL FITXER
const imageCache = new Map();
const processedTileCache = new Map(); // <-- AFEGEIX AQUESTA LÍNIA

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

    function enableDrawer(tool) {
        if (activeDrawer) activeDrawer.disable();
        if (activeToolButton) activeToolButton.classList.remove('active');

        const selectedColor = colorPicker.value;
        const selectedOpacity = document.getElementById('draw-opacity-slider').value;

        const drawOptions = {
            shapeOptions: { color: selectedColor, weight: 3, fillOpacity: selectedOpacity },
            polyline: { shapeOptions: { color: selectedColor, weight: 4 } }
        };

        switch (tool) {
            case 'polygon':
                activeDrawer = new L.Draw.Polygon(map, drawOptions);
                break;
            case 'arrow':
                activeDrawer = new L.Draw.Polyline(map, drawOptions.polyline);
                break;
            case 'clear':
                creativeDrawings.clearLayers();
                return;
        }
        
        if (activeDrawer) activeDrawer.enable();
        
        activeToolButton = document.querySelector(`.draw-tool-btn[data-tool="${tool}"]`);
        if(activeToolButton) activeToolButton.classList.add('active');
    }

    map.on(L.Draw.Event.CREATED, function(event) {
        const layer = event.layer;
        
        if (drawingPanel.style.display === 'block') {
            if (event.layerType === 'polygon') {
                const geojson = layer.toGeoJSON();
                const areaMetres = turf.area(geojson);
                const areaHectarees = areaMetres / 10000;
                
                const popupContent = `<b>Àrea:</b><br>${areaHectarees.toFixed(2)} hectàrees`;
                layer.bindPopup(popupContent).openPopup();
                creativeDrawings.addLayer(layer);

            } else if (event.layerType === 'polyline') {
                const decorator = L.polylineDecorator(layer, {
                    patterns: [{
                        offset: '100%',
                        repeat: 0,
                        symbol: L.Symbol.arrowHead({ pixelSize: 15, polygon: false, pathOptions: { stroke: true, weight: 2, color: layer.options.color } })
                    }]
                });
                creativeDrawings.addLayer(layer).addLayer(decorator);
            }

            if(activeDrawer) activeDrawer.disable();
            if(activeToolButton) activeToolButton.classList.remove('active');
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
});

//Variables refresh
let isAutoRefreshActive = false;
let autoRefreshInterval = null;
let lastCheckedTimestamp = null;

let isLoadingData = false;
let lastSumatoriResult = [];

//altres variables

const MAPBOX_API_KEY = "pk.eyJ1IjoiamFucG9uc2EiLCJhIjoiY21la2JxOGx3MDNvbDJqc2V5dHhrOHlmdSJ9.xP0uBeThN1f-olxgiNd8pw";

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
    // AFEGEIX AQUESTES NOVES VARIABLES DINS DE VARIABLES_CONFIG
'anomalia_tmax': {
    name: 'Anomalia T. Màx. (vs P98)',
    unit: '°C',
    decimals: 1,
    isCalculated: true,
    showPositiveSign: true,
    sources: ['smc_40', 'percentils'], // Font: T. Màx. del dia i els nostres percentils
    calculation: (d) => {
        if (!d.percentils || d.percentils.p98_tmax === undefined) return null;
        return d.smc_40 - d.percentils.p98_tmax;
    },
    // Podem fer una escala de colors per a l'anomalia
    colorScale: [
        { value: -5, color: 'rgba(0, 0, 255, 1)' },    // Molt per sota
        { value: 0, color: 'rgba(240, 240, 240, 1)' }, // Normal
        { value: 5, color: 'rgba(255, 0, 0, 1)' }     // Molt per sobre
    ]
},
'anomalia_tmin_hivern': {
    name: 'Anomalia T. Mín. Hivern (vs P2)',
    unit: '°C',
    decimals: 1,
    isCalculated: true,
    showPositiveSign: true,
    sources: ['smc_42', 'percentils'], // Font: T. Mín. del dia i els nostres percentils
    calculation: (d) => {
        if (!d.percentils || d.percentils.p2_tmin === undefined) return null;
        return d.smc_42 - d.percentils.p2_tmin;
    },
    colorScale: [
        { value: -5, color: 'rgba(255, 0, 0, 1)' },    // Més càlid que el normal (anomalia negativa menor)
        { value: 0, color: 'rgba(240, 240, 240, 1)' }, // Normal
        { value: 5, color: 'rgba(0, 0, 255, 1)' }     // Més fred que el normal (anomalia positiva major)
    ]
},
'anomalia_tmin_estiu': {
    name: 'Anomalia Mín. Estiu (vs P98)',
    unit: '°C',
    decimals: 1,
    isCalculated: true,
    showPositiveSign: true,
    sources: ['smc_42', 'percentils'], // Font: T. Mín. del dia i els nostres percentils
    calculation: (d) => {
        if (!d.percentils || d.percentils.p98_tmin_estiu === undefined) return null;
        return d.smc_42 - d.percentils.p98_tmin_estiu;
    },
    colorScale: [
        { value: -5, color: 'rgba(0, 0, 255, 1)' },
        { value: 0, color: 'rgba(240, 240, 240, 1)' },
        { value: 5, color: 'rgba(255, 0, 0, 1)' }
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
    // --- Humitat ---
    'smc_33': { id: 33, name: 'Humitat relativa', unit: '%', decimals: 0, aemet_id: 'hr' },
    'smc_3':  { id: 3,  name: 'Humitat relativa màxima', unit: '%', decimals: 0, aemet_id: null, summary: 'max' },
    'smc_44': { id: 44, name: 'Humitat relativa mínima', unit: '%', decimals: 0, aemet_id: null, summary: 'min' },
    // --- Vent ---
    'wind': { name: 'Dades de Vent Base', internal: true }, // Variable interna per a càlculs
    'wind_speed_ms': { name: 'Velocitat Vent', unit: 'm/s', base_id: 30, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_speed_kmh': { name: 'Velocitat Vent', unit: 'km/h', base_id: 30, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_semihourly_ms': { name: 'Ratxa Màx. (Semi-h)', unit: 'm/s', base_id: 50, isSimpleWind: true, conversion: 1, decimals: 1 },
    'wind_gust_semihourly_kmh': { name: 'Ratxa Màx. (Semi-h)', unit: 'km/h', base_id: 50, isSimpleWind: true, conversion: 3.6, decimals: 1 },
    'wind_gust_daily_ms': { name: 'Ratxa Màx. Diària', unit: 'm/s', id: 50, summary: 'max', conversion: 1, decimals: 1 },
    'wind_gust_daily_kmh': { name: 'Ratxa Màx. Diària', unit: 'km/h', id: 50, summary: 'max', conversion: 3.6, decimals: 1 },
    'wind_barbs': { name: 'Direcció i Velocitat', isWindBarb: true },
    'smc_1503': { id: 1503, name: 'Velocitat Mitjana Diària Vent 10m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },
    'smc_1504': { id: 1504, name: 'Velocitat Mitjana Diària Vent 6m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },
    'smc_1505': { id: 1505, name: 'Velocitat Mitjana Diària Vent 2m', unit: 'km/h', summary: 'mean', conversion: 3.6, decimals: 1 },

    // --- Precipitació ---
    'precip_semihoraria': { id: 35, name: 'Precipitació Semihorària', unit: 'mm', decimals: 1, isSemihoraria: true }, // <-- LÍNIA NOVA
    'smc_35': { id: 35, name: 'Precipitació acumulada', unit: 'mm', decimals: 1, aemet_id: 'prec', summary: 'sum' },
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
    'smc_38': { id: 38, name: 'Gruix de neu a terra', unit: 'cm', decimals: 0, aemet_id: null },
    // --- NOVES VARIABLES DE COMPARACIÓ ---
    'var_tmax_24h': { name: 'Variació Tª Màx. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', showPositiveSign: true, base_id: 40, summary: 'max' },
    'var_tmin_24h': { name: 'Variació Tª Mín. 24h', unit: '°C', decimals: 1, comparison: 'daily_summary', showPositiveSign: true, base_id: 42, summary: 'min' },
    'var_tactual_24h': { name: 'Variació Tª Actual 24h', unit: '°C', decimals: 1, comparison: 'instant',  showPositiveSign: true, base_id: 32 },
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
    unit: 'punts',
    decimals: 0,
    isCalculated: true,
    sources: ['smc_32', 'smc_33', 'wind_gust'],
    calculation: (d) => {
        let punts = 0;
        const temp = d.smc_32;
        const hr = d.smc_33;
        const ventMs = d.wind_gust.speed_ms;
        const ventKmh = ventMs * 3.6;

        if (temp >= 35) punts += 4;
        else if (temp >= 30) punts += 3;
        else if (temp >= 25) punts += 2;
        else if (temp >= 20) punts += 1;
        if (hr <= 20) punts += 4;
        else if (hr <= 30) punts += 3;
        else if (hr <= 40) punts += 2;
        else if (hr <= 55) punts += 1;
        if (ventKmh >= 60) punts += 3;
        else if (ventKmh >= 40) punts += 2;
        else if (ventKmh >= 25) punts += 1;
        
        return punts;
    },
    colorScale: [
        { value: 2, color: 'rgba(40, 167, 69, 1)' },
        { value: 5, color: 'rgba(255, 193, 7, 1)' },
        { value: 7, color: 'rgba(255, 123, 0, 1)' },
        { value: 9, color: 'rgba(220, 53, 69, 1)' },
        { value: 11, color: 'rgba(108, 2, 138, 1)' }
    ],
    popupTemplate: (station, finalValue, config) => {
        const riskLevels = { 2: "BAIX", 5: "MODERAT", 7: "ALT", 9: "MOLT ALT", 11: "EXTREM" };
        let riskText = "EXTREM";
        for (const key in riskLevels) {
            if (finalValue <= key) {
                riskText = riskLevels[key];
                break;
            }
        }
        
        const temp = station.smc_32.toFixed(1);
        const rh = station.smc_33.toFixed(0);
        
        // ===== AQUESTA ÉS LA LÍNIA CORREGIDA =====
        const gust = (station.wind_gust.speed_ms * 3.6).toFixed(0);

        return `<b>${station.nom}</b><br>
                <hr style="margin: 4px 0;">
                <b style="font-size:14px;">Risc d'Incendi: ${riskText}</b><br>
                Puntuació: ${finalValue} / 11<br>
                <hr style="margin: 4px 0;">
                T. Actual: ${temp} °C<br>
                HR Actual: ${rh} %<br>
                Ratxa Vent (30min): ${gust} km/h`;
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
        { value: 0,  color: 'rgba(248, 210, 153, 0.8)' },
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
                <span style="font-size:11px;">(Total acumulat: ${details.precipitacioTotal.toFixed(1)} mm)</span><br>
                🌡️ Ajust per Tº Nocturna: <b style="${details.puntsTempNoc >= 0 ? 'color:green;' : 'color:red;'}">${details.puntsTempNoc >= 0 ? '+' : ''}${details.puntsTempNoc}</b><br>
                <span style="font-size:11px;">(Nits fredes (<5°C): ${details.diesFreds} | Nits càlides (>15°C): ${details.diesCalids})</span><br>
                🔥 Penalitz. per Calor: <b style="color:red;">${details.penalitzacioTmax}</b><br>
                <span style="font-size:11px;">(Dies amb T. Màx >25°C: ${details.diesCalor})</span><br>
                💨 Penalitz. per Vent: <b style="color:red;">${details.penalitzacioVent}</b><br>
                <span style="font-size:11px;">(Dies amb vent persistent: ${details.diesVent} | Font principal: ${details.fontVent})</span><br>
                🌕 Bonificació per Lluna: <b style="color:green;">+${details.puntsLluna}</b><br>
                <span style="font-size:11px;">(Fase actual: ${getMoonPhaseInfo()})</span><br>
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
        const windKmh = Math.sqrt(d.wind.u**2 + d.wind.v**2) * 3.6; // Convertim de m/s a km/h
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

// ===================================================================================
// PAS 1 (NOU): LÒGICA DE TRADUCCIÓ DE COLORS DEL RADAR
// ===================================================================================

// DICCIONARI OFICIAL: Colors del PNG del Meteocat (la nostra referència).
const escalaMeteocatOficial = [
    { r: 128, g: 0,   b: 255 }, { r: 64,  g: 0,   b: 255 }, { r: 0,   g: 0,   b: 255 },
    { r: 0,   g: 255, b: 255 }, { r: 0,   g: 255, b: 128 }, { r: 0,   g: 255, b: 0   },
    { r: 63,  g: 255, b: 0   }, { r: 127, g: 255, b: 0   }, { r: 191, g: 255, b: 0   },
    { r: 255, g: 255, b: 0   }, { r: 255, g: 171, b: 0   }, { r: 255, g: 129, b: 0   },
    { r: 255, g: 87,  b: 0   }, { r: 255, g: 45,  b: 0   }, { r: 255, g: 0,   b: 0   },
    { r: 255, g: 0,   b: 63  }, { r: 255, g: 0,   b: 127 }, { r: 255, g: 0,   b: 191 },
    { r: 234, g: 51,  b: 247 }, { r: 255, g: 255, b: 255 }
];

// NOVA ESCALA FINAL: Una paleta de 20 colors diferents.
const escalaFinalNova = [
    [173, 216, 230], [135, 206, 250], [100, 149, 237], [65, 105, 225],
    [0, 191, 255],   [0, 255, 255],   [60, 179, 113],  [50, 205, 50],
    [173, 255, 47],  [255, 255, 0],   [255, 215, 0],   [255, 165, 0],
    [255, 140, 0],   [255, 69, 0],    [255, 0, 0],     [220, 20, 60],
    [199, 21, 133],  [218, 112, 214], [148, 0, 211],   [255, 255, 255]
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

        layer.on('click', function(e) {
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
       
        pane: 'poligonsPane',
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
            comarquesLayer.bringToFront();
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
        btn.addEventListener('click', function() {
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
const animationSpeed = 130;
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
  _refreshTileUrl: function(tile, url) {
    const img = new Image();
    img.onload = () => L.Util.requestAnimFrame(() => tile.el.src = url);
    img.src = url;
  },
  refresh: function() {
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

// REEMPLAÇA LA TEVA CLASSE L.TileLayer.WMS.NoFlicker PER AQUESTA VERSIÓ FINAL

L.TileLayer.WMS.NoFlicker = L.TileLayer.WMS.extend({
    refresh: function(newTime) {
        if (!this._map) return;
        this.wmsParams.time = newTime;
        const wasAnimated = this._map._fadeAnimated;
        this._map._fadeAnimated = false;

        Object.values(this._tiles).forEach(tile => {
            if (tile.current && tile.active) {
                const newSrc = this.getTileUrl(tile.coords);
                this._refreshTileUrl(tile, newSrc);
            }
        });

        if (wasAnimated) {
            setTimeout(() => { if (this._map) this._map._fadeAnimated = wasAnimated; }, 2000);
        }
    },

    _refreshTileUrl: function(tile, url) {
        if (imageCache.has(url)) {
            const cachedImg = imageCache.get(url);
            if (cachedImg.complete) {
                L.Util.requestAnimFrame(() => { tile.el.src = cachedImg.src; });
            } else {
                cachedImg.onload = () => {
                    L.Util.requestAnimFrame(() => { tile.el.src = cachedImg.src; });
                };
            }
            return;
        }

        const img = new Image();
        
        // AQUESTA ÉS LA LÍNIA CLAU QUE SOLUCIONA EL PROBLEMA DE CORS
        img.crossOrigin = "Anonymous";
        // --------------------------------------------------------

        imageCache.set(url, img);

        img.onload = () => {
            L.Util.requestAnimFrame(() => { tile.el.src = url; });
        };
        img.onerror = () => {
            imageCache.delete(url);
        };
        
        img.src = url;
    }
});

L.TileLayer.WMS.Eumetsat = L.TileLayer.WMS.NoFlicker.extend({
    updateLayerTime: function() {
        if (!range_values.length || range_element.value >= range_values.length) {
            return;
        }

        const radarDate = new Date(range_values[range_element.value].utctime);
        let finalSatDate;

        if (map.hasLayer(radar_layer) || map.hasLayer(plujaneu_layer)) {
            finalSatDate = findClosestSatTimestamp(radarDate);
        } else {
            finalSatDate = radarDate;
        }

        const SAT_LATENCY_MS = 15 * 60 * 1000;
        const maxAllowedTime = Date.now() - SAT_LATENCY_MS;

        if (finalSatDate.getTime() > maxAllowedTime) {
            return; 
        }

        const timeString = finalSatDate.toISOString().slice(0, 16) + "Z";

        if (this.wmsParams.time !== timeString) {
            this.refresh(timeString);
        }
    }
});

// Funció "factory" per conveniència, com les altres.
L.tileLayer.wms.noFlicker = function (url, options) {
    return new L.TileLayer.WMS.NoFlicker(url, options);
};

// ===================================================================
// VERSIÓ FINAL I ROBUSTA: Gestiona TOTS els tipus de capes
// ===================================================================
async function setRangeValuesAsync() {
    // ===================================================================
    // PRIMER, COMPROVEM LES CAPES AMB DADES EXTERNES (JSONs)
    // Aquestes tenen la màxima prioritat perquè defineixen els seus propis intervals.
    // ===================================================================

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
        // ... (el codi del CAPPI Intern es queda exactament igual)
        try {
            const response = await fetch('http://www.meteocatclients.com/webs_clients/radar/cappi250_catalunya_10dBZ.json?' + new Date().getTime());
            const data = await response.json();
            return data.items.map(item => {
                const match = item.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
                if (!match) return null;
                const date = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5]));
                return { url: 'http://www.meteocatclients.com/webs_clients/radar' + item.src.substring(1), any: date.getUTCFullYear(), mes: date.getUTCMonth() + 1, dia: date.getUTCDate(), hora: date.getUTCHours(), min: date.getUTCMinutes(), utctime: date.getTime() };
            }).filter(Boolean);
        } catch (error) { console.error("Error CAPPI Intern:", error); return []; }
    }

    if (map.hasLayer(cappi_llarg_abast_layer)) {
        // ... (el codi del CAPPI Llarg Abast es queda exactament igual)
        try {
            const response = await fetch('http://www.meteocatclients.com/webs_clients/radar/cappi250_llarg_abast_10dBZ.json?' + new Date().getTime());
            const data = await response.json();
            return data.items.map(item => {
                const match = item.title.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})/);
                if (!match) return null;
                const date = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4], match[5]));
                return { url: 'http://www.meteocatclients.com/webs_clients/radar' + item.src.substring(1), any: date.getUTCFullYear(), mes: date.getUTCMonth() + 1, dia: date.getUTCDate(), hora: date.getUTCHours(), min: date.getUTCMinutes(), utctime: date.getTime() };
            }).filter(Boolean);
        } catch (error) { console.error("Error CAPPI Llarg Abast:", error); return []; }
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
    // Comprovem PRIMER si hi ha cap capa de SATÈL·LIT activa
    const isAnySatelliteActive = [
        eumetsatLayer, 
        eumetsat_ir_layer, 
        eumetsat_hrvis_layer, 
        ...Object.values(satelliteLayers),
        sandwich_layer_final // <-- AFEGEIX AQUESTA LÍNIA CLAU
    ].some(layer => map.hasLayer(layer));

    if (isAnySatelliteActive) {
        console.log("Capa de satèl·lit detectada. Utilitzant intervals de 10 minuts.");
        const SAT_LATENCY_MINS = 15;
        curr_date.setTime(curr_date.getTime() - SAT_LATENCY_MINS * 60 * 1000);
        max_steps_animacio = 36;
        interval_mins_animacio = 10;
        const closestMinute = Math.floor(curr_date.getUTCMinutes() / 10) * 10;
        curr_date.setUTCMinutes(closestMinute, 0, 0);

    } else if (map.hasLayer(windy_radar_layer)) {
        console.log("Capa de Windy detectada. Utilitzant intervals de 5 minuts.");
        max_steps_animacio = 144;
        interval_mins_animacio = 5;
        const roundedMinutes = Math.floor(curr_date.getUTCMinutes() / 5) * 5;
        curr_date.setUTCMinutes(roundedMinutes, 0, 0);

    } else {
        // Comportament per defecte (Radar Meteocat, PoN)
        console.log("Capa de radar per defecte detectada. Utilitzant intervals de 6 minuts.");
        max_steps_animacio = 30;
        interval_mins_animacio = 6;
        const possibles_mins_6min = Array.from({ length: 10 }, (_, i) => i * 6);
        const curr_min = curr_date.getUTCMinutes();
        const min = Math.max(...possibles_mins_6min.filter(m => m <= curr_min));
        curr_date.setUTCMinutes(min, 0, 0);
    }

    // El bucle final per generar els valors es queda igual
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

plujaneu_layer.on('add', function() {
  plujaneu_layer.getContainer().classList.add('pixelated-tile');
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

// AFEGEIX AQUEST BLOC NOU
// Events per reconfigurar l'animació quan la capa de pluja/neu canvia
plujaneu_layer.on('add remove', reconfigureTimeSliderAsync);


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

const dataMarkersLayer = L.markerClusterGroup({
    maxClusterRadius: 15,
    
// ★ REEMPLAÇA LA TEVA 'iconCreateFunction' PER AQUESTA ★
iconCreateFunction: function(cluster) {
    const children = cluster.getAllChildMarkers();
    let totalValue = 0;
    let count = 0;
    let maxValue = -Infinity; // Mantenim el càlcul del màxim per a algunes variables

    children.forEach(child => {
        const htmlContent = child.options.icon.options.html;
        // Aquesta expressió regular millorada captura números positius, negatius i decimals
        const valueMatch = htmlContent.match(/>([+-]?\d+\.?\d*)</);
        if (valueMatch && valueMatch[1]) {
            const value = parseFloat(valueMatch[1]);
            totalValue += value;
            count++;
            if (value > maxValue) {
                maxValue = value;
            }
        }
    });

    // ===== LÒGICA DE LA MITJANA VS. EL MÀXIM =====
    // Per defecte, fem servir la mitjana.
    let displayValue = (count > 0) ? (totalValue / count) : cluster.getChildCount();
    let valueForColor = displayValue;

    // EXCEPCIONS: Per a aquestes variables, té més sentit mostrar el valor màxim.
    const useMaxValueForCluster = [
        'smc_40', 'smc_72_daily_max', 'wind_gust_daily_kmh', 'wind_gust_daily_ms',
        'wind_gust_semihourly_kmh', 'wind_gust_semihourly_ms',
        'calc_fire_risk_semihourly', 'sumatori_precipitacio',
        'alert_intensity', 'alert_accumulation',
        'smc_35', 'weathercom_precip', 'ecowitt_precip' // Precipitacions en general
    ];

    if (useMaxValueForCluster.includes(currentVariableKey)) {
        displayValue = maxValue;
        valueForColor = maxValue;
    }
    // Per a l'índex de rovellons, la mitjana és més representativa.
    // Per tant, NO entra en l'excepció i utilitzarà 'valueForColor' basat en la mitjana.
    // ================================================

    const config = VARIABLES_CONFIG[currentVariableKey];
    const decimals = (config && config.decimals !== undefined) ? config.decimals : 1;
    const formattedValue = formatValueForLabel(displayValue, decimals);
    
    let dynamicColor;
    let textColor = '#000';

    if (config && config.colorScale) {
        dynamicColor = getDynamicColor(valueForColor, config.colorScale);
    } else {
        // La lògica de 'switch' es manté igual, però ara utilitza 'valueForColor'
        switch (currentVariableKey) {
            // ... (tots els teus 'case' es queden igual, no cal tocar-los)
            // ... ex: case 'smc_33': dynamicColor = getHumidityColor(valueForColor); break;
            // Aquesta part no canvia
            case 'calc_night_humidex_min':
                    if (valueForColor < 20) {
                        dynamicColor = '#37d05bff';
                    } else if (valueForColor <= 25) {
                        dynamicColor = '#ffb907ff';
                    } else {
                        dynamicColor = '#e82e40ff';
                    }
                    break;
               case 'var_pressure_3h':
               case 'var_pressure_24h':
                dynamicColor = getPressureTrendColor(valueForColor);
                break;
                case 'sumatori_precipitacio':
                    dynamicColor = getPrecipitationSumColor(valueForColor);
                    break;
                case 'var_tmax_24h':
                case 'var_tmin_24h':
                case 'var_tactual_24h':
                    dynamicColor = getVariationColor(valueForColor);
                    break;
                case 'wind_speed_ms':
                case 'wind_gust_semihourly_ms':
                case 'wind_gust_daily_ms':
                    dynamicColor = getWindColor(valueForColor * 3.6);
                    break;
                case 'wind_speed_kmh':
                case 'wind_gust_semihourly_kmh':
                case 'wind_gust_daily_kmh':
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
                    dynamicColor = getSemihorariaPrecipColor(valueForColor);
                    break;
                case 'weathercom_precip_semihourly':
                    dynamicColor = getSemihorariaPrecipColor(valueForColor);
                    break;
                case 'weathercom_precip':
                    dynamicColor = getDailyPrecipitationColor(valueForColor);
                    break;
                case 'ecowitt_precip':
                    dynamicColor = getDailyPrecipitationColor(valueForColor);
                    break;
                case 'smc_35':
                    dynamicColor = getDailyPrecipitationColor(valueForColor);
                    break;
                case 'smc_72': case 'smc_72_daily_max':
                    dynamicColor = getIntensityColor(valueForColor);
                    break;
                default:
                    dynamicColor = getTempRgbaColor(valueForColor);
                    break;
        }
    }

    let finalFormattedValue;
    if (config && config.showPositiveSign) {
        const sign = displayValue > 0 ? '+' : (displayValue < 0 ? '' : ''); // Només '+' per positius
        finalFormattedValue = sign + formattedValue;
    } else {
        finalFormattedValue = formattedValue;
    }

    const html = `<div style="background-color: ${dynamicColor}; color: ${textColor};"><span>${finalFormattedValue}</span></div>`;
    
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
map.getPane('llampsPane').style.zIndex = 450; // Nivell inferior

map.createPane('poligonsPane');
map.getPane('poligonsPane').style.zIndex = 500; // Nivell intermedi

map.createPane('irPane');
map.getPane('irPane').style.zIndex = 501;
map.getPane('irPane').style.mixBlendMode = 'multiply'; // <-- AFEGEIX AQUESTA LÍNIA

map.createPane('irColorPane');
map.getPane('irColorPane').style.zIndex = 502; // Slightly above the other IR pane
map.getPane('irColorPane').style.mixBlendMode = 'multiply';

map.createPane('iconesPane');
map.getPane('iconesPane').style.zIndex = 550; // Nivell superior

map.createPane('convergenciaPane');

map.getPane('convergenciaPane').style.zIndex = 575; // Un valor entre els polígons (500) i els marcadors (600)


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

// ===================================================================
// SUBSTITUEIX LES DEFINICIONS ANTIGUES PER AQUEST BLOC COMPLET
// ===================================================================

// Nova definició de la capa RGB usant el motlle 'Eumetsat'
const eumetsatLayer = new L.TileLayer.WMS.Eumetsat("https://view.eumetsat.int/geoserver/mtg_fd/rgb_geocolour/ows", {
    layers: 'rgb_geocolour',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    crs: L.CRS.EPSG4326,
    attribution: '© <a href="https://eumetsat.int">EUMETSAT</a>',
    opacity: 0.7
});

// Nova definició de la capa de Vapor d'Aigua
const eumetsat_hrvis_layer = new L.TileLayer.WMS.Eumetsat("https://view.eumetsat.int/geoserver/mtg_fd/vis06_hrfi/ows", {
    layers: 'vis06_hrfi', // <-- Canvia el nom de la capa
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    attribution: '© <a href="https://eumetsat.int">EUMETSAT</a>',
    opacity: 0.7
});

// Nova definició de la capa Infraroja (IR) usant el mateix motlle 'Eumetsat'
const eumetsat_ir_layer = new L.TileLayer.WMS.Eumetsat("https://view.eumetsat.int/geoserver/mtg_fd/ir105_hrfi/ows", {
    layers: 'ir105_hrfi',
    styles: 'mtg_fd_ir105_hrfi_style_01',
    pane: 'irPane',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    attribution: '© <a href="https://eumetsat.int">EUMETSAT</a>',
    opacity: 0.65
});

// Esdeveniments per afegir les classes CSS (per a l'estil visual)
eumetsatLayer.on('add', function () { this.getContainer().classList.add('pixelated-tile'); });
eumetsat_hrvis_layer.on('add', function () { this.getContainer().classList.add('pixelated-tile'); });

async function reconfigureTimeSliderAsync() {
    clearAnimationCache();
    document.getElementById("plujaoneu-text").textContent = "Carregant intervals...";
    
    // Crida a la nostra nova funció unificada
    range_values = await setRangeValuesAsync();
    
    range_element.max = range_values.length - 1;
    range_element.value = range_element.max;

    const event = new Event('input');
    range_element.dispatchEvent(event);
}

eumetsatLayer.on('add remove', reconfigureTimeSliderAsync);
eumetsat_ir_layer.on('add remove', reconfigureTimeSliderAsync);
eumetsat_hrvis_layer.on('add remove', reconfigureTimeSliderAsync);

// ===================================================================================
// VERSIÓ FINAL (v4): DATA URL + REFRESC SUAU + MEMÒRIA CAU (CACHE)
// ===================================================================================
L.TileLayer.MeteocatCanvas = L.TileLayer.extend({
    createTile: function(coords, done) {
        var tile = document.createElement('img');
        L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
        L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
        tile.src = L.Util.emptyImageUrl;
        this._processAndSetSrc(tile, coords);
        return tile;
    },

    refresh: function() {
        if (!this._map) { return; }
        Object.values(this._tiles).forEach(tile => {
            this._processAndSetSrc(tile.el, tile.coords);
        });
    },

    _processAndSetSrc: function(imgElement, coords) {
        const originalUrl = this.getTileUrl(coords);

        // ===== INICI DE LA MILLORA CLAU =====
        // 1. Comprovem si ja hem processat aquesta rajola abans.
        if (processedTileCache.has(originalUrl)) {
            // Si la tenim a la memòria, l'assignem directament. És gairebé instantani.
            imgElement.src = processedTileCache.get(originalUrl);
            return; // Sortim de la funció, ja hem acabat.
        }
        // ===== FI DE LA MILLORA CLAU =====

        // Si no la tenim a la memòria, fem la feina pesada.
        var sourceImage = new Image();
        sourceImage.crossOrigin = 'Anonymous';

        sourceImage.onload = () => {
            var tempCanvas = document.createElement('canvas');
            tempCanvas.width = tempCanvas.height = this.options.tileSize;
            var ctx = tempCanvas.getContext('2d', { willReadFrequently: true });

            ctx.drawImage(sourceImage, 0, 0);
            var imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
            var data = imageData.data;
            for (var i = 0; i < data.length; i += 4) {
                var nouColor = getNouColorPerPixel(data[i], data[i+1], data[i+2], data[i+3]);
                data[i] = nouColor[0]; data[i+1] = nouColor[1]; data[i+2] = nouColor[2]; data[i+3] = nouColor[3];
            }
            ctx.putImageData(imageData, 0, 0);
            
            const dataUrl = tempCanvas.toDataURL('image/png');

            // ===== INICI DE LA MILLORA CLAU =====
            // 2. Guardem el resultat a la memòria cau per a futures ocasions.
            processedTileCache.set(originalUrl, dataUrl);
            // ===== FI DE LA MILLORA CLAU =====
            
            imgElement.src = dataUrl;
        };
        
        sourceImage.src = originalUrl;
    }
});

// ===================================================================================
// PAS 3 (MODIFICAT): CREACIÓ DE LA CAPA DE RADAR AMB LA NOVA CLASSE
// ===================================================================================
const radar_layer = new L.TileLayer.MeteocatCanvas('https://static-m.meteo.cat/tiles/radar/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png', {
    attribution: '© <a href="https://www.meteo.cat/" target="_blank">Meteocat</a>',
    opacity: 0.85,
    maxNativeZoom: 7
});

// Mantenim la lògica original per connectar la capa amb el slider de temps
radar_layer.getTileUrl = function(coords) {
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

// Mantenim els events originals
radar_layer.on('add remove', reconfigureTimeSliderAsync);
radar_layer.on('add', function() {
  radar_layer.getContainer().classList.add('pixelated-tile');
});

// ===================================================================================
// NOU BLOC: LÒGICA PER A LA CAPA DE RADAR DE WINDY
// ===================================================================================

// Escala de colors calibrada per a Windy, basada en la teva implementació original.
const colorStopsDbz = [
    { dbz: 0,   color: [0, 0, 0],       alpha: 0 },
    { dbz: 14,  color: [173, 216, 230], alpha: 255 }, { dbz: 17,  color: [135, 206, 250], alpha: 255 },
    { dbz: 20,  color: [100, 149, 237], alpha: 255 }, { dbz: 23,  color: [65, 105, 225],  alpha: 255 },
    { dbz: 26,  color: [0, 191, 255],   alpha: 255 },   { dbz: 29,  color: [0, 255, 255],   alpha: 255 },
    { dbz: 32,  color: [60, 179, 113],  alpha: 255 },  { dbz: 35,  color: [50, 205, 50],   alpha: 255 },
    { dbz: 38,  color: [173, 255, 47],  alpha: 255 },  { dbz: 41,  color: [255, 255, 0],   alpha: 255 },
    { dbz: 44,  color: [255, 215, 0],   alpha: 255 },  { dbz: 47,  color: [255, 165, 0],   alpha: 255 },
    { dbz: 50,  color: [255, 140, 0],   alpha: 255 },  { dbz: 53,  color: [255, 69, 0],    alpha: 255 },
    { dbz: 56,  color: [255, 0, 0],     alpha: 255 },    { dbz: 59,  color: [220, 20, 60],   alpha: 255 },
    { dbz: 62,  color: [199, 21, 133],  alpha: 255 },  { dbz: 65,  color: [218, 112, 214], alpha: 255 },
    { dbz: 68,  color: [148, 0, 211],   alpha: 255 },  { dbz: 71,  color: [255, 255, 255], alpha: 255 }
];

function pixelToDbz(pixelValue) {
    return (pixelValue / 255) * 127.5;
}

function getColorForWindyValue(pixelValue) {
    const dbz = pixelToDbz(pixelValue);
    if (dbz < 14) return [0, 0, 0, 0];

    let lowerStop = colorStopsDbz[0];
    let upperStop = colorStopsDbz[colorStopsDbz.length - 1];
    for (let i = 0; i < colorStopsDbz.length - 1; i++) {
        if (dbz >= colorStopsDbz[i].dbz && dbz <= colorStopsDbz[i + 1].dbz) {
            lowerStop = colorStopsDbz[i];
            upperStop = colorStopsDbz[i + 1];
            break;
        }
    }
    if (dbz > upperStop.dbz) return [upperStop.color[0], upperStop.color[1], upperStop.color[2], upperStop.alpha];
    
    const range = upperStop.dbz - lowerStop.dbz;
    const position = (range === 0) ? 1 : (dbz - lowerStop.dbz) / range;
    const r = Math.round(lowerStop.color[0] * (1 - position) + upperStop.color[0] * position);
    const g = Math.round(lowerStop.color[1] * (1 - position) + upperStop.color[1] * position);
    const b = Math.round(lowerStop.color[2] * (1 - position) + upperStop.color[2] * position);
    const a = Math.round(lowerStop.alpha * (1 - position) + upperStop.alpha * position);
    return [r, g, b, a];
}

// Classe personalitzada per a la capa de Windy que processa les imatges en un canvas
const WindyRadarLayer = L.TileLayer.extend({
    createTile: function(coords, done) {
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
                    data[i] = newColor[0]; data[i+1] = newColor[1]; data[i+2] = newColor[2]; data[i+3] = newColor[3];
                }
                ctx.putImageData(imageData, 0, 0);
                done(null, tile);
            } catch (e) { done(e, tile); }
        };
        sourceImage.onerror = () => done(new Error('Error al carregar la imatge de Windy'), tile);
        return tile;
    },
    // Funció de refresc suau per evitar el parpelleig
    refresh: function() {
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
                for (let i = 0; i < data.length; i+=4) {
                    const newColor = getColorForWindyValue(data[i]);
                    data[i] = newColor[0]; data[i+1] = newColor[1]; data[i+2] = newColor[2]; data[i+3] = newColor[3];
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
        className: 'windy-radar-tile' // <-- AFEGEIX AQUESTA OPCIÓ
    }
);

// Mètode per construir la URL dinàmicament, igual que les altres capes
windy_radar_layer.getTileUrl = function(coords) {
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

rainviewer_layer.getTileUrl = function(coords) {
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
// NOVA FUNCIÓ GENÈRICA PER CREAR QUALSEVOL RADAR AMB GRAELLA
// (Aquesta funció substitueix la teva antiga 'crearGraellaCappi')
// ===================================================================
function crearGraellaRadar(imageUrl, boundsUTM, capaDeDesti) {
    const divisionsX = 8;
    const divisionsY = 8;

    const ampleUTM = boundsUTM.maxX - boundsUTM.minX;
    const altUTM = boundsUTM.maxY - boundsUTM.minY;
    const ampleTrosUTM = ampleUTM / divisionsX;
    const altTrosUTM = altUTM / divisionsY;

    const novaGraellaLayer = L.layerGroup();
    const fontImatge = new Image();
    fontImatge.crossOrigin = "Anonymous";
    fontImatge.src = imageUrl;

    fontImatge.onload = function() {
        const ampleImatgeOriginal = fontImatge.width;
        const altImatgeOriginal = fontImatge.height;

        for (let i = 0; i < divisionsX; i++) {
            for (let j = 0; j < divisionsY; j++) {
                const trosMinX = boundsUTM.minX + (i * ampleTrosUTM);
                const trosMaxX = trosMinX + ampleTrosUTM;
                const trosMinY = boundsUTM.minY + (j * altTrosUTM);
                const trosMaxY = trosMinY + altTrosUTM;

                const sw = proj4('EPSG:25831', 'EPSG:4326').forward([trosMinX, trosMinY]);
                const ne = proj4('EPSG:25831', 'EPSG:4326').forward([trosMaxX, trosMaxY]);
                const boundsWGS84 = L.latLngBounds(L.latLng(sw[1], sw[0]), L.latLng(ne[1], ne[0]));
                
                const canvasTros = document.createElement('canvas');
                const sx = Math.round((i / divisionsX) * ampleImatgeOriginal);
                const sy = Math.round(((divisionsY - 1 - j) / divisionsY) * altImatgeOriginal);
                const sWidth = Math.round(((i + 1) / divisionsX) * ampleImatgeOriginal) - sx;
                const sHeight = Math.round(((divisionsY - j) / divisionsY) * altImatgeOriginal) - sy;

                canvasTros.width = sWidth;
                canvasTros.height = sHeight;
                const ctx = canvasTros.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(fontImatge, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

                L.imageOverlay(canvasTros.toDataURL(), boundsWGS84, {
                    opacity: 0.85,
                    interactive: false
                }).addTo(novaGraellaLayer);
            }
        }

        capaDeDesti.clearLayers();
        novaGraellaLayer.eachLayer(layer => {
            capaDeDesti.addLayer(layer);
        });
    };
    
    fontImatge.onerror = function() {
      console.error("No s'ha pogut carregar la imatge del radar des de:", imageUrl);
    };
}

// ===================================================================
// INICI DEL NOU BLOC CORRECTE
// ===================================================================

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
        if (map.hasLayer(layer)) {
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
    }

    // La resta de la funció per a EUMETSAT i el text es manté igual
    if (map.hasLayer(eumetsatLayer)) eumetsatLayer.updateLayerTime();
    if (map.hasLayer(eumetsat_ir_layer)) eumetsat_ir_layer.updateLayerTime();
    if (map.hasLayer(eumetsat_hrvis_layer)) eumetsat_hrvis_layer.updateLayerTime();
    setDateText(range_values[range_element.value]);
});


// ===================================================================
// NOVA CAPA: SATÈL·LIT IR ACOLORIT (METEOLOGIX)
// ===================================================================
const ir_color_layer = L.tileLayerNoFlickering(
    'http://localhost:3000/tile/{z}/{x}/{y}/1426_{timestamp}', 
    {
        attribution: '© <a href="https://meteologix.com/" target="_blank">Meteologix</a>',
        opacity: 0.7,
        pane: 'irColorPane',
        updateWhenIdle: true // <-- AFEGEIX AQUESTA LÍNIA
    }
);

ir_color_layer.getTileUrl = function(coords) {
    if (!range_values.length || range_element.value >= range_values.length) {
        return '';
    }
  
    const radarDate = new Date(range_values[range_element.value].utctime);
    const satDate = findClosestSatTimestamp(radarDate);

    // Creem el timestamp en el format que espera la URL original, incloent el '@2x.jpg'
    const timestampString = `${satDate.getUTCFullYear()}${fillTo(satDate.getUTCMonth() + 1, 2)}${fillTo(satDate.getUTCDate(), 2)}${fillTo(satDate.getUTCHours(), 2)}${fillTo(satDate.getUTCMinutes(), 2)}@2x.jpg`;

    return L.Util.template(this._url, {
        z: coords.z,
        x: coords.x,
        y: coords.y,
        timestamp: timestampString // Passem el timestamp complet com un sol paràmetre
    });
};

// Connectem la capa al sistema de temps perquè es reconfiguri i actualitzi
ir_color_layer.on('add remove', reconfigureTimeSliderAsync);

// ===================================================================
// CONFIGURACIÓ CENTRALITZADA DE TOTS ELS CANALS DE SATÈL·LIT
// ===================================================================
const SATELLITE_CHANNELS = [
    { key: 'ir_color', name: 'IR Acolorit', channelCode: '1426' },
    { key: 'hrvis_color', name: 'HRVIS Color', channelCode: '1427' },
    { key: 'real_color', name: 'Real Color', channelCode: '1432' },
    { key: 'natural', name: 'Natural', channelCode: '1435' },
    { key: 'hrvis', name: 'HRVIS HR', channelCode: '1438' },
    { key: 'hrvis_hc', name: 'HRVIS Alt Contrast', channelCode: '1436' },
    { key: 'ir', name: 'IR', channelCode: '1428' },
    { key: 'sandwich', name: 'Sandwich', channelCode: '1515' },
    { key: 'vapor', name: "Vapor d'Aigua", channelCode: '1429' },
    { key: 'dust', name: 'Pols', channelCode: '1430' },
    { key: 'fog', name: 'Boira', channelCode: '1431' },
    { key: 'cloud_phase', name: 'Cloud Phase RGB', channelCode: '1514' },
    { key: 'airmass', name: 'AirMass', channelCode: '1433' },
    { key: 'fire', name: 'Fire', channelCode: '1442' }
];

// ===================================================================
// CREACIÓ DINÀMICA DE TOTES LES CAPES, MENÚ I CONTROLS
// ===================================================================

// Objecte on guardarem totes les capes de satèl·lit creades
const satelliteLayers = {};
// Objecte que construirem per al menú del control de capes
const satelliteMenuLayers = {};

SATELLITE_CHANNELS.forEach(channel => {
    // Creem la URL base per al proxy, incloent el channelCode dinàmic
    const templateUrl = `https://meteo-api.projecte4estacions.com/api/meteologix/tiles/${channel.channelCode}/{z}/{x}/{y}/{timestamp}`;

    const newLayer = L.tileLayerNoFlickering(templateUrl, {
        attribution: `© <a href="https://meteologix.com/" target="_blank">Meteologix (${channel.name})</a>`,
        opacity: 0.7,
        updateWhenIdle: true
    });

    newLayer.getTileUrl = function(coords) {
        if (!range_values.length || range_element.value >= range_values.length) return '';
        const radarDate = new Date(range_values[range_element.value].utctime);
        const satDate = findClosestSatTimestamp(radarDate);
        const timestampString = `${satDate.getUTCFullYear()}${fillTo(satDate.getUTCMonth() + 1, 2)}${fillTo(satDate.getUTCDate(), 2)}${fillTo(satDate.getUTCHours(), 2)}${fillTo(satDate.getUTCMinutes(), 2)}@2x.jpg`;
        return L.Util.template(this._url, {
            z: coords.z,
            x: coords.x,
            y: coords.y,
            timestamp: timestampString
        });
    };

    newLayer.on('add remove', reconfigureTimeSliderAsync);
    satelliteLayers[channel.key] = newLayer;
    satelliteMenuLayers[channel.name] = newLayer; // Afegim al menú
});

// ===================================================================
// NOVA CAPA COMPOSTA: SANDWICH (Versió amb LayerGroup)
// ===================================================================

// Capa Base (HRVIS): Anirà al fons, sense efectes especials.
const sandwich_hrvis_layer = L.tileLayerNoFlickering(
    `http://localhost:3000/proxy/1438/{z}/{x}/{y}/{timestamp}`, {
    attribution: '© Meteologix (Sandwich)',
    updateWhenIdle: true
});
// Assignem la mateixa funció de URL que la resta de capes de Meteologix per garantir la sincronització
sandwich_hrvis_layer.getTileUrl = satelliteLayers.hrvis.getTileUrl;

// Capa Superior (IR Acolorit): Anirà a sobre, amb l'efecte 'multiply'.
const sandwich_ir_color_layer = L.tileLayerNoFlickering(
    `http://localhost:3000/proxy/1426/{z}/{x}/{y}/{timestamp}`, {
    attribution: '© Meteologix (Sandwich)',
    updateWhenIdle: true,
    // Assignem aquesta capa al plafó 'irPane', que ja té l'estil CSS 'mix-blend-mode: multiply'.
    pane: 'irPane', 
    // Establim l'opacitat base que demanaves.
    opacity: 0.7 
});
// Assignem la mateixa funció de URL que la resta.
sandwich_ir_color_layer.getTileUrl = satelliteLayers.ir_color.getTileUrl;

// Creem el grup i hi afegim les dues capes. L'ordre és important.
const sandwich_layer_final = L.layerGroup([sandwich_hrvis_layer, sandwich_ir_color_layer]);

// Connectem el grup al sistema de temps perquè es reconfiguri quan s'activa/desactiva.
sandwich_layer_final.on('add remove', reconfigureTimeSliderAsync);

const timeDependentLayers = [
    plujaneu_layer, 
    radar_layer, 
    rainviewer_layer, 
    windy_radar_layer,
    ...Object.values(satelliteLayers),
    sandwich_hrvis_layer,
    sandwich_ir_color_layer
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
    "ICGC (JSON) Estàndard General": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard_general.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Estàndard Simplificat": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC Relleu": L.mapboxGL({
        style: 'full_relleu.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Fosc": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_mapa_base_fosc.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),

    // --- Capes JSON de l'ICGC (Mapes d'Imatge) ---
    "ICGC (JSON) Orto Híbrida": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_hibrida.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto Estàndard": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Orto amb Xarxa Viària": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_xarxa_viaria.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
     "ICGC (JSON) Orto Estàndard Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_orto_estandard_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),

    // --- Capes JSON de l'ICGC (Mapes Administratius) ---
    "ICGC (JSON) Delimitació Estàndard": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_estandard.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Delimitació Gris": L.mapboxGL({
        style: 'https://geoserveis.icgc.cat/contextmaps/icgc_delimitacio_gris.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "ICGC (JSON) Límits Administratius": L.mapboxGL({
        style: 'relleu_comarques.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "Base Meteocat (JSON)": L.mapboxGL({  
        style: 'meteocat.json',
        attribution: '© <a href="https://www.icgc.cat/" target="_blank">ICGC</a>'
    }),
    "Base Relleu - Color": L.mapboxGL({  
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
baseLayers["Base Meteocat (JSON)"].addTo(map); // Afegeix una capa base per defecte

// Capa WMS ICGC Allaus
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

// Capa de comarques
var comarquesLayer = L.geoJSON(comarquesGeojson, {
  style: { color: "#262626", weight: 1, fill: false }
});

// Capa de municipis
var municipisGeojsonLayer = L.geoJSON(municipisGeojson, { // Canviat el nom de la variable per evitar conflictes
  style: { color: "#4F4F4F", weight: 1.2, fill: false }
});

// Capa de països del món (amb detall)
var monLayer = L.geoJSON(monGeojson, {
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

// Capa per a les càmeres
const camerasLayer = L.layerGroup();
if (typeof webcamPoints !== 'undefined' && Array.isArray(webcamPoints)) {
    const cameraIcon = L.divIcon({
        html: '<span style="font-size:24px;">📍</span>',
        className: 'webcam-icon',
        iconSize: [30, 30],
        iconAnchor: [15, 15] // Centra l'emoji sobre la coordenada
    });
    webcamPoints.forEach(cam => {
        const popupContent = `
            <div style="text-align:center;">
              <h4 style="margin:0 0 5px;">${cam.location}</h4>
              <a href="${cam.link}" target="_blank">
                <img src="${cam.image}?_=${Date.now()}" alt="${cam.location}" style="width:300px; height:169px; object-fit: cover; border:1px solid #ccc;"/>
              </a>
              <p style="margin:5px 0 0;">
                <a href="${cam.link}" target="_blank">Veure càmera en directe</a>
              </p>
            </div>`;
        L.marker([cam.lat, cam.lon], { icon: cameraIcon })
            .bindPopup(popupContent)
            .addTo(camerasLayer);
    });
}


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
            const nivellsText = { 0: "Nivell 0 (Baix)", 1: "Nivell 1 (Moderat)", 2: "Nivell 2 (Alt)", 3: "Nivell 3 (Molt Alt)", 4: "Nivell 4 (Extrem)"};
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

const aemetApiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";

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

    const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${timestampString}&codi_variable=${variableId}`;
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
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}`;
        console.log("URL de la consulta:", urlDades);
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.when($.getJSON(urlDades), $.getJSON(urlMetadades)).done((dadesResponse, metadadesResponse) => {
            const [dadesVariable, metadata] = [dadesResponse[0], metadadesResponse[0]];
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
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
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${query}`;
        
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
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/7bvh-jvq2.json?${query}`;
        
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
        
        const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?${query}`;
        console.log("URL final (sense SUM):", urlDades);

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

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
        const res1 = await fetch(url, { headers: { 'api_key': aemetApiKey }});
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
    const tempF = (tempC * 9/5) + 32;

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
    return (heatIndexF - 32) * 5/9;
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
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
            const urlDades = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${variableId}`;
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
async function fetchAllWindData(dataType, targetDate = null) {
    let speed_ids, dir_ids;
    if (dataType === 'speed') { speed_ids = [30, 48, 46]; dir_ids = [31, 49, 47]; } 
    else { speed_ids = [50, 53, 56]; dir_ids = [51, 54, 57]; }
    const promises = [...speed_ids, ...dir_ids].map(id => fetchSmcData(id, targetDate));
    const results = await Promise.all(promises);
    const speedResults = results.slice(0, 3), dirResults = results.slice(3, 6);
    const finalWindData = new Map();
    for (let i = 0; i < 3; i++) {
        const dirMap = new Map(dirResults[i].data.map(d => [d.codi_estacio, parseFloat(d.valor)]));
        speedResults[i].data.forEach(station => {
            if (!finalWindData.has(station.codi_estacio) && dirMap.has(station.codi_estacio)) {
                finalWindData.set(station.codi_estacio, { ...station, speed_ms: parseFloat(station.valor), direction: dirMap.get(station.codi_estacio) });
            }
        });
    }
    return Array.from(finalWindData.values());
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

/**
 * ★ VERSIÓ MILLORADA: Fa que un element es pugui arrossegar. ★
 * Ara, si no s'especifica una capçalera ('handle'), l'element sencer serà arrossegable.
 * AFEGIDA UNA COMPROVACIÓ PER IGNORAR CLICS EN BOTONS.
 */
function makeDraggable(element, handle) {
    const dragHandle = handle || element;
    let isDragging = false, offsetX, offsetY;

    function startDrag(e) {
        if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) {
            return;
        }
        
        isDragging = true;
        const rect = element.getBoundingClientRect();
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;
        
        // Calculem l'offset respecte a la posició visual real
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;

        // ===== LÍNIES CLAUS DE LA CORRECCIÓ =====
        // Abans de moure, fixem la posició a píxels i neutralitzem el 'transform'.
        element.style.position = 'fixed';
        element.style.transform = 'none'; // <-- AQUESTA ÉS LA LÍNIA MÉS IMPORTANT
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;
        element.style.margin = '0'; // Resetejem marges per evitar conflictes
        // ===========================================

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', stopDrag);
        if (e.cancelable) e.preventDefault();
    }
    
    function drag(e) {
        if (!isDragging) return;
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;
        element.style.left = `${clientX - offsetX}px`;
        element.style.top = `${clientY - offsetY}px`;
    }

    function stopDrag() {
        isDragging = false;
        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
    }
    
    dragHandle.addEventListener('mousedown', startDrag);
    dragHandle.addEventListener('touchstart', startDrag, { passive: false });
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


// ======================================================
// ★★★ AFEGEIX AQUESTA FUNCIÓ AL TEU FITXER .JS ★★★
// Aquesta funció conté la lògica per fer que un element
// es pugui arrossegar per la pantalla.
// ======================================================
function makeDraggable(element, handle) {
    const dragHandle = handle || element;
    let isDragging = false,
        offsetX, offsetY;

    function startDrag(e) {
        // Ignorem clics en botons dins de la capçalera
        if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) {
            return;
        }

        isDragging = true;
        const rect = element.getBoundingClientRect();
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;

        // Calculem la distància des del clic fins a la cantonada de l'element
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;

        // Neutralitzem propietats que puguin interferir
        element.style.position = 'fixed';
        element.style.transform = 'none';
        element.style.margin = '0';
        
        // Assegurem que la posició inicial sigui correcta
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;

        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', stopDrag);
        if (e.cancelable) e.preventDefault();
    }

    function drag(e) {
        if (!isDragging) return;
        const clientX = e.clientX || e.touches[0].clientX;
        const clientY = e.clientY || e.touches[0].clientY;
        element.style.left = `${clientX - offsetX}px`;
        element.style.top = `${clientY - offsetY}px`;
    }

    function stopDrag() {
        isDragging = false;
        document.removeEventListener('mousemove', drag);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('touchmove', drag);
        document.removeEventListener('touchend', stopDrag);
    }

    dragHandle.addEventListener('mousedown', startDrag);
    dragHandle.addEventListener('touchstart', startDrag, { passive: false });
}

// Per a variables simples (Temperatura Actual, Humitat, Pressió)
async function displayVariable(variableKey, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;
    const config = VARIABLES_CONFIG[variableKey];

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    if (!isHistoric) { lastCheckedTimestamp = timestampToUse; }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'instant',
        timestamp: timestampToUse
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    
    if (config.special) {
        startWindLayer();
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
                const ultima = estacionsAemetCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsAemetCat[0].fint);
                finalData.push(...estacionsAemetCat.filter(d => d.fint === ultima && typeof d[config.aemet_id] !== 'undefined').map(d => ({ source: 'aemet', lat: d.lat, lon: d.lon, nom: d.ubi, valor: d[config.aemet_id] })));
            }
        }
    }
    
    dataMarkersLayer.clearLayers();
    finalData.forEach(estacio => {
      const value = Number(estacio.valor); if (isNaN(value)) return;
        
        // --- INICI DE LA CORRECCIÓ ---
        let color;
        let textColor = '#000000'; // Color de text per defecte: negre

        switch (config.id) {
            case 33: case 3: case 44: // <-- ARA INCLOU TOTES LES VARIABLES D'HUMITAT
                color = getHumidityColor(value);
                textColor = getTextColorForHumidity(value); // Decidim el color del text
                break;
            case 35: 
                color = getSemihorariaPrecipColor(value); 
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
                color = getTempRgbaColor(value);
        }
        
        const formattedValue = formatValueForLabel(value, config.decimals);
        const icon = L.divIcon({ 
            className: 'temp-label', 
            html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, 
            iconSize: [30, 18], 
            iconAnchor: [15, 9] 
        });
        // --- FI DE LA CORRECCIÓ ---

        L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}

// AFEGEIX AQUESTA NOVA FUNCIÓ AL TEU FITXER
async function displayPercentileVariable(config) {
    if (isLoadingData) return;
    isLoadingData = true;
    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

    try {
        // El nostre fitxer de percentils no té nom ni coordenades, només el codi.
        // Per tant, primer necessitem les metadades de totes les estacions.
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

        dataMarkersLayer.clearLayers();

        // Ara, recorrem el nostre objecte 'dadesPercentils'
        for (const stationCode in dadesPercentils) {
            const percentileData = dadesPercentils[stationCode];
            const stationInfo = estacionsMap.get(stationCode);
            
            // Comprovem si tenim les dades i les metadades
            if (stationInfo && percentileData[config.valueKey] !== undefined) {
                const value = percentileData[config.valueKey];
                
                // Reutilitzem la teva escala de colors de temperatura!
                const color = getTempRgbaColor(value);
                const formattedValue = formatValueForLabel(value, config.decimals);

                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                L.marker([stationInfo.lat, stationInfo.lon], { icon })
                    .bindPopup(`<b>${stationInfo.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`)
                    .addTo(dataMarkersLayer);
            }
        }
    } catch (error) {
        console.error("Error a displayPercentileVariable:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error carregant dades' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

// Funció auxiliar per a "debounce"
function debounce(func, timeout = 100){
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

// REEMPLAÇA AQUESTA FUNCIÓ
function createLightningPopup() {
    const existingPopup = document.getElementById('lightning-popup');
    if (existingPopup) existingPopup.remove();

    const popup = L.DomUtil.create('div', 'info-popup', map.getContainer());
    popup.id = 'lightning-popup';
    L.DomEvent.disableClickPropagation(popup);

    popup.style.cssText = 'position:absolute; top:80px; left:80px; background:rgba(255,255,255,0.9); padding:10px; border-radius:8px; z-index:1005; box-shadow: 0 2px 10px rgba(0,0,0,0.2); width: 240px;';

    popup.innerHTML = `
        <div style="font-weight:bold; margin-bottom:8px; font-size:14px;">Visualització de Llamps</div>
        <div id="lightning-options-container" style="font-size:13px;">
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_only" checked> Només Temps Real</label>
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="historic"> Temps Real + Històric (120 min)</label>
            <label style="display:block; margin-bottom:5px; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_plus_1h"> Temps Real + Resum 1h (Tiles)</label>
            <label style="display:block; cursor:pointer;"><input type="radio" name="lightning-view" value="realtime_plus_24h"> Temps Real + Resum 24h (Tiles)</label>
        </div>
        <div id="historic-lightning-controls" style="display: none; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px;">
             <label for="historic-lightning-slider" id="historic-lightning-label" style="display: block; margin-bottom: 5px; font-size: 12px; text-align: center;">Últims 120 minuts</label>
             <input type="range" id="historic-lightning-slider" min="5" max="120" step="1" value="120" style="width: 100%;">
        </div>
        <div id="analysis-mode-controls" style="margin-top: 10px; border-top: 1px solid #ccc; padding-top: 10px; font-size:13px;">
            <label style="display:block; cursor:pointer;">
                <input type="checkbox" id="auto-cell-detection-toggle" checked> Detecció Automàtica
            </label>
        </div>
    `;

    const radios = popup.querySelectorAll('input[name="lightning-view"]');
    const historicControls = document.getElementById('historic-lightning-controls');
    const slider = document.getElementById('historic-lightning-slider');
    const sliderLabel = document.getElementById('historic-lightning-label');
    const autoDetectToggle = document.getElementById('auto-cell-detection-toggle');

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

    if (realtimeLightningManager.currentMode === 'historic') {
         popup.querySelector('input[value="historic"]').checked = true;
         historicControls.style.display = 'block';
         document.getElementById('analysis-mode-controls').style.display = 'block';
    } else if (realtimeLightningManager.layer1h && map.hasLayer(realtimeLightningManager.layer1h)) {
        popup.querySelector('input[value="realtime_plus_1h"]').checked = true;
    } else if (realtimeLightningManager.layer24h && map.hasLayer(realtimeLightningManager.layer24h)) {
        popup.querySelector('input[value="realtime_plus_24h"]').checked = true;
    }
    
    // Assegurem l'estat inicial correcte de les eines de dibuix
    toggleAnalysisMode();
}

// Per a Velocitat i Ratxa Semihorària
async function displaySimpleWind(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const timestampToUse = isHistoric ? new Date(targetDate) : findLatestSmcTimestamp(new Date());

    if (!isHistoric) { lastCheckedTimestamp = timestampToUse; }


    // NOU: Actualitzar el display
    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'simple_wind',
        timestamp: timestampToUse
    });

    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    const dataType = (config.base_id === 30) ? 'speed' : 'gust';
    const finalData = await fetchAllWindData(dataType, timestampToUse); // Utilitzem el timestamp
    dataMarkersLayer.clearLayers();
    finalData.forEach(estacio => {
        let value = parseFloat(estacio.speed_ms); if (isNaN(value)) return;
        const valueInKmh = value * 3.6;
        const displayValue = value * config.conversion;
        const color = getWindColor(valueInKmh);
        const formattedValue = displayValue.toFixed(config.decimals);
        const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
        L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${valueInKmh.toFixed(1)} km/h (${value.toFixed(1)} m/s)`).addTo(dataMarkersLayer);
    });
    isLoadingData = false;
}
// AFEGEIX AQUESTA NOVA FUNCIÓ AL COSTAT DE LES ALTRES FUNCIONS "display..."

// ★ REEMPLAÇA LA TEVA FUNCIÓ 'displayRovellonsIndex' PER AQUESTA ★
async function displayRovellonsIndex(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;
    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Calculant ${config.name}... (càrrega intensiva)` }) }).addTo(dataMarkersLayer);

    const dateForQuery = targetDate || new Date();
    updateHistoricDisplay({ mode: targetDate ? 'historic' : 'live', type: 'summary', timestamp: dateForQuery });
    
    const endDate = new Date(dateForQuery);
    const startDate = new Date(dateForQuery);
    startDate.setDate(startDate.getDate() - 20);

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

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
            const faseText = ['🌑 Nova','🌒 Creixent','🌓 Quart Creixent','🌔 Gibosa Creixent','🌕 Plena','🌖 Gibosa Minvant','🌗 Quart Minvant','🌘 Minvant'][Math.floor(faseActual * 8)];
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

/**
 * VERSIÓ FINAL I CORREGIDA: Mostra un resum diari d'una variable.
 * Soluciona l'error de LatLng en mode històric per a la precipitació.
 */
async function displaySummaryVariable(config, targetDate = null) {
    if (isLoadingData) return; isLoadingData = true;

    const isHistoric = targetDate !== null;
    const dateForDay = isHistoric ? targetDate : new Date();

    if (!isHistoric) { lastCheckedTimestamp = findLatestSmcTimestamp(new Date()); }

    updateHistoricDisplay({
        mode: isHistoric ? 'historic' : 'live',
        type: 'summary',
        timestamp: dateForDay
    });

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

    let resultData = [];
    const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

        const isDailyPrecip = config.id === 35 && config.summary === 'sum';

        if (isDailyPrecip) {
            const today = new Date();
            const cutoffDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
            cutoffDate.setUTCHours(0, 0, 0, 0);

            if (startOfDay < cutoffDate) {
                const result = await fetchDailyAccumulationDirectly(startOfDay);
                resultData = result.data;
            } else {
                const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
                resultData = result.data.map(d => ({ ...d, valor: d.valor || d.valor_lectura }));
            }

        } else if (config.id === 50) {
            const gust_ids = [50, 53, 56];
            const promises = gust_ids.map(id => fetchSmcDailySummary(id, 'max', startOfDay, endOfDay));
            const results = await Promise.all(promises);
            const finalGustData = new Map();
            for (const result of results) {
                result.data.forEach(station => { if (!finalGustData.has(station.codi_estacio)) finalGustData.set(station.codi_estacio, station); });
            }
            resultData = Array.from(finalGustData.values()).map(d => ({ ...d, valor: d.valor || d.valor_lectura }));

        } else {
            const result = await fetchSmcDailySummary(config.id, config.summary, startOfDay, endOfDay);
            resultData = result.data.map(d => ({ ...d, valor: d.valor || d.valor_lectura }));
        }

        const enrichedData = resultData.map(d => {
            const stationInfo = estacionsMap.get(d.codi_estacio);
            if (stationInfo) {
                return { ...d, ...stationInfo };
            }
            return null;
        }).filter(Boolean);

        dataMarkersLayer.clearLayers();
        
        enrichedData.forEach(estacio => {
            let value = Number(estacio.valor); if (isNaN(value)) return;

            // --- INICI DE LA MODIFICACIÓ ---
            let color;
            let textColor = '#000000'; // Color de text per defecte: negre
            
            switch (config.id) {
                case 3: case 44: // Humitat Màx/Mín
                    color = getHumidityColor(value);
                    textColor = getTextColorForHumidity(value); // Decidim el color del text
                    break;
                case 1: case 2: 
                    color = getPressureColor(value); 
                    break;
                case 50: 
                    color = getWindColor(value * 3.6); 
                    break;
                case 35: 
                    color = getDailyPrecipitationColor(value); 
                    break;
                case 72: 
                    color = getIntensityColor(value); 
                    break;
                default: 
                    color = getTempRgbaColor(value); 
                    break;
            }

            if (config.conversion) { value *= config.conversion; }
            const formattedValue = formatValueForLabel(value, config.decimals);
            
            const icon = L.divIcon({ 
                className: 'temp-label', 
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; color: ${textColor}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, 
                iconSize: [30, 18], 
                iconAnchor: [15, 9] 
            });
            // --- FI DE LA MODIFICACIÓ ---
            
            L.marker([estacio.lat, estacio.lon], { icon })
              .bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`)
              .addTo(dataMarkersLayer);
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
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

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
        if (finalResults.length === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'No hi ha dades disponibles.' }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3000);
            return;
        }

        finalResults.forEach(station => {
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
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Carregant dades...' }) }).addTo(dataMarkersLayer);

    const config = VARIABLES_CONFIG['weathercom_precip'];
    const weatherComApiKey = "e1f10a1e78da46f5b10a1e78da96f525";
    
    // =================================================================
    // MILLORA 1: OBTENIR MÉS DETALL AMB POC ZOOM
    // =================================================================
    const mapZoom = Math.round(map.getZoom());
    // Per obtenir més detall, fem la petició a un nivell de zoom superior (mapa + 1).
    // Limitem el zoom de la petició a un màxim de 12 per optimitzar el rendiment.
    const fetchZoomLevel = Math.min(mapZoom + 5, 12);
    // =================================================================

    const bounds = map.getBounds();
    const tileZoom = fetchZoomLevel - 1; // Càlcul d'índex per a rajoles de 512px

    const topLeftTile = getTileCoordinates(bounds.getNorthWest().lat, bounds.getNorthWest().lng, tileZoom);
    const bottomRightTile = getTileCoordinates(bounds.getSouthEast().lat, bounds.getSouthEast().lng, tileZoom);

    const promises = [];
    const now = new Date();
    const roundedDate = roundToNearest15Minutes(now);
    const timeEnd = roundedDate.getTime();
    const timeStart = timeEnd - (15 * 60 * 1000);

    for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
            // La URL ha d'utilitzar el 'fetchZoomLevel' per al paràmetre 'lod'
            const url = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart}-${timeEnd}&stepped=true`;
            promises.push(fetch(url).then(res => res.ok ? res.json() : null));
        }
    }

    try {
        const results = await Promise.all(promises);
        const processedStations = new Map();
        
        results.forEach(data => {
            if (!data) return;
            const key = `${timeStart}-${timeEnd}`;
            if (data.hasOwnProperty(key) && data[key].features) {
                data[key].features.forEach(feature => {
                    const properties = feature.properties;
                    const stationId = properties.id || `${properties.neighborhood}-${feature.geometry.coordinates.join(',')}`;

                    if (!processedStations.has(stationId)) {
                        const dailyRainInches = properties.dailyrainin;
                        if (dailyRainInches !== null) { 
                             processedStations.set(stationId, feature);
                        }
                    }
                });
            }
        });
        
        dataMarkersLayer.clearLayers();

        if (processedStations.size === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'No hi ha dades de pluja per a aquesta zona.' }) }).addTo(dataMarkersLayer);
        } else {
            processedStations.forEach(feature => {
                const properties = feature.properties;
                const dailyRainInches = properties.dailyrainin;
                const rainMm = dailyRainInches * 25.4;
                const color = getDailyPrecipitationColor(rainMm);
                const formattedValue = formatValueForLabel(rainMm, 1);

                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], { icon: icon })
                    .bindPopup(`<b>${properties.neighborhood}</b><br>Acumulació diària: ${formattedValue} ${config.unit}`)
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

/**
 * VERSIÓ AMB LOGS: Mostra la precipitació SEMIHORÀRIA (30 minuts) de Weather.com
 * fent dues peticions de 15 minuts i sumant els resultats.
 */
async function displayWeatherComSemiHourlyPrecipitation() {
    // NOU LOG: Iniciem un grup a la consola per mantenir-ho ordenat
    console.groupCollapsed(`%c[METEO] Iniciant consulta de Precipitació Semihorària Express...`, 'font-weight: bold; color: blue;');

    if (isLoadingData) {
        console.warn("Consulta avortada: ja hi ha una càrrega de dades en progrés.");
        console.groupEnd();
        return;
    }
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Carregant dades...' }) }).addTo(dataMarkersLayer);

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

    // NOU LOG: Mostrem els intervals de temps calculats
    console.log(`Interval 1 (Recent): de ${new Date(timeStart1).toLocaleString()} a ${new Date(timeEnd1).toLocaleString()}`);
    console.log(`Interval 2 (Anterior): de ${new Date(timeStart2).toLocaleString()} a ${new Date(timeEnd2).toLocaleString()}`);

    const promises1 = [];
    const promises2 = [];

    for (let x = topLeftTile.x; x <= bottomRightTile.x; x++) {
        for (let y = topLeftTile.y; y <= bottomRightTile.y; y++) {
            const url1 = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart1}-${timeEnd1}&stepped=true`;
            promises1.push(fetch(url1).then(res => res.ok ? res.json() : null));

            const url2 = `https://api2.weather.com/v2/vector-api/products/614/features?x=${x}&y=${y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart2}-${timeEnd2}&stepped=true`;
            promises2.push(fetch(url2).then(res => res.ok ? res.json() : null));
        }
    }
    
    // NOU LOG: Mostrem una URL d'exemple i el total de peticions
    if (promises1.length > 0) {
        console.log(`%cURL d'exemple (Interval 1):`, 'font-weight: bold;', `https://api2.weather.com/v2/vector-api/products/614/features?x=${topLeftTile.x}&y=${topLeftTile.y}&lod=${fetchZoomLevel}&apiKey=${weatherComApiKey}&tile-size=512&time=${timeStart1}-${timeEnd1}&stepped=true`);
    }
    console.log(`Total de peticions a l'API: ${promises1.length + promises2.length} (${promises1.length} per cada interval)`);


    try {
        const allPromises = [...promises1, ...promises2];
        const allResults = await Promise.all(allPromises);
        
        const results1 = allResults.slice(0, promises1.length);
        const results2 = allResults.slice(promises1.length);

        const stationTotals = new Map();

        const processAndSumResults = (results, timeStart, timeEnd) => {
            results.forEach(data => {
                if (!data) return;
                const key = `${timeStart}-${timeEnd}`;
                if (data.hasOwnProperty(key) && data[key].features) {
                    data[key].features.forEach(feature => {
                        const id = feature.properties.id || `${feature.properties.neighborhood}-${feature.geometry.coordinates.join(',')}`;
                        const rainInches = feature.properties.rainin || 0;
                        
                        if (stationTotals.has(id)) {
                            const existingData = stationTotals.get(id);
                            existingData.totalRainInches += rainInches;
                        } else {
                            stationTotals.set(id, {
                                feature: feature,
                                totalRainInches: rainInches
                            });
                        }
                    });
                }
            });
        };

        processAndSumResults(results1, timeStart1, timeEnd1);
        processAndSumResults(results2, timeStart2, timeEnd2);
        
        dataMarkersLayer.clearLayers();

        if (stationTotals.size === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'No hi ha dades de pluja per a aquesta zona.' }) }).addTo(dataMarkersLayer);
        } else {
            stationTotals.forEach(stationData => {
                const { feature, totalRainInches } = stationData;
                const rainMm = totalRainInches * 25.4;
                const color = getSemihorariaPrecipColor(rainMm);
                const formattedValue = formatValueForLabel(rainMm, 1);

                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });

                L.marker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], { icon: icon })
                    .bindPopup(`<b>${feature.properties.neighborhood}</b><br>Precipitació (30 min): ${formattedValue} ${config.unit}`)
                    .addTo(dataMarkersLayer);
            });
        }
        // NOU LOG: Informem del resultat
        console.log(`%cConsulta completada. S'han processat i sumat ${stationTotals.size} estacions amb dades.`, 'color: green; font-weight: bold;');

    } catch (error) {
        console.error("Error carregant o sumant les dades de Weather.com:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
        // NOU LOG: Tanquem el grup de la consola
        console.groupEnd();
    }
}

async function displayEcowittPrecipitation() {
    if (isLoadingData) return;
    isLoadingData = true;

    dataMarkersLayer.clearLayers();
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Carregant dades d\'Ecowitt...' }) }).addTo(dataMarkersLayer);

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
            body: JSON.stringify({
                lngsw: sw.lng, latsw: sw.lat, lngne: ne.lng, latne: ne.lat, zoom: requestZoom
            })
        });

        if (!response.ok) {
            throw new Error(`Error del proxy: ${response.statusText}`);
        }

        const geojsonData = await response.json();
        dataMarkersLayer.clearLayers();

        const featuresLose = geojsonData.data_lose?.features || [];
        const featuresMeter = geojsonData.data_meter?.features || [];
        const allFeatures = [...featuresLose, ...featuresMeter];

        if (!allFeatures || allFeatures.length === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'No hi ha estacions d\'Ecowitt en aquesta zona.' }) }).addTo(dataMarkersLayer);
            return;
        }

        let stationsWithDataCount = 0;
        allFeatures.forEach(feature => {
            const properties = feature.properties;

            let rainValue = null;
            if (typeof properties.dailyrainin === 'number') {
                rainValue = properties.dailyrainin;
            } else if (typeof properties.drain_piezo === 'number') {
                rainValue = properties.drain_piezo;
            }

            if (properties.isdata !== 1 || rainValue === null) {
                return;
            }
            
            stationsWithDataCount++;
            const rainMm = rainValue;
            
            // CORRECCIÓ 1: Utilitzem l'escala de colors correcta per a pluja diària.
            const color = getDailyPrecipitationColor(rainMm);
            const formattedValue = formatValueForLabel(rainMm, config.decimals);

            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18],
                iconAnchor: [15, 9]
            });

            const coords = feature.geometry.coordinates;
            L.marker([parseFloat(coords[1]), parseFloat(coords[0])], { icon: icon })
                .bindPopup(`<b>${properties.name || 'Estació Ecowitt'}</b><br>Acumulació diària: ${formattedValue} ${config.unit}`)
                .addTo(dataMarkersLayer);
        });

        if (stationsWithDataCount === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Cap estació Ecowitt visible reporta dades de pluja.' }) }).addTo(dataMarkersLayer);
        }

    } catch (error) {
        console.error("Error carregant les dades d'Ecowitt via proxy:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
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

    // Pas CLAU: Netegem les DUES capes
    dataMarkersLayer.clearLayers(); 
    windBarbsLayer.clearLayers();
    
    // Mostrem el missatge de "Carregant" a la capa de barbes
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(windBarbsLayer); 
    
    const finalData = await fetchAllWindData('speed', timestampToUse);
    windBarbsLayer.clearLayers(); 

    finalData.forEach(estacio => {
        const { lat, lon, nom, speed_ms, direction } = estacio; 
        if (isNaN(speed_ms) || isNaN(direction)) return;
        
        const icon = createWindBarbIcon(speed_ms, direction);
        
        // AFEGIM LA BARBA A LA CAPA CORRECTA: 'windBarbsLayer'
        L.marker([lat, lon], { icon })
            .bindPopup(`<b>${nom}</b><br>Velocitat: ${(speed_ms * 3.6).toFixed(1)} km/h<br>Direcció: ${direction.toFixed(0)}°`)
            .addTo(windBarbsLayer); 
    });
    
    isLoadingData = false;
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

    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);
    
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
                const ultima = estacionsAemetCat.reduce((max, d) => d.fint > max ? d.fint : max, estacionsAemetCat[0].fint);
                finalData.push(...estacionsAemetCat.filter(d => d.fint === ultima && typeof d[config.aemet_id] !== 'undefined').map(d => ({ source: 'aemet', lat: d.lat, lon: d.lon, nom: d.ubi, valor: d[config.aemet_id] })));
            }
        }
        dataMarkersLayer.clearLayers();
        finalData.forEach(estacio => {
            const value = Number(estacio.valor); if (isNaN(value)) return;
            const color = getTempRgbaColor(value);
            const formattedValue = formatValueForLabel(value, config.decimals);
            const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
            L.marker([estacio.lat, estacio.lon], { icon }).bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`).addTo(dataMarkersLayer);
        });
    } catch (error) { console.error("Error a displayDewPoint:", error); } 
    finally { isLoadingData = false; }
}

// REEMPLAÇA LA TEVA FUNCIÓ AMB AQUESTA VERSIÓ
async function displayCalculatedVariable(config, targetDate = null) {
    if (isLoadingData) return;
    isLoadingData = true;

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
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

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
        const sourceResults = await Promise.all(sourcePromises);
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
                    mergedDataByStation.set(stationId, { nom: stationData.nom, lat: stationData.lat, lon: stationData.lon, codi_estacio: stationData.codi_estacio });
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

                const color = getDynamicColor(finalValue, config.colorScale);
                let formattedValue;
                 if (config.showPositiveSign) {
                   const sign = finalValue > 0 ? '+' : '';
                   const numericValue = formatValueForLabel(finalValue, config.decimals);
                   formattedValue = sign + numericValue;
                 } else {
                   formattedValue = formatValueForLabel(finalValue, config.decimals);
                 }
                const icon = L.divIcon({ className: 'temp-label', html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`, iconSize: [30, 18], iconAnchor: [15, 9] });
                
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
        console.error("Error a displayCalculatedVariable:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error calculant les dades' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
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
    if (intensity < 1)   return "#0095f9"; // Feble
    if (intensity < 2)   return "#00c42c"; // Moderada
    if (intensity < 4)   return "#ffee47"; // Forta
    if (intensity < 6)   return "#ff7235"; // Molt forta
    if (intensity < 10)  return "#ff214e"; // Torrencial
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
        if (mm <= values_diaria[i+1]) {
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
    if (mm < 1)   return "#a1d3fc"; // Blau molt clar
    if (mm < 2.5) return "#51b5fa"; // Blau clar
    if (mm < 5)   return "#0095f9"; // Blau
    if (mm < 10)  return "#00c42c"; // Verd
    if (mm < 15)  return "#ffee47"; // Groc
    if (mm < 25)  return "#ff7235"; // Taronja
    if (mm < 40)  return "#ff214e"; // Vermell
    return "#bd30f3";              // Lila per a valors molt alts
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
      icon: L.divIcon({ className: 'loading-icon', html: `Processant dades...` })
    }).addTo(dataMarkersLayer);

    try {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
        
        const promises = [];
        let loopDate = new Date(startDate);
        const today = new Date();
        const cutoffDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
        cutoffDate.setUTCHours(0, 0, 0, 0);

        while (loopDate <= endDate) {
            const startOfDay = new Date(Date.UTC(loopDate.getUTCFullYear(), loopDate.getUTCMonth(), loopDate.getUTCDate()));
            
            if (loopDate < cutoffDate) {
                promises.push(fetchDailyAccumulationDirectly(new Date(startOfDay)));
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
        
        dataMarkersLayer.clearLayers();

        if (finalSums.size === 0) {
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades per a aquest interval' }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3000);
            return;
        }

        finalSums.forEach((totalSum, stationCode) => {
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo && totalSum > 0) {
                const color = getPrecipitationSumColor(totalSum);
                const formattedValue = formatValueForLabel(totalSum, 1);
                
                const icon = L.divIcon({
                    className: 'temp-label',
                    html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                    iconSize: [30, 18],
                    iconAnchor: [15, 9]
                });
                L.marker([estacioInfo.lat, estacioInfo.lon], { icon: icon })
                    .bindPopup(`<b>${estacioInfo.nom}</b><br>Suma Precipitació: ${formattedValue} mm`)
                    .addTo(dataMarkersLayer);
            }
        });
        
        const finalDataForTable = [];
        finalSums.forEach((totalSum, stationCode) => {
            const estacioInfo = estacionsMap.get(stationCode);
            if (estacioInfo) {
                finalDataForTable.push({ ...estacioInfo, codi_estacio: stationCode, valor: totalSum });
            }
        });
        lastSumatoriResult = finalDataForTable;

    } catch (error) {
        console.error("Error al mostrar el sumatori de precipitació:", error);
        dataMarkersLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'Error en la consulta' }) }).addTo(dataMarkersLayer);
    } finally {
        isLoadingData = false;
    }
}

/**
 * Crea una icona de fletxa/barba de vent en SVG que apunta a la direcció on VA el vent.
 * AQUESTA VERSIÓ TÉ LES BARBES MÉS AMPLES PER A MÉS VISIBILITAT.
 * @param {number} speed_ms - Velocitat del vent en metres per segon.
 * @param {number} direction - Direcció meteorològica del vent (d'on ve).
 * @returns {L.DivIcon} La icona de Leaflet.
 */
function createWindBarbIcon(speed_ms, direction) {
    const speedKmh = speed_ms * 3.6;
    const color = getWindColor(speedKmh); // Assumint que tens la funció getWindColor
    const knots = speed_ms * 1.94384;

    let barbs = '';
    let p = { x: -50, y: 0 }; 
    let remainingKnots = Math.round(knots / 5) * 5;

    // Banderoles de 50 nusos (més amples)
    while (remainingKnots >= 50) {
        // CANVI: La y passa de -12 a -18 per fer el triangle més ample
        barbs += `<path d="M ${p.x} 0 L ${p.x + 12} -18 L ${p.x} -18 Z" stroke-width="5.0" stroke="black" fill="${color}" />`;
        p.x += 14;
        remainingKnots -= 50;
    }
    // Barbes de 10 nusos (més amples)
    while (remainingKnots >= 10) {
        // CANVI: La y passa de -12 a -18 per fer la línia més ampla
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 12}" y2="-18" stroke="black" stroke-width="6.0" />`;
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 12}" y2="-18" stroke="${color}" stroke-width="3.5" />`;
        p.x += 8;
        remainingKnots -= 10;
    }
    // Mitja barba de 5 nusos (més ampla)
    if (remainingKnots >= 5) {
        // CANVI: La y passa de -6 a -9 (la meitat de -18) per fer la línia més ampla
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 6}" y2="-9" stroke="black" stroke-width="6.0" />`;
        barbs += `<line x1="${p.x}" y1="0" x2="${p.x + 6}" y2="-9" stroke="${color}" stroke-width="3.5" />`;
    }
    
    const rotation = direction - 90;

    // El viewBox anterior hauria de seguir sent suficient, però el mantenim ample per seguretat.
    const svg = `
        <div class="wind-barb-icon-wrapper">
            <svg class="wind-barb-svg" viewBox="-65 -35 130 70" style="transform: rotate(${rotation}deg);">
                
                <line x1="0" y1="0" x2="-50" y2="0" stroke="black" stroke-width="6.0" />
                <line x1="0" y1="0" x2="-50" y2="0" stroke="${color}" stroke-width="3.5" />
                
                <g stroke-linecap="round">
                    ${barbs}
                </g>
            </svg>
        </div>`;

    return L.divIcon({
        html: svg,
        className: 'wind-barb-icon-container',
        iconSize: [60, 60],
        iconAnchor: [30, 30]
    });
}

/**
 * ★ VERSIÓ MODIFICADA: Mostra la variació d'una variable (Tª o Pressió) ★
 * Ara és genèrica i funciona per a qualsevol interval de temps definit a la config.
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
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Carregant ${config.name}...` }) }).addTo(dataMarkersLayer);

    let todayDataRaw, yesterdayDataRaw;
    
    try {
        if (config.comparison === 'daily_summary') {
            // (Aquesta part es queda igual, per a futures variables de resum)
            const startOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
            const endOfToday = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));
            const startOfYesterday = new Date(startOfToday.getTime() - (24 * 60 * 60 * 1000));
            const endOfYesterday = new Date(endOfToday.getTime() - (24 * 60 * 60 * 1000));
            [todayDataRaw, yesterdayDataRaw] = await Promise.all([
                fetchSmcDailySummary(config.base_id, config.summary, startOfToday, endOfToday),
                fetchSmcDailySummary(config.base_id, config.summary, startOfYesterday, endOfYesterday)
            ]);

        } else { // 'instant'
            const timestampAvui = isHistoric ? roundToSemiHourly(new Date(targetDate)) : findLatestSmcTimestamp(new Date());
            
            // ★ CANVI CLAU: L'interval de temps ara és dinàmic ★
            const timeshiftMs = (config.timeshift_hours || 24) * 60 * 60 * 1000;
            const timestampAnterior = new Date(timestampAvui.getTime() - timeshiftMs);
            
            const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
            const metadata = await $.getJSON(urlMetadades);
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

            const [todayValues, yesterdayValues] = await Promise.all([
                fetchSmcInstant(config.base_id, timestampAvui),
                fetchSmcInstant(config.base_id, timestampAnterior) // ★ Utilitzem el nou timestamp
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
                    return { ...estacioAnterior, valor: valorAvui - valorAnterior };
                }
            }
            return null;
        }).filter(d => d !== null);

        dataMarkersLayer.clearLayers();
        if (finalData.length === 0) {
             L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon error-icon', html: 'No hi ha dades coincidents' }) }).addTo(dataMarkersLayer);
        }

        finalData.forEach(estacio => {
            const value = Number(estacio.valor);
            if (isNaN(value)) return;
            
            // ★ CANVI CLAU: Seleccionem la funció de color correcta ★
            const color = (config.base_id === 34) ? getPressureTrendColor(value) : getVariationColor(value);
            
            const formattedValue = (value > 0 ? '+' : '') + value.toFixed(config.decimals);
            const icon = L.divIcon({
                className: 'temp-label',
                html: `<div style="width: 100%; height: 100%; background-color: ${color}; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${formattedValue}</div>`,
                iconSize: [30, 18], iconAnchor: [15, 9]
            });
            L.marker([estacio.lat, estacio.lon], { icon: icon, value: value }) // Guardem el valor per als clústers
                .bindPopup(`<b>${estacio.nom}</b><br>${config.name}: ${formattedValue} ${config.unit}`)
                .addTo(dataMarkersLayer);
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

const convergencesLayer = L.layerGroup();
let windArrowsLayer = L.layerGroup();
let areArrowsVisible = true;
let velocityLayer = null;
let isLoadingWind = false;
let windUpdateInterval = null;
let windUpdateTimeout = null;

// --- Funcions de càrrega de dades (Globals) ---

async function loadAemetData() {
    const apiKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5wb25zYUBnbWFpbC5jb20iLCJqdGkiOiI1OTZhMjQ3MC0zODg2LTRkNzktOTE3OC01NTA5MDI5Y2MwNjAiLCJpc3MiOiJBRU1FVCIsImlhdCI6MTUyMTA0OTg0MywidXNlcklkIjoiNTk2YTI0NzAtMzg4Ni00ZDc5LTkxNzgtNTUwOTAyOWNjMDYwIiwicm9sZSI6IiJ9.rmsBWXYts5VUBXKlErX7i9W0e3Uz-sws33bgRcIvlug";
    const urlInicial = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
    try {
        const res1 = await fetch(urlInicial, { headers: { 'api_key': apiKey, 'accept': 'application/json' }});
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
        if (typeof estacio.vv === 'undefined' || typeof estacio.dv === 'undefined') return null;
        const speed = estacio.vv;
        const direction = estacio.dv;
        const angleRad = (270 - direction) * (Math.PI / 180);
        return { lat: estacio.lat, lon: estacio.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), nom: estacio.ubi };
    }).filter(d => d !== null);
    return { data: processedData, timestamp: ultimaDataAemet };
}

function loadSmcData() {
    return new Promise((resolve) => {
        const targetTimestamp = findLatestSmcTimestamp(new Date());
        const yyyy = targetTimestamp.getUTCFullYear();
        const mm = String(targetTimestamp.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(targetTimestamp.getUTCDate()).padStart(2, '0');
        const hh = String(targetTimestamp.getUTCHours()).padStart(2, '0');
        const mi = String(targetTimestamp.getUTCMinutes()).padStart(2, '0');
        const finalTimestampString = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00.000`;
        
        console.log(`[VENT] Demanant dades SMC per a les: ${finalTimestampString}`);
        
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60%0AWHERE%20caseless_one_of(%60nom_estat_ema%60%2C%20%22Operativa%22)";

        $.getJSON(urlMetadades).done(metadata => {
            const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
            const variableCodes = [30, 31, 46, 47, 48, 49];
            const requests = variableCodes.map(code => {
                const url = `https://analisi.transparenciacatalunya.cat/resource/nzvn-apee.json?data_lectura=${finalTimestampString}&codi_variable=${code}`;
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
    const [wind10m, dir10m, wind2m, dir2m, wind6m, dir6m] = datasets;
    const allWind = [wind10m, wind6m, wind2m];
    const allDir = [dir10m, dir6m, dir2m];
    const processedStations = new Set();
    const smcWindData = [];

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
                smcWindData.push({ lat: estacioInfo.lat, lon: estacioInfo.lon, u: speed * Math.cos(angleRad), v: speed * Math.sin(angleRad), codi_estacio: stationCode, nom: estacioInfo.nom });
                processedStations.add(stationCode);
            }
        });
    });
    return smcWindData;
}


// --- Funcions de visualització del vent ---

function displayCombinedWindData(combinedData) {
    convergencesLayer.clearLayers();
    windArrowsLayer.clearLayers();

    if (combinedData.length === 0) {
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Dades de vent no disponibles' }) }).addTo(convergencesLayer);
        return;
    }

    const latitudep = Array.from({length: 25}, (_, i) => 42.9 - i * 0.1);
    const longitudep = Array.from({length: 37}, (_, i) => 0.1 + i * 0.1);
    
    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI/180;
        const φ2 = lat2 * Math.PI/180;
        const Δφ = (lat2-lat1) * Math.PI/180;
        const Δλ = (lon2-lon1) * Math.PI/180;
        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) / 1000;
    }
    
    function interpolateWindData(uData, vData, latEst, lonEst) {
        const valorx = [], valory = [];
        for (let j = 0; j < latitudep.length; j++) {
            for (let k = 0; k < longitudep.length; k++) {
                let sumU = 0, sumV = 0, sumW = 0;
                for (let i = 0; i < latEst.length; i++) {
                    const d = haversine(latitudep[j], longitudep[k], latEst[i], lonEst[i]);
                    if (d < 50) { // Radi d'influència
                        const w = 1 / Math.pow(d, 3); // Ponderació per distància
                        sumU += uData[i] * w; sumV += vData[i] * w; sumW += w;
                    }
                }
                valorx.push(sumW ? sumU / sumW : 0);
                valory.push(sumW ? sumV / sumW : 0);
            }
        }
        return { valorx, valory };
    }

    const latData = combinedData.map(d => d.lat);
    const lonData = combinedData.map(d => d.lon);
    const u = combinedData.map(d => d.u);
    const v = combinedData.map(d => d.v);
    const { valorx, valory } = interpolateWindData(u, v, latData, lonData);

    const header = { parameterUnit: "m.s-1", la1: latitudep[0], lo1: longitudep[0], dx: 0.1, dy: 0.1, nx: longitudep.length, ny: latitudep.length };
    const windgbr = [{ header: { ...header, parameterCategory: 2, parameterNumber: 2 }, data: valorx }, { header: { ...header, parameterCategory: 2, parameterNumber: 3 }, data: valory }];

    velocityLayer = L.velocityLayer({
        displayValues: true, data: windgbr, minVelocity: 0, maxVelocity: 30,
        velocityScale: 0.010, particleAge: 2300, lineWidth: 2.3, particleMultiplier: 1/30,
        colorScale: ["#000000"],
        pane: 'convergenciaPane'
    });
    convergencesLayer.addLayer(velocityLayer);

    combinedData.forEach(d => {
        if (d.u === 0 && d.v === 0) return;
        const magnitude = Math.sqrt(d.u**2 + d.v**2);
        const u_norm = d.u / magnitude, v_norm = d.v / magnitude;
        const line = L.polyline([[d.lat, d.lon], [d.lat + v_norm * 0.08, d.lon + u_norm * 0.08]], { color: 'black', weight: 1.5, opacity: 0.8 });
        const decorator = L.polylineDecorator(line, { patterns: [{ offset: '100%', repeat: 0, symbol: L.Symbol.arrowHead({ pixelSize: 10, polygon: false, pathOptions: { stroke: true, weight: 1.5, color: 'black', opacity: 0.8 }}) }] });
        windArrowsLayer.addLayer(line).addLayer(decorator);
    });

    if (areArrowsVisible) {
        convergencesLayer.addLayer(windArrowsLayer);
    }
}

// --- Funció principal i controladors d'esdeveniments de la capa de vent ---

function startWindLayer() {
    if (isLoadingWind) return;
    isLoadingWind = true;
    console.log("Iniciant càrrega de dades de vent...");

    if (!velocityLayer) {
        convergencesLayer.clearLayers();
        L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: 'Carregant dades de vent...' }) }).addTo(convergencesLayer);
    }
    
    Promise.all([loadSmcData(), loadAemetData()]).then(([smcResult, aemetResult]) => {
        let allData = [];
        const smcTime = smcResult.timestamp ? new Date(smcResult.timestamp + 'Z').getTime() : 0;
        const aemetTime = aemetResult.timestamp ? new Date(aemetResult.timestamp).getTime() : 0;

        if (smcTime > 0) {
            allData.push(...smcResult.data);
            if (aemetTime > 0 && Math.abs(smcTime - aemetTime) < 30 * 60 * 1000) {
                allData.push(...aemetResult.data);
            }
        } else if (aemetTime > 0) {
            allData.push(...aemetResult.data);
        }
        
        displayCombinedWindData(allData);
        isLoadingWind = false;
    }).catch(() => { isLoadingWind = false; });
}

convergencesLayer.on('add', function() {
    startWindLayer();
    if (windUpdateInterval) clearInterval(windUpdateInterval);
    windUpdateInterval = setInterval(startWindLayer, 15 * 60 * 1000);
});

convergencesLayer.on('remove', function() {
    if (windUpdateInterval) { clearInterval(windUpdateInterval); windUpdateInterval = null; }
    if (velocityLayer || isLoadingWind) { 
        convergencesLayer.clearLayers(); 
        velocityLayer = null; 
        isLoadingWind = false; 
    }
});

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
convergencesLayer.on('add', function() {
    startWindLayer();
    scheduleNextWindUpdate();
});

// Modificació de la teva funció `on('remove', ...)`
convergencesLayer.on('remove', function() {
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

// ===================================================================
// FI DE LA NOVA CAPA DE VENT
// ===================================================================


// ===============================================================

// AFEGEIX AQUESTA LÍNIA JUST A SOTA
const windBarbsLayer = L.layerGroup().addTo(map);

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
            "Meteocat gris": baseLayers["Base Meteocat (JSON)"]
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

// 2. Organitzem les capes de superposició (overlays) en grups
const styledOverlays = [
    {
        groupName: "Radar i convergències",
        expanded: false, // Aquest grup començarà obert
        layers: {
            "Convergències Vent": convergencesLayer,
            "PoN sense corregir": plujaneu_layer,
            "CAPPI sense corregir": radar_layer,
            "Opera Radar": rainviewer_layer,
            "Windy Radar": windy_radar_layer, // <-- AFEGEIX AQUESTA LÍNIA
            "CAPPI intern": cappi_intern_layer, // <-- AFEGEIX AQUESTA LÍNIA
            "Llarg abast intern": cappi_llarg_abast_layer // <-- AFEGEIX AQUESTA LÍNIA

        }
    },
        {
        groupName: "Satèl·lit MTG",
        expanded: false, // Aquest grup començarà obert
        layers: {
            "GeoColor": eumetsatLayer, // <-- AFEGIDA AQUÍ
            "IR 10.8": eumetsat_ir_layer, // <-- AFEGEIX LA TEVA NOVA CAPA AQUÍ
            "HRVIS": eumetsat_hrvis_layer,
            "Sandwich 2": sandwich_layer_final 
        }
    },
    {
        groupName: "Interpolació temperatura",
        expanded: false,
        layers: {
            "Temperatura Actual": interpolationTactualLayer,
            "Temperatura Màxima": L.layerGroup(),
            "Temperatura Mínima": interpolationTminLayer
        }
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
            "Live Cams": camerasLayer,
            "Incendis actuals ": actuacionsUrgentsLayer,
            "Pla Alfa Municipal": plaAlfaLayer,
            "Zones Perill Allaus": wmsLayer
        }
    }
];


// ===================================================================
// INICI DEL TRUC: INJECTEM LES CAPES DE SATÈL·LIT AL MENÚ
// ===================================================================

// 1. Busquem el grup de satèl·lits dins de la configuració del menú
const grupSatelit = styledOverlays.find(g => g.groupName === "Satèl·lit MTG");

// 2. Si el trobem, fusionem les capes que ja tenia (Eumetsat)
//    amb totes les noves que hem creat de Meteologix (satelliteMenuLayers)
if (grupSatelit) {
    grupSatelit.layers = {
        ...grupSatelit.layers,       // Mantenim les capes que ja hi havia
        ...satelliteMenuLayers      // Afegim totes les noves de cop
    };
}

// ===================================================================
// FI DEL TRUC
// ===================================================================

// 3. Creem el control amb l'opció de començar TANCAT
const styledLayerControl = L.Control.styledLayerControl(styledBaseLayers, styledOverlays, {
    collapsed: true, // <-- CANVIAT A TRUE
    position: 'topright'
});
map.addControl(styledLayerControl);



const sumatoriControls = document.getElementById('sumatori-controls');

// AFEGEIX AQUEST BLOC NOU
document.getElementById('lightning-btn').addEventListener('click', function() {
    // Si ja està actiu, l'aturem. Si no, l'activem.
    if (realtimeLightningManager.isActive) {
        realtimeLightningManager.stop();
        // Opcional: torna a mostrar una capa per defecte, per exemple la temperatura.
        displayVariable('smc_32');
    } else {
        stopAllDataLayers(); // Aturem qualsevol altra capa de dades
        realtimeLightningManager.start(); // Iniciem el gestor de llamps
        createLightningPopup(); // Creem el seu menú d'opcions
    }
});

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

// ★ REEMPLAÇA LA TEVA FUNCIÓ 'refreshCurrentVariableView' PER AQUESTA ★
function refreshCurrentVariableView() {
    const activeMenuItem = document.querySelector('#meteo-controls .submenu li.active[data-variable-key]');
    if (!activeMenuItem) { return; }
    
    const variableKey = activeMenuItem.dataset.variableKey;
    const config = VARIABLES_CONFIG[variableKey];
    if (!config) { return; }

    const dateToUse = historicModeTimestamp;

    // ★ AQUESTA ÉS LA LÒGICA AFEGIDA ★
    if (config.isSpecial) {
        displayRovellonsIndex(config, dateToUse);
    } // La resta de la funció es manté igual
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
    } else if (config.isCalculated) {
        displayCalculatedVariable(config, dateToUse);
    } else {
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
    let currentValue = parseInt(slider.value, 10);
    let maxValue = parseInt(slider.max, 10);
    if (currentValue < maxValue) {
        slider.value = currentValue + 1;
        // Simulem un esdeveniment 'input' per refrescar el mapa
        slider.dispatchEvent(new Event('input'));
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

// Funció i event listener per al botó de les fletxes
function toggleWindArrows() {
    areArrowsVisible = !areArrowsVisible;
    const btn = document.getElementById('toggle-arrows-btn');
    btn.classList.toggle('inactive', !areArrowsVisible);

    if (areArrowsVisible) {
        if (map.hasLayer(convergencesLayer)) {
            convergencesLayer.addLayer(windArrowsLayer);
        }
    } else {
        if (convergencesLayer.hasLayer(windArrowsLayer)) {
            convergencesLayer.removeLayer(windArrowsLayer);
        }
    }
}
document.getElementById('toggle-arrows-btn').addEventListener('click', toggleWindArrows);

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
      timeDependentLayers.forEach(layer => { if (map.hasLayer(layer)) layer.refresh(); });
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
      timeDependentLayers.forEach(layer => { if (map.hasLayer(layer)) layer.refresh(); });
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
map.on('baselayerchange', function(event) {
    const isBlanc = event.layer === baseLayers.Blanc;
    timeDependentLayers.forEach(layer => {
      if (map.hasLayer(layer)) {
          layer.setOpacity(isBlanc ? 1 : 0.85);
      }
    });
  });

// ★ REEMPLAÇA EL TEU BLOC 'DOMContentLoaded' SENCER PER AQUEST ★

document.addEventListener('DOMContentLoaded', function() {
    
    // ----- Funció "Mestra" per a la Visibilitat de Totes les Llegendes -----
    function updateAllLegendsVisibility() {
        // Obtenim totes les llegendes
        const plujaLegend = document.getElementById('pluja-legend');
        const radarLegend = document.getElementById('radar-legend');
        const sequedatLegend = document.getElementById('sequedat-legend');
        const fireriskLegend = document.getElementById('firerisk-legend');
        const rovellonsLegend = document.getElementById('rovellons-legend'); // <-- LÍNIA NOVA

        // Comprovem que existeixen per evitar errors
        if (!plujaLegend || !radarLegend || !sequedatLegend || !fireriskLegend || !rovellonsLegend) return;

        // Lògica per a les capes del mapa (radar/pluja)
        plujaLegend.style.display = map.hasLayer(plujaneu_layer) ? 'block' : 'none';
        radarLegend.style.display = map.hasLayer(radar_layer) ? 'block' : 'none';

        // Lògica per a les variables de dades
        sequedatLegend.style.display = (currentVariableKey === 'calc_dryness_index') ? 'block' : 'none';
        fireriskLegend.style.display = (currentVariableKey === 'calc_fire_risk_semihourly') ? 'block' : 'none'; 
        rovellonsLegend.style.display = (currentVariableKey === 'calc_rovellons_index') ? 'block' : 'none'; // <-- LÍNIA NOVA
    }

    // ----- Assignació d'Events a les Capes del Mapa -----
    plujaneu_layer.on('add remove', updateAllLegendsVisibility);
    radar_layer.on('add remove', updateAllLegendsVisibility);

    // ----- Gestor de Clics del Menú Principal -----
    document.getElementById('meteo-controls').addEventListener('click', function(event) {
        if (event.target.closest('#historic-controls-container')) return;
        const target = event.target.closest('[data-variable-key]');
        if (!target) return;
        
        event.preventDefault();
        document.getElementById('sumatori-controls').style.display = 'none';

        document.querySelectorAll('#meteo-controls li, #meteo-controls a').forEach(el => el.classList.remove('active'));
        let activeElement = target.closest('li') || target;
        if (activeElement) {
            activeElement.classList.add('active');
            const mainMenuItem = activeElement.closest('.main-menu-item');
            if (mainMenuItem) mainMenuItem.querySelector('a').classList.add('active');
        }

        const variableKey = target.dataset.variableKey;
        currentVariableKey = variableKey;

        // Cridem la funció mestra, que s'encarregarà de mostrar/amagar la llegenda correcta.
        updateAllLegendsVisibility();

        if (variableKey === 'sumatori_precipitacio') {
            document.getElementById('sumatori-controls').style.display = 'flex';
            dataMarkersLayer.clearLayers();
            return;
        }

        const config = VARIABLES_CONFIG[variableKey];
        if (!config) return;
        
        const dateToUse = historicModeTimestamp;

        if (config.isSpecial) {
            displayRovellonsIndex(config, dateToUse);
        }
        else if (config.isEcowitt) displayEcowittPrecipitation();
        else if (config.isWeatherComSemiHourly) displayWeatherComSemiHourlyPrecipitation();
        else if (config.isWeatherCom) displayWeatherComPrecipitation();
        else if (config.isNightSummary) displayNightHumidexMin(config, dateToUse);
        else if (config.comparison) displayVariation(config, dateToUse);
        else if (config.summary) displaySummaryVariable(config, dateToUse);
        else if (config.isWindBarb) displayWindBarb(config, dateToUse);
        else if (config.isSimpleWind) displaySimpleWind(config, dateToUse);
        else if (config.isHybrid) displayDewPoint(config, dateToUse);
        else if (config.isCalculated) displayCalculatedVariable(config, dateToUse);
        else displayVariable(variableKey, dateToUse); 
    });

// ======================================================
// LÒGICA PER ALS BOTONS D'ALERTES XEMA
// ======================================================
const alertBtn = document.getElementById('alert-btn');
const alertPanel = document.getElementById('alert-panel');
const closeAlertPanelBtn = document.getElementById('close-alert-panel');
const alertIntensityBtn = document.getElementById('alert-intensity-btn');
const alertAccumulationBtn = document.getElementById('alert-accumulation-btn');

if (alertBtn && alertPanel && closeAlertPanelBtn && alertIntensityBtn && alertAccumulationBtn) {
    // Event per obrir el panell d'alertes
    alertBtn.addEventListener('click', () => {
        alertPanel.style.display = 'block';
    });

    // Event per tancar el panell d'alertes
    closeAlertPanelBtn.addEventListener('click', () => {
        alertPanel.style.display = 'none';
    });

    // Event per al botó d'alerta per intensitat
    alertIntensityBtn.addEventListener('click', () => {
        displayAlerts('alert_intensity');
    });

    // Event per al botó d'alerta per acumulació
    alertAccumulationBtn.addEventListener('click', () => {
        displayAlerts('alert_accumulation');
    });
}

    // ----- Lògica per a Fer Arrossegables els Panells i Llegendes -----
    const drawingPanel = document.getElementById('drawing-panel');
    const avisosPanel = document.getElementById('avisos-comarques-panel');
    if (drawingPanel) makeDraggable(drawingPanel, document.getElementById('drawing-panel-header'));
    if (avisosPanel) makeDraggable(avisosPanel, document.getElementById('avisos-panel-header'));

    const llegendaPluja = document.getElementById('pluja-legend');
    const llegendaRadar = document.getElementById('radar-legend');
    const llegendaSequedat = document.getElementById('sequedat-legend');
    const llegendaIncendis = document.getElementById('firerisk-legend');
    const llegendaRovellons = document.getElementById('rovellons-legend');

    if (llegendaPluja) makeDraggable(llegendaPluja, llegendaPluja.querySelector('.legend-header'));
    if (llegendaRadar) makeDraggable(llegendaRadar, llegendaRadar.querySelector('.llegenda-header'));
    if (llegendaSequedat) makeDraggable(llegendaSequedat, llegendaSequedat.querySelector('.legend-header'));
    if (llegendaIncendis) makeDraggable(llegendaIncendis, llegendaIncendis.querySelector('.legend-header'));
    if (llegendaRovellons) makeDraggable(llegendaRovellons, llegendaRovellons.querySelector('.legend-header'));

    // ----- Lògica per als Botons de Tancar -----
    document.querySelectorAll('.close-legend').forEach(button => {
        button.addEventListener('click', function() {
            const legendToClose = this.closest('.legend, .llegenda');
            if (legendToClose) legendToClose.style.display = 'none';
        });
    });

    // ----- Crida Inicial per Establir l'Estat Correcte -----
    updateAllLegendsVisibility();
});

// ======================================================
// FUNCIONALITAT PER AL NOU BOTÓ DE NETEJA
// ======================================================

// Aquest és el codi corregit
document.getElementById('clear-data-btn').addEventListener('click', function() {
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
    L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `Buscant ${config.name}...` }) }).addTo(dataMarkersLayer);

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
            L.marker(map.getCenter(), { icon: L.divIcon({ className: 'loading-icon', html: `No hi ha alertes per a la data ${friendlyDate}.` }) }).addTo(dataMarkersLayer);
            setTimeout(() => dataMarkersLayer.clearLayers(), 3500);
            return;
        }

        dataMarkersLayer.clearLayers();
        stationsInAlert.forEach(estacio => {
            const estacioInfo = { lat: estacio.lat, lon: estacio.lon, nom: estacio.nom };
            const value = parseFloat(estacio.valor);

            if (estacioInfo && !isNaN(value)) {
                const color = (config.summary === 'max') ? getSemihorariaPrecipColor(value) : getDailyPrecipitationColor(value);
                
                // <-- CANVI CLAU 2: DISSENY DE L'ETIQUETA UNIFICAT -->
                // Utilitzem les mateixes propietats que la resta de marcadors de dades.
                const icon = L.divIcon({
                    className: 'temp-label', // Classe estàndard
                    html: `<div style="background-color: ${color}; width: 100%; height: 100%; border-radius: 9px; display: flex; align-items: center; justify-content: center;">${value.toFixed(1)}</div>`,
                    iconSize: [30, 18],     // Mida estàndard
                    iconAnchor: [15, 9]      // Ancoratge estàndard
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
    const timeCutoff = now - (120 * 60 * 1000); // Finestra fixa de 120 minuts

    // 1. Afegeix les dades històriques (que ja estan dins de la finestra de 120 min)
    realtimeLightningManager.historicStrikes.forEach((strike, id) => {
        combinedStrikes.set(id, strike);
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
    const MINIM_LLAMPS_PER_ACTIVITAT = 5;

    celules.forEach(cell => {
        cell.pixelKeys = new Set(cell.pixels.map(p => {
            const gridX = Math.floor(p.lon / RASTER_RESOLUTION);
            const gridY = Math.floor(p.lat / RASTER_RESOLUTION);
            return `${gridX}_${gridY}`;
        }));
        cell.recomptesComplets = new Array(bins).fill(0);
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
        
        const MINUTS_MINIMS_PER_ANALISI_LJ = 14;
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
    } else {
        console.log("Anàlisi retrospectiva: No s'han trobat cèl·lules significatives.");
        cellulesTempestaLayer.clearLayers();
        ljIconsLayer.clearLayers();
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
             const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
             const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
             mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats);
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
                const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
                const saltsCombinats = [...cell.saltN2, ...cell.saltN1];
                mostrarGrafic(labels, cell.recomptesComplets, saltsCombinats);
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
    const labels = Array.from({ length: 60 }, (_, i) => `-${120 - i*2}m`);
    const saltsCombinats = [...celulaAnalitzada.saltN2, ...celulaAnalitzada.saltN1];
    mostrarGrafic(labels, celulaAnalitzada.recomptesComplets, saltsCombinats);
}

/**
 * VERSIÓ FINAL: Dibuixa el gràfic, gestiona els colors per intensitat,
 * la icona de llamp i la interactivitat de la finestra.
 */
function mostrarGrafic(labels, data, saltsDetectats = []) {
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
    const backgroundColors = data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).bg : 'rgba(0, 149, 249, 0.5)');
    const borderColors = data.map((_, index) => saltsMap.has(index) ? getColorPerSalt(saltsMap.get(index)).border : 'rgba(0, 149, 249, 1)');

    lightningChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Llamps per minut dins la zona',
                data: data,
                backgroundColor: backgroundColors,
                borderColor: borderColors,
                borderWidth: 1
            }]
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
    layerGroup: L.layerGroup({ pane: 'llampsPane' }),

    // Propietats per a les dades històriques i les capes de resum
    historicStrikes: new Map(),
    historicLayerGroup: L.layerGroup({ pane: 'llampsPane' }),
    historicUpdateInterval: null,
    timeFilterMinutes: 120,
    layer1h: null,
    layer24h: null,
    MAX_AGE_MINS: 30,

    // Inicia el mòdul de llamps i connecta a les dues fonts
    start: function() {
        if (this.isActive) return;
        console.log("Iniciant mòdul de llamps (amb dues fonts)...");
        this.isActive = true;
        this.layerGroup.addTo(map);
        this.historicLayerGroup.addTo(map);
        this.connect();
        this.updateInterval = setInterval(() => this.updateMarkers(), 5000);
    },

    // Atura el mòdul i tanca les dues connexions
    stop: function() {
        if (!this.isActive) return;
        console.log("Aturant mòdul de llamps.");
        this.isActive = false;
        if (this.socketLm) this.socketLm.close();
        if (this.socketBo) this.socketBo.close();
        this.socketLm = null;
        this.socketBo = null;

        if (this.updateInterval) clearInterval(this.updateInterval);
        this.updateInterval = null;
        
        this.strikeMarkers.clear();
        this.layerGroup.clearLayers();
        map.removeLayer(this.layerGroup);

        this.toggleHistoricLayers('none');
        const popup = document.getElementById('lightning-popup');
        if (popup) popup.remove();
    },

    // Funció orquestradora que inicia les dues connexions
    connect: function() {
        this.connectLightningMaps();
        this.connectBlitzortung();
    },

    // Connexió a LightningMaps.org (sense canvis)
    connectLightningMaps: function() {
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
                this.socketLm.send(`{"k":${(data.k*3604)%7081*new Date().getTime()/100}}`);
                return;
            }
            if (data.strokes) data.strokes.forEach(s => this.addStrike(s));
        };
        this.socketLm.onclose = () => console.log("WS LightningMaps: Tancat.");
        this.socketLm.onerror = (error) => console.error("WS LightningMaps Error:", error);
    },

    // VERSIÓ CORREGIDA per connectar-se a Blitzortung.org
    connectBlitzortung: function() {
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
    decodeBlitzortungStrike: function(data) {
        // El JSON descomprimit té claus normals: 'lat', 'lon', 'time', etc.
        if (data.lat !== undefined && data.lon !== undefined) {
            const id = `bo-${data.time}-${data.lat}-${data.lon}`;
            return {
                id: id,
                lat: data.lat,
                lon: data.lon
            };
        }
        return null;
    },

    // Funció unificada per afegir qualsevol llamp al mapa
addStrike: function(strike) {
    if (this.strikeMarkers.has(strike.id) || !strike.lat || !strike.lon) return;

    // CORRECCIÓ: Especifiquem el 'pane' correcte aquí
    const flashStyle = { radius: 30, fillColor: "#FFFFFF", fillOpacity: 0.8, weight: 0, pane: 'llampsPane' };
    
    const marker = L.circleMarker([strike.lat, strike.lon], flashStyle);
    const markerData = { marker: marker, timestamp: new Date().getTime() };
    this.strikeMarkers.set(strike.id, markerData);
    this.layerGroup.addLayer(marker);
    
    setTimeout(() => { if (this.strikeMarkers.has(strike.id)) this.updateMarkerStyle(markerData, 0); }, 250);
    this.createExpandingCircle(strike.lat, strike.lon);
},

    // Funcions per a la visualització dels llamps en temps real
updateMarkers: function() {
    const now = new Date().getTime();
    
    // El temps màxim de vida ara depèn del valor del slider quan el mode històric està actiu
    // Si no està en mode històric, es manté el màxim de 30 minuts.
    const maxAgeMins = this.currentMode === 'historic' ? this.timeFilterMinutes : this.MAX_AGE_MINS;

    this.strikeMarkers.forEach((markerData, strikeId) => {
        const ageMins = (now - markerData.timestamp) / 60000;
        if (ageMins > maxAgeMins) {
            this.layerGroup.removeLayer(markerData.marker);
            this.strikeMarkers.delete(strikeId);
        } else {
            // L'estil dels llamps en temps real continua basant-se en l'escala de 30 min
            this.updateMarkerStyle(markerData, ageMins);
        }
    });
},

updateMarkerStyle: function(markerData, ageMins = 0) {
    const color = this.getColorForAge(ageMins);
    
    // CORRECCIÓ: Hem esborrat una barra baixa extra de "MAX_AGE_MINS"
    const radius = 4 - (ageMins / this.MAX_AGE_MINS) * 2; 
    
    markerData.marker.setStyle({
        fillColor: color, 
        color: "#000000", 
        fillOpacity: 0.9, 
        opacity: 0.9,
        weight: 0.5, 
        radius: radius
    });
},
    
    getColorForAge: function(ageMins) {
        if (ageMins < 2) return '#FFFF00';
        if (ageMins < 5) return '#FFCC00';
        if (ageMins < 10) return '#FFA500';
        if (ageMins < 20) return '#FF4500';
        return '#B22222';
    },

    createExpandingCircle: function(lat, lon) {
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

    sendBoundsSubscription: function() {
        if (!this.isActive || !this.socketLm || this.socketLm.readyState !== 1) return;
        const bounds = map.getBounds();
        this.socketLm.send(JSON.stringify({ "v": 24, "a": 4, "i": {}, "p": [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()] }));
    },

    // Totes les funcions per a les dades històriques i resum
    toggleHistoricLayers: function(option) {
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

    startHistoricMode: function() {
        console.log("Iniciant mode històric de llamps.");
        this.fetchHistoricLightning();
        if (this.historicUpdateInterval) clearInterval(this.historicUpdateInterval);
        this.historicUpdateInterval = setInterval(() => this.fetchHistoricLightning(), 60000);
    },

stopHistoricMode: function() {
    console.log("Aturant mode històric de llamps.");
    if (this.historicUpdateInterval) {
        clearInterval(this.historicUpdateInterval);
        this.historicUpdateInterval = null;
    }
    this.historicStrikes.clear();
    this.historicLayerGroup.clearLayers();
    this.isInitialHistoricLoad = true; // <-- REINICIEM EL FLAG AQUÍ
},

isInitialHistoricLoad: true,

fetchHistoricLightning: async function() {
    console.log("Actualitzant dades històriques de llamps...");
    // ... (la part inicial que obté les dades de l'API es manté igual)
    const urls = [];
    for (let i = 0; i < 24; i++) {
        const folderName = String(i).padStart(2, '0');
        urls.push(`https://meteo-api.projecte4estacions.com/api/blitzortung/dades-historiques/${folderName}`);
    }
    try {
        const responses = await Promise.all(urls.map(url => fetch(url).then(res => res.json()).catch(() => [])));
        const allStrikes = responses.flat();
        const newHistoricStrikes = new Map();
        const now = new Date();
        const timeCutoff = now.getTime() - (120 * 60 * 1000);
        allStrikes.forEach(strike => {
            const strikeTime = new Date(strike[2] + 'Z').getTime();
            if (strikeTime >= timeCutoff) {
                const lat = strike[1];
                const lon = strike[0];
                const strikeId = `${lon}_${lat}_${strike[2]}`;
                newHistoricStrikes.set(strikeId, { lat: lat, lon: lon, timestamp: strikeTime });
            }
        });
        
        this.historicStrikes = newHistoricStrikes;
        console.log(`Processats ${this.historicStrikes.size} llamps històrics.`);
        this.updateHistoricMarkers();

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
        } else if (analisisPolygon) {
            analitzarLightningJump();
        }
    } catch (error) {
        console.error("Error obtenint dades històriques de llamps:", error);
    }
},

// Dins de l'objecte realtimeLightningManager
updateHistoricMarkers: function() {
    this.historicLayerGroup.clearLayers();
    const now = new Date().getTime();
    const timeFilterMs = this.timeFilterMinutes * 60 * 1000;
    this.historicStrikes.forEach(strike => {
        const ageMs = now - strike.timestamp;
        if (ageMs <= timeFilterMs) {
            const ageMins = ageMs / 60000;
            const color = this.getHistoricColorForAge(ageMins);
            const radius = 4 - (ageMins / 120) * 2.5; // Mida petita
            
            const marker = L.circleMarker([strike.lat, strike.lon], {
                radius: radius,
                fillColor: color,
                color: '#000000',
                weight: 0.5,
                opacity: 0.9,
                fillOpacity: 0.9,
                pane: 'llampsPane' // CORRECCIÓ: Especifiquem el 'pane' correcte aquí
            });
            this.historicLayerGroup.addLayer(marker);
        }
    });
},

    getHistoricColorForAge: function(ageMins) {
        if (ageMins < 5) return '#FFFFFF';
        if (ageMins < 15) return '#FFFF00';
        if (ageMins < 30) return '#FFCC00';
        if (ageMins < 60) return '#FFA500';
        if (ageMins < 90) return '#FF4500';
        return '#B22222';
    },

    setTimeFilter: function(minutes) {
        this.timeFilterMinutes = minutes;
        this.updateHistoricMarkers();
    }
};

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
}


// Quan mous el slider... cridem a la funció genèrica
satelliteOpacitySlider.addEventListener('input', updateOpacity);
// FI DEL BLOC NOU ----------------------------------------------

// =================================================================
// MILLORA 2: ACTUALITZACIÓ AUTOMÀTICA EN MOURE EL MAPA
// =================================================================
map.on('moveend', function() {
    // Comprovem quina de les capes "Express" està activa
    if (currentVariableKey === 'weathercom_precip') {
        displayWeatherComPrecipitation();
    } else if (currentVariableKey === 'weathercom_precip_semihourly') {
        displayWeatherComSemiHourlyPrecipitation();
    } else if (currentVariableKey === 'ecowitt_precip') { // <-- AFEGEIX AQUEST BLOC
        displayEcowittPrecipitation();
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

// ★ REEMPLAÇA LA TEVA VERSIÓ D'AQUESTA FUNCIÓ PER AQUESTA ★
async function fetchDataForCurrentVariable() {
    // Aquesta comprovació s'ha de fer PRIMER, abans de buscar la configuració,
    // perquè 'sumatori_precipitacio' és un cas especial que depèn d'una variable ja calculada.
    if (currentVariableKey === 'sumatori_precipitacio') {
        return lastSumatoriResult;
    }

    const config = VARIABLES_CONFIG[currentVariableKey];
    if (!config) return [];

    // === Lògica per a l'Índex de Rovellons ===
    if (config.isSpecial) {
        // ... (la resta de la teva funció es queda exactament igual)
        const dateForQuery = historicModeTimestamp || new Date();
        const endDate = new Date(dateForQuery);
        const startDate = new Date(dateForQuery);
        startDate.setDate(startDate.getDate() - 20);

        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));

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
            const faseText = ['🌑 Nova','🌒 Creixent','🌓 Quart Creixent','🌔 Gibosa Creixent','🌕 Plena','🌖 Gibosa Minvant','🌗 Quart Minvant','🌘 Minvant'][Math.floor(faseActual * 8)];
            if (FASES_BONUS.includes(faseText)) puntsLluna = 10;
            let score = puntsPluja + puntsTempNoc + penalitzacioTmax + penalitzacioVent + puntsLluna;
            const finalScore = Math.max(0, Math.min(100, Math.round(score)));
            finalData.push({ ...stationInfo, codi_estacio: stationId, valor: finalScore });
        });
        return finalData;
    }


    // === Lògica per a les variables de Percentils ===
    if (config.isPercentile) {
        const urlMetadades = "https://analisi.transparenciacatalunya.cat/resource/yqwd-vj5e.json?$query=SELECT%0A%20%20%60codi_estacio%60%2C%0A%20%20%60nom_estacio%60%2C%0A%20%20%60latitud%60%2C%0A%20%20%60longitud%60";
        const metadata = await $.getJSON(urlMetadades);
        const estacionsMap = new Map(metadata.map(est => [est.codi_estacio, { nom: est.nom_estacio, lat: parseFloat(est.latitud), lon: parseFloat(est.longitud) }]));
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
            if (sourceConfig && sourceConfig.summary){
                 const dateForDay = dateToUse || new Date();
                 const startOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 0, 0, 0, 0));
                 const endOfDay = new Date(Date.UTC(dateForDay.getUTCFullYear(), dateForDay.getUTCMonth(), dateForDay.getUTCDate(), 23, 59, 59, 999));
                 return fetchSmcDailySummary(sourceConfig.id, sourceConfig.summary, startOfDay, endOfDay).then(res => ({key: sourceKey, data: res.data}));
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
                if (result.key === 'past_data'){
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
                 if(hasAllData) finalValue = config.calculation(station);
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
});
// =================================================================
// VERSIÓ FINAL DE L'EINA DE CAPTURA (Estratègia de "Dos Clics")
// =================================================================

document.addEventListener('DOMContentLoaded', () => {
    const captureBtn = document.getElementById('capture-screen-btn');
    if (!captureBtn) return;

    let capturedCanvas = null; // Variable per guardar la captura
    let isCaptureMode = false; // Per saber si estem en mode "retallar"

    // Funció principal que inicia el procés
    async function toggleCaptureMode() {
        if (isCaptureMode) {
            // Si ja estem en mode captura, el desactivem
            resetCaptureMode();
            return;
        }

        console.log("Demanant permís per capturar la pantalla...");
        
        try {
            // Guardem l'estat del mapa per si de cas
            const originalCenter = map.getCenter();
            const originalZoom = map.getZoom();

            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { mediaSource: "screen", cursor: "never" },
                preferCurrentTab: true
            });
            
            const track = stream.getVideoTracks()[0];
            const video = document.createElement('video');
            video.srcObject = stream;
            
            video.onloadedmetadata = () => {
                video.play();

                // Dibuixem la imatge al canvas
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                track.stop(); // Aturem la captura immediatament

                // Guardem el canvas i activem el mode de retall
                capturedCanvas = canvas;
                isCaptureMode = true;
                captureBtn.innerHTML = "✏️"; // Canviem la icona del botó
                captureBtn.title = "Cancel·lar mode de retall";
                document.body.style.cursor = 'crosshair'; // Canviem el cursor de tota la pàgina

                // Restaurem l'estat del mapa per si s'ha trencat
                map.setView(originalCenter, originalZoom);
                setTimeout(() => map.invalidateSize(), 100);
            };

        } catch (error) {
            console.error("Error en capturar la pantalla:", error);
            resetCaptureMode();
        }
    }

    // Funció per iniciar l'eina de retall sobre la imatge ja capturada
    function initSnipping(e) {
        if (!isCaptureMode || e.target.closest('#side-menu')) return; // No comencis si es clica un botó del menú
        
        let startX = e.clientX;
        let startY = e.clientY;

        const selectionRect = document.createElement('div');
        selectionRect.id = 'selection-rectangle';
        selectionRect.style.left = `${startX}px`;
        selectionRect.style.top = `${startY}px`;
        document.body.appendChild(selectionRect);

        function onMouseMove(moveEvent) {
            const width = Math.abs(moveEvent.clientX - startX);
            const height = Math.abs(moveEvent.clientY - startY);
            const newX = Math.min(startX, moveEvent.clientX);
            const newY = Math.min(startY, moveEvent.clientY);
            selectionRect.style.left = `${newX}px`;
            selectionRect.style.top = `${newY}px`;
            selectionRect.style.width = `${width}px`;
            selectionRect.style.height = `${height}px`;
        }

        function onMouseUp(upEvent) {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            const finalRect = selectionRect.getBoundingClientRect();
            document.body.removeChild(selectionRect);

            if (finalRect.width > 10 && finalRect.height > 10) {
                cropAndCopy(capturedCanvas, finalRect);
            }
            
            // Un cop s'ha retallat, tornem a l'estat normal
            resetCaptureMode();
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    function cropAndCopy(sourceCanvas, rect) {
        const dpr = window.devicePixelRatio || 1;
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = rect.width * dpr;
        cropCanvas.height = rect.height * dpr;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(
            sourceCanvas,
            rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr,
            0, 0, rect.width * dpr, rect.height * dpr
        );
        cropCanvas.toBlob(blob => {
            navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
                .then(showCopyNotification)
                .catch(err => console.error("Error en copiar:", err));
        }, 'image/png');
    }

    // Funció per netejar i sortir del mode de captura
    function resetCaptureMode() {
        capturedCanvas = null;
        isCaptureMode = false;
        captureBtn.innerHTML = "✂️";
        captureBtn.title = "Capturar una àrea de la pantalla";
        document.body.style.cursor = 'default';
        document.removeEventListener('mousedown', initSnipping);
    }

    function showCopyNotification() {
        let notification = document.getElementById('copy-notification');
        if (!notification) {
            notification = document.createElement('div');
            notification.id = 'copy-notification';
            notification.textContent = '✅ Captura copiada al porta-retalls!';
            document.body.appendChild(notification);
        }
        notification.classList.add('visible');
        setTimeout(() => {
            notification.classList.remove('visible');
        }, 2500);
    }

    // Assignació d'events principal
    captureBtn.addEventListener('click', toggleCaptureMode);
    document.addEventListener('mousedown', initSnipping);
}); // <-- LA CLAU ARA ESTÀ AQUÍ, TANCANT EL BLOC ANTERIOR

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
        const imageUrl = `mapa_tmin_mlr+id2d.png${cacheBuster}`;

        console.log("Mostrant la capa PNG de temperatura.");
        capaTemperaturaPNG = L.imageOverlay(imageUrl, imageBounds, {
            opacity: 0.85,
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
    ...Object.values(satelliteLayers)
];

// Gestor per QUAN S'ACTIVA UNA CAPA
map.on('overlayadd', function(e) {
    if (e.name === 'Temperatura Màxima') {
        mostrarMapaTemperaturaPNG();
    }
    
    // Si la capa activada és una de satèl·lit individual
    if (allSatelliteLayers.includes(e.layer)) {
        activeSatelliteLayer = e.layer;
        satelliteControls.style.display = 'flex';
        updateOpacity();
    } 
    // 👇 NOU: Si la capa activada és el nostre grup "Sandwich"
    else if (e.layer === sandwich_layer_final) {
        // Li diem que la capa a controlar serà la base HRVIS del sandwich
        activeSatelliteLayer = sandwich_hrvis_layer; 
        satelliteControls.style.display = 'flex';
        updateOpacity();
    }
});

// Gestor per QUAN ES DESACTIVA UNA CAPA
map.on('overlayremove', function(e) {
    if (e.name === 'Temperatura Màxima') {
        amagarMapaTemperaturaPNG();
    }

    // Si la capa desactivada és una de satèl·lit individual
    if (allSatelliteLayers.includes(e.layer) && activeSatelliteLayer === e.layer) {
        satelliteControls.style.display = 'none';
        activeSatelliteLayer = null;
    }
    // 👇 NOU: Si es desactiva el grup "Sandwich"
    else if (e.layer === sandwich_layer_final) {
        satelliteControls.style.display = 'none';
        activeSatelliteLayer = null;
    }
});

// AIXÍ HAURIA DE QUEDAR:
setTimeout(() => {
    // La resta es queda igual, per mostrar les dades per defecte mentrestant
    displayVariable('smc_32');

    // Marcar la primera opció del menú com a activa
    const defaultOption = document.querySelector('li[data-variable-key="smc_32"]');
    if(defaultOption) {
        defaultOption.classList.add('active');
        defaultOption.closest('.main-menu-item').querySelector('a').classList.add('active');
    }

}, 500);