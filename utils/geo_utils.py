"""
geo_utils.py
Trail-building math: haversine distance, speed between consecutive points,
dwell-time, anomalous-jump detection, and simple frequent-location detection.
"""
import math
from collections import defaultdict


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Compass bearing from point 1 to point 2 in degrees (0–360)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return round((math.degrees(math.atan2(x, y)) + 360) % 360, 1)


def bearing_label(deg):
    if deg is None:
        return None
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    return dirs[int((deg + 22.5) / 45) % 8]


def build_trail(records, anomalous_speed_kmh=130):
    """
    records: list of CDRRecord-like objects/dicts with timestamp, latitude,
    longitude, sorted ascending by timestamp by the caller.

    Mutates/annotates each record with speed_from_prev_kmh, is_anomalous_jump,
    distance_from_prev_km, bearing_from_prev, and dwell_minutes_after.
    Returns the same list.
    """
    for i, rec in enumerate(records):
        if i == 0:
            rec["speed_from_prev_kmh"] = None
            rec["is_anomalous_jump"] = False
            rec["distance_from_prev_km"] = None
            rec["bearing_from_prev"] = None
        else:
            prev = records[i - 1]
            dist_km = haversine_km(prev["latitude"], prev["longitude"], rec["latitude"], rec["longitude"])
            dt_hours = max((rec["timestamp"] - prev["timestamp"]).total_seconds() / 3600.0, 1e-6)
            speed = dist_km / dt_hours
            rec["speed_from_prev_kmh"] = round(speed, 1)
            rec["is_anomalous_jump"] = speed > anomalous_speed_kmh
            rec["distance_from_prev_km"] = round(dist_km, 2)
            rec["bearing_from_prev"] = bearing_deg(
                prev["latitude"], prev["longitude"], rec["latitude"], rec["longitude"]
            )

        if i < len(records) - 1:
            nxt = records[i + 1]
            dwell = (nxt["timestamp"] - rec["timestamp"]).total_seconds() / 60.0
            rec["dwell_minutes_after"] = round(dwell, 1)
        else:
            rec["dwell_minutes_after"] = None

    return records


def enrich_record_indices(records):
    """Add trail_index and time-since-previous metadata for API responses."""
    for i, rec in enumerate(records):
        rec["trail_index"] = i
        if i > 0 and rec.get("timestamp") and records[i - 1].get("timestamp"):
            gap = (rec["timestamp"] - records[i - 1]["timestamp"]).total_seconds()
            rec["gap_from_prev_seconds"] = int(gap)
        else:
            rec["gap_from_prev_seconds"] = None
        if rec.get("bearing_from_prev") is not None:
            rec["bearing_label"] = bearing_label(rec["bearing_from_prev"])
        else:
            rec["bearing_label"] = None
    return records


def frequent_locations(records, round_decimals=3, top_n=5):
    """
    Groups records by rounded lat/lon to approximate 'frequently visited
    places' (a rough proxy for home/work without claiming certainty).
    """
    buckets = defaultdict(list)
    for r in records:
        key = (round(r["latitude"], round_decimals), round(r["longitude"], round_decimals))
        buckets[key].append(r)

    ranked = sorted(buckets.items(), key=lambda kv: len(kv[1]), reverse=True)
    results = []
    for (lat, lon), recs in ranked[:top_n]:
        results.append({
            "latitude": lat,
            "longitude": lon,
            "visit_count": len(recs),
            "sample_address": recs[0].get("tower_address"),
        })
    return results


def activity_by_hour(records):
    """Returns dict hour(0-23) -> count, for a 'peak activity hours' chart."""
    buckets = {h: 0 for h in range(24)}
    for r in records:
        if r.get("timestamp"):
            buckets[r["timestamp"].hour] += 1
    return buckets


def call_type_breakdown(records):
    counts = defaultdict(int)
    for r in records:
        counts[r.get("call_type", "unknown")] += 1
    return dict(counts)


def actual_trail_distance_km(records):
    """Sum segment distances excluding anomalous jumps."""
    total = 0.0
    for r in records:
        if r.get("is_anomalous_jump"):
            continue
        total += r.get("distance_from_prev_km") or 0
    return round(total, 1)


def call_pattern_matrix(records):
    """Incoming vs outgoing counts per hour (0–23)."""
    matrix = {h: {"incoming": 0, "outgoing": 0} for h in range(24)}
    for r in records:
        ts = r.get("timestamp")
        ct = r.get("call_type")
        if not ts or ct not in ("incoming", "outgoing"):
            continue
        hour = ts.hour if hasattr(ts, "hour") else None
        if hour is None:
            continue
        matrix[hour][ct] += 1
    return matrix


def operator_handoffs(records):
    """Detect service_provider / tower_operator changes along the trail."""
    handoffs = []
    for i in range(1, len(records)):
        prev = records[i - 1]
        curr = records[i]
        prev_op = prev.get("tower_operator") or prev.get("service_provider")
        curr_op = curr.get("tower_operator") or curr.get("service_provider")
        if prev_op and curr_op and prev_op.strip() != curr_op.strip():
            handoffs.append({
                "trail_index": i,
                "record_id": curr.get("id"),
                "timestamp": curr["timestamp"].isoformat() if hasattr(curr.get("timestamp"), "isoformat") else curr.get("timestamp"),
                "from_operator": prev_op,
                "to_operator": curr_op,
                "location": curr.get("tower_address") or curr.get("location_text"),
            })
    return handoffs


def device_change_alerts(records):
    """Flag IMEI / IMSI changes along chronological trail."""
    alerts = []
    prev_imei = None
    prev_imsi = None
    for i, r in enumerate(records):
        ts = r.get("timestamp")
        ts_iso = ts.isoformat() if hasattr(ts, "isoformat") else ts
        if r.get("imei") and prev_imei and r["imei"] != prev_imei:
            alerts.append({
                "type": "imei",
                "trail_index": i,
                "record_id": r.get("id"),
                "timestamp": ts_iso,
                "from_value": prev_imei,
                "to_value": r["imei"],
            })
        if r.get("imsi") and prev_imsi and r["imsi"] != prev_imsi:
            alerts.append({
                "type": "imsi",
                "trail_index": i,
                "record_id": r.get("id"),
                "timestamp": ts_iso,
                "from_value": prev_imsi,
                "to_value": r["imsi"],
            })
        if r.get("imei"):
            prev_imei = r["imei"]
        if r.get("imsi"):
            prev_imsi = r["imsi"]
    return alerts


def top_contacts(records, sort_by="count", top_n=10):
    """
    Groups records by the 'other party' number (whichever of source/dest
    isn't the subject's own number is ambiguous from CDR alone, so this
    groups by dest_number which is what most exports treat as the contact).
    Returns contact, count, total_duration_seconds, first_contact, last_contact.
    """
    buckets = defaultdict(list)
    for r in records:
        contact = r.get("dest_number") or r.get("source_number") or "Unknown"
        buckets[contact].append(r)

    rows = []
    for contact, recs in buckets.items():
        if not contact or contact == "Unknown":
            continue
        timestamps = [r["timestamp"] for r in recs if r.get("timestamp")]
        rows.append({
            "contact": contact,
            "count": len(recs),
            "total_duration_seconds": sum(r.get("duration_seconds", 0) or 0 for r in recs),
            "first_contact": min(timestamps).isoformat() if timestamps else None,
            "last_contact": max(timestamps).isoformat() if timestamps else None,
        })

    key = "count" if sort_by == "count" else "total_duration_seconds"
    rows.sort(key=lambda r: r[key], reverse=True)
    return rows[:top_n]
