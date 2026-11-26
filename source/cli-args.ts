import meow from 'meow';
import {packageJsonUrl} from './runtime.ts';

const helpText = `
	Usage
	  $ pappardelle [--profile <name>] [prompt]
	  $ pappardelle --resume <prompt or issue-key>
	  $ pappardelle highlight <issue-key> [--focus]
	  $ pappardelle send <issue-key> [text]
	  $ pappardelle close <issue-key> [--yes]
	  $ pappardelle send <issue-key> --keys <key>...
	  $ pappardelle spaces [--json]
	  $ pappardelle space get [issue-key] [--json] [--field <name>]...
	  $ pappardelle space list [--json]
	  $ pappardelle agent-profile list [--json]
	  $ pappardelle read <issue-key> [--turns N] [--json]
	  $ pappardelle companion <command...>
	  $ pappardelle update [--restart-tuis | --no-restart-tuis]
	  $ pappardelle restart [--hard [--yes]]
	  $ pappardelle plugin install

	Description
	  Interactive TUI for managing pappardelle workspaces.
	  Displays worktree spaces in an fzf-style list with agent and
	  companion panes for the selected space.

	  If a prompt is provided, creates a new session directly without
	  entering the interactive TUI.
	  Existing workspaces resume automatically when opened by issue key.

	Commands
	  highlight <key>  Select a row in the running TUI by issue key. With
	                   --focus, also focus that space's agent pane
	  link-pr <url>    Record a verified PR/MR for the current workspace
	  send <key> [text]
	                   Submit text as a prompt to the space's agent session.
	                   Everything after the key is sent as is, flags
	                   included. Reads stdin when no text is given
	  close <key>      Close a space, same as x in the TUI
	  send <key> --keys <key>
	                   Press tmux key names (Escape, S-Tab, C-c) in the space's
	                   agent session, in order, without submitting anything.
	                   Repeat --keys for several
	  spaces           List open spaces with status, title, PR and branch
	                   summary (--json for the full record)
	  space get [key]  What a space is: its phase, title, worktree, branch,
	                   profile, tmux sessions and panes, PR and status. With
	                   no key, the space this runs in. See pappardelle space --help
	  space list       The main space and every open space, as space get
	  agent-profile list
	                   The agent profiles a space can be opened on with
	                   --agent-profile (--json with the files defining each)
	  read <key>       Print the last turns of a space's conversation
	                   (--turns N, default 5; --json)
	  screen|state|wait|answer <key>
	                   Watch another space's agent and answer its prompts.
	                   See pappardelle state --help
	  queue|schedule|schedules|unschedule
	                   Wake another space's agent later with an OS timer
	  tui panes|focus-log
	                   Diagnostics for the running TUIs' panes
	  companion        Run, type into, read, resize and close panes in a
	                   space's companion. See pappardelle companion --help
	  mcp              Serve these commands as MCP tools over stdio. Agents
	                   start this
	  mcp install      Add that server to Codex, OpenCode, Antigravity and Pi.
	                   install.sh runs this
	  update           Update Pappardelle to the latest release (same as U)
	  restart          Restart this repo's TUI in place
	  restart --hard   End every agent session, then restart every TUI
	  plugin install   Install the plugin (skills, hooks and MCP tools) from this
	                   install into Claude Code, Codex and agy. install.sh runs this

	Controls
	  j/k or arrows  Navigate between spaces
	  Enter          Focus the agent pane
	  s / Option+s   Jump to the sous-chef (main space's agent)
	  n              New space (create worktree + issue)
	  x / Del        Close space
	  o              Open workspace (apps, links, etc.)
	  d              Open IDE
	  /              Search spaces
	  U              Update Pappardelle to the latest release
	  ?              All keys
	  q/Ctrl+C       Quit

	Options
	  --profile <name>    Use a configured profile instead of automatic selection
	  --agent-profile <name>
	                      Launch the space's agent on this agent profile, for
	                      this launch only. Not applied to an agent already
	                      running
	  --resume            Skip the initialization prompt when opening a space
	  --no-resume         Enable the initialization prompt for an existing space
	  --wait              After opening a space, wait up to 60s for its agent to
	                      start; exit 3 if it isn't confirmed
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
	  $ pappardelle --agent-profile codex STA-313  # Open STA-313 on codex this time
	  $ pappardelle --resume --wait STA-313  # Reopen, then wait for its agent
	  $ pappardelle highlight STA-313  # Highlight row in running TUI
	  $ pappardelle highlight main --focus  # Jump to the sous-chef's agent pane
	  $ pappardelle send 313 "fix the failing tests"  # Prompt STA-313's agent
	  $ pappardelle send 313 --keys Escape  # Interrupt STA-313's agent
	  $ pappardelle close STA-313 --yes  # Close STA-313 without asking
	  $ pappardelle companion hunk diff --watch  # Show a diff in this space's companion
	  $ pappardelle update       # Update, then ask before restarting running TUIs
	  $ pappardelle restart      # Restart this repo's TUI in place
	  $ pappardelle restart --hard  # End agent sessions, restart every TUI
`;

