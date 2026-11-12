"""The hooks' side of Pappardelle's experimental.sqliteState.

With the flag on, a hook that writes a state file also writes its rows to the
SQLite database, in one transaction, so readers of either see the same thing.
The schema belongs to the TypeScript side (source/state-db.ts): nothing here
creates the database or a table, and a hook that cannot use the database
still writes its file.

Status is the exception: with the flag on it goes to the status daemon
(status_socket.py) and is stored nowhere.
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence, Union

# A hook runs inside the agent's turn, so it gives up on a busy database
# quickly. The file it still writes is imported by the next reader.
BUSY_TIMEOUT_SECONDS = 0.1
LOG_INTERVAL_SECONDS = 60

Statements = Sequence[tuple[str, Sequence[Any]]]


def _state_dir() -> Path:
    return Path.home() / ".pappardelle"


def _recorded_flag() -> dict[str, Any]:
    """What the CLI last read from the home config (source/state-flag.ts)."""
    try:
        with open(_state_dir() / "state-flag.json") as f:
            recorded = json.load(f)
        return recorded if isinstance(recorded, dict) else {}
    except (OSError, ValueError):
        return {}


def state_db_path(environ: Mapping[str, str] = os.environ) -> Optional[str]:
    """The database to write to, or None while the flag is off."""
    override = environ.get("PAPPARDELLE_SQLITE_STATE")
    recorded = _recorded_flag()
    if override == "0":
        return None
    if override != "1" and recorded.get("sqliteState") is not True:
        return None
    return (
        environ.get("PAPPARDELLE_STATE_DB")
        or recorded.get("db")
        or str(_state_dir() / "state.db")
    )


# The number is the protocol's (STATUS_SOCKET_NAME in source/state-db.ts).
STATUS_SOCKET_NAME = "status-1.sock"


def status_socket_path(environ: Mapping[str, str] = os.environ) -> Optional[str]:
    """The status daemon's socket, or None while the flag is off.

    It is beside the database unless PAPPARDELLE_STATUS_SOCKET names another
    place, so whatever moves the database moves the daemon with it, as in
    statusSocketPath (source/state-db.ts).
    """
    db_path = state_db_path(environ)
    if db_path is None:
        return None
    return environ.get("PAPPARDELLE_STATUS_SOCKET") or os.path.join(os.path.dirname(db_path), STATUS_SOCKET_NAME)


def _log_failure(message: str) -> None:
    """Log a failed database write, at most once a minute across all hooks.

    Some failures last until the user changes something (a Python whose
    SQLite cannot read the schema, a database that was removed), and every
    hook event of every agent meets them.
    """
    try:
        log_dir = _state_dir() / "logs"
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


def write_through(
    db_path: str,
    file_path: Path,
    write_file: Callable[[], Optional[os.stat_result]],
    statements: Union[Statements, Callable[[], Statements]],
) -> None:
    """Write a state file and the rows that mirror it.

    `write_file` replaces the file and returns the stat of what it wrote,
    taken before the rename so it cannot be another writer's. It runs inside
    the write transaction, which keeps the order of files the same as the
    order of commits across processes, and lets it read the file it replaces
    without another writer changing it in between. It returns None when it
    decided to leave the file alone, and then no rows change either.
    `statements` may be a function, asked once the file is written, for rows
    that depend on what was written. If the database cannot be used, the file
    is written alone.
    """
    try:
        # Imported here so a hook pays for it only while the flag is on.
        import sqlite3
    except ImportError as error:
        # Python can be built without SQLite.
        _log_failure(f"State database write failed for {file_path}: {error}")
        write_file()
        return

    wrote = False
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
        written = write_file()
        wrote = True
        if written is None:
            connection.execute("ROLLBACK")
            return
        for sql, parameters in statements() if callable(statements) else statements:
            connection.execute(sql, parameters)
        connection.execute(
            """INSERT INTO json_sync (path, ino, size, mtime_ns, malformed)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (path) DO UPDATE SET ino = excluded.ino,
                size = excluded.size, mtime_ns = excluded.mtime_ns,
                malformed = 0""",
            (
                os.path.abspath(file_path),
                str(written.st_ino),
                written.st_size,
                str(written.st_mtime_ns),
            ),
        )
        connection.execute("COMMIT")
        _ring_bell(db_path)
    except sqlite3.Error as error:
        _log_failure(f"State database write failed for {file_path}: {error}")
        if connection is not None and connection.in_transaction:
            connection.execute("ROLLBACK")
        if not wrote:
            write_file()
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
