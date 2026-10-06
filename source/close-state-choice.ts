import {AUTO_REMOVE_STATE_TYPES} from './auto-remove.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from './providers/types.ts';

export type StateChoice =
	// Stands in for the done state until the tracker's states have loaded, so
	// Enter pressed early still closes the issue.
	| {kind: 'close'}
	| {kind: 'set'; state: TrackerState}
	| {kind: 'leave'; currentName: string | undefined};

export function closeSpaceContent(spaceName: string) {
	return {
		title: 'Close Space',
		message: `Close space ${spaceName}?`,
		detail: 'The worktree and git branch will remain on disk.',
		processingMessage: `Closing space ${spaceName}…`,
	};
}

const DONE_KEY = 'done';
const PREFERRED_DONE_ID = 'closed';

export function choiceKey(choice: StateChoice): string {
	switch (choice.kind) {
		case 'close': {
			return DONE_KEY;
		}

		case 'set': {
			return choice.state.id === PREFERRED_DONE_ID
				? DONE_KEY
				: `set:${choice.state.id}`;
		}

		case 'leave': {
			return 'leave';
		}
	}
}

/** `states` is null while loading and when the load failed. */
export function buildStateChoices(
	states: TrackerState[] | null,
	current: TrackerIssue | null | undefined,
): StateChoice[] {
	const leave: StateChoice = {kind: 'leave', currentName: current?.state.name};
	if (!states || states.length === 0) return [{kind: 'close'}, leave];
	return [
		...states.map(state => ({kind: 'set', state}) satisfies StateChoice),
		leave,
	];
}

function isAlreadyDone(
	choices: StateChoice[],
	current: TrackerIssue | null | undefined,
): boolean {
	if (!current) return false;
	if (AUTO_REMOVE_STATE_TYPES.has(current.state.type)) return true;
	return choices.some(
		choice =>
			choice.kind === 'set' &&
			choice.state.done &&
			choice.state.name === current.state.name,
	);
}

export function defaultChoiceKey(
	choices: StateChoice[],
	current: TrackerIssue | null | undefined,
): string {
	if (isAlreadyDone(choices, current)) return 'leave';
	if (choices.some(choice => choiceKey(choice) === DONE_KEY)) return DONE_KEY;
	const firstDone = choices.find(
		choice => choice.kind === 'set' && choice.state.done,
	);
	return firstDone ? choiceKey(firstDone) : choiceKey(choices[0]!);
}

export function cycleChoice(
	index: number,
	count: number,
	direction: 'left' | 'right',
): number {
	if (count <= 0) return 0;
	const step = direction === 'right' ? 1 : -1;
	return (((index + step) % count) + count) % count;
}

export function choiceLabel(choice: StateChoice): string {
	switch (choice.kind) {
		case 'close': {
			return 'Closed';
		}

		case 'set': {
			return choice.state.name;
		}

		case 'leave': {
			return choice.currentName
				? `Leave as ${choice.currentName}`
				: 'Leave unchanged';
		}
	}
}

/** Resolves false when the tracker rejected the write. */
export async function applyStateChoice(
	tracker: IssueTrackerProvider,
	issueKey: string,
	choice: StateChoice | undefined,
): Promise<boolean> {
	if (!choice) return true;
	switch (choice.kind) {
		case 'close': {
			return (await tracker.closeIssue?.(issueKey)) ?? false;
		}

		case 'set': {
			return (
				(await tracker.setIssueState?.(issueKey, choice.state.id)) ?? false
			);
		}

		case 'leave': {
			return true;
		}
	}
}