export const SPACE_USAGE = `Usage: pappardelle space get [issue-key] [--json] [--field <name>]...
       pappardelle space list [--json]`;

export const SPACE_HELP = `
	Usage
	  $ pappardelle space get [issue-key] [--json] [--field <name>]...
	  $ pappardelle space list [--json]

	space get prints what Pappardelle knows about a space, from its stores:
	repo, key, phase (starting, open, closing or closed), title, worktreePath,
	branch, profile, agentSessions, tmux (socket, socketFlag, agentSession,
	companionSession, agentTarget, companionTarget), panes (agent, companion),
	prNumber, prLinks, pipeline, unresolvedCommentCount and status. With no
	key it answers for the space it runs in: PAPPARDELLE_SPACE, else the
	worktree or main checkout that holds the working directory.

	space list prints the main space, then every open space in the rail's order.

	Options
	  --json          Print the record as JSON
	  --field <name>  Print one field, such as profile or tmux.agentTarget: a
	                  string bare, an object as JSON, nothing for null. Repeat
	                  for several, printed as one JSON object keyed by name

	Exit codes
	  0  Printed
	  1  No such space, or not in a space and no key given
	  2  Usage
	  3  A state store could not be read. space list still prints the
	     spaces it could read and names each one it could not
`;

export const AGENT_PROFILE_USAGE =
	'Usage: pappardelle agent-profile list [--json]';

export const AGENT_PROFILE_HELP = `
	Usage
	  $ pappardelle agent-profile list [--json]

	Lists the agent profiles a space can be opened on, one name per line: the
	built-in claude and every entry under agent_profiles: in the merged config.
	Pass one to pappardelle --agent-profile <name> to open a space on it.

	Options
	  --json  Print [{name, sources}], sources being the config files that
	          define the profile, highest priority first ([] for the built-in
	          claude)

	Exit codes
	  0  Printed
	  2  Usage
	  3  The config could not be read
`;

