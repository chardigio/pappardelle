// The tools `pappardelle mcp` serves. Each maps its JSON input onto a CLI call,
// so the CLI keeps owning validation and behavior. Text goes on stdin rather
// than in argv so that text starting with "-" isn't read as a flag.
//
// `update` and `restart --hard` stay CLI-only: one replaces the install and the
// other ends every session, so both should take a deliberate command.

import {z} from 'zod';
import {PANE_NAME_PATTERN, PANE_NAME_RULE} from './companion-splits.ts';
import {MAX_WAIT_SECONDS} from './supervise-args.ts';
import {WATCH_TARGETS, type WatchTarget} from './space-watch.ts';

export type CliCall = {args: string[]; stdin?: string; cwd?: string};

export type McpTool = {
	name: string;
	description: string;
	readOnly: boolean;
	destructive: boolean;
	inputSchema: z.ZodRawShape;
	toCli: (input: Record<string, unknown>) => CliCall;
};

function defineTool<Shape extends z.ZodRawShape>(tool: {
	name: string;
	description: string;
	readOnly?: boolean;
	destructive?: boolean;
	inputSchema: Shape;
	toCli: (input: z.infer<z.ZodObject<Shape>>) => CliCall;
}): McpTool {
	return {
		readOnly: false,
		destructive: false,
		...tool,
		toCli: tool.toCli as McpTool['toCli'],
	};
}

function flags(values: Record<string, string | number | undefined>): string[] {
	return Object.entries(values).flatMap(([name, value]) =>
		value === undefined ? [] : [`--${name}`, String(value)],
	);
}

const space = z
	.string()
	.optional()
	.describe('Space key, such as STA-696. Defaults to your own space');
const paneName = z
	.string()
	.regex(PANE_NAME_PATTERN, `Pane names are ${PANE_NAME_RULE}`);
const pane = paneName
	.optional()
	.describe('Pane name. Defaults to main, the pane the companion starts with');
const splitSize = z
	.string()
	.describe(
		'Cells along the split (40), or a share of the companion column (30%). Counts the whole framed pane',
	);
const key = z
	.string()
	.describe(
		'Space key, such as STA-696. main is the main checkout. A bare number takes the team prefix',
	);
const tmuxKeys = z
	.array(z.string())
	.min(1)
	.describe('tmux key names, such as Escape, S-Tab or C-c, pressed in order');

/**
 * Approved without a prompt on every agent: the companion tools because an
 * agent changes its companion constantly to show its work, and the
 * supervision tools because watching other spaces means calling them in a
 * loop. space_answer stays safe unprompted because it approves only what
 * passes both gates (approve-policy.ts, then approve-classifier.ts), and has
 * no override.
 */
export const AUTO_APPROVED_TOOLS = [
	'companion_run',
	'companion_type',
	'companion_press_keys',
	'companion_read',
	'companion_resize',
	'companion_close',
	'companion_list',
	'companion_width',
	'space_send',
	'space_screen',
	'space_state',
	'space_question_tabs',
	'space_wait',
	'space_watch',
	'space_answer',
	'space_queue',
	'space_schedule',
	'space_schedules',
	'space_unschedule',
	'tui_panes',
	'tui_focus_log',
] as const;

