#!/usr/bin/env python3
import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

YEAR = 2024
BASE = "https://download.bls.gov/pub/time.series/cx"
SERIES_URL = f"{BASE}/cx.series"
DATA_URL = f"{BASE}/cx.data.1.AllData"

REGIONS = {
    "northeast": "Northeast",
    "midwest": "Midwest",
    "south": "South",
    "west": "West",
}
BANDS = [
    {"id": "lt15", "label": "Less than $15,000", "min": 0, "max": 14999},
    {"id": "15-30", "label": "$15,000 to $29,999", "min": 15000, "max": 29999},
    {"id": "30-40", "label": "$30,000 to $39,999", "min": 30000, "max": 39999},
    {"id": "40-50", "label": "$40,000 to $49,999", "min": 40000, "max": 49999},
    {"id": "50-70", "label": "$50,000 to $69,999", "min": 50000, "max": 69999},
    {"id": "70-100", "label": "$70,000 to $99,999", "min": 70000, "max": 99999},
    {"id": "100-150", "label": "$100,000 to $149,999", "min": 100000, "max": 149999},
    {"id": "150-200", "label": "$150,000 to $199,999", "min": 150000, "max": 199999},
    {"id": "200plus", "label": "$200,000 and more", "min": 200000, "max": None},
]

FIELD_PREFIXES = {
    "annualExpenditures": ["total expenditures", "average annual expenditures"],
    "averageIncomeBeforeTax": ["income before taxes"],
    "averageIncomeAfterTax": ["income after taxes"],
    "averagePeople": ["people"],
    "food": ["food"],
    "housing": ["housing"],
    "apparel": ["apparel and services"],
    "transportation": ["transportation"],
    "healthcare": ["healthcare"],
    "entertainment": ["entertainment"],
    "personalCare": ["personal care products and services"],
    "education": ["education"],
    "miscellaneous": ["miscellaneous"],
    "personalInsurancePensions": ["personal insurance and pensions"],
}

HEADERS = {
    "User-Agent": "ShareCapsule-Finance-Benchmark-Refresh/1.0 (public BLS LABSTAT data)",
    "Accept": "text/plain,application/octet-stream,*/*;q=0.5",
}


def download_text(url):
    response = requests.get(url, timeout=120, headers=HEADERS)
    response.raise_for_status()
    return response.content.decode("utf-8-sig", errors="replace")


def rows_from_tsv(text):
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    result = []
    for row in reader:
        result.append({str(key).strip(): (value.strip() if isinstance(value, str) else value) for key, value in row.items()})
    return result


def normalize(value):
    return " ".join(str(value or "").lower().split())


def matches_title(title, demographic, characteristic, prefixes):
    norm = normalize(title)
    marker = f" by {normalize(demographic)}: "
    if marker not in norm:
        return False
    if not norm.endswith(normalize(characteristic)):
        return False
    subject = norm.split(marker, 1)[0]
    return any(subject == normalize(prefix) for prefix in prefixes)


def series_index(series_rows):
    return [(row.get("series_id", ""), row.get("series_title", "")) for row in series_rows if row.get("series_id") and row.get("series_title")]


def find_series(index, demographic, characteristic, prefixes):
    matches = [series_id for series_id, title in index if matches_title(title, demographic, characteristic, prefixes)]
    if not matches:
        raise RuntimeError(f"No LABSTAT series found for {prefixes[0]} by {demographic}: {characteristic}")
    if len(matches) > 1:
        raise RuntimeError(f"Ambiguous LABSTAT series for {prefixes[0]} by {demographic}: {characteristic}: {matches[:5]}")
    return matches[0]


def values_for_year(data_text, wanted_ids):
    wanted = set(wanted_ids)
    values = {}
    reader = csv.DictReader(io.StringIO(data_text), delimiter="\t")
    for raw in reader:
        row = {str(key).strip(): (value.strip() if isinstance(value, str) else value) for key, value in raw.items()}
        series_id = row.get("series_id", "")
        if series_id not in wanted or row.get("year") != str(YEAR) or row.get("period") != "A01":
            continue
        try:
            values[series_id] = float(row.get("value", ""))
        except (TypeError, ValueError):
            values[series_id] = None
    return values


def build_profile(index, values, demographic, characteristic):
    result = {}
    for field, prefixes in FIELD_PREFIXES.items():
        series_id = find_series(index, demographic, characteristic, prefixes)
        result[field] = values.get(series_id)
    return result


def ratio(value, base):
    if value is None or base in (None, 0):
        return 1.0
    return float(value) / float(base)


def regionalize(income_profile, region_profile, national_profile):
    cohort = {}
    for field in FIELD_PREFIXES:
        income_value = income_profile.get(field)
        region_value = region_profile.get(field)
        national_value = national_profile.get(field)
        if income_value is None:
            cohort[field] = None
            continue
        # Apply the region's current relative level for the same measure to the
        # national income-range mean. This is an estimate, not an official cross-tab.
        cohort[field] = round(float(income_value) * ratio(region_value, national_value), 2)
    return cohort


def main():
    series_rows = rows_from_tsv(download_text(SERIES_URL))
    index = series_index(series_rows)

    characteristics = ["All Consumer Units"] + [band["label"] for band in BANDS] + list(REGIONS.values())
    ids = []
    for characteristic in characteristics:
        demographic = "Income Range" if characteristic == "All Consumer Units" or characteristic in [band["label"] for band in BANDS] else "Region of residence"
        for prefixes in FIELD_PREFIXES.values():
            ids.append(find_series(index, demographic, characteristic, prefixes))

    data_text = download_text(DATA_URL)
    values = values_for_year(data_text, ids)

    national = build_profile(index, values, "Income Range", "All Consumer Units")
    income_profiles = {band["id"]: build_profile(index, values, "Income Range", band["label"]) for band in BANDS}

    regions = {}
    for slug, region_name in REGIONS.items():
        region_profile = build_profile(index, values, "Region of residence", region_name)
        cohorts = []
        for band in BANDS:
            estimated = regionalize(income_profiles[band["id"]], region_profile, national)
            cohorts.append({**band, **estimated})
        regions[slug] = {
            "name": region_name,
            "source": "BLS CE LABSTAT 2024 income-range and region means",
            "cohorts": cohorts,
        }

    result = {
        "schemaVersion": 2,
        "source": "U.S. Bureau of Labor Statistics Consumer Expenditure Surveys LABSTAT",
        "sourcePeriod": str(YEAR),
        "benchmarkMethod": "regionalized-income-cohort",
        "isExactCrossTab": False,
        "generatedFrom": "BLS 2024 annual income-range means adjusted by BLS 2024 Census-region means",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFiles": [SERIES_URL, DATA_URL],
        "regions": regions,
        "notes": [
            "Peer cohorts are descriptive estimates, not recommended budgets.",
            "Automated LABSTAT data do not include BLS cross-tabulations. ShareCapsule regionalizes income-range means using the relative regional mean for each measure.",
            "BLS publishes exact two-year region-by-income cross-tabulations separately; those can replace this estimate when a controlled refresh source is available.",
            "The health engine compares peer context with the user's own cash flow, reserves and debt before suggesting a direction.",
        ],
    }
    out = Path("health/benchmarks.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sourcePeriod": YEAR, "method": result["benchmarkMethod"], "regions": {key: len(value["cohorts"]) for key, value in regions.items()}, "output": str(out)}))


if __name__ == "__main__":
    main()
