import {
	MAIN_PANE,
	SPLIT_LIST_FORMAT,
	parseCompanionListing,
	splitOptionArgs,
	type CompanionSplit,
	type SplitDirection,
} from './companion-splits.ts';
import {
	getCompanionEnabled,
	loadConfig,
	type PappardelleConfig,
} from './config.ts';
import type {PaneWidth} from './layout-sizing.ts';
import {readSpaceState} from './space-state.ts';
import {MAIN_WORKTREE_KEY} from './space-utils.ts';
import {
	buildShellLaunchArgs,
	createCompanionSplit,
	defaultInnerTmuxRunner,
	exactSessionTarget,
	getSessionNames,
	INNER_SOCKET,
	resolveInnerSessionTargetSync,
	type OuterTmuxRunner,
} from './tmux.ts';

// main is the companion session's own pane, named with the pane user option
// @pappa_pane. Every other pane is a split: a session of its own (see
// companion-splits.ts), which the TUI shows in a framed pane beside main.

export class CompanionError extends Error {}

/**
 * Why a space has no companion pane, or null when it has one. With the
 * companion off the TUI starts no companion session, so without this check
 * a verb fails with "no companion session", which reads as a bug to fix
 * rather than a setting. The profile is the space's saved one: the CLI has no
 * issue title, so a legacy space that only a title keyword matches is checked
 * against the top-level value.
 */
export function companionOffReason(
	config: PappardelleConfig,
	spaceKey: string,
	profileName?: string,
): string | null {
	if (getCompanionEnabled(config, undefined, profileName)) return null;
	const where =
		profileName !== undefined &&
		config.profiles[profileName]?.companion === false
			? `profiles.${profileName}`
			: 'the top-level config';
	return `${spaceKey}'s companion is off (${where} sets companion: false), so it has no companion pane. Set companion: true to use the companion verbs`;
}

/** `companionOffReason` for a space of the repo, from the config on disk. */
export function spaceCompanionOffReason(
	spaceKey: string,
	repoName: string,
): string | null {
	try {
		const profile =
			spaceKey === MAIN_WORKTREE_KEY
				? undefined
				: readSpaceState(repoName, spaceKey)?.profile;
		return companionOffReason(loadConfig(), spaceKey, profile);
	} catch {
		// A config that does not load cannot turn the companion off; the verb
		// reports its own error.
		return null;
	}
}

export interface CompanionPane {
	name: string | null;
	paneId: string;
	split: SplitDirection | null;
	size: PaneWidth | null;
	command: string;
	startCommand: string;
	width: number;
	height: number;
	/** The TUI is showing it. */
	shown: boolean;
}

export interface CompanionDeps {
	runner?: OuterTmuxRunner;
	repoName?: string;
}

const PANE_FORMAT = [
	'#{pane_id}',
	'#{@pappa_pane}',
	'#{pane_current_command}',
	'#{pane_width}',
	'#{pane_height}',
	'#{session_attached}',
	'#{pane_start_command}',
].join('\t');

function tmux(runner: OuterTmuxRunner, args: string[]): string {
	const result = runner(args);
	if (result.error || result.status !== 0) {
		const reason =
			result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
		throw new CompanionError(`tmux ${args[0]} failed: ${reason}`);
	}

	return result.stdout;
}

function paneNumber(paneId: string): number {
	return Number.parseInt(paneId.replace(/^%/, ''), 10);
}

export function parsePaneList(stdout: string): CompanionPane[] {
	return stdout
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [paneId, name, command, width, height, attached, ...start] =
				line.split('\t');
			return {
				paneId: paneId!,
				name: name || null,
				split: null,
				size: null,
				command: command ?? '',
				width: Number(width),
				height: Number(height),
				shown: Number(attached) > 0,
				startCommand: start.join('\t'),
			};
		});
}

/**
 * The `=session:` target of a space's companion session. Only the companion
 * name is ever built here, so no verb can reach the space's agent session.
 */
export function companionSessionTarget(
	spaceKey: string,
	deps: CompanionDeps = {},
): string {
	const runner = deps.runner ?? defaultInnerTmuxRunner;
	const session = getSessionNames(spaceKey, deps.repoName).companion;
	const target = resolveInnerSessionTargetSync(session, runner);
	if (!target) {
		throw new CompanionError(
			`No companion session for ${spaceKey} (${session} on ${INNER_SOCKET}). Select the space in Pappardelle to start it.`,
		);
	}

	return target;
}

/**
 * List the session's panes, first naming the session's original pane `main`
 * if nothing carries that name yet. Sessions made before panes had names, or
 * by idow's bash, start untagged. tmux pane ids only grow and respawn-pane
 * keeps the id, so the lowest id is the pane the session started with.
 */
export function listCompanionPanes(
	target: string,
	runner: OuterTmuxRunner,
): CompanionPane[] {
	const panes = parsePaneList(
		tmux(runner, ['list-panes', '-s', '-t', target, '-F', PANE_FORMAT]),
	);
	if (panes.length === 0 || panes.some(pane => pane.name === MAIN_PANE))
		return panes;
	let original = panes[0]!;
	for (const pane of panes) {
		if (paneNumber(pane.paneId) < paneNumber(original.paneId)) original = pane;
	}

	tmux(runner, [
		'set-option',
		'-p',
		'-t',
		original.paneId,
		'@pappa_pane',
		MAIN_PANE,
	]);
	original.name = MAIN_PANE;
	return panes;
}

