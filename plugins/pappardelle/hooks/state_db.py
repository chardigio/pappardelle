"""The hooks' side of Pappardelle's SQLite state.

A hook writes its rows to the database. The schema belongs to the TypeScript
side (source/state-db.ts): nothing here creates the database or a table, and
a hook that cannot use the database logs that and records nothing.

Status is the exception: it goes to the status daemon (status_socket.py) and
is stored nowhere.
"""

import os
import time
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping, NamedTuple, Optional, Sequence

# A hook runs inside the agent's turn, so it gives up on a busy database
# quickly.
BUSY_TIMEOUT_SECONDS = 0.1
LOG_INTERVAL_SECONDS = 60

Statements = Sequence[tuple[str, Sequence[Any]]]

# MAIN_WORKTREE_KEY in source/space-utils.ts.
MAIN_KEY = "main"


def state_dir() -> Path:
    return Path.home() / ".pappardelle"


def state_db_path(environ: Mapping[str, str] = os.environ) -> str:
    """The database, where stateDbPath (source/state-db.ts) puts it."""
    return environ.get("PAPPARDELLE_STATE_DB") or str(state_dir() / "state.db")


# The number is the protocol's (STATUS_SOCKET_NAME in source/state-db.ts).
STATUS_SOCKET_NAME = "status-1.sock"


def status_socket_path(environ: Mapping[str, str] = os.environ) -> str:
    """The status daemon's socket.

    It is beside the database unless PAPPARDELLE_STATUS_SOCKET names another
    place, so whatever moves the database moves the daemon with it, as in
    statusSocketPath (source/state-db.ts).
    """
    return environ.get("PAPPARDELLE_STATUS_SOCKET") or os.path.join(
        os.path.dirname(state_db_path(environ)), STATUS_SOCKET_NAME
    )


def _log_failure(message: str) -> None:
    """Log a failed database read or write, at most once a minute across all hooks.

    Some failures last until the user changes something (a Python whose
    SQLite cannot read the schema, a database that was removed), and every
    hook event of every agent meets them.
    """
    try:
        log_dir = state_dir() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = log_dir / "state-db-failure.stamp"
        try:
            if time.time() - stamp.stat().st_mtime < LOG_INTERVAL_SECONDS:
                return
        except FileNotFoundError:
            pass
        stamp.touch()
        with open(log_dir / "hook-events.log", "a") as f:
            f.write(f"[{datetime.now().isoformat()}] {message}\n")
    except OSError:
        pass


class WriteOutcome(Enum):
    COMMITTED = "committed"
    NOTHING_TO_WRITE = "nothing to write"
    # Logged under the write's label.
    FAILED = "failed"


def write_rows(db_path: str, label: str, statements: Callable[[Any], Statements]) -> WriteOutcome:
    """Run one write transaction. `statements` gets the open connection, to
    read what the rows hold under the write lock, and returns the statements
    to run, none when nothing needs to change.
    """
    try:
        # Imported here so a hook that writes nothing never pays for it.
        import sqlite3
    except ImportError as error:
        # Python can be built without SQLite.
        _log_failure(f"State database write failed for {label}: {error}")
        return WriteOutcome.FAILED

    connection = None
    try:
        # mode=rw: a missing database is the TypeScript side's to create.
        connection = sqlite3.connect(
            f"file:{_uri_path(db_path)}?mode=rw",
            uri=True,
            timeout=BUSY_TIMEOUT_SECONDS,
            isolation_level=None,
        )
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("BEGIN IMMEDIATE")
        changes = statements(connection)
        if not changes:
            # Nothing changed, so no TUI has anything to read again.
            connection.execute("ROLLBACK")
            return WriteOutcome.NOTHING_TO_WRITE
        for sql, parameters in changes:
            connection.execute(sql, parameters)
        connection.execute("COMMIT")
        _ring_bell(db_path)
        return WriteOutcome.COMMITTED
    except sqlite3.Error as error:
        _log_failure(f"State database write failed for {label}: {error}")
        if connection is not None and connection.in_transaction:
            connection.execute("ROLLBACK")
        return WriteOutcome.FAILED
    finally:
        if connection is not None:
            connection.close()


def _uri_path(path: str) -> str:
    """Escape the characters that end the path part of a SQLite URI.

    urllib.parse would do it, at about 2 ms of import on every hook event.
    """
    return path.replace("%", "%25").replace("?", "%3f").replace("#", "%23")


