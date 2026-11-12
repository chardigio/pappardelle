"""Runs the hook tests against files alone, or with experimental.sqliteState on:
files and SQLite, and status sent to a status socket.

PAPPARDELLE_SQLITE_STATE=1 in the environment selects the second. Either way
no test reads the developer's own flag, touches their database or reaches
their status daemon.
"""

import json
import os
import shutil
import socket
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, Optional

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


class StatusSocket:
    """A listening socket where the status daemon's would be."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._listener.bind(str(path))
        self._listener.listen()
        self._listener.setblocking(False)
        self._received: list[dict[str, Any]] = []

    def messages(self) -> list[dict[str, Any]]:
        """Every line sent so far, by connections that have closed."""
        while True:
            try:
                connection, _ = self._listener.accept()
            except BlockingIOError:
                return self._received
            # Whether an accepted socket blocks is the listener's choice on
            # some systems, and this listener does not block.
            connection.setblocking(True)
            with connection, connection.makefile() as lines:
                self._received.extend(json.loads(line) for line in lines)

    def close(self) -> None:
        """Stop listening, as when no daemon runs."""
        self._listener.close()
        self.path.unlink(missing_ok=True)


@pytest.fixture
def short_tmp_path() -> Iterator[Path]:
    """A directory for a Unix socket, whose path is limited to about 104 bytes."""
    directory = Path(tempfile.mkdtemp(prefix="papp-"))
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def status_socket(short_tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[StatusSocket]:
    """The socket a hook under test sends its status to while the flag is on."""
    listening = StatusSocket(short_tmp_path / "status-1.sock")
    monkeypatch.setenv("PAPPARDELLE_STATUS_SOCKET", str(listening.path))
    yield listening
    listening.close()


@pytest.fixture
def read_status(request: pytest.FixtureRequest) -> Callable[[Path, str], Optional[dict[str, Any]]]:
    """Reads what the hook last reported under a status key, where this run's
    mode puts it: the status file in the given directory, or with the flag on
    the last line sent to the status socket."""
    if not SQLITE_RUN:

        def from_file(status_dir: Path, status_key: str) -> Optional[dict[str, Any]]:
            file = status_dir / f"{status_key}.json"
            return json.loads(file.read_text()) if file.exists() else None

        return from_file

    listening: StatusSocket = request.getfixturevalue("status_socket")

    def from_socket(_status_dir: Path, status_key: str) -> Optional[dict[str, Any]]:
        sent = [message["state"] for message in listening.messages()]
        return next((state for state in reversed(sent) if state["workspaceName"] == status_key), None)

    return from_socket


@pytest.fixture(autouse=True)
def _state_mode(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PAPPARDELLE_STATUS_SOCKET", raising=False)
    if SQLITE_RUN:
        request.getfixturevalue("state_db")
    elif "state_db" not in request.fixturenames:
        monkeypatch.setenv("PAPPARDELLE_SQLITE_STATE", "0")
