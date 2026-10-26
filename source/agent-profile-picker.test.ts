import test from 'ava';
import {
	agentPickerHeight,
	agentPopupList,
	filterAgentProfiles,
} from './agent-profile-picker.ts';

test('the picker is as tall as its list until the list scrolls', t => {
	t.is(agentPickerHeight(2), 8);
	t.is(agentPickerHeight(16), 22);
	t.is(agentPickerHeight(30), 24);
});

test('a popup shorter than its list scrolls instead of overflowing', t => {
	t.deepEqual(agentPopupList(12, 40), {rows: 12, scrollMarkers: false});
	// tmux shrank the popup to 14 rows: 6 for the chrome, 2 for the scroll markers.
	t.deepEqual(agentPopupList(12, 14), {rows: 6, scrollMarkers: true});
	t.deepEqual(agentPopupList(30, 40), {rows: 16, scrollMarkers: true});
	// A popup sized for 30 options fills every row.
	t.deepEqual(agentPopupList(30, agentPickerHeight(30)), {
		rows: 16,
		scrollMarkers: true,
	});
});

test('a popup with room for one option drops the scroll markers', t => {
	t.deepEqual(agentPopupList(12, 8), {rows: 1, scrollMarkers: false});
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
