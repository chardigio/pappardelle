import {test, expect} from 'bun:test';
import type {SpaceData} from './types.ts';
import {applyStatusUpdates} from './workspace-status.ts';

test('status batches preserve identity for unchanged rows and ignore other repositories', () => {
	const spaces: SpaceData[] = [
		{
			name: 'main',
			statusKey: 'repo-main',
			worktreePath: null,
			programStatus: {status: 'working'},
		},
		{name: 'STA-1', worktreePath: null, programStatus: {status: 'idle'}},
	];
	expect(
		applyStatusUpdates(
			spaces,
			new Map([
				['main', {status: 'idle'}],
				['repo-main', {status: 'working'}],
				['other-main', {status: 'error'}],
			]),
		),
	).toBe(spaces);
	const updated = applyStatusUpdates(
		spaces,
		new Map([['repo-main', {status: 'blocked', tool: 'AskUserQuestion'}]]),
	);
	expect(updated).not.toBe(spaces);
	expect(updated[1]).toBe(spaces[1]);
	expect(updated[0]?.programStatus?.tool).toBe('AskUserQuestion');
	expect(spaces[0]?.programStatus?.status).toBe('working');
	const cleared = applyStatusUpdates(
		updated,
		new Map([['repo-main', {status: 'blocked'}]]),
	);
	expect(cleared[0]?.programStatus?.tool).toBe(undefined);
	expect(cleared[0]).not.toBe(updated[0]);
});
