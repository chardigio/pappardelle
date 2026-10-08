import test from 'ava';
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

test('an open issue defaults to closed', t => {
	const choices = buildStateChoices(STATES, IN_PROGRESS);
	const key = defaultChoiceKey(choices);
	const chosen = choices.find(choice => choiceKey(choice) === key)!;
	t.is(choiceLabel(chosen), 'Closed');
});

test('an issue that is already done defaults to leaving it', t => {
	const closed = issue('Closed', 'completed');
	t.is(defaultChoiceKey(buildStateChoices(STATES, closed)), 'leave');

	const states = [...STATES, {id: 'in_review', name: 'In Review', done: true}];
	const reviewed = issue('In Review', 'in_review');
	t.is(defaultChoiceKey(buildStateChoices(states, reviewed)), 'leave');
});

test('without a closed state the first done state is the default', t => {
	const states = [
		{id: 'open', name: 'Open', done: false},
		{id: 'shipped', name: 'Shipped', done: true},
	];
	t.is(defaultChoiceKey(buildStateChoices(states, IN_PROGRESS)), 'set:shipped');
});

test('before states load, Enter still closes the issue', t => {
	for (const states of [null, []]) {
		const choices = buildStateChoices(states, IN_PROGRESS);
		t.deepEqual(
			choices.map(choice => choice.kind),
			['close', 'leave'],
		);
		t.is(defaultChoiceKey(choices), choiceKey({kind: 'close'}));
	}
});

test('the loading stand-in and the loaded closed state are the same selection', t => {
	t.is(choiceKey({kind: 'close'}), choiceKey({kind: 'set', state: STATES[2]!}));
});

test('cycling wraps at both ends', t => {
	t.is(cycleChoice(4, 5, 'right'), 0);
	t.is(cycleChoice(0, 5, 'left'), 4);
	t.is(cycleChoice(1, 5, 'right'), 2);
});

test('leave names the current state', t => {
	t.is(
		choiceLabel({
			kind: 'leave',
			currentName: 'In Progress',
			currentDone: false,
		}),
		'Leave as In Progress',
	);
	t.is(
		choiceLabel({kind: 'leave', currentName: undefined, currentDone: false}),
		'Leave unchanged',
	);
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

test('applying a choice makes the matching tracker call', async t => {
	const {tracker, calls} = recordingTracker(true);
	const deferred: StateChoice = {kind: 'set', state: STATES[3]!};
	t.true(await applyStateChoice(tracker, 'bd-1', {kind: 'close'}));
	t.true(await applyStateChoice(tracker, 'bd-1', deferred));
	t.true(
		await applyStateChoice(tracker, 'bd-1', {
			kind: 'leave',
			currentName: 'Open',
		}),
	);
	t.deepEqual(calls, [
		['close', 'bd-1'],
		['set', 'bd-1', 'deferred'],
	]);
});

test('a rejected write comes back false', async t => {
	const {tracker} = recordingTracker(false);
	t.false(await applyStateChoice(tracker, 'bd-1', {kind: 'close'}));
});

test('the current status is offered only as Leave', t => {
	const labels = buildStateChoices(STATES, IN_PROGRESS).map(choice =>
		choiceLabel(choice),
	);
	t.deepEqual(labels, ['Open', 'Closed', 'Deferred', 'Leave as In Progress']);
});
