import json
import os
import subprocess
from pathlib import Path

HOOKS_DIR = Path(__file__).parent
AGY_INSTALLER = HOOKS_DIR / "install-agy-hooks.sh"


def run_agy_installer(home: Path) -> str:
    return subprocess.run(
        ["bash", str(AGY_INSTALLER)], env={**os.environ, "HOME": str(home)}, capture_output=True, text=True, check=True
    ).stdout


def test_agy_installer_keeps_other_named_hooks_and_is_idempotent(tmp_path: Path):
    hooks_json = tmp_path / ".gemini" / "config" / "hooks.json"
    hooks_json.parent.mkdir(parents=True)
    other = {"lint": {"PostToolUse": [{"matcher": "*", "hooks": [{"command": "lint.sh"}]}]}}
    hooks_json.write_text(json.dumps(other))

    run_agy_installer(tmp_path)
    merged = json.loads(hooks_json.read_text())
    assert merged["lint"] == other["lint"]
    assert set(merged["pappardelle-session"]) == {"SessionStart", "PreInvocation"}

    assert "already" in run_agy_installer(tmp_path)
    assert json.loads(hooks_json.read_text()) == merged


def test_agy_installer_skips_without_agy_config(tmp_path: Path):
    assert "not set up" in run_agy_installer(tmp_path)
    assert not (tmp_path / ".gemini").exists()
