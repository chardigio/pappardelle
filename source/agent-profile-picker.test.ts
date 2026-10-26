import test from 'ava';
import {
	agentPickerHeight,
	agentPopupVisibleRows,
	filterAgentProfiles,
} from './agent-profile-picker.ts';

test('the picker is as tall as its list until the list scrolls', t => {
	t.is(agentPickerHeight(2), 8);
	t.is(agentPickerHeight(16), 22);
	t.is(agentPickerHeight(30), 24);
});

test('a popup shorter than its list scrolls instead of overflowing', t => {
	t.is(agentPopupVisibleRows(12, 40), 12);
	// tmux shrank the popup to 14 rows: 6 for the chrome, 2 for the scroll markers.
	t.is(agentPopupVisibleRows(12, 14), 6);
	t.is(agentPopupVisibleRows(30, 40), 16);
	// A popup sized for 30 options fills every row.
	t.is(agentPopupVisibleRows(30, agentPickerHeight(30)), 16);
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
