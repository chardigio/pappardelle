#!/usr/bin/env python3
"""Tests for tracker_config.py — provider detection and issue-key recovery."""

import importlib.util
import os
from pathlib import Path

import pytest

_module_path = Path(__file__).parent / "tracker_config.py"
_spec = importlib.util.spec_from_file_location("tracker_config", _module_path)
assert _spec and _spec.loader
tracker_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tracker_config)


def write_repo(root: Path, pappardelle: str = "", beads: str | None = None) -> Path:
    """Lay out a repo with a .pappardelle.yml and optionally a .beads/config.yaml."""
    root.mkdir(parents=True, exist_ok=True)
    (root / ".pappardelle.yml").write_text(pappardelle)
    if beads is not None:
        (root / ".beads").mkdir(exist_ok=True)
        (root / ".beads" / "config.yaml").write_text(beads)
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
# get_beads_prefix
# ---------------------------------------------------------------------------


def test_beads_prefix_prefers_beads_config(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nteam_prefix: fallback\n",
        beads='issue-prefix: "myproj"\n',
    )
    assert tracker_config.get_beads_prefix(str(repo)) == "myproj"


def test_beads_prefix_falls_back_to_team_prefix(tmp_path):
    # .beads/config.yaml ships with issue-prefix commented out, so team_prefix
    # is what most repos will actually have set.
    repo = write_repo(tmp_path, "version: 1\nteam_prefix: Pap\n", beads='# issue-prefix: ""\n')
    assert tracker_config.get_beads_prefix(str(repo)) == "pap"


def test_beads_prefix_is_none_when_unset(tmp_path):
    repo = write_repo(tmp_path, "version: 1\n")
    assert tracker_config.get_beads_prefix(str(repo)) is None


# ---------------------------------------------------------------------------
# get_beads_prefixes
# ---------------------------------------------------------------------------


_MULTI_PREFIX_CONFIG = """version: 1
team_prefix: myproj
issue_tracker:
  provider: beads
profiles:
  backend:
    keywords: [api]
    team_prefix: my_service
  vendor:
    keywords: [sdk]
    tracker_projects:
      - 'vendor-sdk'
      - "Other-Thing"
"""


def test_beads_prefixes_collects_every_configured_source(tmp_path):
    repo = write_repo(tmp_path, _MULTI_PREFIX_CONFIG)
    assert sorted(tracker_config.get_beads_prefixes(str(repo))) == [
        "my_service",
        "myproj",
        "other-thing",
        "vendor-sdk",
    ]


def test_beads_prefixes_reads_an_inline_tracker_projects_list(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nteam_prefix: myproj\nprofiles:\n"
        "  vendor:\n    tracker_projects: [vendor-sdk, 'Other-Thing']\n",
    )
    assert sorted(tracker_config.get_beads_prefixes(str(repo))) == [
        "myproj",
        "other-thing",
        "vendor-sdk",
    ]


def test_beads_prefixes_ignores_trailing_comments(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nteam_prefix: myproj  # the database prefix\nprofiles:\n"
        "  vendor:\n    tracker_projects:\n      - vendor-sdk # current\n",
    )
    assert sorted(tracker_config.get_beads_prefixes(str(repo))) == [
        "myproj",
        "vendor-sdk",
    ]


