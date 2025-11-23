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
let knownWarningIds = new Set();

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

  layer.on("click", () => {
    updateAlertCard(p);
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

// detect new warnings for audio + zoom trigger

function detectNewWarnings(features) {
  const currentWarningIds = new Set();
  let hasNewWarning = false;

  for (const f of features) {
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

  return hasNewWarning;
}

// ============ LOAD ALERTS ============

async function loadAlerts() {
  try {
    const resp = await fetch("/alerts");
    const data = await resp.json();

    const allFeatures = data.features || [];

    // map features = only alerts that actually have geometry
    const mapFeatures = allFeatures.filter((f) => f && f.geometry);

    // headline & count use only polygon alerts now
    headlineAlerts = mapFeatures.map((f) => f.properties || {});
    updateHeadlineMetric(mapFeatures.length);

    // warning sound + flag if brand-new warning appeared
    const hasNewWarning = detectNewWarnings(allFeatures);

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

    // Auto-fit once on first load
    try {
      if (!firstFitDone && mapFeatures.length > 0) {
        const bounds = alertsLayer.getBounds();
        if (bounds && bounds.isValid()) {
          map.fitBounds(bounds.pad(0.1));
          firstFitDone = true;
        }
      }
    } catch (e) {
      console.warn("Initial fit bounds error", e);
    }

    // If a brand-new warning appeared, refit to all current polygons
    try {
      if (hasNewWarning && mapFeatures.length > 0) {
        const bounds = alertsLayer.getBounds();
        if (bounds && bounds.isValid()) {
          map.fitBounds(bounds.pad(0.1));
        }
      }
    } catch (e) {
      console.warn("New warning fit bounds error", e);
    }

    // choose best alert for left panel
    const bestFeature = pickBestAlert(mapFeatures) || null;

    if (bestFeature) {
      updateAlertCard(bestFeature.properties || {});
    } else {
      updateAlertCard(null);
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

function updateAlertCard(props) {
  if (alertPanel && props) {
    alertPanel.classList.remove("panel-hidden");
    if (mainLayout) {
      mainLayout.classList.remove("layout-no-panel");
    }
    setTimeout(() => map.invalidateSize(), 300);
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
