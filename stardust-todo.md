# TODO

Work through each item below. Check off items as you complete them by changing `- [ ]` to `- [x]`.

## Setup

- [ ] Read and understand the Linear issue description
- [ ] Assign to Stardust Jams MVP project (`linctl issue update <issue> --project "092fb10f-fe37-4606-beb5-0cf907cf1ba3"`)
- [ ] Update the Linear issue title if the auto-generated one isn't ideal
- [ ] Update the Linear issue description with implementation details (preserve "Original prompt" section at the bottom)

## Research & Planning

- [ ] Explore the codebase to find relevant files (use Grep/Glob to search)
- [ ] Read key files to understand existing architecture and patterns
- [ ] Ask clarifying questions if requirements are ambiguous (use AskUserQuestion)
- [ ] Plan the implementation approach and identify files to modify

## Implementation (Red-Green TDD)

- [ ] Write failing tests first (Red phase)
  - Backend: `services/{service}/_tests/`
  - iOS: `{App}Tests/` targets
- [ ] Implement the minimum code to make tests pass (Green phase)
- [ ] Refactor if needed while keeping tests green
- [ ] Build and verify changes compile
  - iOS: `cd _ios/stardust-jams && xcodebuild -project stardust-jams.xcodeproj -scheme stardust-jams -destination "platform=iOS Simulator,name=iPhone 17 Pro" build`
  - Backend: `uv run pytest services/{service}/_tests/`

## Testing

- [ ] Run all relevant tests and verify they pass
- [ ] Manual testing / visual verification if applicable (use /qa skill for automated screenshot testing)

## Wrap Up

- [ ] Commit and push changes
- [ ] Apply the `stardust_jams` initiative label to the PR
- [ ] Update the GitHub PR title and body with summary and test plan
  - Include: Summary bullets, Test plan, Linear Issue link
  - Preserve "Original prompt" section
- [ ] Update Linear issue state to "In Review"
