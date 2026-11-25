import {test, expect} from 'bun:test';
import {
	AGENT_PICKER_NAME_MAX_WIDTH,
	agentPickerHeight,
	agentPopupList,
	cutAgentProfileName,
	filterAgentProfiles,
} from './agent-profile-picker.ts';
import {displayWidth} from './text-measure.ts';

test('the picker is as tall as its list until the list scrolls', () => {
	expect(agentPickerHeight(2)).toBe(8);
	expect(agentPickerHeight(16)).toBe(22);
	expect(agentPickerHeight(30)).toBe(24);
});

test('a popup shorter than its list scrolls instead of overflowing', () => {
	expect(agentPopupList(12, 40)).toStrictEqual({
		rows: 12,
		scrollMarkers: false,
	});
	// tmux shrank the popup to 14 rows: 6 for the chrome, 2 for the scroll markers.
	expect(agentPopupList(12, 14)).toStrictEqual({rows: 6, scrollMarkers: true});
	expect(agentPopupList(30, 40)).toStrictEqual({rows: 16, scrollMarkers: true});
	// A popup sized for 30 options fills every row.
	expect(agentPopupList(30, agentPickerHeight(30))).toStrictEqual({
		rows: 16,
		scrollMarkers: true,
	});
});

test('a popup with room for one option drops the scroll markers', () => {
	expect(agentPopupList(12, 8)).toStrictEqual({rows: 1, scrollMarkers: false});
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

test('filterAgentProfiles ranks the tightest in-order match first', () => {
	expect(names('sh')).toStrictEqual([
		'sol-high',
		'opus-high',
		'astra-high',
		'sonnet-high',
	]);
	expect(names('xh')).toStrictEqual(['haiku-xhigh']);
	expect(names('zz')).toStrictEqual([]);
});

test("filterAgentProfiles matches the profile's-agent row by its label", () => {
	expect(names('prof')).toStrictEqual(['']);
});

test('filterAgentProfiles keeps the full list in order for an empty query', () => {
	expect(names(' ')).toStrictEqual(choices.map(choice => choice.name));
});

test('cutAgentProfileName cuts wide names by display width, not characters', () => {
	const cut = cutAgentProfileName('漢'.repeat(20));
	expect(displayWidth(cut, 'unicode') <= AGENT_PICKER_NAME_MAX_WIDTH).toBe(
		true,
	);
	expect(cut.endsWith('…')).toBe(true);
});
