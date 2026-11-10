"""Exercise benchmark teardown against real owned and unrelated processes."""
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from unittest import TestCase
from unittest.mock import patch

harness = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/benchmarks/workspace-ready.py'))
children = []
checks = TestCase()

def sleeper(root=None):
    env = {key: value for key, value in os.environ.items() if key != harness['FIXTURE_MARKER']}
    if root is not None:
        env[harness['FIXTURE_MARKER']] = str(root)
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env=env)
    children.append(child)
    return child

try:
    with tempfile.TemporaryDirectory(prefix='pappa-cleanup-verification-') as directory:
        base = Path(directory)
        owned = base / 'owned'
        owned.mkdir()
        owned_child = sleeper(owned)
        unrelated = sleeper()
        harness['remove_fixture'](str(owned))
        checks.assertNotEqual(owned_child.wait(timeout=5), 0)
        checks.assertFalse(owned.exists())
        checks.assertIsNone(unrelated.poll())

        stale = base / 'pappa-ready-1073741824-abandoned'
        stale.mkdir()
        stale_child = sleeper(stale)
        active = base / f'pappa-ready-{os.getpid()}-active'
        active.mkdir()
        active_child = sleeper(active)
        with patch('tempfile.gettempdir', return_value=str(base)):
            harness['sweep_stale_fixtures']()
        checks.assertNotEqual(stale_child.wait(timeout=5), 0)
        checks.assertFalse(stale.exists())
        checks.assertTrue(active.exists())
        checks.assertIsNone(active_child.poll())
        checks.assertIsNone(unrelated.poll())
        harness['remove_fixture'](str(active))
        active_child.wait(timeout=5)
    print('PASS owned processes terminated; unrelated/active fixtures preserved; stale fixtures removed')
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)