def test_finds_beads_key_under_an_inline_tracker_project_prefix(tmp_path):
    repo = write_repo(
        tmp_path / "vendor-sdk-hic",
        "version: 1\nteam_prefix: myproj\nissue_tracker:\n  provider: beads\n"
        "profiles:\n  vendor:\n    tracker_projects: [vendor-sdk]\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "vendor-sdk-hic"


def test_beads_prefixes_is_just_the_database_prefix_without_profiles(tmp_path):
    repo = write_repo(tmp_path, "version: 1\nteam_prefix: solo\n")
    assert tracker_config.get_beads_prefixes(str(repo)) == ["solo"]


def test_beads_prefixes_is_empty_when_nothing_is_configured(tmp_path):
    repo = write_repo(tmp_path, "version: 1\n")
    assert tracker_config.get_beads_prefixes(str(repo)) == []


def test_global_prefix_matches_workspaces_when_database_prefix_differs(tmp_path):
    repo = write_repo(
        tmp_path / "other-abc",
        "team_prefix: Other\nissue_tracker:\n  provider: beads\n",
        "issue-prefix: current\n",
    )
    assert tracker_config.get_beads_prefixes(str(repo)) == ["current", "other"]
    assert tracker_config.find_issue_key(str(repo)) == "other-abc"


def test_beads_prefixes_deduplicates_case_insensitively(tmp_path):
    repo = write_repo(
        tmp_path,
        "version: 1\nteam_prefix: pap\nprofiles:\n  a:\n    team_prefix: PAP\n",
    )
    assert tracker_config.get_beads_prefixes(str(repo)) == ["pap"]


# ---------------------------------------------------------------------------
# find_issue_key
# ---------------------------------------------------------------------------


def test_finds_classic_issue_key(tmp_path):
    repo = write_repo(tmp_path / "STA-123", "version: 1\n")
    assert tracker_config.find_issue_key(str(repo)) == "STA-123"


def test_ignores_ordinary_directory_names(tmp_path):
    repo = write_repo(tmp_path / "my-app", "version: 1\n")
    assert tracker_config.find_issue_key(str(repo)) is None


def test_finds_beads_key_when_prefix_matches(tmp_path):
    repo = write_repo(
        tmp_path / "pap-a1b2",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "pap-a1b2"


def test_finds_beads_child_key(tmp_path):
    repo = write_repo(
        tmp_path / "pap-a1b2.1",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "pap-a1b2.1"


def test_beads_matching_is_anchored_to_the_configured_prefix(tmp_path):
    # Without this anchor, any hyphenated path component would read as an issue.
    repo = write_repo(
        tmp_path / "some-dir",
        "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) is None


def test_beads_key_ignored_when_no_prefix_is_configured(tmp_path):
    repo = write_repo(tmp_path / "pap-a1b2", "version: 1\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.find_issue_key(str(repo)) is None


def test_lowercase_key_ignored_under_a_non_beads_tracker(tmp_path):
    repo = write_repo(tmp_path / "pap-a1b2", "version: 1\nteam_prefix: pap\n")
    assert tracker_config.find_issue_key(str(repo)) is None


def test_finds_beads_key_under_a_profile_tracker_project_prefix(tmp_path):
    # A workspace minted under a profile's tracker_projects prefix is a real
    # workspace; matching only the database prefix stranded it on the fallback
    # branch key and silently skipped its comments.
    repo = write_repo(tmp_path / "vendor-sdk-hic", _MULTI_PREFIX_CONFIG)
    assert tracker_config.find_issue_key(str(repo)) == "vendor-sdk-hic"


def test_finds_beads_key_under_a_profile_team_prefix(tmp_path):
    repo = write_repo(tmp_path / "my_service-a1b2", _MULTI_PREFIX_CONFIG)
    assert tracker_config.find_issue_key(str(repo)) == "my_service-a1b2"


def test_workspace_directory_wins_over_a_key_shaped_parent(tmp_path):
    # The repo directory sits above the workspace directory and is itself
    # key-shaped whenever a configured prefix is a strict prefix of it. Scanning
    # root-first returned "vendor-sdk" and filed status against no issue at all.
    repo = write_repo(
        tmp_path / "vendor-sdk" / "vendor-a1b2",
        "version: 1\nteam_prefix: vendor\nissue_tracker:\n  provider: beads\n",
    )
    assert tracker_config.find_issue_key(str(repo)) == "vendor-a1b2"


def test_main_checkout_is_not_its_own_issue_key(tmp_path, monkeypatch):
    # A beads prefix defaults to the repo directory name and may be a strict
    # prefix of it, so the main checkout's own directory is key-shaped. The
    # worktree case is saved by deepest-first ordering; the main checkout has
    # nothing deeper, and this returned "vendor-sdk" for the one path whose
    # contract says there is no issue — filing status and comments against an
    # issue that does not exist.
    repo = write_repo(
        tmp_path / "vendor-sdk",
        "version: 1\nteam_prefix: vendor\nissue_tracker:\n  provider: beads\n",
    )
    monkeypatch.setattr(tracker_config, "get_main_repo_root", lambda start=None: str(repo))
    assert tracker_config.find_issue_key(str(repo)) is None


def test_workspace_under_a_key_shaped_main_checkout_still_resolves(tmp_path, monkeypatch):
    # Dropping the main root must not cost us the real workspace below it.
    checkout = write_repo(
        tmp_path / "vendor-sdk",
        "version: 1\nteam_prefix: vendor\nissue_tracker:\n  provider: beads\n",
    )
    workspace = checkout / "vendor-a1b2"
    workspace.mkdir()
    monkeypatch.setattr(tracker_config, "get_main_repo_root", lambda start=None: str(checkout))
    assert tracker_config.find_issue_key(str(workspace)) == "vendor-a1b2"


def test_multi_prefix_config_still_rejects_ordinary_directory_names(tmp_path):
    repo = write_repo(tmp_path / "fix-crash", _MULTI_PREFIX_CONFIG)
    assert tracker_config.find_issue_key(str(repo)) is None


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


def test_beads_prefix_resolves_from_the_main_checkout_in_a_worktree(worktree):
    checkout, linked = worktree
    write_repo(checkout, "version: 1\n", beads="issue-prefix: pap\n")
    assert tracker_config.get_beads_prefix(str(linked)) == "pap"


def test_profile_prefixes_resolve_from_the_main_checkout_in_a_worktree(worktree):
    checkout, linked = worktree
    write_repo(checkout, _MULTI_PREFIX_CONFIG)
    assert "vendor-sdk" in tracker_config.get_beads_prefixes(str(linked))


def test_issue_key_recovered_from_a_worktree_with_no_config_of_its_own(worktree):
    # The bug this fixes: the key was unrecoverable, so update-status.py fell
    # through to its "<repo>-<branch>" fallback and wrote status under a name
    # the sidebar never reads — "pappardelle-pap-a1b2.json" for "pap-a1b2".
    checkout, linked = worktree
    write_repo(checkout, "version: 1\nteam_prefix: pap\nissue_tracker:\n  provider: beads\n")
    assert tracker_config.find_issue_key(str(linked)) == "pap-a1b2"


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
    monkeypatch.setattr(
        tracker_config, "_resolve_main_repo_root", lambda start: "/tmp/elsewhere"
    )
    assert tracker_config.get_main_repo_root("/tmp/elsewhere") == "/tmp/elsewhere"


if __name__ == "__main__":
    raise SystemExit(pytest.main([os.path.abspath(__file__), "-v"]))
