---
name: do
description: Step-based workflow for implementing an issue in a multi-repo workspace. Handles research, planning, shallow cloning, agent teams, implementation, QA, and pull requests.
---

# /do — Implement an Issue Across Multiple Repos

Step-based workflow for implementing an issue end-to-end in a parent repo that orchestrates work across multiple child repos via on-demand shallow cloning.

## Input

Accepts:

- **Issue URL**: `https://your-tracker.example.com/browse/PROJ-123`
- **Issue ID**: `PROJ-123`
- **Just the number**: `123` (assumes the configured project prefix)

## Steps

### 1. Fetch & Understand the Issue

- Use your issue tracker tool to view the issue
- Read title, description, acceptance criteria, comments
- Transition to "In Progress"

### 2. Research & Planning

- Use a code search tool (e.g., SourceBot's `codesearch` MCP) to find what code is involved and where it lives
- **IMPORTANT:** Use `AskUserQuestion` to clarify ambiguities before proceeding. It is ok to over-ask to clarify details for the spec!
- Read relevant code to understand existing patterns before making changes

### 3. Update the Issue

- **Update the issue title and description** with refined requirements, acceptance criteria, and technical plan before implementing
- This is critical — the issue must accurately reflect what will be built

### 4. Shallow-Clone Required Repos

Only clone the repos you need. Use `--depth 1` for fast, minimal clones:

```bash
git clone --depth 1 https://github.com/org/repo-name.git
```

Do NOT clone all repos upfront — only the ones identified as relevant during planning.

This keeps initialization fast and reduces noise while grepping and globbing. Because we use `--depth 1`, only the latest commit is fetched — no full history.

### 5. Spin Up Agent Team

Spin up an **Agent Team** with at least **one agent per repo** being modified:

- Each agent works in its own cloned repo directory! YOU MUST INITIALIZE THE AGENT IN THE CORRECT DIRECTORY!
- Each agent creates a feature branch, implements changes, runs tests, and commits
- The lead agent coordinates, reviews progress, and handles cross-repo concerns

### 6. Implement

- **Prefer red-green TDD** — write tests first when possible
- Follow existing architectural patterns in each repo
- Run pre-commit hooks and tests in each repo before committing

### 7. QA

There should be another QA agent _per_ repo being worked on that should run a code review against the PR/MR as recommended by the repo's agentic documentation, run tests, and run the services to make sure they're working as expected.

And there should be an over-arching integration test agent that runs integration tests across all repos being worked on with help via communicating via each of the per-repo subagents.

Do NOT skip this step — it is critical to the success of the project.

### 8. Create Pull Requests

- Create PRs/MRs via your VCS tool
- **Title**: always prefix with the issue key — `[PROJ-123] Descriptive title`
- **Description**: comprehensive — include summary, what each agent did, QA steps, and overview of all changes
- **NEVER** mark the issue as "Done" — that's for human review after merge

There should be one PR/MR per child repo worked on!

There should always be a PR/MR in the parent repo itself that serves as a reference for the others: the description should link to the other PRs/MRs and give a high-level overview of the changes.