export function parseCli(argv: readonly string[] = process.argv.slice(2)) {
	return meow(helpText, {
		importMeta: {...import.meta, url: packageJsonUrl},
		// `send` reads its key and text from raw argv (parseSendArgs).
		argv: argv[0] === 'send' ? ['send'] : [...argv],
		// `update` asks on a TTY only when neither --restart-tuis nor
		// --no-restart-tuis was passed, which meow's default of false would make
		// indistinguishable.
		booleanDefault: undefined,
		flags: {
			profile: {type: 'string'},
			agentProfile: {type: 'string'},
			resume: {type: 'boolean'},
			wait: {type: 'boolean'},
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
			focus: {
				type: 'boolean',
			},
			keys: {
				type: 'string',
				isMultiple: true,
			},
			json: {
				type: 'boolean',
			},
			turns: {
				type: 'number',
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
	mcp: {
		usage: 'pappardelle mcp [install]',
		flags: [],
		help: `
	Usage
	  $ pappardelle mcp
	  $ pappardelle mcp install

	mcp serves Pappardelle's commands as MCP tools over stdio, for the session
	that started it. Agents start this, so you shouldn't need to. Outside a repo
	with a .pappardelle.yml it serves no tools.

	mcp install adds that server to each of Codex, OpenCode, Antigravity and Pi
	that is installed, and auto-approves its companion tools where the agent asks
	first. install.sh runs this. Claude Code gets both from the plugin.
`,
	},
	'plugin install': {
		usage: 'pappardelle plugin install',
		flags: [],
		help: `
	Usage
	  $ pappardelle plugin install

	Installs the Pappardelle plugin (skills, hooks and MCP tools) from this
	install into Claude Code, Codex and agy, skipping any that isn't installed.
	  Claude Code: points pappardelle-marketplace at the install; it loads the
	    plugin in place, so a new install takes effect after /reload-plugins.
	    Removes the hooks older installs merged into ~/.claude/settings.json.
	  Codex: installs the plugin's skills, and points the session hook in
	    ~/.codex/hooks.json at the install.
	  agy: links ~/.gemini/config/plugins/pappardelle to the install. Restart
	    open agy sessions to load it (agy has no /reload-plugins).
	Files it changes are backed up to <file>.pappardelle.bak first.
`,
	},
} as const;

// The prompt is read from raw argv because meow would pull anything
// flag-shaped out of it.
// Only --keys and --force right after the key are flags, so a prompt that
// mentions them later on is still sent as text.
export function parseSendArgs(argv: readonly string[]): {
	key?: string;
	text: string;
	keys: string[];
	force: boolean;
} {
	const [key, ...rest] = argv.slice(argv.indexOf('send') + 1);
	if (key === undefined || key.startsWith('-'))
		return {text: '', keys: [], force: false};
	const keys: string[] = [];
	let force = false;
	for (;;) {
		if (rest[0] === '--force') {
			rest.shift();
			force = true;
		} else if (rest[0] === '--keys' || rest[0]?.startsWith('--keys=')) {
			const flag = rest.shift()!;
			const value = flag === '--keys' ? rest.shift() : flag.slice(7);
			if (value) keys.push(value);
		} else {
			break;
		}
	}

	// A --force typed after the text is still the flag; text that really ends
	// in --force goes on stdin. One inside the text is text.
	const trailing = rest.length > 1 && rest.at(-1) === '--force';
	return {
		key,
		text: (trailing ? rest.slice(0, -1) : rest).join(' '),
		keys,
		force: force || trailing,
	};
}

export type SubcommandGate =
	| {action: 'run'}
	| {action: 'help'; text: string}
	| {action: 'reject'; message: string};

// `close`, `restart` and `update` act on live spaces or TUIs and `plugin
// install` rewrites Claude Code settings, so a flag they don't know must stop
// them. meow only answers --help when it is the sole argument and otherwise
// ignores unknown flags.
export function subcommandGate(argv: readonly string[]): SubcommandGate {
	// Any other `plugin ...` is a typo, not a prompt, and as a prompt it would
	// create a workspace.
	const name = argv[0] === 'plugin' ? 'plugin install' : argv[0];
	if (name === undefined || !Object.hasOwn(subcommands, name)) {
		return {action: 'run'};
	}

	const {usage, flags, help} = subcommands[name as keyof typeof subcommands];
	const given = argv.filter(arg => arg.startsWith('-'));
	if (given.some(arg => arg === '--help' || arg === '-h')) {
		return {action: 'help', text: help};
	}

	if (
		name === 'plugin install' &&
		argv.filter(arg => !arg.startsWith('-')).join(' ') !== 'plugin install'
	) {
		return {
			action: 'reject',
			message: `Unknown command pappardelle ${argv.join(' ')}\nUsage: ${usage}`,
		};
	}

	if (
		name === 'mcp' &&
		!['mcp', 'mcp install'].includes(
			argv.filter(arg => !arg.startsWith('-')).join(' '),
		)
	) {
		return {
			action: 'reject',
			message: `Unknown command pappardelle ${argv.join(' ')}\nUsage: ${usage}`,
		};
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

	if (given.includes('--restart-tuis') && given.includes('--no-restart-tuis')) {
		return {
			action: 'reject',
			message: `--restart-tuis and --no-restart-tuis can't be combined\nUsage: ${usage}`,
		};
	}

	return {action: 'run'};
}
