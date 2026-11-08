"""The installer copies files by name, so a new sibling import is silent until a
hook dies at runtime on a machine installed through hooks/install.sh."""

import json
import os
import re
import subprocess
from pathlib import Path

HOOKS_DIR = Path(__file__).parent
INSTALL_SH = (HOOKS_DIR / "install.sh").read_text()

SIBLING_IMPORT = re.compile(r'spec_from_file_location\(\s*"[^"]+",\s*(\w+)')
SIBLING_PATH = re.compile(r'^(\w+)\s*=\s*[^\n]*/\s*"([\w.-]+\.py)"', re.MULTILINE)


def sibling_modules(source: str) -> set[str]:
    paths = dict(SIBLING_PATH.findall(source))
    return {paths[var] for var in SIBLING_IMPORT.findall(source) if var in paths}


def test_installer_copies_every_sibling_module_the_hooks_import():
    entrypoints = [p for p in HOOKS_DIR.glob("*.py") if not p.name.startswith("test_") and "-" in p.name]
    assert entrypoints, "no hook entrypoints found"

    missing = {
        (entrypoint.name, module)
        for entrypoint in entrypoints
        for module in sibling_modules(entrypoint.read_text())
        if module not in INSTALL_SH
    }
    assert not missing, f"install.sh does not copy: {sorted(missing)}"


def test_sibling_module_detection_finds_tracker_config():
    modules = sibling_modules((HOOKS_DIR / "update-status.py").read_text())
    assert "tracker_config.py" in modules


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
