"""Build the pinned Unicode/CLDR data without network access or font extraction."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "vendor/unicode/17.0"
GROUPS = {
    "Smileys & Emotion": "表情与情感",
    "People & Body": "人物与身体",
    "Animals & Nature": "动物与自然",
    "Food & Drink": "食物与饮品",
    "Travel & Places": "旅行与地点",
    "Activities": "活动",
    "Objects": "物品",
    "Symbols": "符号",
    "Flags": "旗帜",
}


def key(sequence):
    return "-".join(f"{ord(char):X}" for char in sequence)


def annotations(locale):
    merged = {}
    for source in ("annotationsDerived", "annotations"):
        for item in ET.parse(SOURCES / f"{source}-{locale}.xml").getroot().iter("annotation"):
            merged[(item.attrib["cp"], item.attrib.get("type", "keywords"))] = {
                "value": item.text or "",
                "draft": item.attrib.get("draft"),
                "source": source,
            }
    return merged


def generate():
    manifest = json.loads((SOURCES / "sources.json").read_text(encoding="utf-8"))
    for item in manifest["sources"]:
        digest = hashlib.sha256((SOURCES / item["name"]).read_bytes()).hexdigest()
        if digest != item["sha256"]:
            raise ValueError(f"Pinned source hash mismatch: {item['name']}")
    zh, en = annotations("zh"), annotations("en")
    entries = []
    group = subgroup = ""
    for line in (SOURCES / "emoji-test.txt").read_text(encoding="utf-8").splitlines():
        if line.startswith("# group: "):
            group = line.split(": ", 1)[1]
        if line.startswith("# subgroup: "):
            subgroup = line.split(": ", 1)[1]
        match = re.fullmatch(r"([0-9A-F ]+)\s*; fully-qualified\s*# \S+ E([0-9.]+) (.+)", line)
        if not match:
            continue
        sequence = "".join(chr(int(value, 16)) for value in match[1].split())
        lookup = sequence.replace("\ufe0f", "")
        chinese = zh.get((lookup, "tts"), {})
        english = en.get((lookup, "tts"), {})
        name_en = english.get("value") or match[3]
        name = chinese.get("value") or name_en
        keywords = list(
            dict.fromkeys(
                term.strip()
                for term in (
                    [name, name_en]
                    + zh.get((lookup, "keywords"), {}).get("value", "").split("|")
                    + en.get((lookup, "keywords"), {}).get("value", "").split("|")
                )
                if term.strip()
            )
        )
        skeleton = "".join(
            char for char in sequence if not 0x1F3FB <= ord(char) <= 0x1F3FF and char != "\ufe0f"
        )
        entries.append(
            {
                "id": key(sequence),
                "sequence": sequence,
                "name": name,
                "english": name_en,
                "keywords": keywords,
                "group": group,
                "subgroup": subgroup,
                "emojiVersion": match[2],
                "variantGroup": key(skeleton),
                "tones": [
                    ord(char) - 0x1F3FA for char in sequence if 0x1F3FB <= ord(char) <= 0x1F3FF
                ],
                "annotationDraft": chinese.get("draft"),
            }
        )
    ids = {row["id"] for row in entries}
    if len(ids) != len(entries) or not entries:
        raise ValueError("Emoji data must be complete and unique")
    data = {
        "unicodeVersion": manifest["unicode"],
        "emojiVersion": manifest["emoji"],
        "cldrVersion": manifest["cldr"],
        "license": "Unicode-3.0",
        "groups": [{"id": group, "label": label} for group, label in GROUPS.items()],
        "entries": entries,
    }
    backend = {
        "version": manifest["emoji"],
        "keys": {row["id"]: row["sequence"] for row in entries},
    }
    return {
        ROOT / "apps/web/src/data/emoji.json": data,
        ROOT / "src/tongpin/data/emoji.json": backend,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="Verify generated files, without writing"
    )
    args = parser.parse_args()
    outputs = generate()
    for path, value in outputs.items():
        rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != rendered:
                raise SystemExit(f"Generated emoji data differs: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(rendered, encoding="utf-8", newline="\n")
    print(
        json.dumps({"entries": len(next(iter(outputs.values()))["entries"]), "check": args.check})
    )


if __name__ == "__main__":
    main()
