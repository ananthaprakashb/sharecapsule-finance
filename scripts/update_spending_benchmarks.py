#!/usr/bin/env python3
"""Build ShareCapsule's public peer-spending benchmark.

The source values below are transcribed from the U.S. Bureau of Labor Statistics
Consumer Expenditure Surveys 2023 annual report:
  Table 2 — Quintiles of income before taxes
  Table 4 — Region of residence

BLS also publishes exact two-year region-by-income cross-tabulations. This
builder does NOT claim to reproduce those cross-tabs. It creates a transparent
regionalized estimate by applying each Census region's category-relative factor
to the national income-quintile mean for the same category.

Keeping audited source constants in-repo makes the build deterministic and
avoids depending on BLS network access from GitHub-hosted CI, which is currently
blocked for these downloads.
"""

import json
from pathlib import Path

YEAR = "2023"
SOURCE_PAGE = "https://www.bls.gov/opub/reports/consumer-expenditures/2023/home.htm"
EXACT_CROSS_TAB_INDEX = "https://www.bls.gov/cex/tables.htm"

FIELDS = [
    "annualExpenditures",
    "averageIncomeBeforeTax",
    "averagePeople",
    "food",
    "housing",
    "apparel",
    "transportation",
    "healthcare",
    "entertainment",
    "personalCare",
    "education",
    "miscellaneous",
    "personalInsurancePensions",
]

NATIONAL = {
    "annualExpenditures": 77280,
    "averageIncomeBeforeTax": 101805,
    "averagePeople": 2.5,
    "food": 9985,
    "housing": 25436,
    "apparel": 2041,
    "transportation": 13174,
    "healthcare": 6159,
    "entertainment": 3635,
    "personalCare": 950,
    "education": 1656,
    "miscellaneous": 1184,
    "personalInsurancePensions": 9556,
}

# Table 2, Consumer Expenditure Surveys, 2023.
QUINTILES = [
    {
        "id": "q1", "label": "Lowest 20% (under $28,262)", "min": 0, "max": 28261,
        "annualExpenditures": 33776, "averageIncomeBeforeTax": 15596, "averagePeople": 1.6,
        "food": 5278, "housing": 13943, "apparel": 938, "transportation": 4917,
        "healthcare": 3539, "entertainment": 1445, "personalCare": 438,
        "education": 727, "miscellaneous": 428, "personalInsurancePensions": 713,
    },
    {
        "id": "q2", "label": "Second 20% ($28,262–$54,552)", "min": 28262, "max": 54552,
        "annualExpenditures": 48923, "averageIncomeBeforeTax": 40751, "averagePeople": 2.1,
        "food": 7100, "housing": 18656, "apparel": 1247, "transportation": 7809,
        "healthcare": 4844, "entertainment": 2234, "personalCare": 637,
        "education": 531, "miscellaneous": 1023, "personalInsurancePensions": 2608,
    },
    {
        "id": "q3", "label": "Third 20% ($54,553–$90,238)", "min": 54553, "max": 90238,
        "annualExpenditures": 65487, "averageIncomeBeforeTax": 71057, "averagePeople": 2.5,
        "food": 8989, "housing": 22674, "apparel": 1640, "transportation": 11909,
        "healthcare": 5753, "entertainment": 2718, "personalCare": 875,
        "education": 1079, "miscellaneous": 1089, "personalInsurancePensions": 5942,
    },
    {
        "id": "q4", "label": "Fourth 20% ($90,239–$148,681)", "min": 90239, "max": 148681,
        "annualExpenditures": 87922, "averageIncomeBeforeTax": 116717, "averagePeople": 2.9,
        "food": 11550, "housing": 27951, "apparel": 2487, "transportation": 15914,
        "healthcare": 7010, "entertainment": 3871, "personalCare": 1111,
        "education": 1176, "miscellaneous": 1270, "personalInsurancePensions": 11878,
    },
    {
        "id": "q5", "label": "Highest 20% ($148,682+)", "min": 148682, "max": None,
        "annualExpenditures": 150093, "averageIncomeBeforeTax": 264518, "averagePeople": 3.2,
        "food": 16996, "housing": 43897, "apparel": 3888, "transportation": 25279,
        "healthcare": 9633, "entertainment": 7898, "personalCare": 1687,
        "education": 4766, "miscellaneous": 2106, "personalInsurancePensions": 26604,
    },
]

