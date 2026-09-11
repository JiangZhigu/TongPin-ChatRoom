from __future__ import annotations

import json
import runpy
from pathlib import Path

import pytest

from tongpin.contracts.base import APIError
from tongpin.domain.emoji import emoji_keys, require_emoji

ROOT = Path(__file__).resolve().parents[1]


def test_offline_pinned_generator_matches_both_shipped_files_byte_for_byte():
    builder = runpy.run_path(str(ROOT / "scripts/build_emoji.py"))
    for path, value in builder["generate"]().items():
        expected = json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
        assert path.read_bytes() == expected.encode("utf-8")


def test_all_fully_qualified_entries_have_chinese_search_annotations_and_real_variants():
    data = json.loads((ROOT / "apps/web/src/data/emoji.json").read_text(encoding="utf-8"))
    assert (data["unicodeVersion"], data["emojiVersion"], data["cldrVersion"]) == (
        "17.0.0",
        "17.0",
        "48.2",
    )
    entries = data["entries"]
    assert len(entries) == len({row["id"] for row in entries}) == 3944
    assert len(data["groups"]) == 9
    builder = runpy.run_path(str(ROOT / "scripts/build_emoji.py"))
    chinese = builder["annotations"]("zh")
    assert all(
        row["name"] == chinese[(row["sequence"].replace("\ufe0f", ""), "tts")]["value"]
        and row["name"] in row["keywords"]
        for row in entries
    )
    assert {row["id"]: row["sequence"] for row in entries} == emoji_keys()
    for row in entries:
        assert row["id"] == "-".join(f"{ord(char):X}" for char in row["sequence"])
        assert row["tones"] == [
            ord(char) - 0x1F3FA for char in row["sequence"] if 0x1F3FB <= ord(char) <= 0x1F3FF
        ]
    assert max(len(row["sequence"]) for row in entries) >= 10
    assert any(len(row["tones"]) == 2 and row["tones"][0] != row["tones"][1] for row in entries)
    assert any(row["annotationDraft"] == "contributed" for row in entries)


@pytest.mark.parametrize(
    "key,sequence",
    [
        ("1F469-1F3FD-200D-1F4BB", "👩🏽‍💻"),
        ("31-FE0F-20E3", "1️⃣"),
        ("1F1E8-1F1F3", "🇨🇳"),
        ("2764-FE0F", "❤️"),
    ],
)
def test_whitelist_preserves_joiners_variation_selectors_and_flags(key, sequence):
    assert require_emoji(key) == sequence


@pytest.mark.parametrize("key", ["1F3FD", "1F600-1F3FD", "31-20E3", "2764", "1f600", "arbitrary"])
def test_unqualified_components_and_fabricated_modifiers_are_rejected(key):
    with pytest.raises(APIError) as caught:
        require_emoji(key)
    assert caught.value.code == "VALIDATION_ERROR"
