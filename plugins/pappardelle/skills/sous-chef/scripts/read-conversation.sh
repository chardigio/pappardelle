#!/usr/bin/env bash
# Read recent conversation messages from a Pappardelle space.
# Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]
# Outputs the last N user/assistant message summaries from the conversation log.
#
# Agent-neutral since STA-1850. The harness is read from the space's status file
# (which names whichever agent wrote it) and the transcript is located and
# parsed accordingly: Claude keeps one JSONL per cwd-encoded project directory;
# Codex files rollouts by date with the cwd in each file's session_meta header.
# Output shape is identical either way.
set -euo pipefail

ISSUE_KEY="${1:?Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]}"
REPO_NAME="${2:?Error: repo name argument required. Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]}"
MAX_MESSAGES="${3:-20}"

# Pass all values via environment variables to avoid shell injection into Python
export SC_ISSUE_KEY="$ISSUE_KEY"
export SC_REPO_NAME="$REPO_NAME"
export SC_MAX_MESSAGES="$MAX_MESSAGES"
export SC_PROJECTS_DIR="$HOME/.claude/projects"
export SC_CODEX_SESSIONS_DIR="$HOME/.codex/sessions"
export SC_STATUS_DIR="$HOME/.pappardelle/agent-status"

python3 -c "
import json, os, glob, sys

issue_key = os.environ['SC_ISSUE_KEY']
repo_name = os.environ['SC_REPO_NAME']
max_messages = int(os.environ['SC_MAX_MESSAGES'])
projects_dir = os.environ['SC_PROJECTS_DIR']
codex_sessions_dir = os.environ['SC_CODEX_SESSIONS_DIR']
status_dir = os.environ['SC_STATUS_DIR']

worktree_path = os.path.expanduser(f'~/.worktrees/{repo_name}/{issue_key}')


def resolve_agent():
    # Which harness owns this space's transcript, per its status file.
    try:
        with open(os.path.join(status_dir, f'{issue_key}.json')) as f:
            return json.load(f).get('agent') or 'claude'
    except Exception:
        return 'claude'


def find_claude_log():
    # Claude encodes project paths by replacing both / and . with -
    encoded_path = worktree_path.replace('/', '-').replace('.', '-')
    project_dir = os.path.join(projects_dir, encoded_path)
    if not os.path.isdir(project_dir):
        return None
    jsonl_files = glob.glob(os.path.join(project_dir, '*.jsonl'))
    return max(jsonl_files, key=os.path.getmtime) if jsonl_files else None


def find_codex_log():
    # Codex rollouts are filed by date, so the cwd lives in each file's
    # session_meta header. Newest-first with a scan cap.
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


def parse_claude(path):
    messages = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = entry.get('type')
            if msg_type not in ('user', 'assistant'):
                continue

            msg = entry.get('message', {})
            content = msg.get('content', '')

            # Extract text from message content
            if isinstance(content, str):
                text = content[:500]
            elif isinstance(content, list):
                text = ' '.join(
                    p.get('text', '')[:200] for p in content
                    if isinstance(p, dict) and p.get('type') == 'text'
                )[:500]
            else:
                text = str(content)[:500]

            if msg_type == 'user':
                messages.append({'role': 'user', 'text': text, 'ts': entry.get('timestamp')})
            elif msg_type == 'assistant' and text.strip():
                messages.append({'role': 'assistant', 'text': text, 'ts': entry.get('timestamp')})
    return messages


def parse_codex(path):
    # Codex records turns as event_msg entries. Only final_answer agent
    # messages are real replies to the human — commentary is mid-turn
    # narration and would pad the recap with half-thoughts.
    messages = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get('type') != 'event_msg':
                continue
            payload = entry.get('payload') or {}
            text = payload.get('message')
            if not isinstance(text, str) or not text.strip():
                continue

            if payload.get('type') == 'user_message':
                messages.append({'role': 'user', 'text': text[:500], 'ts': entry.get('timestamp')})
            elif payload.get('type') == 'agent_message' and payload.get('phase') == 'final_answer':
                messages.append({'role': 'assistant', 'text': text[:500], 'ts': entry.get('timestamp')})
    return messages


agent = resolve_agent()
log_file = find_codex_log() if agent == 'codex' else find_claude_log()

if not log_file:
    print(json.dumps({
        'issueKey': issue_key,
        'agent': agent,
        'error': f'No conversation log found for {issue_key}',
    }))
    sys.exit(0)

messages = parse_codex(log_file) if agent == 'codex' else parse_claude(log_file)

# Take last N messages
recent = messages[-max_messages:]

output = {
    'issueKey': issue_key,
    'agent': agent,
    'totalMessages': len(messages),
    'recentMessages': recent
}
print(json.dumps(output, indent=2))
"
