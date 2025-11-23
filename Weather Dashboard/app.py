from flask import Flask, jsonify, render_template
import requests
import time

app = Flask(__name__)

ALERTS_URL = "https://api.weather.gov/alerts/active"
CACHE_SECONDS = 60  # refresh NWS data at most once per minute

_alert_cache = None
_alert_cache_time = 0

# ---------- Fallback event list (lowercase) ----------

FALLBACK_EVENTS = [
    "winter weather advisory",
    "winter storm warning",
    "winter storm watch",
    "blizzard warning",
    "wind chill advisory",
    "wind chill warning",
    "freeze warning",
    "hard freeze warning",
    "frost advisory",
    "ice storm warning",
    "areal flood advisory",
    "areal flood warning",
    "areal flood watch",
    "dense fog advisory",
    "wind advisory",
    "high wind warning",
    "red flag warning",
    "fire weather watch",
    "special weather statement",
    "heat advisory",
    "excessive heat warning",
    "snow squall warning",
]

# Simple in-memory cache for zone geometries so we don't hammer NWS
_ZONE_GEOM_CACHE = {}


def fetch_zone_geometry(zone_url):
    """
    Fetch geometry for a zone (county/forecast zone, etc.) from NWS.
    Response is a GeoJSON Feature; we return the 'geometry' part.
    Cached in _ZONE_GEOM_CACHE.
    """
    if zone_url in _ZONE_GEOM_CACHE:
        return _ZONE_GEOM_CACHE[zone_url]

    headers = {
        "User-Agent": "MaxWeatherDashboard (example@example.com)"
    }
    try:
        resp = requests.get(zone_url, headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        geom = data.get("geometry")
        _ZONE_GEOM_CACHE[zone_url] = geom
        return geom
    except Exception as e:
        print(f"Error fetching zone geometry {zone_url}: {e}")
        _ZONE_GEOM_CACHE[zone_url] = None
        return None


def add_zone_geometry_for_event(feature):
    """
    For alerts of specific types (FALLBACK_EVENTS) that have NO geometry
    but DO have affectedZones, try to build a polygon/multipolygon
    from the zone geometries.

    Only modifies feature['geometry'] if:
      - feature['geometry'] is falsy
      - event name is in FALLBACK_EVENTS
      - affectedZones has at least one URL
    """
    if feature.get("geometry"):
        return  # already has real geometry from NWS

    props = feature.get("properties") or {}
    event = (props.get("event") or "").lower()
    affected_zones = props.get("affectedZones") or []

    if not affected_zones:
        return

    if event not in FALLBACK_EVENTS:
        return

    polygons = []

    for zone_url in affected_zones:
        geom = fetch_zone_geometry(zone_url)
        if not geom:
            continue

        g_type = geom.get("type")
        coords = geom.get("coordinates")

        if not g_type or coords is None:
            continue

        if g_type == "Polygon":
            polygons.append(coords)
        elif g_type == "MultiPolygon":
            # MultiPolygon is list-of-polygons
            polygons.extend(coords)

    if not polygons:
        # couldn't get any zone geometry
        return

    # If we got exactly one polygon, keep it as Polygon.
    # If multiple, make a MultiPolygon.
    if len(polygons) == 1:
        feature["geometry"] = {
            "type": "Polygon",
            "coordinates": polygons[0],
        }
    else:
        feature["geometry"] = {
            "type": "MultiPolygon",
            "coordinates": polygons,
        }


def fetch_alerts_from_nws():
    """
    Fetch ALL active alerts from NWS.
    Then, for alerts of the types listed in FALLBACK_EVENTS that have no geometry,
    try to attach zone-based polygons.
    """
    headers = {
        "User-Agent": "MaxWeatherDashboard (example@example.com)"
    }
    resp = requests.get(ALERTS_URL, headers=headers, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    features = data.get("features") or []
    for f in features:
        add_zone_geometry_for_event(f)

    return data


def get_cached_alerts():
    global _alert_cache, _alert_cache_time
    now = time.time()
    if _alert_cache is None or (now - _alert_cache_time) > CACHE_SECONDS:
        _alert_cache = fetch_alerts_from_nws()
        _alert_cache_time = now
    return _alert_cache


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/alerts")
def alerts():
    # front-end will handle filtering to features that actually have geometry
    return jsonify(get_cached_alerts())


if __name__ == "__main__":
    app.run(debug=True)
