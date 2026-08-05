#!/usr/bin/env bash
# Gather Pappardelle space data for the sous-chef skill.
# Reads open spaces, agent statuses, issue metadata, and session info.
# Outputs a JSON summary of all spaces with their current state.
#
# Agent-neutral since STA-1850: the status file names the harness that wrote it
# and carries a normalized `state`, and conversation logs are located per agent
# (Claude: ~/.claude/projects/<encoded-cwd>/; Codex: ~/.codex/sessions/**/).
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
export SC_STATUS_DIR="$HOME/.pappardelle/agent-status"
export SC_META_DIR="$HOME/.pappardelle/repos/$REPO_NAME/issue-meta"
export SC_SPACE_STATE_DIR="$HOME/.pappardelle/repos/$REPO_NAME/space-state"
export SC_SESSIONS_DIR="$HOME/.claude/sessions"
export SC_PROJECTS_DIR="$HOME/.claude/projects"
export SC_CODEX_SESSIONS_DIR="$HOME/.codex/sessions"

python3 -c "
import json, os, glob, time, sys

repo_name = os.environ['SC_REPO_NAME']
open_spaces_file = os.environ['SC_OPEN_SPACES_FILE']
status_dir = os.environ['SC_STATUS_DIR']
meta_dir = os.environ['SC_META_DIR']
space_state_dir = os.environ['SC_SPACE_STATE_DIR']
sessions_dir = os.environ['SC_SESSIONS_DIR']
projects_dir = os.environ['SC_PROJECTS_DIR']
codex_sessions_dir = os.environ['SC_CODEX_SESSIONS_DIR']

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

def find_claude_log(worktree_path):
    # Claude Code encodes project paths by replacing / and . with - (including
    # the leading /). e.g. /Users/me/.worktrees/repo/STA-123 →
    # -Users-me--worktrees-repo-STA-123. Verified empirically.
    encoded_path = worktree_path.replace('/', '-').replace('.', '-')
    project_dir = os.path.join(projects_dir, encoded_path)
    if not os.path.isdir(project_dir):
        return None
    jsonl_files = glob.glob(os.path.join(project_dir, '*.jsonl'))
    return max(jsonl_files, key=os.path.getmtime) if jsonl_files else None


def find_codex_log(worktree_path):
    # Codex rollouts are filed by date, not cwd, so the cwd lives in each
    # file's session_meta header. Newest-first with a scan cap keeps this
    # cheap on an old sessions/ tree.
    rollouts = sorted(
        glob.glob(os.path.join(codex_sessions_dir, '*', '*', '*', '*.jsonl')),
        key=os.path.getmtime,
        reverse=True,
    )[:250]
    for path in rollouts:
        try:
            with open(path) as f:
                header = json.loads(f.readline())
        except Exception:
            continue
        if header.get('type') != 'session_meta':
            continue
        if (header.get('payload') or {}).get('cwd') == worktree_path:
            return path
    return None


def find_conversation_log(agent, worktree_path):
    try:
        if agent == 'codex':
            return find_codex_log(worktree_path)
        return find_claude_log(worktree_path)
    except Exception as e:
        print(f'Warning: could not locate conversation log: {e}', file=sys.stderr)
        return None


results = []
for space in spaces:
    entry = {'name': space}

    # Normalized agent status. The state is one of the five values every harness
    # maps into: idle | working | needs-approval | needs-answer | done.
    status_file = os.path.join(status_dir, f'{space}.json')
    if os.path.exists(status_file):
        try:
            with open(status_file) as f:
                status = json.load(f)
            entry['state'] = status.get('state', 'unknown')
            entry['agent'] = status.get('agent')
            decoration = status.get('decoration') or {}
            entry['currentTool'] = decoration.get('tool')
            entry['model'] = decoration.get('model')
            entry['lastUpdate'] = status.get('lastUpdate')
            if entry['lastUpdate']:
                age_min = (now_ms - entry['lastUpdate']) / 60000
                entry['minutesAgo'] = round(age_min, 1)
            entry['sessionId'] = status.get('sessionId')
        except Exception as e:
            print(f'Warning: could not read status for {space}: {e}', file=sys.stderr)
            entry['state'] = 'unknown'
    else:
        entry['state'] = 'no_status'

    # Issue metadata from pappardelle cache
    meta_file = os.path.join(meta_dir, f'{space}.json')
    if os.path.exists(meta_file):
        try:
            with open(meta_file) as f:
                meta = json.load(f)
            entry['meta'] = meta
        except Exception as e:
            print(f'Warning: could not read metadata for {space}: {e}', file=sys.stderr)

    # Persisted space-state (rail-status + recap) written by the Pappardelle TUI.
    # Lets the sous-chef brief on pipeline/comments/recap without shelling out.
    space_state_file = os.path.join(space_state_dir, f'{space}.json')
    if os.path.exists(space_state_file):
        try:
            with open(space_state_file) as f:
                state = json.load(f)
            if isinstance(state, dict):
                for key in ('pipeline', 'unresolvedCommentCount', 'prNumber', 'recap'):
                    if key in state:
                        entry[key] = state[key]
                if 'updatedAt' in state:
                    entry['spaceStateUpdatedAt'] = state['updatedAt']
        except Exception as e:
            print(f'Warning: could not read space-state for {space}: {e}', file=sys.stderr)

    # Session info
    if space in session_map:
        sess = session_map[space]
        entry['pid'] = sess.get('pid')
        entry['worktreePath'] = sess.get('cwd')

    # Check for a conversation log, dispatched by the agent that wrote the
    # status file (defaulting to Claude when there's no status file yet).
    worktree_path = os.path.expanduser(f'~/.worktrees/{repo_name}/{space}')
    newest = find_conversation_log(entry.get('agent') or 'claude', worktree_path)
    if newest:
        entry['conversationLog'] = newest
        entry['logModified'] = os.path.getmtime(newest)
        log_age_min = (time.time() - os.path.getmtime(newest)) / 60
        entry['logMinutesAgo'] = round(log_age_min, 1)

    # tmux session check. The claude- prefix is historical and harness-neutral.
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
