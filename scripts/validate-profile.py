"""Validate rendered metrics, original layouts, links, and refresh cache keys."""

import base64
import json
import os
import re
from collections import Counter
from itertools import groupby
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OWNER = os.environ.get("PROFILE_OWNER", "StevenWang-CY")
CACHE_KEY = os.environ["PROFILE_CACHE_KEY"]
SNAPSHOT = Path(os.environ.get("PUBLIC_CONTRIBUTIONS_SNAPSHOT", "generated-data/profile-contributions.json"))
assert re.fullmatch(r"\d{8}-r5", CACHE_KEY), "invalid profile cache key"
assert SNAPSHOT.is_file() and not SNAPSHOT.is_symlink(), "missing contribution snapshot"
snapshot = json.loads(SNAPSHOT.read_text())
assert snapshot["userName"] == OWNER
assert snapshot["profileDate"].replace("-", "") == CACHE_KEY[:8]
days = snapshot["days"]
total = sum(day["contributionCount"] for day in days)
assert total == snapshot["totalContributions"] and total >= 2000
active = [day["contributionCount"] > 0 for day in days]
longest = max((len(list(group)) for state, group in groupby(active) if state), default=0)
current_days = active if active[-1] else active[:-1]
current = next((i for i, state in enumerate(reversed(current_days)) if not state), len(current_days))


def local(name):
    return name.rsplit("}", 1)[-1]


def read_svg(path):
    assert path.is_file() and not path.is_symlink(), f"{path}: missing asset"
    raw = path.read_text()
    assert len(raw.encode()) <= 8 * 1024 * 1024, f"{path}: asset too large"
    assert not re.search(r"<!DOCTYPE|<!ENTITY|@import|javascript:", raw, re.I)
    root = ET.fromstring(raw)
    assert local(root.tag) == "svg" and root.get("role") == "img"
    allowed = {"svg", "title", "desc", "style", "rect", "path", "g", "text", "defs", "clipPath", "image", "foreignObject", "div", "circle", "line", "mask", "ellipse"}
    ids = {element.get("id") for element in root.iter() if element.get("id")}
    for element in root.iter():
        assert local(element.tag) in allowed, f"{path}: unexpected SVG element"
        for name, value in element.attrib.items():
            assert not local(name).lower().startswith("on"), f"{path}: active event attribute"
            if local(name) == "href":
                assert local(element.tag) == "image"
                match = re.fullmatch(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)", value)
                assert match, f"{path}: external or unsupported image reference"
                image = base64.b64decode(match[2], validate=True)
                assert image.startswith(b"\x89PNG\r\n\x1a\n") if match[1] == "png" else image.startswith(b"\xff\xd8")
    for ref in re.findall(r"url\(([^)]+)\)", raw):
        assert ref.startswith("#") and ref[1:] in ids, f"{path}: external or missing SVG reference"
    assert root.find("{http://www.w3.org/2000/svg}title") is not None
    return root


expected_files = set()
expected_urls = Counter()
expected_star_keys = {}
for index, name in enumerate(("township", "SILKern.")):
    filename = f"featured-{index}.svg"
    expected_files.add(filename)
    root = read_svg(ASSETS / filename)
    assert root.get("viewBox") == "0 0 846 212"
    assert root.get("data-project") == name
    stars = int(root.get("data-stars"))
    assert stars >= 0
    star_nodes = [e for e in root.iter() if local(e.tag) == "text" and e.get("class") == "meta" and e.get("x") == "50"]
    assert len(star_nodes) == 1 and star_nodes[0].text == str(stars), "live star count missing"
    assert len([e for e in root.iter() if local(e.tag) == "foreignObject"]) == 1
    expected_urls[f"/{OWNER}/{OWNER}/main/assets/{filename}"] = 1
    expected_star_keys[filename] = f"{CACHE_KEY}-s{stars}"

stats_texts = []
for theme in ("light", "dark"):
    filename = f"contribution-stats-{theme}.svg"
    expected_files.add(filename)
    root = read_svg(ASSETS / filename)
    assert root.get("viewBox") == "0 0 495 195"
    assert int(root.get("data-total")) == total
    assert int(root.get("data-current-streak")) == current
    assert int(root.get("data-longest-streak")) == longest
    assert root.get("data-as-of") == snapshot["profileDate"]
    numbers = [e.text for e in root.iter() if local(e.tag) == "text" and e.get("font-size") == "28px"]
    assert numbers == [f"{total:,}", str(current), str(longest)], "rendered metrics differ from snapshot"
    assert any(e.get("id") == "mask_out_ring_behind_fire" for e in root.iter()), "original streak ring missing"
    stats_texts.append([e.text for e in root.iter() if local(e.tag) == "text"])
    expected_urls[f"/{OWNER}/{OWNER}/main/assets/{filename}"] = 2 if theme == "light" else 1
