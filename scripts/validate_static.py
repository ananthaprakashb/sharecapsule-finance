#!/usr/bin/env python3
from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = "finance.sharecapsule.app"
BASE_URL = f"https://{DOMAIN}"

REQUIRED = [
    "index.html",
    "CNAME",
    "robots.txt",
    "sitemap.xml",
    "404.html",
    "SECURITY.md",
    "PUBLISHING.md",
    "guide/index.html",
    "guide/expenses.html",
    "guide/credit-cards.html",
    "guide/emergency-fund.html",
    "guide/investing.html",
    "guide/retirement.html",
    "guide/protection.html",
    "guide/taxes.html",
    "guide/review.html",
    "passive-income/index.html",
    "about/index.html",
    "methodology/index.html",
    "privacy/index.html",
    "security/index.html",
    "sources/index.html",
    "roadmap/index.html",
]

IGNORE_SCHEMES = {"mailto", "tel", "data", "javascript"}


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs):
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.links.append(("href", values["href"]))
        elif tag == "link" and values.get("href"):
            self.links.append(("href", values["href"]))
        elif tag == "script" and values.get("src"):
            self.links.append(("src", values["src"]))
            self.scripts.append(values["src"])


def target_for(html_file: Path, raw: str) -> Path | None:
    value = raw.strip()
    if not value or value.startswith("#"):
        return None
    parsed = urlparse(value)
    if parsed.scheme in IGNORE_SCHEMES:
        return None
    if parsed.scheme in {"http", "https"}:
        if parsed.netloc != DOMAIN:
            return None
        path = parsed.path
    else:
        path = parsed.path

    if not path:
        return None
    if path.startswith("/"):
        candidate = ROOT / path.lstrip("/")
    else:
        candidate = html_file.parent / path

    if str(path).endswith("/"):
        candidate = candidate / "index.html"
    elif candidate.suffix == "":
        if candidate.is_dir():
            candidate = candidate / "index.html"
    return candidate.resolve()


def validate_required(errors: list[str]) -> None:
    for relative in REQUIRED:
        if not (ROOT / relative).exists():
            errors.append(f"Missing required file: {relative}")


def validate_domain(errors: list[str]) -> None:
    cname = (ROOT / "CNAME").read_text(encoding="utf-8").strip()
    if cname != DOMAIN:
        errors.append(f"CNAME must contain only {DOMAIN!r}; found {cname!r}")
    robots = (ROOT / "robots.txt").read_text(encoding="utf-8")
    expected = f"Sitemap: {BASE_URL}/sitemap.xml"
    if expected not in robots:
        errors.append("robots.txt does not advertise the production sitemap")


def validate_html(errors: list[str]) -> None:
    for html_file in ROOT.rglob("*.html"):
        if ".git" in html_file.parts:
            continue
        text = html_file.read_text(encoding="utf-8")
        parser = LinkParser()
        parser.feed(text)

        for script in parser.scripts:
            parsed = urlparse(script)
            if parsed.scheme in {"http", "https"}:
                errors.append(f"Remote script dependency is not allowed: {html_file.relative_to(ROOT)} -> {script}")

        for _, raw in parser.links:
            parsed = urlparse(raw)
            if parsed.scheme in {"http", "https"} and parsed.netloc != DOMAIN:
                continue
            target = target_for(html_file, raw)
            if target is None:
                continue
            try:
                target.relative_to(ROOT.resolve())
            except ValueError:
                errors.append(f"Link escapes repository root: {html_file.relative_to(ROOT)} -> {raw}")
                continue
            if not target.exists():
                errors.append(f"Broken internal asset/link: {html_file.relative_to(ROOT)} -> {raw}")


def validate_sitemap(errors: list[str]) -> None:
    sitemap = ROOT / "sitemap.xml"
    try:
        root = ET.parse(sitemap).getroot()
    except Exception as exc:
        errors.append(f"Invalid sitemap.xml: {exc}")
        return

    namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [node.text.strip() for node in root.findall("sm:url/sm:loc", namespace) if node.text]
    if len(locs) != len(set(locs)):
        errors.append("sitemap.xml contains duplicate URLs")
    for url in locs:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != DOMAIN:
            errors.append(f"Invalid sitemap host/scheme: {url}")
            continue
        path = parsed.path
        target = ROOT / path.lstrip("/")
        if path.endswith("/"):
            target /= "index.html"
        if not target.exists():
            errors.append(f"Sitemap URL has no matching static page: {url}")

    expected_paths = {
        "/",
        "/guide/",
        "/guide/expenses.html",
        "/guide/credit-cards.html",
        "/guide/emergency-fund.html",
        "/guide/investing.html",
        "/guide/retirement.html",
        "/guide/protection.html",
        "/guide/taxes.html",
        "/guide/review.html",
        "/passive-income/",
        "/about/",
        "/methodology/",
        "/privacy/",
        "/security/",
        "/sources/",
        "/roadmap/",
    }
    actual_paths = {urlparse(url).path for url in locs}
    missing = expected_paths - actual_paths
    if missing:
        errors.append("Sitemap is missing launch pages: " + ", ".join(sorted(missing)))


def main() -> int:
    errors: list[str] = []
    validate_required(errors)
    if not errors:
        validate_domain(errors)
        validate_html(errors)
        validate_sitemap(errors)

    if errors:
        print("Static publishing validation failed:\n")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Static publishing validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
