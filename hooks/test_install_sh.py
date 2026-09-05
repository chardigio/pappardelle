"""The installer copies files by name, so a new sibling import is silent until a
hook dies at runtime on a machine installed through hooks/install.sh."""

import re
from pathlib import Path

HOOKS_DIR = Path(__file__).parent
INSTALL_SH = (HOOKS_DIR / "install.sh").read_text()

SIBLING_IMPORT = re.compile(r'spec_from_file_location\(\s*"[^"]+",\s*(\w+)')
SIBLING_PATH = re.compile(r'^(\w+)\s*=\s*[^\n]*/\s*"([\w.-]+\.py)"', re.MULTILINE)


def sibling_modules(source: str) -> set[str]:
    paths = dict(SIBLING_PATH.findall(source))
    return {paths[var] for var in SIBLING_IMPORT.findall(source) if var in paths}


def test_installer_copies_every_sibling_module_the_hooks_import():
    entrypoints = [
        p
        for p in HOOKS_DIR.glob("*.py")
        if not p.name.startswith("test_") and "-" in p.name
    ]
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
