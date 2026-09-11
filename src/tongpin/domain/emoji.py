from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from tongpin.contracts.base import APIError


@lru_cache(maxsize=1)
def emoji_keys():
    source = Path(__file__).resolve().parents[1] / "data/emoji.json"
    return json.loads(source.read_text(encoding="utf-8"))["keys"]


def require_emoji(key):
    value = emoji_keys().get(key)
    if not value:
        raise APIError("VALIDATION_ERROR", "请选择列表中的完整表情。", 422)
    return value
