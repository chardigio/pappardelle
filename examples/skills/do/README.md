# /do

A generic skill for working through a TODO checklist. Designed for use with Pappardelle workspaces.

## How it works

1. Pappardelle copies `TODO-TEMPLATE.md` → `TODO.md` in the worktree during `post_workspace_init`
2. Claude is initialized with `/do <issue-key>`
3. Claude reads TODO.md and works through each item systematically

## Setup

Add the initialization command and a `post_workspace_init` command to your `.pappardelle.yml` to copy the template. You can set these globally or per-profile:

**Global** (applies to all profiles):

```yaml
claude:
  initialization_command: "/do"
post_workspace_init:
  - name: "Create TODO.md"
    run: "cp ${REPO_ROOT}/.claude/skills/do/TODO-TEMPLATE.md ${WORKTREE_PATH}/TODO.md"
```

**Per-profile** (overrides global for a specific profile):

```yaml
profiles:
  my-profile:
    claude:
      initialization_command: "/do"
    post_workspace_init:
      - name: "Create TODO.md"
        run: "cp ${REPO_ROOT}/.claude/skills/do/TODO-TEMPLATE.md ${WORKTREE_PATH}/TODO.md"
```

## Files

- **SKILL.md** - Skill definition
- **TODO-TEMPLATE.md** - Checklist template copied to worktrees as TODO.md (customize this for your project)
