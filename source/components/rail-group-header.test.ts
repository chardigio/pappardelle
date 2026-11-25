import {test, expect} from 'bun:test';
import type {RailRow} from '../rail-groups.ts';
import {railGroupHeaderText} from './RailGroupHeader.tsx';

const row: Extract<RailRow, {kind: 'header'}> = {
	kind: 'header',
	group: {
		id: 'in progress',
		name: 'In Progress',
		color: 'blue',
		statuses: [],
		categories: [],
	},
	count: 12,
};

test('a header that fits shows name and count apart', () => {
	expect(railGroupHeaderText(row, 40, 'unicode')).toStrictEqual({
		name: 'In Progress',
		count: ' (12)',
	});
});

test('a narrow header shortens the name before dropping the count', () => {
	expect(railGroupHeaderText(row, 10, 'unicode')).toStrictEqual({
		name: 'In P…',
		count: ' (12)',
	});
});

test('a header too narrow for the count is cut with an ellipsis', () => {
	expect(railGroupHeaderText(row, 5, 'unicode')).toStrictEqual({
		name: 'In P…',
		count: '',
	});
});
