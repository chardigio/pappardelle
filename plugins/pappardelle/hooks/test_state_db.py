"""Tests for the hooks' state database writes (state_db.py)."""

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest
import state_db


@pytest.fixture
def notes_db(state_db: Path) -> Path:
    connection = sqlite3.connect(state_db)
    connection.execute("CREATE TABLE notes (name TEXT PRIMARY KEY, body TEXT) STRICT")
    connection.commit()
    connection.close()
    return state_db


def write_note(db: Path, file: Path, body: str) -> None:
    def write_file() -> os.stat_result:
        temporary = file.with_suffix(".tmp")
        temporary.write_text(json.dumps({"a": body}))
        written = os.stat(temporary)
        os.replace(temporary, file)
        return written

    state_db.write_through(
        str(db),
        file,
        write_file,
        [("INSERT OR REPLACE INTO notes VALUES (?, ?)", ("a", body))],
    )


def rows(db: Path, sql: str) -> list[tuple]:
    connection = sqlite3.connect(db)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def test_writes_the_file_its_rows_and_the_files_signature(notes_db: Path, tmp_path: Path):
    file = tmp_path / "notes.json"
    write_note(notes_db, file, "one")

    assert json.loads(file.read_text()) == {"a": "one"}
    assert rows(notes_db, "SELECT name, body FROM notes") == [("a", "one")]
    stat = os.stat(file)
    assert rows(notes_db, "SELECT path, ino, size, mtime_ns, malformed FROM json_sync") == [
        (str(file), str(stat.st_ino), stat.st_size, str(stat.st_mtime_ns), 0)
    ]
    assert Path(f"{notes_db}.bell").exists()


def test_a_missing_database_is_not_created_and_the_file_is_still_written(tmp_path: Path):
    db = tmp_path / "absent.db"
    file = tmp_path / "notes.json"
    write_note(db, file, "one")

    assert json.loads(file.read_text()) == {"a": "one"}
    assert not db.exists()


def test_a_locked_database_costs_a_fraction_of_a_second_and_keeps_the_file(
    notes_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # The failure is logged under the home directory.
    monkeypatch.setenv("HOME", str(tmp_path))
    file = tmp_path / "notes.json"
    holder = sqlite3.connect(notes_db, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    try:
        started = time.monotonic()
        write_note(notes_db, file, "one")
        elapsed = time.monotonic() - started
    finally:
        holder.execute("ROLLBACK")
        holder.close()

    assert json.loads(file.read_text()) == {"a": "one"}
    assert elapsed < 1.0
    assert rows(notes_db, "SELECT * FROM notes") == []
    log = (tmp_path / ".pappardelle" / "logs" / "hook-events.log").read_text()
    assert "State database write failed" in log and str(file) in log


def test_the_flag_comes_from_the_override_then_the_recorded_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert state_db.state_db_path({}) is None

    (tmp_path / ".pappardelle").mkdir()
    (tmp_path / ".pappardelle" / "state-flag.json").write_text(
        json.dumps({"sqliteState": True, "db": "/recorded/state.db"})
    )
    assert state_db.state_db_path({}) == "/recorded/state.db"
    assert state_db.state_db_path({"PAPPARDELLE_SQLITE_STATE": "0"}) is None
    assert state_db.state_db_path({"PAPPARDELLE_STATE_DB": "/env/state.db"}) == "/env/state.db"

    (tmp_path / ".pappardelle" / "state-flag.json").write_text(
        json.dumps({"sqliteState": False, "db": "/recorded/state.db"})
    )
    assert state_db.state_db_path({}) is None
    assert state_db.state_db_path({"PAPPARDELLE_SQLITE_STATE": "1"}) == "/recorded/state.db"


def test_a_database_path_with_uri_characters_is_opened(state_db: Path, tmp_path: Path):
    odd = tmp_path / "50% done? #1"
    odd.mkdir()
    db = odd / "state.db"
    db.write_bytes(state_db.read_bytes())
    connection = sqlite3.connect(db)
    connection.execute("CREATE TABLE notes (name TEXT PRIMARY KEY, body TEXT) STRICT")
    connection.commit()
    connection.close()

    write_note(db, tmp_path / "notes.json", "one")
    assert rows(db, "SELECT name, body FROM notes") == [("a", "one")]