function loadSpace(spaceKey: string, deps: CompanionDeps) {
	const runner = deps.runner ?? defaultInnerTmuxRunner;
	const session = getSessionNames(spaceKey, deps.repoName).companion;
	const target = companionSessionTarget(spaceKey, {...deps, runner});
	const main = listCompanionPanes(target, runner).find(
		pane => pane.name === MAIN_PANE,
	)!;
	const {splits} = parseCompanionListing(
		tmux(runner, ['list-sessions', '-F', SPLIT_LIST_FORMAT]),
		session,
	);
	return {runner, session, main, splits};
}

type Space = ReturnType<typeof loadSpace>;

function findSplit(space: Space, name: string): CompanionSplit {
	const split = space.splits.find(each => each.name === name);
	if (!split) {
		const names = [MAIN_PANE, ...space.splits.map(each => each.name)];
		throw new CompanionError(
			`No companion pane named ${name} (panes: ${names.join(', ')})`,
		);
	}

	return split;
}

/** The pane id for keys and reads: main's pane, or the split's one pane. */
function paneTarget(space: Space, name: string): string {
	return name === MAIN_PANE ? space.main.paneId : findSplit(space, name).paneId;
}

function setSplitSize(
	runner: OuterTmuxRunner,
	split: CompanionSplit,
	size: PaneWidth,
): void {
	tmux(runner, splitOptionArgs(split.session, 'size', size));
}

function refuseMainSize(pane: string): void {
	if (pane === MAIN_PANE) {
		throw new CompanionError(
			"main's size is the companion column; use companion width to change it",
		);
	}
}

export type RunResult = {created: boolean};

export function runInCompanion(
	spaceKey: string,
	options: {
		pane: string;
		split: SplitDirection;
		size?: PaneWidth;
		command: string;
	},
	deps: CompanionDeps = {},
): RunResult {
	if (options.size !== undefined) refuseMainSize(options.pane);

	const space = loadSpace(spaceKey, deps);
	const launch = buildShellLaunchArgs(options.command);
	const split = space.splits.find(each => each.name === options.pane);
	const existing = options.pane === MAIN_PANE ? space.main : split;
	if (existing) {
		// #{session_path} keeps the command in the worktree even after the user
		// has cd'd elsewhere in the pane.
		tmux(space.runner, [
			'respawn-pane',
			'-k',
			'-t',
			existing.paneId,
			'-c',
			'#{session_path}',
			...launch,
		]);
		if (split && options.size !== undefined)
			setSplitSize(space.runner, split, options.size);
		return {created: false};
	}

	const created = createCompanionSplit(
		spaceKey,
		{...options, name: options.pane},
		{runner: space.runner, repoName: deps.repoName},
	);
	if (!created.ok) throw new CompanionError(created.reason);
	return {created: true};
}

/**
 * Text is typed literally and Enter goes separately, so a TUI never reads
 * the Enter as part of a paste. Unlike `send`, there is no C-u first: in a
 * program like less or lazygit it is a command of its own.
 */
export function sendCompanionKeys(
	spaceKey: string,
	options: {pane: string; text?: string; keys: string[]; enter: boolean},
	deps: CompanionDeps = {},
): void {
	const space = loadSpace(spaceKey, deps);
	const paneId = paneTarget(space, options.pane);
	if (options.keys.length > 0) {
		for (const key of options.keys) {
			tmux(space.runner, ['send-keys', '-t', paneId, key]);
		}

		return;
	}

	if (options.text)
		tmux(space.runner, ['send-keys', '-t', paneId, '-l', '--', options.text]);
	if (options.enter) tmux(space.runner, ['send-keys', '-t', paneId, 'Enter']);
}

export function readCompanionPane(
	spaceKey: string,
	options: {pane: string; lines: number},
	deps: CompanionDeps = {},
): string {
	const space = loadSpace(spaceKey, deps);
	const output = tmux(space.runner, [
		'capture-pane',
		'-p',
		'-J',
		'-S',
		`-${options.lines}`,
		'-t',
		paneTarget(space, options.pane),
	]);
	// capture-pane runs from -S through the bottom of the screen, so a short
	// --lines still captures a whole screenful.
	return output
		.replace(/\n+$/, '')
		.split('\n')
		.slice(-options.lines)
		.join('\n');
}

export function resizeCompanionPane(
	spaceKey: string,
	options: {pane: string; size: PaneWidth},
	deps: CompanionDeps = {},
): void {
	refuseMainSize(options.pane);
	const space = loadSpace(spaceKey, deps);
	setSplitSize(space.runner, findSplit(space, options.pane), options.size);
}

export function closeCompanionPane(
	spaceKey: string,
	pane: string,
	deps: CompanionDeps = {},
): void {
	if (pane === MAIN_PANE) {
		throw new CompanionError(
			`main can't be closed; use companion run --pane main -- <command> to change it`,
		);
	}

	const space = loadSpace(spaceKey, deps);
	tmux(space.runner, [
		'kill-session',
		'-t',
		exactSessionTarget(findSplit(space, pane).session),
	]);
}

export function listCompanion(
	spaceKey: string,
	deps: CompanionDeps = {},
): CompanionPane[] {
	const space = loadSpace(spaceKey, deps);
	return [
		space.main,
		...space.splits.map(split => ({
			name: split.name,
			paneId: split.paneId,
			split: split.split,
			size: split.size,
			command: split.command,
			startCommand: split.startCommand,
			width: split.width,
			height: split.height,
			shown: split.shown,
		})),
	];
}

export function formatPaneList(panes: CompanionPane[]): string {
	return panes
		.map(pane =>
			[
				pane.name ?? '-',
				pane.paneId,
				pane.command,
				`${pane.width}x${pane.height}`,
				pane.split
					? `${pane.split}${pane.size === null ? '' : ` ${pane.size}`}`
					: '',
				pane.shown ? 'shown' : '',
			]
				.filter(Boolean)
				.join('  '),
		)
		.join('\n');
}
