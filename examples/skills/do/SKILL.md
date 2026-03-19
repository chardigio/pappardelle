---
name: do
description: Work through a TODO.md checklist in the worktree root, continuing until all items are checked off.
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: >
            cat >/dev/null;
            COUNT_FILE=.claude/skills/do/.ralph-count;
            COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0);
            if grep -qF -- '- [ ]' TODO.md 2>/dev/null && [ "$COUNT" -lt 3 ]; then
              echo $((COUNT + 1)) > "$COUNT_FILE";
              echo "Unchecked TODO items remain in TODO.md. Keep working through them." >&2;
              exit 2;
            else
              rm -f "$COUNT_FILE";
              exit 0;
            fi
---

# /do - Work Through TODO Checklist

You have a `TODO.md` file in the worktree root containing a checklist of tasks to complete for this issue. Your job is to work through every item systematically.

## How It Works

1. **Read `TODO.md`** to see what needs to be done
2. **Work through each item** in order
3. **Check off items** as you complete them by marking each empty checkbox as done and adding a detailed explanation of what was done and how in parentheses after.
4. A hook will automatically check if unchecked items remain and keep you going

## Rules

- Always check off an item (`- [x]`) immediately after completing it
- Work through items in order unless dependencies require a different sequence
- If an item is blocked or not applicable, check it off and add a note explaining why
- Use `AskUserQuestion` when requirements are ambiguous or you need user input
- Make small, incremental changes and test frequently

## Updating Issue Details

When you start working on an issue, update it with proper details:

### 1. Assign to the Correct Project

The issue may not have a project assigned yet. Based on what you're implementing, assign it to the appropriate project.

### 2. Update Title (if needed)

If the auto-generated title isn't ideal, improve it to clearly describe the task.

### 3. Update Description

Update the description but **keep the "Original prompt" section at the bottom**:

```
Your detailed description here...

---

_Original prompt:_

> <keep the original prompt text as a blockquote>
```

### 4. Update GitHub PR

Edit the PR body to add summary details, but **preserve the "Original prompt" section**:

```bash
gh pr edit --body "## Summary
- Bullet points describing changes

## Test plan
- How to test

## Issue
[Link to issue]

---

_Original prompt:_

> <keep the original prompt text as a blockquote>

---
Generated with [Claude Code](https://claude.com/claude-code)"
```

## Argument

The argument passed to this skill is the issue key (e.g., `PROJ-123`). Use it for:

- Looking up the issue in your issue tracker
- Updating issue status as you progress
- Commit messages: `[PROJ-123] Description`
