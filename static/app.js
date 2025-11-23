// ============ MAP SETUP ============

const map = L.map("map", {
  center: [39.0, -98.0],
  zoom: 4,
  zoomControl: false,
});

// Dark basemap
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    attribution: "&copy; OpenStreetMap & CARTO",
    maxZoom: 18,
  }
).addTo(map);

// Zoom control
L.control
  .zoom({
    position: "bottomright",
  })
  .addTo(map);

// Radar WMS
const radarLayer = L.tileLayer
  .wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi", {
    layers: "nexrad-n0r-900913",
    format: "image/png",
    transparent: true,
    opacity: 0.7,
  })
  .addTo(map);

// Refresh radar tiles every 30 seconds
setInterval(() => {
  radarLayer.setParams({ time: Date.now() });
}, 30000);

// ============ STATE ============

let alertsLayer = null;
let firstFitDone = false;

// Track all polygon alerts we've seen (for zoom + auto-open)
let knownPolygonIds = new Set();

// Track warning IDs separately for audio
let knownWarningIds = new Set();

// For controlling auto-open of the panel
let firstAutoPanelShown = false;

// Track which alert the USER has selected
let selectedAlertId = null;

const alertPanel = document.getElementById("alert-panel");
const closeBtn = document.getElementById("alert-close-btn");
const mainLayout = document.getElementById("main-layout");

// headline rotation
let headlineAlerts = [];
let headlineIndex = 0;
let headlineIntervalId = null;

// ============ HELPERS ============

if (closeBtn && alertPanel) {
  closeBtn.addEventListener("click", () => {
    alertPanel.classList.add("panel-hidden");
    if (mainLayout) {
      mainLayout.classList.add("layout-no-panel");
    }
    setTimeout(() => map.invalidateSize(), 300);
  });
}

// Helper to derive a stable ID from a feature
function getFeatureId(feature) {
  if (!feature) return null;
  const p = feature.properties || {};
  return feature.id || p.id || p.ugc || null;
}

function severityColor(sev) {
  if (!sev) return "#00aaff";
  sev = sev.toUpperCase();
  if (sev === "EXTREME") return "#ff0054";
  if (sev === "SEVERE") return "#ff3b1f";
  if (sev === "MODERATE") return "#ffb347";
  if (sev === "MINOR") return "#ffe166";
  return "#29bfff";
}

function styleFeature(feature) {
  const severity = feature.properties?.severity;
  return {
    color: "#f5f5f5",
    weight: 2,
    fillColor: severityColor(severity),
    fillOpacity: 0.35,
  };
}

function onEachFeature(feature, layer) {
  const p = feature.properties || {};
  const tooltipText = `${p.event || "Alert"}\n${p.severity || ""}`;
  layer.bindTooltip(tooltipText.replace(/\n/g, "<br>"));

  // USER click => lock in selection and open panel
  layer.on("click", () => {
    selectedAlertId = getFeatureId(feature);
    updateAlertCard(p, true);
  });
}

// scoring for "best" alert

function severityScore(sev) {
  if (!sev) return 0;
  const s = sev.toUpperCase();
  if (s === "EXTREME") return 4;
  if (s === "SEVERE") return 3;
  if (s === "MODERATE") return 2;
  if (s === "MINOR") return 1;
  return 0;
}

function urgencyScore(urg) {
  if (!urg) return 0;
  const u = urg.toUpperCase();
  if (u === "IMMEDIATE") return 3;
  if (u === "EXPECTED") return 2;
  if (u === "FUTURE") return 1;
  return 0;
}

function alertScore(props) {
  const sev = severityScore(props.severity);
  const urg = urgencyScore(props.urgency);
  const isWarning = (props.event || "").toLowerCase().includes("warning");
  return sev * 10 + urg * 2 + (isWarning ? 5 : 0);
}

function pickBestAlert(features) {
  if (!features || !features.length) return null;
  let best = features[0];
  let bestScore = alertScore(best.properties || {});
  for (let i = 1; i < features.length; i++) {
    const p = features[i].properties || {};
    const s = alertScore(p);
    if (s > bestScore) {
      bestScore = s;
      best = features[i];
    }
  }
  return best;
}

// --- detect new polygon alerts (for zoom + auto-open) ---

