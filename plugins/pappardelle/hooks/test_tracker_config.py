#!/usr/bin/env python3
"""Tests for tracker_config.py: provider detection and main checkout resolution."""

import importlib.util
import os
from pathlib import Path

import pytest

_module_path = Path(__file__).parent / "tracker_config.py"
_spec = importlib.util.spec_from_file_location("tracker_config", _module_path)
assert _spec and _spec.loader
tracker_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tracker_config)


def write_repo(root: Path, pappardelle: str = "") -> Path:
    """Lay out a repo with a .pappardelle.yml."""
    root.mkdir(parents=True, exist_ok=True)
    (root / ".pappardelle.yml").write_text(pappardelle)
    return root


# ---------------------------------------------------------------------------
# get_tracker_provider
# ---------------------------------------------------------------------------


def test_provider_defaults_to_linear_without_config(tmp_path):
    assert tracker_config.get_tracker_provider(str(tmp_path)) == "linear"


def test_provider_reads_beads(tmp_path):
    repo = write_repo(tmp_path, "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.get_tracker_provider(str(repo)) == "beads"


def test_provider_reads_jira(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nissue_tracker:\n  provider: jira\n  base_url: https://x.atlassian.net\n",
    )
    assert tracker_config.get_tracker_provider(str(repo)) == "jira"


def test_provider_skips_comment_lines_between_key_and_value(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nissue_tracker:\n  # which tracker\n  provider: beads\n",
    )
    assert tracker_config.get_tracker_provider(str(repo)) == "beads"


def test_provider_found_from_a_subdirectory(tmp_path):
    repo = write_repo(tmp_path, "version: 1\nissue_tracker:\n  provider: beads\n")
    nested = repo / "src" / "deep"
    nested.mkdir(parents=True)
    assert tracker_config.get_tracker_provider(str(nested)) == "beads"


# ---------------------------------------------------------------------------
# find_repo_config — worktree fallback
# ---------------------------------------------------------------------------


@pytest.fixture
def worktree(tmp_path, monkeypatch):
    """A linked worktree that carries no config, plus its main checkout.

    Mirrors the machine setups that put .pappardelle.yml and .beads/ in
    .git/info/exclude: the worktree is a real directory outside the main
    checkout, so walking up from it can never reach the config.
    """
    checkout = tmp_path / "checkout"
    linked = tmp_path / "worktrees" / "pap-a1b2"
    linked.mkdir(parents=True)
    monkeypatch.setattr(tracker_config, "get_main_repo_root", lambda start=None: str(checkout))
    return checkout, linked


def test_provider_resolves_from_the_main_checkout_in_a_worktree(worktree):
    checkout, linked = worktree
    write_repo(checkout, "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.get_tracker_provider(str(linked)) == "beads"


def test_a_local_config_is_used_without_consulting_git(tmp_path, monkeypatch):
    # The fallback forks git, and this runs on every tool use. The main checkout
    # must never pay for it.
    def fail(start=None):
        raise AssertionError("git should not be consulted when the config is on the path")

    monkeypatch.setattr(tracker_config, "get_main_repo_root", fail)
    repo = write_repo(tmp_path, "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.get_tracker_provider(str(repo)) == "beads"


def test_injected_main_repo_root_is_used_instead_of_git(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("git should not be forked when the root was injected")

    monkeypatch.setattr(tracker_config.subprocess, "run", fail)
    monkeypatch.setattr(tracker_config, "_MAIN_REPO_ROOT_CACHE", {})
    monkeypatch.setenv("PAPPARDELLE_MAIN_REPO_ROOT", "/tmp/main-checkout")
    assert tracker_config.get_main_repo_root() == "/tmp/main-checkout"


def test_injected_main_repo_root_does_not_answer_for_another_directory(monkeypatch):
    # An explicit start is a question about some other directory, not about the
    # workspace whose root was injected.
    monkeypatch.setattr(tracker_config, "_MAIN_REPO_ROOT_CACHE", {})
    monkeypatch.setenv("PAPPARDELLE_MAIN_REPO_ROOT", "/tmp/main-checkout")
    monkeypatch.setattr(tracker_config, "_resolve_main_repo_root", lambda start: "/tmp/elsewhere")
    assert tracker_config.get_main_repo_root("/tmp/elsewhere") == "/tmp/elsewhere"


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-v"]))
