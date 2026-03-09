---
name: do-todo
description: Work through a TODO.md checklist in the worktree root, continuing until all items are checked off.
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: "cat > /dev/null; COUNT_FILE=.claude/skills/do-todo/.ralph-count; COUNT=$(cat \"$COUNT_FILE\" 2>/dev/null || echo 0); if grep -qF -- '- [ ]' TODO.md 2>/dev/null && [ \"$COUNT\" -lt 3 ]; then echo $((COUNT + 1)) > \"$COUNT_FILE\"; echo '{\"ok\": false, \"reason\": \"Unchecked TODO items remain in TODO.md. Keep working through them.\"}'; else rm -f \"$COUNT_FILE\"; echo '{\"ok\": true}'; fi"
---

# /do-todo - Work Through TODO Checklist

You have a `TODO.md` file in the worktree root containing a checklist of tasks to complete for this issue. Your job is to work through every item systematically.

## How It Works

1. **Read `TODO.md`** to see what needs to be done
2. **Work through each item** in order
3. **Check off items** as you complete them by changing `- [ ]` to `- [x]`
4. A hook will automatically check if unchecked items remain and keep you going

## Rules

- Always check off an item (`- [x]`) immediately after completing it
- Work through items in order unless dependencies require a different sequence
- If an item is blocked or not applicable, check it off and add a note explaining why
- Use `AskUserQuestion` when requirements are ambiguous or you need user input
- Make small, incremental changes and test frequently

## Argument

The argument passed to this skill is the issue key (e.g., `PROJ-123`). Use it for:
- Looking up the issue in your issue tracker
- Updating issue status as you progress
- Commit messages: `[PROJ-123] Description`