function detectNewPolygons(mapFeatures) {
  const currentIds = new Set();
  const newIds = [];

  for (const f of mapFeatures) {
    if (!f) continue;
    const id = getFeatureId(f);
    if (!id) continue;

    currentIds.add(id);
    if (!knownPolygonIds.has(id)) {
      newIds.push(id);
    }
  }

  knownPolygonIds = currentIds;
  return {
    hasNewPolygon: newIds.length > 0,
    newIds,
  };
}

// --- detect new warnings (for audio only) ---

function detectNewWarnings(allFeatures) {
  const currentWarningIds = new Set();
  let hasNewWarning = false;

  for (const f of allFeatures) {
    if (!f || !f.properties) continue;
    const props = f.properties;
    const id = f.id || props.id;
    if (!id) continue;

    const eventName = (props.event || "").toLowerCase();
    const sev = (props.severity || "").toLowerCase();

    const isWarning =
      eventName.includes("warning") || sev === "severe" || sev === "extreme";

    if (isWarning) {
      currentWarningIds.add(id);
      if (!knownWarningIds.has(id)) {
        hasNewWarning = true;
      }
    }
  }

  knownWarningIds = currentWarningIds;

  if (hasNewWarning) {
    playWarnSound();
  }
}

// ============ LOAD ALERTS ============

async function loadAlerts() {
  try {
    const resp = await fetch("/alerts");
    const data = await resp.json();

    const allFeatures = data.features || [];

    // only alerts that actually have geometry
    const mapFeatures = allFeatures.filter((f) => f && f.geometry);

    // headline + count use polygon alerts
    headlineAlerts = mapFeatures.map((f) => f.properties || {});
    updateHeadlineMetric(mapFeatures.length);

    // audio for new warnings
    detectNewWarnings(allFeatures);

    // auto-zoom / panel only when new polygons appear
    const { hasNewPolygon, newIds } = detectNewPolygons(mapFeatures);

    if (alertsLayer) {
      map.removeLayer(alertsLayer);
    }

    alertsLayer = L.geoJSON(
      { type: "FeatureCollection", features: mapFeatures },
      {
        style: styleFeature,
        onEachFeature,
      }
    ).addTo(map);

    // ----- ZOOM LOGIC -----
    try {
      if (mapFeatures.length > 0) {
        // Decide what geometry to zoom to
        let featureToZoom = null;

        if (!firstFitDone) {
          // First time: zoom to ALL polygons
          // (alertsLayer bounds)
          const bounds = alertsLayer.getBounds();
          if (bounds && bounds.isValid()) {
            map.fitBounds(bounds.pad(0.1));
            firstFitDone = true;
          }
        } else if (hasNewPolygon) {
          // New polygon(s) appeared: zoom to the strongest one among them
          const newFeatures = mapFeatures.filter((f) =>
            newIds.includes(getFeatureId(f))
          );
          featureToZoom = pickBestAlert(newFeatures) || pickBestAlert(mapFeatures);

          if (featureToZoom) {
            const tempLayer = L.geoJSON(featureToZoom);
            const b = tempLayer.getBounds();
            if (b && b.isValid()) {
              map.fitBounds(b.pad(0.15));
            }
          }
        }
      }
    } catch (e) {
      console.warn("Fit bounds error", e);
    }

    // ----- INFO PANEL LOGIC -----

    // Try to keep showing the user's selected alert if it still exists
    let selectedFeature = null;
    if (selectedAlertId) {
      selectedFeature =
        mapFeatures.find((f) => getFeatureId(f) === selectedAlertId) || null;
    }

    // choose best alert for fallback
    const bestFeature = pickBestAlert(mapFeatures) || null;

    // Should we auto-open the panel (only if nothing manually selected)?
    const shouldAutoShowPanel =
      !firstAutoPanelShown || (hasNewPolygon && !selectedFeature);

    if (mapFeatures.length === 0) {
      // no alerts at all
      selectedAlertId = null;
      firstAutoPanelShown = false;
      updateAlertCard(null, true);
    } else if (selectedFeature) {
      // User has something selected, keep showing that one.
      updateAlertCard(selectedFeature.properties || {}, false);
    } else if (bestFeature) {
      // No selection -> use best alert and (maybe) auto-open panel
      selectedAlertId = getFeatureId(bestFeature);
      updateAlertCard(bestFeature.properties || {}, shouldAutoShowPanel);
      firstAutoPanelShown = true;
    }

    // start / update headline cycling
    startHeadlineCycle();
  } catch (err) {
    console.error("Error loading alerts", err);
    stopHeadlineCycle();
    updateHeadlineError();
  }
}

