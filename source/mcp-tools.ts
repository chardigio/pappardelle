// The tools `pappardelle mcp` serves. Each maps its JSON input onto a CLI call,
// so the CLI keeps owning validation and behavior. Text goes on stdin rather
// than in argv so that text starting with "-" isn't read as a flag.
//
// `update` and `restart --hard` stay CLI-only: one replaces the install and the
// other ends every session, so both should take a deliberate command.

import {z} from 'zod';

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
const pane = z
	.string()
	.optional()
	.describe('Pane name. Defaults to main, the pane the companion starts with');
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
 * Approved without a prompt on every agent, because an agent has to change the
 * companion constantly to keep showing its work.
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
] as const;

export const MCP_TOOLS: readonly McpTool[] = [
	defineTool({
		name: 'companion_run',
		description:
			"Run a command in a pane of a space's companion, replacing what runs there. An existing pane restarts with the new command, so running again with the same name doesn't add a pane. A missing pane is split off main. Use a named split for an app, dev server or test watcher so the user can watch it start",
		inputSchema: {
			command: z
				.string()
				.describe('Shell line to run. Pipes and redirects work'),
			pane,
			split: z
				.enum(['right', 'down'])
				.optional()
				.describe('Direction for a new pane. Defaults to down'),
			size: z
				.string()
				.optional()
				.describe(
					'Size of a new pane: lines or columns (40), or a share (30%)',
				),
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
		description: 'Resize a pane inside the companion',
		inputSchema: {
			pane: z.string().describe('Pane name'),
			width: z.string().optional().describe('Columns (60) or a share (40%)'),
			height: z.string().optional().describe('Lines (10) or a share (40%)'),
			space,
		},
		toCli: ({pane, width, height, space}) => ({
			args: ['companion', 'resize', pane, ...flags({width, height, space})],
		}),
	}),
	defineTool({
		name: 'companion_close',
		description:
			"Close a companion pane. main can't be closed; run something else in it",
		destructive: true,
		inputSchema: {pane: z.string().describe('Pane name'), space},
		toCli: ({pane, space}) => ({
			args: ['companion', 'close', pane, ...flags({space})],
		}),
	}),
	defineTool({
		name: 'companion_list',
		description:
			"List a space's companion panes: name, pane id, command, size, active",
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
		inputSchema: {key},
		toCli: ({key}) => ({args: ['highlight', key]}),
	}),
	defineTool({
		name: 'space_send',
		description:
			"Type a prompt into a space's agent TUI as if the user did: clears the input line, types the text literally, presses Enter. Slash commands are prompts. Use it when the user asks for it; to talk to another agent, use SendMessage. Fails with No active session when the agent's session isn't running: reopen with space_open (resume and wait) first",
		inputSchema: {key, text: z.string().min(1)},
		toCli: ({key, text}) => ({args: ['send', key], stdin: text}),
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
		name: 'tui_restart',
		description:
			"Restart this repo's TUI when it looks frozen or stale, and confirm it came back. Agent sessions keep running",
		inputSchema: {},
		toCli: () => ({args: ['restart']}),
	}),
];
