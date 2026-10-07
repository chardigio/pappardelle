import meow from 'meow';

const helpText = `
	Usage
	  $ pappardelle [prompt]
	  $ pappardelle highlight <issue-key>
	  $ pappardelle send <issue-key> [text]
	  $ pappardelle update [--restart-tuis | --no-restart-tuis]
	  $ pappardelle restart [--hard [--yes]]

	Description
	  Interactive TUI for managing pappardelle workspaces.
	  Displays worktree spaces in an fzf-style list with Claude and
	  companion panes for the selected space.

	  If a prompt is provided, creates a new session directly without
	  entering the interactive TUI.

	Commands
	  highlight <key>  Select a row in the running TUI by issue key
	  link-pr <url>    Record a verified PR/MR for the current workspace
	  send <key> [text]
	                   Submit text as a prompt to the space's agent session.
	                   Reads stdin when no text is given; use stdin for text
	                   that starts with "-", which would parse as a flag
	  update           Update Pappardelle to the latest release (same as U)
	  restart          Restart this repo's TUI in place
	  restart --hard   End every agent session, then restart every TUI

	Controls
	  j/k or arrows  Navigate between spaces
	  Enter          Select space
	  n              New space (create worktree + issue)
	  o              Open workspace (apps, links, iTerm, etc.)
	  d              Delete selected space
	  r              Refresh list
	  U              Update Pappardelle to the latest release
	  q/Ctrl+C       Quit

	Options
	  --no-layout         Don't set up tmux pane layout (run standalone)
	  --workspace         Outer workspace root when linking a nested repository
	  --restart-tuis      After update, restart running TUIs without asking
	  --no-restart-tuis   After update, leave running TUIs alone and print a hint
	  --yes               Skip restart --hard's confirmation

	Examples
	  $ pappardelle              # Run with tmux layout
	  $ pappardelle --no-layout  # Run standalone (list only)
	  $ pappardelle "fix auth bug"  # Create new session with prompt
	  $ pappardelle highlight STA-313  # Highlight row in running TUI
	  $ pappardelle send 313 "fix the failing tests"  # Prompt STA-313's Claude
	  $ pappardelle update       # Update, then ask before restarting running TUIs
	  $ pappardelle restart      # Restart this repo's TUI in place
	  $ pappardelle restart --hard  # End agent sessions, restart every TUI
`;

export function parseCli(argv: readonly string[] = process.argv.slice(2)) {
	return meow(helpText, {
		importMeta: import.meta,
		argv: [...argv],
		// `update` asks on a TTY only when neither --restart-tuis nor
		// --no-restart-tuis was passed, which meow's default of false would make
		// indistinguishable.
		booleanDefault: undefined,
		flags: {
			workspace: {type: 'string'},
			layout: {
				type: 'boolean',
				default: true,
			},
			restartTuis: {
				type: 'boolean',
			},
			hard: {
				type: 'boolean',
			},
			yes: {
				type: 'boolean',
			},
		},
	});
}
