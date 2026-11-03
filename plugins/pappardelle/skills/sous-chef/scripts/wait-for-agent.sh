#!/usr/bin/env bash
# Wait for a reopened space's agent to start before sous-chef sends to it.
# A failed agent launch leaves a login shell in the pane, and `pappardelle send`
# only checks that the tmux session exists, so sending without this check can
# run the chef's instruction as a shell command.
#
# Exits 0 once the space's status file records a SessionStart from this repo's
# worktree at or after <since-ms>; exits 1 on timeout.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: wait-for-agent.sh <REPO-NAME> <ISSUE-KEY> <SINCE-MS>" >&2
  exit 2
fi

# Pass all values via environment variables to avoid shell injection into Python
export SC_REPO_NAME="$1"
export SC_ISSUE_KEY="$2"
export SC_SINCE_MS="$3"
export SC_STATUS_DIR="$HOME/.pappardelle/claude-status"
export SC_TIMEOUT_SECS="${SC_WAIT_TIMEOUT_SECS:-60}"

python3 -c "
import json, os, sys, time

key = os.environ['SC_ISSUE_KEY']
since_ms = int(os.environ['SC_SINCE_MS'])
status_file = os.path.join(os.environ['SC_STATUS_DIR'], f'{key}.json')
# Status files are keyed by issue key alone, so the cwd tells this repo's space
# apart from another repo's space with the same key.
worktree = os.path.expanduser(f\"~/.worktrees/{os.environ['SC_REPO_NAME']}/{key}\")
deadline = time.time() + float(os.environ['SC_TIMEOUT_SECS'])

def started():
    try:
        with open(status_file) as f:
            status = json.load(f)
    except (OSError, ValueError):
        return False
    cwd = status.get('cwd') or ''
    return (
        status.get('event') == 'SessionStart'
        and (cwd == worktree or cwd.startswith(worktree + '/'))
        and (status.get('lastUpdate') or 0) >= since_ms
    )

while not started():
    if time.time() >= deadline:
        sys.exit(1)
    time.sleep(0.5)
"