loadAlerts();
setInterval(loadAlerts, 60000);

// ============ HEADLINE ROTATION ============

function startHeadlineCycle() {
  stopHeadlineCycle();

  if (!headlineAlerts || headlineAlerts.length === 0) {
    updateHeadlineNoAlerts();
    return;
  }

  headlineIndex = 0;
  showHeadlineAlert(headlineIndex);

  headlineIntervalId = setInterval(() => {
    if (!headlineAlerts || headlineAlerts.length === 0) {
      updateHeadlineNoAlerts();
      return;
    }
    headlineIndex = (headlineIndex + 1) % headlineAlerts.length;
    showHeadlineAlert(headlineIndex);
  }, 7000);
}

function stopHeadlineCycle() {
  if (headlineIntervalId !== null) {
    clearInterval(headlineIntervalId);
    headlineIntervalId = null;
  }
}

function showHeadlineAlert(idx) {
  const props = headlineAlerts[idx] || {};
  const textEl = document.getElementById("headline-text");
  if (!textEl) return;

  textEl.classList.add("headline-hidden");

  setTimeout(() => {
    updateHeadlineFromAlert(props);
    textEl.classList.remove("headline-hidden");
  }, 200);
}

// ============ PANEL / TEXT HELPERS ============

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "--";
}

/**
 * updateAlertCard(props, showPanel)
 * - props: alert properties (or null)
 * - showPanel: if true, force panel to open/close;
 *              if false, just update text, keep current visibility.
 */
function updateAlertCard(props, showPanel = false) {
  if (alertPanel) {
    if (!props) {
      // no alerts => hide panel
      alertPanel.classList.add("panel-hidden");
      if (mainLayout) {
        mainLayout.classList.add("layout-no-panel");
      }
    } else if (showPanel) {
      // only auto-open when explicitly requested
      alertPanel.classList.remove("panel-hidden");
      if (mainLayout) {
        mainLayout.classList.remove("layout-no-panel");
      }
      setTimeout(() => map.invalidateSize(), 300);
    }
  }

  if (!props) {
    setText("alert-type", "NO ACTIVE ALERTS");
    setText("alert-expiration", "Expires: --");
    setText("stat-severity", "--");
    setText("stat-urgency", "--");
    setText("stat-certainty", "--");
    setText("alert-areas", "--");
    setText("alert-headline", "--");
    setText("alert-description", "--");
    setText("alert-instruction", "--");
    setText("alert-effective", "Effective: --");
    setText("alert-sender", "Source: --");
    return;
  }

  const eventName = props.event || "Weather Alert";

  setText("alert-type", eventName.toUpperCase());
  setText(
    "alert-expiration",
    props.expires ? `Expires: ${props.expires}` : "Expires: --"
  );

  setText("stat-severity", props.severity || "--");
  setText("stat-urgency", props.urgency || "--");
  setText("stat-certainty", props.certainty || "--");

  setText("alert-areas", props.areaDesc || "--");
  setText("alert-headline", props.headline || props.event || "--");
  setText("alert-description", props.description || "--");
  setText("alert-instruction", props.instruction || "--");

  setText(
    "alert-effective",
    props.effective ? `Effective: ${props.effective}` : "Effective: --"
  );
  setText(
    "alert-sender",
    props.senderName ? `Source: ${props.senderName}` : "Source: --"
  );
}

function updateHeadlineMetric(count) {
  setText("headline-metric-value", count);
}

function updateHeadlineFromAlert(props) {
  const eventName = props.event || "WEATHER ALERTS ACTIVE";
  const areas = props.areaDesc || "";
  const text = `${eventName.toUpperCase()} • ${areas}`;
  setText("headline-text", text);
}

function updateHeadlineNoAlerts() {
  setText("headline-text", "NO ACTIVE NWS ALERTS");
}

function updateHeadlineError() {
  setText("headline-text", "ERROR LOADING ALERTS FROM NWS");
}

// ============ AUDIO ============

function playWarnSound() {
  const audio = document.getElementById("warn-sound");
  if (!audio) return;
  try {
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.warn("Audio play blocked or failed:", err);
      });
    }
  } catch (e) {
    console.warn("Audio error:", e);
  }
}

// ============ CLOCK ============

function updateClock() {
  const now = new Date();
  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");
  const ss = now.getSeconds().toString().padStart(2, "0");
  setText("radar-clock", `${hh}:${mm}:${ss}`);
}
updateClock();
setInterval(updateClock, 1000);
