"""A persistent agent and its real hook processes, for launcher regression checks."""

import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


mode, root, kind = sys.argv[1:4]
is_claude = kind == "true"

if mode == "hook":
    spec = importlib.util.spec_from_file_location(
        "agent_session", Path(__file__).parents[1] / "hooks" / "agent_session.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    print(json.dumps(module.record_agent_session(json.load(sys.stdin), is_claude)))
    sys.exit(0)


def record(session_id):
    command = shlex.join([sys.executable, __file__, "hook", root, kind])
    result = subprocess.run(
        ["/bin/sh", "-c", command],
        input=json.dumps({"session_id": session_id, "hook_event_name": "SessionStart"}),
        text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


if mode == "nested":
    print(json.dumps(record("nested")))
    sys.exit(0)

primary = record("primary")
command = shlex.join([sys.executable, __file__, "nested", root, kind])
nested = subprocess.run(
    ["/bin/sh", "-c", command + "; :"], text=True, capture_output=True, check=True,
)
Path(root, "recording.json").write_text(json.dumps({
    "primary": primary,
    "nested": json.loads(nested.stdout),
    "sessions": json.loads(Path(os.environ["PAPPARDELLE_AGENT_SESSIONS"]).read_text()),
}))
sys.stdout.write("\x1b]7501;state=idle:app=fixture\x07")
sys.stdout.flush()
sys.stdin.readline()
