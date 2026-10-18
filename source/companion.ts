import type {SplitDirection} from './companion-args.ts';
import {
	MAIN_PANE,
	buildShellLaunchArgs,
	defaultInnerTmuxRunner,
	getSessionNames,
	INNER_SOCKET,
	resolveInnerSessionTarget,
	type OuterTmuxRunner,
} from './tmux.ts';

// Panes in a space's companion session are named with the pane user option
// @pappa_pane. @pappa_split remembers which way a pane was split off main, so
// `run --size` on an existing pane resizes the same axis it was created on.

export class CompanionError extends Error {}

export interface CompanionPane {
	name: string | null;
	paneId: string;
	split: SplitDirection | null;
	command: string;
	startCommand: string;
	width: number;
	height: number;
	active: boolean;
}

export interface CompanionDeps {
	runner?: OuterTmuxRunner;
	repoName?: string;
}

const PANE_FORMAT = [
	'#{pane_id}',
	'#{@pappa_pane}',
	'#{@pappa_split}',
	'#{pane_current_command}',
	'#{pane_width}',
	'#{pane_height}',
	'#{pane_active}',
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
			const [paneId, name, split, command, width, height, active, ...start] =
				line.split('\t');
			return {
				paneId: paneId!,
				name: name || null,
				split: split === 'right' || split === 'down' ? split : null,
				command: command ?? '',
				width: Number(width),
				height: Number(height),
				active: active === '1',
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
	const target = resolveInnerSessionTarget(session, runner);
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

function findPane(panes: CompanionPane[], name: string): CompanionPane {
	const pane = panes.find(p => p.name === name);
	if (!pane) {
		const names = panes.map(p => p.name).filter(Boolean);
		throw new CompanionError(
			`No companion pane named ${name} (panes: ${names.join(', ')})`,
		);
	}

	return pane;
}

function loadCompanionPanes(spaceKey: string, deps: CompanionDeps) {
	const runner = deps.runner ?? defaultInnerTmuxRunner;
	const target = companionSessionTarget(spaceKey, {...deps, runner});
	return {runner, panes: listCompanionPanes(target, runner)};
}

export type RunResult = {paneId: string; created: boolean};

export function runInCompanion(
	spaceKey: string,
	options: {
		pane: string;
		split: SplitDirection;
		size?: string;
		command: string;
	},
	deps: CompanionDeps = {},
): RunResult {
	const {runner, panes} = loadCompanionPanes(spaceKey, deps);
	const launch = buildShellLaunchArgs(options.command);
	const existing = panes.find(p => p.name === options.pane);
	if (existing) {
		if (options.size !== undefined && !existing.split) {
			throw new CompanionError(
				`${options.pane} was not split off main, so --size has no axis; use companion resize ${options.pane} --width/--height`,
			);
		}

		// #{session_path} keeps the command in the worktree even after the user
		// has cd'd elsewhere in the pane.
		tmux(runner, [
			'respawn-pane',
			'-k',
			'-t',
			existing.paneId,
			'-c',
			'#{session_path}',
			...launch,
		]);
		if (options.size !== undefined) {
			tmux(runner, [
				'resize-pane',
				'-t',
				existing.paneId,
				existing.split === 'right' ? '-x' : '-y',
				options.size,
			]);
		}

		return {paneId: existing.paneId, created: false};
	}

	const main = findPane(panes, MAIN_PANE);
	const paneId = tmux(runner, [
		'split-window',
		'-d',
		options.split === 'right' ? '-h' : '-v',
		...(options.size === undefined ? [] : ['-l', options.size]),
		'-t',
		main.paneId,
		'-c',
		'#{session_path}',
		'-P',
		'-F',
		'#{pane_id}',
		...launch,
	]).trim();
	tmux(runner, ['set-option', '-p', '-t', paneId, '@pappa_pane', options.pane]);
	tmux(runner, [
		'set-option',
		'-p',
		'-t',
		paneId,
		'@pappa_split',
		options.split,
	]);
	return {paneId, created: true};
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
	const {runner, panes} = loadCompanionPanes(spaceKey, deps);
	const {paneId} = findPane(panes, options.pane);
	if (options.keys.length > 0) {
		for (const key of options.keys) {
			tmux(runner, ['send-keys', '-t', paneId, key]);
		}

		return;
	}

	if (options.text)
		tmux(runner, ['send-keys', '-t', paneId, '-l', '--', options.text]);
	if (options.enter) tmux(runner, ['send-keys', '-t', paneId, 'Enter']);
}

export function readCompanionPane(
	spaceKey: string,
	options: {pane: string; lines: number},
	deps: CompanionDeps = {},
): string {
	const {runner, panes} = loadCompanionPanes(spaceKey, deps);
	const {paneId} = findPane(panes, options.pane);
	const output = tmux(runner, [
		'capture-pane',
		'-p',
		'-J',
		'-S',
		`-${options.lines}`,
		'-t',
		paneId,
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
	options: {pane: string; width?: string; height?: string},
	deps: CompanionDeps = {},
): void {
	const {runner, panes} = loadCompanionPanes(spaceKey, deps);
	const {paneId} = findPane(panes, options.pane);
	tmux(runner, [
		'resize-pane',
		'-t',
		paneId,
		...(options.width === undefined ? [] : ['-x', options.width]),
		...(options.height === undefined ? [] : ['-y', options.height]),
	]);
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

	const {runner, panes} = loadCompanionPanes(spaceKey, deps);
	tmux(runner, ['kill-pane', '-t', findPane(panes, pane).paneId]);
}

export function listCompanion(
	spaceKey: string,
	deps: CompanionDeps = {},
): CompanionPane[] {
	return loadCompanionPanes(spaceKey, deps).panes;
}

export function formatPaneList(panes: CompanionPane[]): string {
	return panes
		.map(pane =>
			[
				pane.name ?? '-',
				pane.paneId,
				pane.command,
				`${pane.width}x${pane.height}`,
				pane.active ? 'active' : '',
			]
				.join('  ')
				.trimEnd(),
		)
		.join('\n');
}