# Table 4, Consumer Expenditure Surveys, 2023.
REGIONS = {
    "northeast": {
        "name": "Northeast", "annualExpenditures": 87445, "averageIncomeBeforeTax": 116860,
        "averagePeople": 2.4, "food": 11165, "housing": 29921, "apparel": 2190,
        "transportation": 13880, "healthcare": 6467, "entertainment": 3901,
        "personalCare": 1005, "education": 2600, "miscellaneous": 1415,
        "personalInsurancePensions": 11106,
    },
    "midwest": {
        "name": "Midwest", "annualExpenditures": 72575, "averageIncomeBeforeTax": 92618,
        "averagePeople": 2.4, "food": 9627, "housing": 22123, "apparel": 1905,
        "transportation": 12517, "healthcare": 6588, "entertainment": 3911,
        "personalCare": 851, "education": 1551, "miscellaneous": 1051,
        "personalInsurancePensions": 9273,
    },
    "south": {
        "name": "South", "annualExpenditures": 68364, "averageIncomeBeforeTax": 89821,
        "averagePeople": 2.4, "food": 8852, "housing": 22322, "apparel": 1805,
        "transportation": 12247, "healthcare": 5639, "entertainment": 3046,
        "personalCare": 890, "education": 1420, "miscellaneous": 910,
        "personalInsurancePensions": 8237,
    },
    "west": {
        "name": "West", "annualExpenditures": 89510, "averageIncomeBeforeTax": 119926,
        "averagePeople": 2.6, "food": 11374, "housing": 30561, "apparel": 2464,
        "transportation": 14881, "healthcare": 6436, "entertainment": 4211,
        "personalCare": 1105, "education": 1444, "miscellaneous": 1615,
        "personalInsurancePensions": 10953,
    },
}


def factor(region_value, national_value):
    if not national_value:
        return 1.0
    return float(region_value) / float(national_value)


def regionalize(quintile, region):
    cohort = {key: quintile[key] for key in ("id", "label", "min", "max")}
    for field in FIELDS:
        cohort[field] = round(float(quintile[field]) * factor(region[field], NATIONAL[field]), 2)
    return cohort


def build():
    regions = {}
    for slug, region in REGIONS.items():
        regions[slug] = {
            "name": region["name"],
            "cohorts": [regionalize(quintile, region) for quintile in QUINTILES],
        }

    return {
        "schemaVersion": 3,
        "source": "U.S. Bureau of Labor Statistics Consumer Expenditure Surveys",
        "sourcePeriod": YEAR,
        "benchmarkMethod": "regionalized-income-quintile",
        "isExactCrossTab": False,
        "generatedFrom": "BLS 2023 income-quintile means regionalized with BLS 2023 Census-region means",
        "sourcePages": [SOURCE_PAGE, EXACT_CROSS_TAB_INDEX],
        "regions": regions,
        "notes": [
            "Peer cohorts are descriptive estimates, not recommended budgets.",
            "ShareCapsule applies the region-to-U.S. ratio for each category to the national income-quintile mean for that category.",
            "This is not the official BLS region-by-income cross-tabulation. BLS publishes exact two-year cross-tabulated tables separately.",
            "The personal health engine combines peer context with the user's own cash flow, reserve and debt signals before suggesting actions.",
        ],
    }


def main():
    data = build()
    output = Path("health/benchmarks.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "sourcePeriod": data["sourcePeriod"],
        "method": data["benchmarkMethod"],
        "regions": {key: len(value["cohorts"]) for key, value in data["regions"].items()},
        "output": str(output),
    }))


if __name__ == "__main__":
    main()
