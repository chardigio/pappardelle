import test from 'ava';
import {
	agentPopupVisibleRows,
	buildAgentProfilePopupArgs,
	filterAgentProfiles,
	handleAgentPopupKey,
} from './agent-profile-popup.ts';

test('the popup command survives paths with spaces', t => {
	const args = buildAgentProfilePopupArgs(
		['/usr/local/bin/node', '/Users/me/My Tools/cli.js'],
		'/tmp/a b/request.json',
		'/tmp/a b/result',
		2,
	);
	t.is(
		args.at(-1),
		"'/usr/local/bin/node' '/Users/me/My Tools/cli.js' 'pick-agent-profile' '/tmp/a b/request.json' '/tmp/a b/result'",
	);
});

test('the popup is as tall as its list until the list scrolls', t => {
	const height = (count: number) => {
		const args = buildAgentProfilePopupArgs(['p'], 'r', 'o', count);
		return Number(args[args.indexOf('-h') + 1]);
	};

	t.is(height(2), 6);
	t.is(height(16), 20);
	t.is(height(30), 22);
});

test('a popup shorter than its list scrolls instead of overflowing', t => {
	t.is(agentPopupVisibleRows(12, 40), 12);
	// tmux shrank the popup to 10 rows: 2 for the hint, 2 for the scroll markers.
	t.is(agentPopupVisibleRows(12, 10), 6);
	t.is(agentPopupVisibleRows(30, 40), 14);
});

const choices = [
	'',
	'claude',
	'opus-high',
	'sonnet-high',
	'haiku-xhigh',
	'sol-high',
	'astra-high',
].map(name => ({name, source: 'x'}));
const names = (query: string) =>
	filterAgentProfiles(choices, query).map(choice => choice.name);

test('filterAgentProfiles ranks the tightest in-order match first', t => {
	t.deepEqual(names('sh'), [
		'sol-high',
		'opus-high',
		'astra-high',
		'sonnet-high',
	]);
	t.deepEqual(names('xh'), ['haiku-xhigh']);
	t.deepEqual(names('zz'), []);
});

test("filterAgentProfiles matches the profile's-agent row by its label", t => {
	t.deepEqual(names('prof'), ['']);
});

test('filterAgentProfiles keeps the full list in order for an empty query', t => {
	t.deepEqual(
		names(' '),
		choices.map(choice => choice.name),
	);
});

test('/ starts a filter where j and k are text, not movement', t => {
	let {state} = handleAgentPopupKey({query: null, index: 3}, '/', {}, 7);
	t.deepEqual(state, {query: '', index: 0});
	({state} = handleAgentPopupKey(state, 'j', {}, 7));
	({state} = handleAgentPopupKey(state, 'k', {}, 1));
	t.deepEqual(state, {query: 'jk', index: 0});
	({state} = handleAgentPopupKey(state, '', {backspace: true}, 0));
	t.is(state.query, 'j');
});

test('Esc while filtering leaves the filter, not the popup', t => {
	t.deepEqual(
		handleAgentPopupKey({query: 'so', index: 1}, '', {escape: true}, 2),
		{
			state: {query: null, index: 0},
		},
	);
	t.is(
		handleAgentPopupKey({query: null, index: 1}, '', {escape: true}, 7).action,
		'cancel',
	);
});

test('Enter while filtering chooses the highlighted match, if any', t => {
	t.is(
		handleAgentPopupKey({query: 'so', index: 1}, '', {return: true}, 2).action,
		'choose',
	);
	t.is(
		handleAgentPopupKey({query: 'zz', index: 0}, '', {return: true}, 0).action,
		undefined,
	);
});

test('arrows move within the filtered list', t => {
	t.is(
		handleAgentPopupKey({query: 'h', index: 1}, '', {downArrow: true}, 2).state
			.index,
		1,
	);
	t.is(
		handleAgentPopupKey({query: 'h', index: 1}, '', {upArrow: true}, 2).state
			.index,
		0,
	);
});
