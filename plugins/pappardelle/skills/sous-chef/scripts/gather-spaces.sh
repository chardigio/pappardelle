#!/usr/bin/env bash
# Gather Pappardelle space data for the sous-chef skill.
# Reads open spaces, claude statuses, issue metadata, and session info.
# Outputs a JSON summary of all spaces with their current state.
set -euo pipefail

REPO_NAME="${1:?Error: repo name argument required. Usage: gather-spaces.sh <REPO-NAME>}"

OPEN_SPACES_FILE="$HOME/.pappardelle/repos/$REPO_NAME/open-spaces.json"

if [ ! -f "$OPEN_SPACES_FILE" ]; then
  echo '{"error": "No open spaces file found", "spaces": []}'
  exit 0
fi

# Pass all values via environment variables to avoid shell injection into Python
export SC_REPO_NAME="$REPO_NAME"
export SC_OPEN_SPACES_FILE="$OPEN_SPACES_FILE"
export SC_STATUS_DIR="$HOME/.pappardelle/claude-status"
export SC_META_DIR="$HOME/.pappardelle/repos/$REPO_NAME/issue-meta"
export SC_SESSIONS_DIR="$HOME/.claude/sessions"
export SC_PROJECTS_DIR="$HOME/.claude/projects"

python3 -c "
import json, os, glob, time, sys

repo_name = os.environ['SC_REPO_NAME']
open_spaces_file = os.environ['SC_OPEN_SPACES_FILE']
status_dir = os.environ['SC_STATUS_DIR']
meta_dir = os.environ['SC_META_DIR']
sessions_dir = os.environ['SC_SESSIONS_DIR']
projects_dir = os.environ['SC_PROJECTS_DIR']

with open(open_spaces_file) as f:
    spaces = json.load(f)

now_ms = int(time.time() * 1000)

# Map session PIDs to worktrees
session_map = {}  # issue_key -> {pid, sessionId, cwd, startedAt}
for sf in glob.glob(os.path.join(sessions_dir, '*.json')):
    try:
        with open(sf) as f:
            sess = json.load(f)
        cwd = sess.get('cwd', '')
        # Match the full worktree prefix to avoid false matches on similar repo names
        worktrees_prefix = os.path.expanduser(f'~/.worktrees/{repo_name}/')
        if cwd.startswith(worktrees_prefix):
            remainder = cwd[len(worktrees_prefix):]
            issue_key = remainder.split('/')[0]
            if issue_key:
                # Prefer the most recent session if multiple match the same issue key
                # (e.g. stale session files from restarted Claude sessions).
                # Note: uses lexicographic comparison, which is correct for ISO 8601
                # timestamps with a consistent timezone suffix. Claude Code uses UTC 'Z'
                # format consistently; if that ever changes to '+00:00', this comparison
                # would need to parse with datetime.fromisoformat().
                existing = session_map.get(issue_key)
                if existing is None or sess.get('startedAt', '') > existing.get('startedAt', ''):
                    session_map[issue_key] = sess
    except Exception as e:
        print(f'Warning: could not read session {sf}: {e}', file=sys.stderr)

results = []
for space in spaces:
    entry = {'name': space}

    # Claude status
    status_file = os.path.join(status_dir, f'{space}.json')
    if os.path.exists(status_file):
        try:
            with open(status_file) as f:
                status = json.load(f)
            entry['status'] = status.get('status', 'unknown')
            entry['currentTool'] = status.get('currentTool')
            entry['lastUpdate'] = status.get('lastUpdate')
            if entry['lastUpdate']:
                age_min = (now_ms - entry['lastUpdate']) / 60000
                entry['minutesAgo'] = round(age_min, 1)
            entry['sessionId'] = status.get('sessionId')
        except Exception as e:
            print(f'Warning: could not read status for {space}: {e}', file=sys.stderr)
            entry['status'] = 'unknown'
    else:
        entry['status'] = 'no_status'

    # Issue metadata from pappardelle cache
    meta_file = os.path.join(meta_dir, f'{space}.json')
    if os.path.exists(meta_file):
        try:
            with open(meta_file) as f:
                meta = json.load(f)
            entry['meta'] = meta
        except Exception as e:
            print(f'Warning: could not read metadata for {space}: {e}', file=sys.stderr)

    # Session info
    if space in session_map:
        sess = session_map[space]
        entry['pid'] = sess.get('pid')
        entry['worktreePath'] = sess.get('cwd')

    # Check for conversation log
    # Claude Code encodes project paths by replacing / and . with - (including the leading /).
    # e.g. /Users/me/.worktrees/repo/STA-123 → -Users-me--worktrees-repo-STA-123
    # This is Claude Code's internal convention — verified empirically.
    worktree_path = os.path.expanduser(f'~/.worktrees/{repo_name}/{space}')
    encoded_path = worktree_path.replace('/', '-').replace('.', '-')
    project_dir = os.path.join(projects_dir, encoded_path)
    if os.path.isdir(project_dir):
        jsonl_files = glob.glob(os.path.join(project_dir, '*.jsonl'))
        if jsonl_files:
            # Get most recent by mtime
            newest = max(jsonl_files, key=os.path.getmtime)
            entry['conversationLog'] = newest
            entry['logModified'] = os.path.getmtime(newest)
            log_age_min = (time.time() - os.path.getmtime(newest)) / 60
            entry['logMinutesAgo'] = round(log_age_min, 1)

    # tmux session check
    tmux_name = f'claude-{repo_name}-{space}'
    entry['tmuxSession'] = tmux_name

    results.append(entry)

# Sort by lastUpdate descending (most recently active first)
results.sort(key=lambda x: x.get('lastUpdate', 0) or 0, reverse=True)

output = {
    'totalSpaces': len(spaces),
    'spaces': results,
    'timestamp': now_ms
}
print(json.dumps(output, indent=2))
"
