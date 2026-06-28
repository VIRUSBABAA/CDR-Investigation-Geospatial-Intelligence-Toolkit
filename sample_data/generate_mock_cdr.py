"""
generate_mock_cdr.py
Builds two SYNTHETIC CDR Excel sheets (mock_cdr_victim1.xlsx, mock_cdr_victim2.xlsx)
using cell IDs that exist in data/mock_towers_pakistan.csv, so the demo map
shows a believable trail out of the box. All numbers, names and call data
here are entirely fictional.
"""
import csv
import random
from datetime import datetime, timedelta
import pandas as pd

random.seed(7)

TOWERS_PATH = "/home/claude/cdr-osint-tool/data/mock_towers_pakistan.csv"

with open(TOWERS_PATH, newline="") as f:
    towers = list(csv.DictReader(f))

by_city = {}
for t in towers:
    by_city.setdefault(t["city"], []).append(t)


def _row(subject_imei, subject_imsi, subject_number, contacts, tower, ts):
    direction = random.choice(["Outgoing", "Incoming", "Outgoing", "Missed", "Incoming"])
    call_type = "SMS" if random.random() < 0.2 else "Voice"
    other = random.choice(contacts)
    duration = 0 if direction == "Missed" or call_type == "SMS" else random.randint(15, 600)
    end_ts = ts + timedelta(seconds=duration)
    return {
        "IMEI": subject_imei,
        "IMSI": subject_imsi,
        "A Number": subject_number,
        "B Number": other,
        "Start Time": ts.strftime("%Y-%m-%d %H:%M:%S"),
        "End Time": end_ts.strftime("%Y-%m-%d %H:%M:%S"),
        "Service Provider": tower["operator"],
        "Type": call_type,
        "Direction": direction,
        "Location": tower["address"],
        "Cell Id": tower["cell_id"],
        "Cell Sector": random.randint(1, 3),
        "Latitude": tower["latitude"],
        "Longitude": tower["longitude"],
        "Duration": duration,
    }


def build_subject_trail(subject_imei, subject_imsi, subject_number, home_city, work_city, days=5):
    """A simple daily pattern: home overnight, work during the day,
    a few calls scattered in between, plus one day-trip to a third city."""
    rows = []
    home_towers = by_city[home_city]
    work_towers = by_city[work_city]
    other_city = random.choice([c for c in by_city if c not in (home_city, work_city)])
    other_towers = by_city[other_city]

    start = datetime(2026, 5, 1, 6, 0)
    contacts = [f"0301{random.randint(1000000, 9999999)}" for _ in range(5)]

    for d in range(days):
        day_start = start + timedelta(days=d)

        for _ in range(random.randint(2, 4)):
            t = random.choice(home_towers)
            ts = day_start + timedelta(minutes=random.randint(0, 150))
            rows.append(_row(subject_imei, subject_imsi, subject_number, contacts, t, ts))

        if d == 3:
            for _ in range(random.randint(3, 5)):
                t = random.choice(other_towers)
                ts = day_start + timedelta(hours=random.randint(4, 10))
                rows.append(_row(subject_imei, subject_imsi, subject_number, contacts, t, ts))
        else:
            for _ in range(random.randint(4, 7)):
                t = random.choice(work_towers)
                ts = day_start + timedelta(hours=random.randint(3, 11))
                rows.append(_row(subject_imei, subject_imsi, subject_number, contacts, t, ts))

        for _ in range(random.randint(2, 5)):
            t = random.choice(home_towers)
            ts = day_start + timedelta(hours=random.randint(12, 17))
            rows.append(_row(subject_imei, subject_imsi, subject_number, contacts, t, ts))

    rows.sort(key=lambda r: r["Start Time"])
    return rows


victim1 = build_subject_trail("490154203237518", "410015303237518", "03001234567", "Lahore", "Lahore", days=5)
victim2 = build_subject_trail("351728092345671", "410012092345671", "03219876543", "Karachi", "Hyderabad", days=5)

pd.DataFrame(victim1).to_excel("/home/claude/cdr-osint-tool/sample_data/mock_cdr_victim1.xlsx", index=False)
pd.DataFrame(victim2).to_excel("/home/claude/cdr-osint-tool/sample_data/mock_cdr_victim2.xlsx", index=False)

print(f"victim1: {len(victim1)} rows, victim2: {len(victim2)} rows")
