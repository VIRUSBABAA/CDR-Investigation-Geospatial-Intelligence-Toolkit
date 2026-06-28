"""
tower_lookup.py
Loads data/mock_towers_pakistan.csv (SYNTHETIC data, see that file's header
comment) and resolves a Cell ID to coordinates + operator/address.

If a Cell ID isn't found in the mock DB, falls back to a deterministic
pseudo-random location within Pakistan's bounding box so the demo never
breaks -- but the result is clearly flagged location_confidence="estimated"
so it's never mistaken for a real lookup.
"""
import csv
import hashlib

PK_BOUNDS = {"lat_min": 24.0, "lat_max": 37.0, "lon_min": 61.0, "lon_max": 77.0}

_tower_cache = None


def load_tower_db(path):
    global _tower_cache
    if _tower_cache is not None:
        return _tower_cache

    towers = {}
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            towers[row["cell_id"]] = {
                "latitude": float(row["latitude"]),
                "longitude": float(row["longitude"]),
                "operator": row["operator"],
                "address": row["address"],
                "city": row["city"],
                "technology": row["technology"],
            }
    _tower_cache = towers
    return towers


def _fallback_location(cell_id):
    """Deterministic pseudo-random coordinate inside Pakistan's bbox,
    so the same unknown cell_id always maps to the same point."""
    h = int(hashlib.sha256(cell_id.encode()).hexdigest(), 16)
    lat_frac = (h % 100000) / 100000
    lon_frac = ((h // 100000) % 100000) / 100000
    lat = PK_BOUNDS["lat_min"] + lat_frac * (PK_BOUNDS["lat_max"] - PK_BOUNDS["lat_min"])
    lon = PK_BOUNDS["lon_min"] + lon_frac * (PK_BOUNDS["lon_max"] - PK_BOUNDS["lon_min"])
    return lat, lon


def lookup_cell(cell_id, tower_db_path):
    towers = load_tower_db(tower_db_path)
    hit = towers.get(str(cell_id))
    if hit:
        return {
            "latitude": hit["latitude"],
            "longitude": hit["longitude"],
            "operator": hit["operator"],
            "address": hit["address"],
            "location_confidence": "known_tower",
        }

    lat, lon = _fallback_location(str(cell_id))
    return {
        "latitude": lat,
        "longitude": lon,
        "operator": "Unknown",
        "address": "Unresolved Cell ID (estimated placement)",
        "location_confidence": "estimated",
    }
