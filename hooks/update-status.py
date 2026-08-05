#!/usr/bin/env python3
"""
Backwards-compatibility shim for the pre-STA-1850 hook name.

Status normalization now lives in ``update-agent-status.py``, which every
harness's hooks invoke with an explicit ``--agent``. This file stays because a
user's ``~/.claude/settings.json`` references the *old* path by name: deleting
it outright would silently stop status reporting for anyone who upgrades
Pappardelle without re-running ``hooks/install.sh``.

It forwards to the real normalizer as ``--agent claude``, which is what the old
Claude-only hook effectively was. Re-run ``hooks/install.sh`` to move your
settings onto the new name; this shim can be dropped a release or two later.
"""

import runpy
import sys
from pathlib import Path

TARGET = Path(__file__).parent / "update-agent-status.py"


def main() -> None:
    if not TARGET.exists():
        # Nothing to forward to — stay silent rather than breaking the agent.
        sys.exit(0)

    # Preserve any flags the caller passed (e.g. --tool) and pin the agent.
    if any(arg == "--agent" or arg.startswith("--agent=") for arg in sys.argv[1:]):
        sys.argv = [str(TARGET), *sys.argv[1:]]
    else:
        sys.argv = [str(TARGET), "--agent", "claude", *sys.argv[1:]]

    runpy.run_path(str(TARGET), run_name="__main__")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # Never let hook failures propagate to the agent.
        sys.exit(0)
