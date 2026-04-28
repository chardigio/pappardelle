# /do

A generic skill for working through a TODO checklist. Designed for use with Pappardelle workspaces.

## How it works

1. Claude is initialized with `/do <issue-key>` (set via `claude.initialization_command` in your `.pappardelle.yml`)
2. The skill's first step copies `TODO-TEMPLATE.md` → `TODO.md` in the worktree on every invocation (always overwrite — see the `## Setup` section in `SKILL.md`)
3. Claude reads `TODO.md` and works through each item systematically

The template copy is now owned by the skill itself rather than `post_workspace_init`, so adding a `/do` profile no longer requires any TODO-related shell command in `.pappardelle.yml`.

## Setup

Just point your profile at the skill — that's it:

**Global** (applies to all profiles):

```yaml
claude:
  initialization_command: '/do'
```

**Per-profile** (overrides global for a specific profile):

```yaml
profiles:
  my-profile:
    claude:
      initialization_command: '/do'
```

## Files

- **SKILL.md** - Skill definition
- **TODO-TEMPLATE.md** - Checklist template copied to worktrees as TODO.md (customize this for your project)
