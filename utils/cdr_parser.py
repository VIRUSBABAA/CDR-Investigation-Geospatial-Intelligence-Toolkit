"""
cdr_parser.py
Imports a CDR Excel/CSV export and auto-detects which column is which,
since every carrier export uses slightly different headers.
"""
import pandas as pd
from datetime import datetime

# header keyword -> normalized field
COLUMN_KEYWORDS = {
    "source_number": ["a number", "a-party", "caller", "msisdn a", "calling"],
    "dest_number":   ["b number", "b-party", "callee", "msisdn b", "called"],
    "imei":          ["imei"],
    "imsi":          ["imsi"],
    "cell_sector":   ["cell sector", "sector"],
    "cell_id":       ["cell id", "cellid", "cgi", "cell-id"],
    "service_provider": ["service provider", "operator", "carrier", "network"],
    "direction":     ["direction"],
    "call_type":     ["type", "call type", "service type"],
    "location":      ["location", "site", "address"],
    "latitude":      ["latitude", "lat"],
    "longitude":     ["longitude", "lon", "long"],
    "start_time":    ["start time", "start date", "call start"],
    "end_time":      ["end time", "end date", "call end"],
    "timestamp":     ["date/time", "datetime", "timestamp", "date", "time"],
    "duration_seconds": ["duration", "call duration", "length"],
}

# Checked in this order so e.g. "Start Time" isn't swallowed by the
# more generic "timestamp" keyword "time".
PRIORITY_ORDER = [
    "imei", "imsi", "cell_sector", "cell_id", "source_number", "dest_number",
    "service_provider", "direction", "call_type", "location",
    "latitude", "longitude", "start_time", "end_time", "duration_seconds",
    "timestamp",
]


def _normalize_header(h):
    return str(h).strip().lower()


def detect_column_mapping(df):
    """Returns dict: normalized_field -> actual column name in df.
    Matches in PRIORITY_ORDER so a more specific field (e.g. 'start_time')
    claims a column before a more generic one (e.g. 'timestamp') can."""
    mapping = {}
    used_columns = set()
    headers = {col: _normalize_header(col) for col in df.columns}

    for field in PRIORITY_ORDER:
        keywords = COLUMN_KEYWORDS[field]
        for col, norm in headers.items():
            if col in used_columns:
                continue
            if any(kw in norm for kw in keywords):
                mapping[field] = col
                used_columns.add(col)
                break
    return mapping


def _parse_timestamp(value):
    if pd.isna(value):
        return None
    if isinstance(value, datetime):
        return value
    for fmt in ("%Y-%m-%d %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M",
                "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M:%S"):
        try:
            return datetime.strptime(str(value), fmt)
        except ValueError:
            continue
    try:
        return pd.to_datetime(value).to_pydatetime()
    except Exception:
        return None


def _classify_call_type(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return "unknown"
    s = str(raw).strip().lower()
    if "out" in s:
        return "outgoing"
    if "in" in s:
        return "incoming"
    if "miss" in s:
        return "missed"
    if "sms" in s or "text" in s:
        return "sms"
    return s or "unknown"


def parse_cdr_file(filepath):
    """
    Reads a CDR Excel/CSV export and returns a list of normalized record
    dicts. Supports two location modes:
      1. Direct Latitude/Longitude columns in the sheet (used as-is)
      2. Cell ID only -> resolved later via the tower lookup table

    Supports two timestamp modes:
      1. A single Date/Time column
      2. Separate Start Time / End Time columns (Start Time is used as the
         event time; duration is derived from End Time if no Duration
         column exists)

    Raises ValueError with a human-readable message if neither a usable
    location nor a usable timestamp can be found.
    """
    if filepath.lower().endswith(".csv"):
        df = pd.read_csv(filepath)
    else:
        df = pd.read_excel(filepath)

    if df.empty:
        raise ValueError("The uploaded sheet has no rows.")

    mapping = detect_column_mapping(df)

    has_timestamp = "timestamp" in mapping or "start_time" in mapping
    has_location = "cell_id" in mapping or ("latitude" in mapping and "longitude" in mapping)

    if not has_timestamp:
        raise ValueError(
            "Could not auto-detect a time column. Expected a header like "
            "'Date/Time' or 'Start Time'."
        )
    if not has_location:
        raise ValueError(
            "Could not auto-detect a location column. Expected either a "
            "'Cell ID' column or both 'Latitude' and 'Longitude' columns."
        )

    records = []
    skipped = 0
    for _, row in df.iterrows():
        time_col = mapping.get("timestamp") or mapping.get("start_time")
        ts = _parse_timestamp(row.get(time_col))
        if ts is None:
            skipped += 1
            continue

        cell_id = row.get(mapping.get("cell_id")) if "cell_id" in mapping else None
        lat = row.get(mapping.get("latitude")) if "latitude" in mapping else None
        lon = row.get(mapping.get("longitude")) if "longitude" in mapping else None
        has_cell = cell_id is not None and not pd.isna(cell_id)
        has_coords = lat is not None and lon is not None and not pd.isna(lat) and not pd.isna(lon)

        if not has_cell and not has_coords:
            skipped += 1
            continue

        duration = 0
        if "duration_seconds" in mapping:
            raw = row.get(mapping["duration_seconds"])
            try:
                duration = int(float(raw)) if not pd.isna(raw) else 0
            except (ValueError, TypeError):
                duration = 0
        elif "end_time" in mapping:
            end_ts = _parse_timestamp(row.get(mapping["end_time"]))
            if end_ts and end_ts > ts:
                duration = int((end_ts - ts).total_seconds())

        def _get_str(field):
            return str(row.get(mapping[field], "")).strip() if field in mapping else ""

        call_type_raw = row.get(mapping.get("call_type")) if "call_type" in mapping else None
        direction_raw = row.get(mapping.get("direction")) if "direction" in mapping else None
        # Direction (Incoming/Outgoing) is usually more reliable than a
        # generic 'Type' (Voice/SMS) column for our incoming/outgoing/missed
        # classification, so prefer it when both exist.
        type_source = direction_raw if direction_raw is not None and not (isinstance(direction_raw, float) and pd.isna(direction_raw)) else call_type_raw

        records.append({
            "source_number": _get_str("source_number"),
            "dest_number": _get_str("dest_number"),
            "imei": _get_str("imei"),
            "imsi": _get_str("imsi"),
            "service_provider": _get_str("service_provider"),
            "location_text": _get_str("location"),
            "cell_id": str(cell_id).strip() if has_cell else None,
            "latitude": float(lat) if has_coords else None,
            "longitude": float(lon) if has_coords else None,
            "timestamp": ts,
            "duration_seconds": duration,
            "call_type": _classify_call_type(type_source),
        })

    if not records:
        raise ValueError("No valid rows found after parsing (check date/time and location columns).")

    return records, skipped, mapping
