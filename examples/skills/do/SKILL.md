---
name: do
description: Start working on a new task. Workspace is already set up with git worktree, issue, and GitHub PR. Just start implementing the feature described in the prompt.
disable-model-invocation: true
---

# /do - Implement a Task

You are in a development workspace that has been automatically set up for you. The workspace includes:
- Git worktree with a branch for this issue
- Issue tracker issue (created or fetched)
- GitHub PR (created or found)

## Interactive Mode

**This is INTERACTIVE mode.** Before diving into implementation, you should:

1. **Ask clarifying questions** using the `AskUserQuestion` tool
2. **Validate assumptions** about the requirements
3. **Confirm the approach** before writing code

Use `AskUserQuestion` when:
- The requirements are ambiguous
- Multiple implementation approaches are possible
- You need to confirm UI/UX decisions
- You're unsure about edge cases

## Your Current Task

The user has described what they want (either via prompt or issue description). Your job is to:

1. **Understand the request** — Read the prompt/description carefully
2. **Ask questions** — Use AskUserQuestion to clarify any ambiguities
3. **Explore the codebase** — Find relevant files and understand the existing implementation
4. **Plan the implementation** — Think about how to implement the feature
5. **Confirm the plan** — Optionally share your plan with the user
6. **Implement the changes** — Make the necessary code changes
7. **Test your changes** — Build and verify the changes work

## Workflow

1. First, explore the codebase to understand the current implementation:
   - Use Grep/Glob to find relevant files
   - Read the key files to understand the architecture

2. **Ask clarifying questions** if anything is unclear:
   ```
   Use AskUserQuestion tool with options like:
   - "Which approach do you prefer?"
   - "Should this affect X or Y?"
   - "What should happen when Z?"
   ```

3. Create a plan for the implementation:
   - Break down the task into smaller steps
   - Identify files that need to be modified
   - Consider edge cases

4. Implement the changes:
   - STRONGLY PREFER RED/GREEN TEST-DRIVEN DEVELOPMENT
   - Make incremental changes
   - Test as you go
   - Commit when appropriate

5. Update the issue and PR:
   - Update issue status as you progress
   - The PR will be updated when you push commits

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

## Important Notes

- **ASK QUESTIONS FIRST** — This is interactive mode, use AskUserQuestion before making assumptions
- The workspace is already set up — you don't need to create the worktree, issue, or PR
- Focus on implementing the feature described in the prompt
- Make small, incremental changes and test frequently
- Use the TODO list to track your progress
- Update issue state as you progress (In Progress → In Review → Done)
- **Always preserve the "Original prompt" section** when updating descriptions
