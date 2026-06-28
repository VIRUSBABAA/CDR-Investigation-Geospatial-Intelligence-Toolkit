"""
Generates data/mock_towers_pakistan.csv

IMPORTANT: This is 100% SYNTHETIC data for demo/testing purposes.
- Operator names (MockTel Alpha/Beta/Gamma/Delta) are FICTIONAL, not real carriers.
- Cell IDs are randomly generated, not real telecom infrastructure identifiers.
- Coordinates are scattered around real Pakistani city centers purely so the
  demo map looks geographically realistic. No real tower locations are used.
"""
import csv
import random

random.seed(42)

CITIES = [
    ("Lahore", 31.5497, 74.3436),
    ("Karachi", 24.8607, 67.0011),
    ("Islamabad", 33.6844, 73.0479),
    ("Rawalpindi", 33.6007, 73.0679),
    ("Faisalabad", 31.4504, 73.1350),
    ("Multan", 30.1575, 71.5249),
    ("Peshawar", 34.0151, 71.5249),
    ("Quetta", 30.1798, 66.9750),
    ("Sialkot", 32.4945, 74.5229),
    ("Gujranwala", 32.1877, 74.1945),
    ("Hyderabad", 25.3960, 68.3578),
    ("Sukkur", 27.7052, 68.8574),
]

OPERATORS = ["MockTel Alpha", "MockTel Beta", "MockTel Gamma", "MockTel Delta"]
TECH = ["2G", "3G", "4G"]

rows = []
cell_counter = 100000

for city, lat, lon in CITIES:
    # ~15 towers scattered within roughly 8km of each city center
    for _ in range(15):
        jitter_lat = lat + random.uniform(-0.07, 0.07)
        jitter_lon = lon + random.uniform(-0.07, 0.07)
        operator = random.choice(OPERATORS)
        cell_id = f"{cell_counter}"
        lac = random.randint(1000, 9999)
        cell_counter += 7  # non-sequential, just for realism

        rows.append({
            "cell_id": cell_id,
            "lac": lac,
            "operator": operator,
            "technology": random.choice(TECH),
            "latitude": round(jitter_lat, 6),
            "longitude": round(jitter_lon, 6),
            "address": f"{city} - Mock Sector {random.randint(1, 12)}",
            "city": city,
        })

with open("/home/claude/cdr-osint-tool/data/mock_towers_pakistan.csv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)

print(f"Generated {len(rows)} mock towers -> mock_towers_pakistan.csv")
