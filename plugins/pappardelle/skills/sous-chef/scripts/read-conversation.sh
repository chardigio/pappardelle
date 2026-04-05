#!/usr/bin/env bash
# Read recent conversation messages from a Pappardelle space.
# Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]
# Outputs the last N user/assistant message summaries from the conversation log.
set -euo pipefail

ISSUE_KEY="${1:?Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]}"
REPO_NAME="${2:?Error: repo name argument required. Usage: read-conversation.sh <ISSUE-KEY> <REPO-NAME> [max-messages]}"
MAX_MESSAGES="${3:-20}"

# Pass all values via environment variables to avoid shell injection into Python
export SC_ISSUE_KEY="$ISSUE_KEY"
export SC_REPO_NAME="$REPO_NAME"
export SC_MAX_MESSAGES="$MAX_MESSAGES"
export SC_PROJECTS_DIR="$HOME/.claude/projects"

python3 -c "
import json, os, glob, sys

issue_key = os.environ['SC_ISSUE_KEY']
repo_name = os.environ['SC_REPO_NAME']
max_messages = int(os.environ['SC_MAX_MESSAGES'])
projects_dir = os.environ['SC_PROJECTS_DIR']

# Claude encodes project paths by replacing both / and . with -
worktree_path = os.path.expanduser(f'~/.worktrees/{repo_name}/{issue_key}')
encoded_path = worktree_path.replace('/', '-').replace('.', '-')
project_dir = os.path.join(projects_dir, encoded_path)

if not os.path.isdir(project_dir):
    print(json.dumps({'issueKey': issue_key, 'error': f'No conversation log found for {issue_key}'}))
    sys.exit(0)

# Find the most recent JSONL file
jsonl_files = glob.glob(os.path.join(project_dir, '*.jsonl'))
if not jsonl_files:
    print(json.dumps({'issueKey': issue_key, 'error': 'No JSONL conversation file found'}))
    sys.exit(0)

jsonl_file = max(jsonl_files, key=os.path.getmtime)

messages = []
with open(jsonl_file) as f:
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

# Take last N messages
recent = messages[-max_messages:]

output = {
    'issueKey': issue_key,
    'totalMessages': len(messages),
    'recentMessages': recent
}
print(json.dumps(output, indent=2))
"