export const MCP_TOOLS: readonly McpTool[] = [
	defineTool({
		name: 'companion_run',
		description:
			"Run a command in a pane of a space's companion, replacing what runs there. An existing pane restarts with the new command, so running again with the same name doesn't add a pane. A missing pane is split off main, and the TUI shows it in a framed pane of its own. Use a named split for an app, dev server or test watcher so the user can watch it start. The result says whether the TUI is showing it or when it will",
		inputSchema: {
			command: z
				.string()
				.describe('Shell line to run. Pipes and redirects work'),
			pane,
			split: z
				.enum(['right', 'down'])
				.optional()
				.describe('Direction for a new pane. Defaults to down'),
			size: splitSize.optional(),
			space,
		},
		toCli: ({command, pane, split, size, space}) => ({
			args: [
				'companion',
				'run',
				...flags({pane, split, size, space}),
				'--',
				command,
			],
		}),
	}),
	defineTool({
		name: 'companion_type',
		description:
			'Type text into the program running in a companion pane, then press Enter',
		inputSchema: {
			text: z.string().min(1),
			enter: z
				.boolean()
				.optional()
				.describe('Press Enter after the text. Defaults to true'),
			pane,
			space,
		},
		toCli: ({text, enter, pane, space}) => ({
			args: [
				'companion',
				'keys',
				...flags({pane, space}),
				...(enter === false ? ['--no-enter'] : []),
			],
			stdin: text,
		}),
	}),
	defineTool({
		name: 'companion_press_keys',
		description:
			'Press keys in the program running in a companion pane, with no Enter after them',
		inputSchema: {keys: tmuxKeys, pane, space},
		toCli: ({keys, pane, space}) => ({
			args: [
				'companion',
				'keys',
				...flags({pane, space}),
				...keys.flatMap(name => ['--keys', name]),
			],
		}),
	}),
	defineTool({
		name: 'companion_read',
		description: 'Read the last lines a companion pane is showing',
		readOnly: true,
		inputSchema: {
			lines: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('How many lines. Defaults to 50'),
			pane,
			space,
		},
		toCli: ({lines, pane, space}) => ({
			args: ['companion', 'read', ...flags({lines, pane, space})],
		}),
	}),
	defineTool({
		name: 'companion_resize',
		description:
			"Resize a companion split along the way it was split: its width for right, its height for down. The size is kept for that split. main's width is the companion column; set it with companion_width",
		inputSchema: {
			pane: paneName.describe('Pane name'),
			size: splitSize,
			space,
		},
		toCli: ({pane, size, space}) => ({
			args: ['companion', 'resize', pane, ...flags({size, space})],
		}),
	}),
	defineTool({
		name: 'companion_close',
		description:
			"Close a companion split and its framed pane in the TUI. main can't be closed; run something else in it",
		destructive: true,
		inputSchema: {pane: paneName.describe('Pane name'), space},
		toCli: ({pane, space}) => ({
			args: ['companion', 'close', pane, ...flags({space})],
		}),
	}),
	defineTool({
		name: 'companion_list',
		description:
			"List a space's companion panes: name, pane id, command, size in cells, which way and how big each split was asked for, and whether the TUI is showing it",
		readOnly: true,
		inputSchema: {space},
		toCli: ({space}) => ({
			args: ['companion', 'list', '--json', ...flags({space})],
		}),
	}),
	defineTool({
		name: 'companion_width',
		description:
			"Set a space's companion column width in the TUI. It applies while that space is selected and survives a TUI restart. The result says whether the TUI applied it (it may clamp it to fit) or when it will",
		inputSchema: {
			width: z
				.string()
				.describe('Columns (80), a share of the window (40%), or reset'),
			space,
		},
		toCli: ({width, space}) => ({
			args: ['companion', 'width', ...flags({space}), width],
		}),
	}),
	defineTool({
		name: 'spaces_list',
		description:
			'List every open space: agent status, minutes since the last update, issue title, PR, commits ahead and diff size against the base branch, pipeline, unresolved comments, recap',
		readOnly: true,
		inputSchema: {},
		toCli: () => ({args: ['spaces', '--json']}),
	}),
	defineTool({
		name: 'space_read',
		description:
			"Read the last turns of a space's conversation. A turn is a user prompt and the assistant text that answered it",
		readOnly: true,
		inputSchema: {
			key,
			turns: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('How many turns. Defaults to 5'),
		},
		toCli: ({key, turns}) => ({
			args: ['read', key, ...flags({turns}), '--json'],
		}),
	}),
	defineTool({
		name: 'space_highlight',
		description: 'Select a space in the TUI',
		inputSchema: {
			key,
			focus: z
				.boolean()
				.optional()
				.describe(
					"Also make the space's agent pane the active pane in the Pappardelle window, as Enter does in the rail",
				),
		},
		toCli: ({key, focus}) => ({
			args: ['highlight', key, ...(focus ? ['--focus'] : [])],
		}),
	}),
	defineTool({
		name: 'space_send',
		description:
			"Type a prompt into a space's agent TUI as if the user did: clears the input line, types the text literally, presses Enter. Slash commands are prompts. Use it when the user asks for it; to talk to another agent, use SendMessage. Fails with No active session when the agent's session isn't running: reopen with space_open (resume and wait) first",
		inputSchema: {
			key,
			text: z.string().min(1),
			force: z
				.boolean()
				.optional()
				.describe(
					"Send even though the agent's input box has text in it, which sending clears. Without it, a draft fails the send so a person's typing isn't thrown away",
				),
		},
		toCli: ({key, text, force}) => ({
			args: ['send', key, ...(force ? ['--force'] : [])],
			stdin: text,
		}),
	}),
	defineTool({
		name: 'space_press_keys',
		description:
			"Press keys in a space's agent TUI, without clearing or submitting anything. In Claude Code, Escape interrupts the turn, S-Tab cycles the permission mode (default, accept edits, plan), C-c clears the input and twice in a row exits",
		inputSchema: {key, keys: tmuxKeys},
		toCli: ({key, keys}) => ({
			args: ['send', key, ...keys.flatMap(name => ['--keys', name])],
		}),
	}),
	defineTool({
		name: 'space_screen',
		description:
			"Read a space's agent screen as the user sees it, with scrollback, or its companion pane's",
		readOnly: true,
		inputSchema: {
			key,
			companion: z
				.boolean()
				.optional()
				.describe('Read the companion instead of the agent'),
			pane: z
				.string()
				.optional()
				.describe('Companion pane name, with companion. Defaults to main'),
			lines: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Lines of scrollback. Defaults to 60'),
		},
		toCli: ({key, companion, pane, lines}) => ({
			args: [
				'screen',
				key,
				...(companion ? ['--companion'] : []),
				...flags({pane, lines}),
			],
		}),
	}),
	defineTool({
		name: 'space_state',
		description:
			"What a space's agent is doing: working, permission (a tool prompt, with the command, the subagent that asked and the numbered options), question (an AskUserQuestion dialog), auth, dialog (a Codex dialog such as folder trust; a person answers it), usage_limit (Codex, with the reset time), draft (text sitting in the input box), idle or no_session",
		readOnly: true,
		inputSchema: {key},
		toCli: ({key}) => ({args: ['state', key, '--json']}),
	}),
	defineTool({
		name: 'space_question_tabs',
		description:
			'Read every question of a multi-question AskUserQuestion dialog in a space. It presses Right through the tabs and Left back to the first, so the dialog ends where it started',
		inputSchema: {key},
		toCli: ({key}) => ({args: ['state', key, '--tabs', '--json']}),
	}),
	defineTool({
		name: 'space_wait',
		description:
			"Wait until a space's agent reaches a state, instead of checking it over and over. Returns its state and screen tail, or timedOut with the state as it is then: call it again to keep waiting. A space with no agent session returns at once with state no_session",
		readOnly: true,
		inputSchema: {
			key,
			until: z
				.enum(['working', 'idle', 'blocked', 'ready', 'changed'])
				.describe(
					'blocked: a prompt, question, login or usage limit. ready: anything but working. changed: any state other than the current one',
				),
			timeout_seconds: z
				.number()
				.int()
				.positive()
				.max(MAX_WAIT_SECONDS)
				.optional()
				.describe(
					'Defaults to 50, under the 60 seconds Codex gives a tool call. Raise it only if your client allows longer',
				),
		},
		toCli: ({key, until, timeout_seconds: timeout}) => ({
			args: ['wait', key, '--until', until, '--json', ...flags({timeout})],
		}),
	}),
	defineTool({
		name: 'space_watch',
		description:
			"Wait for any of several spaces to change state, for a supervising loop: call it, handle what it returns with space_answer or space_send, then call it again with the cursor it returned. Returns result changed with each space's old and new state and, for one waiting on a person, its prompt, question or dialog; or result timed_out. Without since, spaces already in an until state return at once; with it, only what changed after that cursor, so nothing that happened while you were handling another space is missed",
		readOnly: true,
		inputSchema: {
			keys: z
				.array(z.string())
				.optional()
				.describe(
					'Spaces to watch. Defaults to every space with an agent except your own',
				),
			until: z
				.array(z.enum(WATCH_TARGETS as [WatchTarget, ...WatchTarget[]]))
				.optional()
				.describe(
					'Return only for these states, and for a space that closes. blocked is any state waiting on a person: permission, question, auth, dialog or usage_limit. Without until, any change returns',
				),
			since: z
				.string()
				.optional()
				.describe('The cursor the previous space_watch returned'),
			timeout_seconds: z
				.number()
				.int()
				.positive()
				.max(MAX_WAIT_SECONDS)
				.optional()
				.describe(
					'Defaults to 50, under the 60 seconds Codex gives a tool call. Raise it only if your client allows longer',
				),
		},
		toCli: ({keys, until, since, timeout_seconds: timeout}) => ({
			args: [
				'watch',
				...(until ?? []).flatMap(state => ['--until', state]),
				...flags({since, timeout}),
				'--json',
				...(keys?.length ? ['--', ...keys] : []),
			],
		}),
	}),
	defineTool({
		name: 'space_answer',
		description:
			"Answer a permission prompt or question in a space's agent: an option number, several options on a multi-select question (ticked, then confirmed with Submit or Next), typed text into a question's free-text row, or keys. Each step is checked on screen, and an answer the agent didn't take fails rather than reporting success. A multi-question dialog takes one call per question, then option 1 on its review step to submit. Approving a Bash command once goes through only when it clears hard refusals (push, PR changes, --force, reset --hard, rm outside QA scratch, kill-server outside an isolated socket) and a model check finds it publishes nothing, deletes nothing outside the worktree or scratch, and sends no secrets. Anything else, edits, and every \"Yes, and don't ask again\" fail with the command and the reason for the user to decide. Ask the user then; don't work around it",
		inputSchema: {
			key,
			option: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('The number of the option to choose'),
			options: z
				.array(z.number().int().positive())
				.min(1)
				.optional()
				.describe(
					'On a multi-select question, every option to tick; the others are unticked',
				),
			text: z
				.string()
				.min(1)
				.optional()
				.describe(
					"Typed into a single-select question's free-text row (Type something) and submitted",
				),
			keys: z
				.array(z.string())
				.min(1)
				.optional()
				.describe(
					'tmux key names instead of an option. On a permission prompt only Escape, which declines',
				),
		},
		toCli: ({key, option, options, text, keys}) => ({
			args: [
				'answer',
				key,
				...[
					...(option === undefined ? [] : [option]),
					...(options ?? []),
				].flatMap(number => ['--option', String(number)]),
				// Joined, so an answer that starts with a dash stays the value.
				...(text === undefined ? [] : [`--text=${text}`]),
				...(keys ?? []).flatMap(name => ['--keys', name]),
			],
		}),
	}),
	defineTool({
		name: 'space_queue',
		description:
			"Hold a message for a space's next scheduled send, in place of what the schedule would send. Used once",
		inputSchema: {key, text: z.string().min(1)},
		toCli: ({key, text}) => ({args: ['queue', key], stdin: text}),
	}),
	defineTool({
		name: 'space_schedule',
		description:
			"Wake a space's agent later with an OS timer, which runs even when this session and the TUI don't: at (send message at a time), after_limit (send message, default continue, once its Codex usage limit resets), or keep_going (every interval: continue after a limit, and the nudge when the agent sits idle two checks in a row; never over a draft)",
		inputSchema: {
			key,
			kind: z.enum(['at', 'after_limit', 'keep_going']),
			at: z
				.string()
				.optional()
				.describe('For at: an ISO time, or HH:MM for its next occurrence'),
			message: z.string().optional().describe('For at and after_limit'),
			every: z
				.string()
				.optional()
				.describe('For keep_going: how often to check, such as 10m'),
			nudge: z.string().optional().describe('For keep_going'),
			until: z
				.string()
				.optional()
				.describe('For keep_going: when to stop, as an ISO time or HH:MM'),
		},
		toCli: ({key, kind, at, message, every, nudge, until}) => ({
			args: [
				'schedule',
				key,
				...(kind === 'at'
					? flags({at, message})
					: kind === 'after_limit'
						? ['--after-limit', ...flags({message})]
						: ['--keep-going', ...flags({every, nudge, until})]),
			],
		}),
	}),
	defineTool({
		name: 'space_schedules',
		description: 'List scheduled wake-ups, for one space or all',
		readOnly: true,
		inputSchema: {key: key.optional()},
		toCli: ({key}) => ({args: ['schedules', ...(key ? [key] : [])]}),
	}),
	defineTool({
		name: 'space_unschedule',
		description: 'Cancel a scheduled wake-up by the id space_schedules shows',
		inputSchema: {id: z.string()},
		toCli: ({id}) => ({args: ['unschedule', id]}),
	}),
	defineTool({
		name: 'space_open',
		description:
			'Open a space, or reopen one whose session is gone, and save it on the board. An issue key opens or resumes that issue. A description files a new issue, and the output names its key: never rerun one, since a rerun files a duplicate. A failure means setup or registration failed; if setup finished, the worktree may exist without showing on the board',
		inputSchema: {
			input: z
				.string()
				.describe(
					'Issue key, bare issue number, issue URL, or a description of the work',
				),
			resume: z
				.boolean()
				.optional()
				.describe(
					'true skips the initialization prompt for any input, false sends it even for an existing space. By default only an existing worktree opened by key skips it',
				),
			profile: z
				.string()
				.optional()
				.describe(
					"The profile's key in .pappardelle.yml, not its display name",
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					"Wait up to 60s for the space's agent to start, and fail if it isn't confirmed. Set it before space_send to a space you just reopened: a failed launch leaves a shell in the pane, which would run the text as a command. Spaces running Codex never confirm, since Codex doesn't report its status",
				),
		},
		toCli: ({input, resume, profile, wait}) => ({
			args: [
				...flags({profile}),
				...(resume === undefined ? [] : [resume ? '--resume' : '--no-resume']),
				...(wait ? ['--wait'] : []),
				'--',
				input,
			],
		}),
	}),
	defineTool({
		name: 'space_close',
		description:
			"Close a space like x in the TUI: runs its deinit hooks, ends its agent and companion sessions, removes it from the board. The worktree stays unless a hook removes it, and the issue's state doesn't change. Closing your own space ends this session, so say so and wait for the go first",
		destructive: true,
		inputSchema: {key},
		toCli: ({key}) => ({args: ['close', key, '--yes']}),
	}),
	defineTool({
		name: 'link_pr',
		description:
			"Record an existing GitHub PR or GitLab MR for this workspace, so the rail's status follows its published branch. Call it after creating or reusing a PR/MR, once per repository. It verifies the URL with gh or glab. If it fails, report that and keep the PR/MR: don't create another one to repair an indicator",
		inputSchema: {
			url: z.string().describe('HTTPS URL of the PR or MR'),
			repository: z
				.string()
				.optional()
				.describe(
					"Directory of the PR's source repository. Defaults to the directory this session started in. Pass it when you work in a nested repository",
				),
			workspace: z
				.string()
				.optional()
				.describe(
					'The outer workspace root, when the source repository is nested inside one',
				),
		},
		toCli: ({url, repository, workspace}) => ({
			args: ['link-pr', url, ...flags({workspace})],
			cwd: repository,
		}),
	}),
	defineTool({
		name: 'tui_panes',
		description:
			"Diagnostics: what each running TUI's rail and viewer panes are running (pane_start_command), to check which build they're on",
		readOnly: true,
		inputSchema: {},
		toCli: () => ({args: ['tui', 'panes']}),
	}),
	defineTool({
		name: 'tui_focus_log',
		description:
			'Diagnostics: log every change of the active pane in the TUIs and of client focus flags for a number of seconds, while the user reproduces a focus problem',
		readOnly: true,
		inputSchema: {
			seconds: z
				.number()
				.int()
				.positive()
				.max(MAX_WAIT_SECONDS)
				.optional()
				.describe('Defaults to 30'),
		},
		toCli: ({seconds}) => ({args: ['tui', 'focus-log', ...flags({seconds})]}),
	}),
	defineTool({
		name: 'tui_restart',
		description:
			"Restart this repo's TUI when it looks frozen or stale, and confirm it came back. Agent sessions keep running",
		inputSchema: {},
		toCli: () => ({args: ['restart']}),
	}),
];
