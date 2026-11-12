"""Runs the hook tests against files alone, or against files and SQLite.

PAPPARDELLE_SQLITE_STATE=1 in the environment selects the second. Either way
no test reads the developer's own flag or touches their database.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SQLITE_RUN = os.environ.get("PAPPARDELLE_SQLITE_STATE") == "1"


@pytest.fixture(scope="session")
def migrated_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """An empty database with the current schema, created by its owner."""
    bun = shutil.which("bun")
    if bun is None:
        if SQLITE_RUN:
            pytest.fail("PAPPARDELLE_SQLITE_STATE=1 needs bun to create the state database")
        pytest.skip("bun is not installed")
    db = tmp_path_factory.mktemp("state-db") / "state.db"
    subprocess.run(
        [bun, str(REPO_ROOT / "source" / "state-cli.ts"), "migrate", str(db)],
        check=True,
        cwd=REPO_ROOT,
    )
    return db


@pytest.fixture
def state_db(migrated_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fresh database that the hooks under test write to."""
    db = tmp_path / "state.db"
    shutil.copy(migrated_db, db)
    monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "1")
    monkeypatch.setenv("PAPPARDELLE_STATE_DB", str(db))
    return db


@pytest.fixture(autouse=True)
def _state_mode(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    if SQLITE_RUN:
        request.getfixturevalue("state_db")
    elif "state_db" not in request.fixturenames:
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")
