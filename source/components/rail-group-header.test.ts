import test from 'ava';
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
	collapsed: true,
	attention: null,
};

test('a header that fits shows chevron, name and count', t => {
	t.is(railGroupHeaderText(row, 40, 'unicode'), '▸ In Progress (12)');
});

test('a narrow header shortens the name before dropping the count', t => {
	t.is(railGroupHeaderText(row, 12, 'unicode'), '▸ In P… (12)');
});

test('a header too narrow for the count is cut with an ellipsis', t => {
	t.is(railGroupHeaderText(row, 6, 'unicode'), '▸ In …');
});
