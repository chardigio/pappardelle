"""Keeps every hook test off the developer's own state: each test runs with
a home directory of its own, so the database and the status socket the hooks
find by default are under it and do not exist unless the test asks for the
`state_db` or `status_socket` fixture."""

import json
import shutil
import socket
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def migrated_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """An empty database with the current schema, created by its owner."""
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun is not installed")
    assert bun is not None  # pytest.skip ends the test, but mypy cannot see that here
    db = tmp_path_factory.mktemp("state-db") / "state.db"
    subprocess.run(
        [bun, str(REPO_ROOT / "source" / "state-cli.ts"), "migrate", str(db)],
        check=True,
        cwd=REPO_ROOT,
    )
    return db


def record_space(
    db: Path,
    repo: str,
    key: str,
    worktree_path: str,
    agent_session: str = "",
    tmux_socket: str = "pappardelle_inner",
) -> None:
    """An open space's identity as prepare-space records it (source/space-identity-sqlite.ts)."""
    import sqlite3

    connection = sqlite3.connect(db)
    try:
        connection.execute(
            """INSERT INTO space_identities
            (repo, key, worktree_path, tmux_socket, agent_session, companion_session)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (repo, key, worktree_path, tmux_socket, agent_session or f"agent-{repo}-{key}", f"companion-{repo}-{key}"),
        )
        if key != "main":
            connection.execute("INSERT INTO spaces (repo, key, state) VALUES (?, ?, 'open')", (repo, key))
        connection.commit()
    finally:
        connection.close()


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("PAPPARDELLE_STATE_DB", raising=False)
    monkeypatch.delenv("PAPPARDELLE_STATUS_SOCKET", raising=False)
    return home


@pytest.fixture
def state_db(migrated_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fresh database that the hooks under test write to."""
    db = tmp_path / "state.db"
    shutil.copy(migrated_db, db)
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
    """The socket a hook under test sends its status to."""
    listening = StatusSocket(short_tmp_path / "status-1.sock")
    monkeypatch.setenv("PAPPARDELLE_STATUS_SOCKET", str(listening.path))
    yield listening
    listening.close()


@pytest.fixture
def read_status(status_socket: StatusSocket) -> Callable[[str], Optional[dict[str, Any]]]:
    """The status the hook last sent under a status key, or None."""

    def last_sent(status_key: str) -> Optional[dict[str, Any]]:
        sent = [message["state"] for message in status_socket.messages()]
        return next((state for state in reversed(sent) if state["workspaceName"] == status_key), None)

    return last_sent
