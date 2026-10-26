import meow from 'meow';

const helpText = `
	Usage
	  $ pappardelle [--profile <name>] [prompt]
	  $ pappardelle --resume <prompt or issue-key>
	  $ pappardelle highlight <issue-key>
	  $ pappardelle send <issue-key> [text]
	  $ pappardelle close <issue-key> [--yes]
	  $ pappardelle update [--restart-tuis | --no-restart-tuis]
	  $ pappardelle restart [--hard [--yes]]

	Description
	  Interactive TUI for managing pappardelle workspaces.
	  Displays worktree spaces in an fzf-style list with agent and
	  companion panes for the selected space.

	  If a prompt is provided, creates a new session directly without
	  entering the interactive TUI.
	  Existing workspaces resume automatically when opened by issue key.

	Commands
	  highlight <key>  Select a row in the running TUI by issue key
	  link-pr <url>    Record a verified PR/MR for the current workspace
	  send <key> [text]
	                   Submit text as a prompt to the space's agent session.
	                   Reads stdin when no text is given; use stdin for text
	                   that starts with "-", which would parse as a flag
	  close <key>      Close a space, same as x in the TUI
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
	  --profile <name>    Use a configured profile instead of automatic selection
	  --resume            Skip the initialization prompt when opening a space
	  --no-resume         Enable the initialization prompt for an existing space
	  --no-layout         Don't set up tmux pane layout (run standalone)
	  --workspace         Outer workspace root when linking a nested repository
	  --restart-tuis      After update, restart running TUIs without asking
	  --no-restart-tuis   After update, leave running TUIs alone and print a hint
	  --yes               Skip the confirmation for close or restart --hard

	Examples
	  $ pappardelle              # Run with tmux layout
	  $ pappardelle --no-layout  # Run standalone (list only)
	  $ pappardelle "fix auth bug"  # Create new session with prompt
	  $ pappardelle --profile mobile "fix auth bug"  # Select the mobile profile
	  $ pappardelle --resume STA-313  # Reopen without an initialization prompt
	  $ pappardelle highlight STA-313  # Highlight row in running TUI
	  $ pappardelle send 313 "fix the failing tests"  # Prompt STA-313's agent
	  $ pappardelle close STA-313 --yes  # Close STA-313 without asking
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
			profile: {type: 'string'},
			resume: {type: 'boolean'},
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
			teardownOnly: {
				type: 'boolean',
			},
		},
	});
}

const subcommands = {
	close: {
		usage: 'pappardelle close <issue-key> [--yes]',
		// --teardown-only is internal: a self-close hands the session kill to a
		// detached copy of itself, because the kill ends the calling process.
		flags: ['--yes', '--teardown-only'],
		help: `
	Usage
	  $ pappardelle close <issue-key> [--yes]

	Closes a space, same as x in the TUI: runs its pre_workspace_deinit
	hooks, ends its agent and companion sessions, and removes it from the
	list. The worktree stays on disk. A running TUI drops the row within
	10 seconds. On a terminal it asks first.

	Options
	  --yes  Skip the confirmation. Required when not run from a terminal
`,
	},
	restart: {
		usage: 'pappardelle restart [--hard [--yes]]',
		flags: ['--hard', '--yes'],
		help: `
	Usage
	  $ pappardelle restart [--hard [--yes]]

	Restarts this repo's TUI in its tmux pane on the build that ran this
	command, then waits for it to report ready. Your terminal stays attached,
	and agent and companion sessions keep running. Exits non-zero when the
	TUI is not confirmed on that build.

	Options
	  --hard  End every agent and companion session, then restart every TUI
	  --yes   Skip --hard's confirmation
`,
	},
	update: {
		usage: 'pappardelle update [--restart-tuis | --no-restart-tuis]',
		flags: ['--restart-tuis', '--no-restart-tuis'],
		help: `
	Usage
	  $ pappardelle update [--restart-tuis | --no-restart-tuis]

	Installs the latest release (same as U in the TUI). Running TUIs stay on
	the old build until they restart; on a terminal it asks first.

	Options
	  --restart-tuis      Restart running TUIs without asking. Exits non-zero
	                      when one is not confirmed running afterwards
	  --no-restart-tuis   Leave running TUIs alone and print a hint
`,
	},
} as const;

export type SubcommandGate =
	| {action: 'run'}
	| {action: 'help'; text: string}
	| {action: 'reject'; message: string};

// `close`, `restart` and `update` act on live spaces or TUIs, so a flag they
// don't know must stop them. meow only answers --help when it is the sole argument and
// otherwise ignores unknown flags.
export function subcommandGate(argv: readonly string[]): SubcommandGate {
	const name = argv[0];
	if (name === undefined || !Object.hasOwn(subcommands, name)) {
		return {action: 'run'};
	}

	const {usage, flags, help} = subcommands[name as keyof typeof subcommands];
	const given = argv.slice(1).filter(arg => arg.startsWith('-'));
	if (given.some(arg => arg === '--help' || arg === '-h')) {
		return {action: 'help', text: help};
	}

	const unknown = given.find(
		arg => !(flags as readonly string[]).includes(arg),
	);
	if (unknown !== undefined) {
		return {
			action: 'reject',
			message: `Unknown flag ${unknown} for pappardelle ${name}\nUsage: ${usage}\nRun pappardelle ${name} --help for details`,
		};
	}

	return {action: 'run'};
}