assert stats_texts[0] == stats_texts[1], "light/dark metrics differ"
actual_files = {p.name for pattern in ("featured-*.svg", "contribution-stats-*.svg") for p in ASSETS.glob(pattern)}
assert actual_files == expected_files, "missing or stale generated profile assets"
expected_urls[f"/{OWNER}/{OWNER}/output/github-contribution-grid-snake.svg"] = 2
expected_urls[f"/{OWNER}/{OWNER}/output/github-contribution-grid-snake-dark.svg"] = 1

static_keys = {}
for name in ("website", "linkedin", "email"):
    filename = f"contact-{name}.svg"
    path = ASSETS / filename
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_size <= 16 * 1024
    root = ET.fromstring(path.read_text())
    assert root.get("viewBox") == "0 0 105 195", "original contact geometry changed"
    expected_urls[f"/{OWNER}/{OWNER}/main/assets/{filename}"] = 1
    static_keys[filename] = "contact-inline-strip-r1"
for name in ("vllm", "sglang"):
    filename = f"contributor-{name}.png"
    path = ASSETS / filename
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_size <= 512 * 1024
    assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    expected_urls[f"/{OWNER}/{OWNER}/main/assets/{filename}"] = 1
    static_keys[filename] = "contributor-r1"

readme = (ROOT / "README.md").read_text()
for section in ("FEATURED-REPOS", "CONTRIBUTION-STATS"):
    start, end = (f"<!-- {section}:{edge} -->" for edge in ("START", "END"))
    assert readme.count(start) == readme.count(end) == 1
    assert readme.index(start) < readme.index(end)
actual_urls = Counter()
for match in re.findall(r"https://raw\.githubusercontent\.com/[^\s\"'>]+", readme):
    url = urlsplit(match)
    filename = url.path.rsplit("/", 1)[-1]
    key = static_keys.get(filename, expected_star_keys.get(filename, f"{CACHE_KEY}-c{total}"))
    assert parse_qs(url.query).get("v") == [key], f"{filename}: stale image cache key"
    actual_urls[url.path] += 1
assert actual_urls == expected_urls, "generated image links are missing or duplicated"
for link in (f"https://github.com/{OWNER}/township", f"https://github.com/{OWNER}/SILKern.",
             "https://chuyuewang.vercel.app/", "mailto:stevenwang0805@outlook.com",
             "https://www.linkedin.com/in/chuyue-wang/"):
    assert link in readme, f"missing profile link: {link}"
repos = ("vllm-project/vllm", "vllm-project/vllm-metal", "vllm-project/agentic-api", "vllm-project/flash-attention", "sgl-project/sgl-eval")
for repo in repos:
    assert f'href="https://github.com/{repo}"' in readme, f"missing contribution link: {repo}"
assert readme.index("contributor-vllm.png") < readme.index("contributor-sglang.png")
snake = readme.index("/output/github-contribution-grid-snake")
featured = readme.index("<!-- FEATURED-REPOS:START -->")
stats = readme.index("<!-- CONTRIBUTION-STATS:START -->")
footer = readme.index("<sub>Contributions and stars refresh every four hours.</sub>")
assert snake < featured < stats < footer, "original contribution/project/streak order changed"
assert readme.rstrip().endswith("<sub><em>Playing guitar between commits.</em></sub>")
stats_block = readme[stats:readme.index("<!-- CONTRIBUTION-STATS:END -->")]
assert stats_block.count('width="58.5%"') == 1 and stats_block.count('width="12.4%"') == 3
assert stats_block.count("assets/contact-") == 3, "contact icons must accompany the streak card"
assert all(text not in readme for text in ("Wharton", "LLM inference &amp; agents · Penn", "### Selected work", "### On GitHub", "-mobile.svg", "streak-stats.demolab.com"))
print(f"Profile verified: {total:,} contributions, {current}/{longest} day streaks, original cards/contact strip, 5 contribution links, 8 refreshed URLs.")
