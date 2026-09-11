from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tongpin.config import Settings
from tongpin.infra.db import Database


def pytest_configure(config):
    root = Path(__file__).resolve().parents[1]
    if config.option.basetemp is None:
        config.option.basetemp = str(root / ".codex/tmp" / ("pytest-" + uuid.uuid4().hex[:12]))
    Path(config.option.basetemp).resolve().parent.mkdir(parents=True, exist_ok=True)


@pytest.fixture
def database(tmp_path):
    database = Database(tmp_path / "test.sqlite3")
    database.migrate()
    return database


@pytest.fixture
def settings(tmp_path):
    return Settings(
        data_root=tmp_path / "data", environment="test", secret="test-secret-isolated-" * 3
    )
