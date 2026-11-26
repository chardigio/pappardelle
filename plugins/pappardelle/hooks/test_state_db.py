"""Tests for the hooks' state database writes (state_db.py)."""

import os
import sqlite3
import sys
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


COMMITTED = state_db.WriteOutcome.COMMITTED
FAILED = state_db.WriteOutcome.FAILED


def write_note(db: Path, body: str) -> state_db.WriteOutcome:
    return state_db.write_rows(
        str(db), "the note", lambda _connection: [("INSERT OR REPLACE INTO notes VALUES (?, ?)", ("a", body))]
    )


def rows(db: Path, sql: str) -> list[tuple]:
    connection = sqlite3.connect(db)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def hook_log() -> str:
    return (Path.home() / ".pappardelle" / "logs" / "hook-events.log").read_text()


def test_writes_its_rows_and_rings_the_bell(notes_db: Path):
    assert write_note(notes_db, "one") is COMMITTED

    assert rows(notes_db, "SELECT name, body FROM notes") == [("a", "one")]
    assert Path(f"{notes_db}.bell").exists()


def test_the_statements_are_built_from_what_the_rows_hold_inside_the_transaction(notes_db: Path):
    write_note(notes_db, "one")

    def append(connection: sqlite3.Connection):
        (body,) = connection.execute("SELECT body FROM notes WHERE name = 'a'").fetchone()
        return [("UPDATE notes SET body = ? WHERE name = 'a'", (body + " two",))]

    assert state_db.write_rows(str(notes_db), "the note", append) is COMMITTED
    assert rows(notes_db, "SELECT body FROM notes") == [("one two",)]


def test_no_statements_commit_nothing_and_ring_no_bell(notes_db: Path):
    outcome = state_db.write_rows(str(notes_db), "the note", lambda _connection: [])

    assert outcome is state_db.WriteOutcome.NOTHING_TO_WRITE
    assert not Path(f"{notes_db}.bell").exists()


def test_a_missing_database_is_not_created_and_the_failure_is_logged(tmp_path: Path):
    db = tmp_path / "absent.db"

    assert write_note(db, "one") is FAILED

    assert not db.exists()
    assert "State database write failed for the note" in hook_log()


def test_a_locked_database_costs_a_fraction_of_a_second(notes_db: Path):
    holder = sqlite3.connect(notes_db, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    try:
        started = time.monotonic()
        outcome = write_note(notes_db, "one")
        elapsed = time.monotonic() - started
    finally:
        holder.execute("ROLLBACK")
        holder.close()

    assert outcome is FAILED
    assert elapsed < 1.0
    assert rows(notes_db, "SELECT * FROM notes") == []
    assert "State database write failed for the note" in hook_log()


def test_a_python_without_sqlite_writes_nothing_and_logs_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # What `import sqlite3` meets in a Python built without the _sqlite3 module.
    monkeypatch.setitem(sys.modules, "sqlite3", None)

    assert write_note(tmp_path / "state.db", "one") is FAILED

    assert "State database write failed for the note" in hook_log()


def test_a_failure_that_repeats_is_logged_once_a_minute(tmp_path: Path):
    logs = Path.home() / ".pappardelle" / "logs"

    def lines() -> list[str]:
        return (logs / "hook-events.log").read_text().splitlines()

    for body in ("one", "two", "three"):
        write_note(tmp_path / "absent.db", body)
    assert len(lines()) == 1

    (stamp,) = [entry for entry in logs.iterdir() if entry.name != "hook-events.log"]
    a_minute_ago = time.time() - state_db.LOG_INTERVAL_SECONDS - 1
    os.utime(stamp, (a_minute_ago, a_minute_ago))
    write_note(tmp_path / "absent.db", "four")
    assert len(lines()) == 2


def test_a_database_path_with_uri_characters_is_opened(state_db: Path, tmp_path: Path):
    odd = tmp_path / "50% done? #1"
    odd.mkdir()
    db = odd / "state.db"
    db.write_bytes(state_db.read_bytes())
    connection = sqlite3.connect(db)
    connection.execute("CREATE TABLE notes (name TEXT PRIMARY KEY, body TEXT) STRICT")
    connection.commit()
    connection.close()

    assert write_note(db, "one") is COMMITTED
    assert rows(db, "SELECT name, body FROM notes") == [("a", "one")]
