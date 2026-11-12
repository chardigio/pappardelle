"""The hooks' side of the status daemon (source/status-daemon.ts).

With experimental.sqliteState on, a hook reports its status to the daemon,
which keeps it in memory and pushes it to the rails. Nothing is written to
disk.
"""

import json
from typing import Any

# A hook runs inside the agent's turn. A daemon that is there accepts at once,
# so a longer wait would only delay the agent when the daemon is stopped.
CONNECT_TIMEOUT_SECONDS = 0.05


def send_status(path: str, state: dict[str, Any]) -> bool:
    """Send one hook event to the daemon. True when the line was sent.

    Nothing listening is the normal case while Pappardelle is not running, so
    a failure is neither raised nor logged.
    """
    connection = None
    try:
        # Imported here so a hook pays for it only while the flag is on.
        import socket

        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(CONNECT_TIMEOUT_SECONDS)
        connection.connect(path)
        connection.sendall((json.dumps({"type": "hook", "state": state}) + "\n").encode())
        return True
    except (ImportError, OSError, ValueError):
        return False
    finally:
        if connection is not None:
            connection.close()
