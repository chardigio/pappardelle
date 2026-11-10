// A companion split is a tmux session of its own next to the space's
// companion session, so the TUI can show it in a framed pane of its own.
// Its arrangement lives in session options, read back in one list-sessions:
// @pappa_split is the way it was split off main, @pappa_size its size along
// that axis, and @pappa_order when it was made, so the TUI replays the splits
// in the order they were made.

import {parsePaneWidth, type PaneWidth} from './layout-sizing.ts';

/** The name of the companion's own pane, which the session starts with. */
export const MAIN_PANE = 'main';

// A name becomes part of a tmux session name, and `~` joins it to the
// companion's name, so it can't hold `~` or anything tmux rewrites.
export const PANE_NAME_PATTERN = /^[a-z\d][a-z\d-]*$/;

export function isPaneName(value: unknown): value is string {
	return typeof value === 'string' && PANE_NAME_PATTERN.test(value);
}

export const PANE_NAME_RULE =
	'lowercase letters, digits and dashes, starting with a letter or digit';

export type SplitDirection = 'right' | 'down';

export function isSplitDirection(value: unknown): value is SplitDirection {
	return value === 'right' || value === 'down';
}

// toSessionKey never produces `~`, so the space key always parses back.
const SEPARATOR = '~';

export function splitSessionName(
	companionSession: string,
	name: string,
): string {
	return `${companionSession}${SEPARATOR}${name}`;
}

/** The companion session a split session belongs to, or the name itself. */
export function owningCompanionSession(session: string): string {
	const index = session.indexOf(SEPARATOR);
	return index === -1 ? session : session.slice(0, index);
}

export type CompanionSplit = {
	name: string;
	session: string;
	split: SplitDirection;
	size: PaneWidth | null;
	order: number;
	paneId: string;
	command: string;
	width: number;
	height: number;
	/** A viewer has it attached, which is the TUI showing it. */
	shown: boolean;
	startCommand: string;
};

export const SPLIT_LIST_FORMAT = [
	'#{session_name}',
	'#{@pappa_split}',
	'#{@pappa_size}',
	'#{@pappa_order}',
	'#{pane_id}',
	'#{pane_current_command}',
	'#{pane_width}',
	'#{pane_height}',
	'#{session_attached}',
	'#{@pappa_splits_seeded}',
	'#{pane_start_command}',
].join('\t');

/** The splits of one companion session, from list-sessions in SPLIT_LIST_FORMAT. */
export function parseSplitList(
	stdout: string,
	companionSession: string,
): CompanionSplit[] {
	const prefix = splitSessionName(companionSession, '');
	const splits: CompanionSplit[] = [];
	for (const line of stdout.split('\n')) {
		const [
			session,
			split,
			size,
			order,
			paneId,
			command,
			width,
			height,
			attached,
			_seeded,
			...start
		] = line.split('\t');
		if (!session?.startsWith(prefix) || !isSplitDirection(split)) continue;
		splits.push({
			name: session.slice(prefix.length),
			session,
			split,
			size: size ? parsePaneWidth(size) : null,
			order: Number(order) || 0,
			paneId: paneId ?? '',
			command: command ?? '',
			width: Number(width),
			height: Number(height),
			shown: Number(attached) > 0,
			startCommand: start.join('\t'),
		});
	}

	return splits.sort(
		(a, b) => a.order - b.order || a.name.localeCompare(b.name),
	);
}

/**
 * Whether the configured splits were started for this companion session
 * already, from the same list-sessions output as `parseSplitList`.
 */
export function splitsSeeded(
	stdout: string,
	companionSession: string,
): boolean {
	return stdout.split('\n').some(line => {
		const fields = line.split('\t');
		return fields[0] === companionSession && Boolean(fields[9]);
	});
}

/**
 * What decides the outer panes' arrangement: the splits' names and
 * directions, in the order they were made. Size is left out, since a new
 * size is a resize of the panes already there, and so is when they were
 * made, so two spaces with the same splits share their panes.
 */
export function splitSignature(splits: readonly CompanionSplit[]): string {
	return JSON.stringify(splits.map(split => [split.name, split.split]));
}

/** The smallest the companion's main pane is left, so its frame still shows. */
export const MIN_MAIN_PANE = {width: 10, height: 5};

/**
 * Each split's size in cells along its axis, in the order the splits are
 * made. Each split comes off main, so main shrinks as they're made: a size
 * is cells or a percentage of the companion column, capped so main keeps
 * `MIN_MAIN_PANE`, and a split with no size takes half of what main has left.
 */
export function splitTargets(
	splits: ReadonlyArray<Pick<CompanionSplit, 'split' | 'size'>>,
	column: {width: number; height: number},
): number[] {
	const main = {...column};
	return splits.map(({split, size}) => {
		const axis = split === 'right' ? 'width' : 'height';
		// One cell of every split is the gap between it and main.
		const room = main[axis] - 1 - MIN_MAIN_PANE[axis];
		const length = split === 'right' ? column.width : column.height;
		const wanted =
			size === null
				? Math.floor((main[axis] - 1) / 2)
				: typeof size === 'number'
					? size
					: Math.floor((length * Number.parseFloat(size)) / 100);
		const cells = Math.max(1, Math.min(wanted, room));
		main[axis] -= cells + 1;
		return cells;
	});
}
