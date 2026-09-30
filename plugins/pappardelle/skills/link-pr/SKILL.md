---
name: link-pr
description: Record an existing GitHub PR or GitLab MR in a Pappardelle workspace so rail status follows its published branch. Use after creating or reusing a PR/MR, especially when its remote branch differs from the workspace name.
---

# Link a workspace PR or MR

After successfully creating or reusing a PR/MR for a Pappardelle workspace, run `pappardelle link-pr <url>` from its source repository before reporting the workflow complete. The command verifies the URL through `gh` or `glab` and saves the published branch; rerunning replaces the mapping for that repository and local branch.

For a nested repository, pass `--workspace <outer-workspace-root>` so the mapping belongs to the outer workspace. Run once for each repository with a PR/MR. Do not create another PR just to repair an indicator.

If linking fails, report the failure and preserve the existing PR/MR. Do not claim the workspace is linked or hand-edit its cached pipeline status. This step records an existing PR/MR; it does not authorize creating, pushing, or publishing one.
