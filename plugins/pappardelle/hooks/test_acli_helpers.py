#!/usr/bin/env python3
"""
Tests for acli_helpers.py shared module.

Run with: uv run pytest hooks/test_acli_helpers.py -v
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

_module_path = Path(__file__).parent / "acli_helpers.py"
_spec = importlib.util.spec_from_file_location("acli_helpers", _module_path)
assert _spec is not None
assert _spec.loader is not None
mod = importlib.util.module_from_spec(_spec)
sys.modules["acli_helpers"] = mod
_spec.loader.exec_module(mod)

acli_succeeded = mod.acli_succeeded


class TestAcliSucceeded:
    def test_returns_true_on_clean_success(self):
        result = MagicMock()
        result.returncode = 0
        result.stdout = "Updated PROJ-1"
        result.stderr = ""
        assert acli_succeeded(result) is True

    def test_returns_false_on_nonzero_returncode(self):
        result = MagicMock()
        result.returncode = 1
        result.stdout = ""
        result.stderr = "Something went wrong"
        assert acli_succeeded(result) is False

    def test_returns_false_on_failure_in_stdout(self):
        result = MagicMock()
        result.returncode = 0
        result.stdout = "Failure: invalid ADF"
        result.stderr = ""
        assert acli_succeeded(result) is False

    def test_returns_false_on_error_colon_in_stderr(self):
        result = MagicMock()
        result.returncode = 0
        result.stdout = ""
        result.stderr = "Error: connection refused"
        assert acli_succeeded(result) is False

    def test_returns_false_on_invalid_payload_exception(self):
        result = MagicMock()
        result.returncode = 0
        result.stdout = "InvalidPayloadException: bad request"
        result.stderr = ""
        assert acli_succeeded(result) is False

    def test_does_not_false_negative_on_error_substring(self):
        """'Error' as part of a word (no colon) should NOT trigger failure."""
        result = MagicMock()
        result.returncode = 0
        result.stdout = "Updated Error-Handling-Improvements task"
        result.stderr = ""
        assert acli_succeeded(result) is True

    def test_does_not_false_negative_on_error_in_title(self):
        """Issue title containing 'Error' should not cause false failure."""
        result = MagicMock()
        result.returncode = 0
        result.stdout = "Comment added to ErrorBudget-Tracking"
        result.stderr = ""
        assert acli_succeeded(result) is True

    def test_handles_none_stdout_stderr(self):
        result = MagicMock()
        result.returncode = 0
        result.stdout = None
        result.stderr = None
        assert acli_succeeded(result) is True
