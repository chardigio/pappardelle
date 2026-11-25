import {test, expect} from 'bun:test';
import {
	applyStateChoice,
	buildStateChoices,
	choiceKey,
	choiceLabel,
	cycleChoice,
	defaultChoiceKey,
	type StateChoice,
} from './close-state-choice.ts';
import type {
	IssueTrackerProvider,
	TrackerIssue,
	TrackerState,
} from './providers/types.ts';

const STATES: TrackerState[] = [
	{id: 'open', name: 'Open', done: false},
	{id: 'in_progress', name: 'In Progress', done: false},
	{id: 'closed', name: 'Closed', done: true},
	{id: 'deferred', name: 'Deferred', done: false},
];

function issue(name: string, type: string): TrackerIssue {
	return {
		identifier: 'bd-1',
		title: 't',
		state: {name, type, color: ''},
		project: null,
	};
}

const IN_PROGRESS = issue('In Progress', 'in_progress');

test('an open issue defaults to closed', () => {
	const choices = buildStateChoices(STATES, IN_PROGRESS);
	const key = defaultChoiceKey(choices);
	const chosen = choices.find(choice => choiceKey(choice) === key)!;
	expect(choiceLabel(chosen)).toBe('Closed');
});

test('an issue that is already done defaults to leaving it', () => {
	const closed = issue('Closed', 'completed');
	expect(defaultChoiceKey(buildStateChoices(STATES, closed))).toBe('leave');

	const states = [...STATES, {id: 'in_review', name: 'In Review', done: true}];
	const reviewed = issue('In Review', 'in_review');
	expect(defaultChoiceKey(buildStateChoices(states, reviewed))).toBe('leave');
});

test('without a closed state the first done state is the default', () => {
	const states = [
		{id: 'open', name: 'Open', done: false},
		{id: 'shipped', name: 'Shipped', done: true},
	];
	expect(defaultChoiceKey(buildStateChoices(states, IN_PROGRESS))).toBe(
		'set:shipped',
	);
});

test('before states load, Enter still closes the issue', () => {
	for (const states of [null, []]) {
		const choices = buildStateChoices(states, IN_PROGRESS);
		expect(choices.map(choice => choice.kind)).toStrictEqual([
			'close',
			'leave',
		]);
		expect(defaultChoiceKey(choices)).toBe(choiceKey({kind: 'close'}));
	}
});

test('the loading stand-in and the loaded closed state are the same selection', () => {
	expect(choiceKey({kind: 'close'})).toBe(
		choiceKey({kind: 'set', state: STATES[2]!}),
	);
});

test('cycling wraps at both ends', () => {
	expect(cycleChoice(4, 5, 'right')).toBe(0);
	expect(cycleChoice(0, 5, 'left')).toBe(4);
	expect(cycleChoice(1, 5, 'right')).toBe(2);
});

test('leave names the current state', () => {
	expect(
		choiceLabel({
			kind: 'leave',
			currentName: 'In Progress',
			currentDone: false,
		}),
	).toBe('Leave as In Progress');
	expect(
		choiceLabel({kind: 'leave', currentName: undefined, currentDone: false}),
	).toBe('Leave unchanged');
});

function recordingTracker(result: boolean) {
	const calls: string[][] = [];
	const tracker = {
		async closeIssue(key: string) {
			calls.push(['close', key]);
			return result;
		},
		async setIssueState(key: string, id: string) {
			calls.push(['set', key, id]);
			return result;
		},
	} as unknown as IssueTrackerProvider;
	return {tracker, calls};
}

test('applying a choice makes the matching tracker call', async () => {
	const {tracker, calls} = recordingTracker(true);
	const deferred: StateChoice = {kind: 'set', state: STATES[3]!};
	expect(await applyStateChoice(tracker, 'bd-1', {kind: 'close'})).toBe(true);
	expect(await applyStateChoice(tracker, 'bd-1', deferred)).toBe(true);
	expect(
		await applyStateChoice(tracker, 'bd-1', {
			kind: 'leave',
			currentName: 'Open',
		}),
	).toBe(true);
	expect(calls).toStrictEqual([
		['close', 'bd-1'],
		['set', 'bd-1', 'deferred'],
	]);
});

test('a rejected write comes back false', async () => {
	const {tracker} = recordingTracker(false);
	expect(await applyStateChoice(tracker, 'bd-1', {kind: 'close'})).toBe(false);
});

test('the current status is offered only as Leave', () => {
	const labels = buildStateChoices(STATES, IN_PROGRESS).map(choice =>
		choiceLabel(choice),
	);
	expect(labels).toStrictEqual([
		'Open',
		'Closed',
		'Deferred',
		'Leave as In Progress',
	]);
});