def _ring_bell(db_path: str) -> None:
    """Tell watching TUIs the database changed (source/state-db-watch.ts)."""
    try:
        with open(f"{db_path}.bell", "w") as f:
            f.write(f"{int(time.time() * 1000)}\n")
    except OSError:
        pass


class SpaceRow(NamedTuple):
    """A space's stored identity (space_identities in source/state-db.ts)."""

    repo: str
    key: str
    worktree_path: str
    agent_session: str


class LaunchedAgent(NamedTuple):
    """The agent profile a space's agent session was last started with."""

    profile: str
    is_claude: bool


class SessionEntry(NamedTuple):
    """The session recorded for one agent profile of a space (agent_sessions
    in source/state-db.ts)."""

    session_id: str
    pid: Optional[int]
    started: Optional[str]


def _read(sql: str, parameters: Sequence[Any] = ()) -> Optional[list[Any]]:
    """The rows a query returns, or None when the database cannot be read."""
    try:
        import sqlite3
    except ImportError as error:
        _log_failure(f"State database read failed: {error}")
        return None
    try:
        connection = sqlite3.connect(
            f"file:{_uri_path(state_db_path())}?mode=ro",
            uri=True,
            timeout=BUSY_TIMEOUT_SECONDS,
        )
        try:
            return connection.execute(sql, parameters).fetchall()
        finally:
            connection.close()
    except sqlite3.Error as error:
        _log_failure(f"State database read failed: {error}")
        return None


def space_at_path(cwd: str) -> Optional[SpaceRow]:
    """The open space or main whose stored worktree is cwd or its nearest
    ancestor, as identityAt in source/space-identity.ts.

    Both sides go through realpath, so a directory reached through a symlink
    belongs to the same space. A path inside a git checkout nested in that
    worktree (an agent's worktree under the main checkout) belongs to none.
    None when no space holds cwd, or when the database cannot be read.
    """
    # Closed rows are kept forever, and a closed space holds no caller.
    rows = _read(
        """SELECT i.repo, i.key, i.worktree_path, i.agent_session
        FROM space_identities i
        WHERE i.key = ? OR EXISTS (
            SELECT 1 FROM spaces s WHERE s.repo = i.repo AND s.key = i.key)""",
        (MAIN_KEY,),
    )
    if rows is None:
        return None
    roots: dict[str, SpaceRow] = {}
    for row in rows:
        roots.setdefault(os.path.realpath(row[2]), SpaceRow(*row))
    directory = os.path.realpath(cwd)
    while True:
        if directory in roots:
            return roots[directory]
        if os.path.lexists(os.path.join(directory, ".git")):
            return None
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def agent_session_name(repo: str, key: str) -> Optional[str]:
    """The name of a space's agent session, as it was stored when the space was created."""
    rows = _read("SELECT agent_session FROM space_identities WHERE repo = ? AND key = ?", (repo, key))
    return rows[0][0] if rows else None


def launched_agent(repo: str, key: str) -> Optional[LaunchedAgent]:
    """The agent profile a space's agent session was last started with, and
    whether it is a claude one (SpaceState.agentProfile in source/space-state.ts)."""
    rows = _read(
        """SELECT agent_profile, agent_is_claude FROM space_state
        WHERE repo = ? AND key = ? AND agent_profile IS NOT NULL""",
        (repo, key),
    )
    return LaunchedAgent(rows[0][0], rows[0][1] == 1) if rows else None


_SESSION_ENTRY = """SELECT session_id, pid, started FROM agent_sessions
    WHERE repo = ? AND key = ? AND agent_profile = ?"""


def agent_session_entry(repo: str, key: str, agent_profile: str) -> Optional[SessionEntry]:
    """The session recorded for one agent profile of a space, or None."""
    rows = _read(_SESSION_ENTRY, (repo, key, agent_profile))
    return SessionEntry(*rows[0]) if rows else None


def agent_session_row(connection: Any, repo: str, key: str, agent_profile: str) -> Optional[SessionEntry]:
    """`agent_session_entry` on a connection inside its write transaction."""
    row = connection.execute(_SESSION_ENTRY, (repo, key, agent_profile)).fetchone()
    return SessionEntry(*row) if row else None
