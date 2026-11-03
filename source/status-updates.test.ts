import test from 'ava';
import type {SpaceData} from './types.ts';
import {applyStatusUpdates} from './workspace-status.ts';

test('status batches preserve identity for unchanged rows and ignore other repositories', t => {
	const spaces: SpaceData[] = [
		{
			name: 'main',
			statusKey: 'repo-main',
			worktreePath: null,
			programStatus: {status: 'working'},
		},
		{name: 'STA-1', worktreePath: null, programStatus: {status: 'idle'}},
	];
	t.is(
		applyStatusUpdates(
			spaces,
			new Map([
				['main', {status: 'idle'}],
				['repo-main', {status: 'working'}],
				['other-main', {status: 'error'}],
			]),
		),
		spaces,
	);
	const updated = applyStatusUpdates(
		spaces,
		new Map([['repo-main', {status: 'blocked', tool: 'AskUserQuestion'}]]),
	);
	t.not(updated, spaces);
	t.is(updated[1], spaces[1]);
	t.is(updated[0]?.programStatus?.tool, 'AskUserQuestion');
	t.is(spaces[0]?.programStatus?.status, 'working');
	const cleared = applyStatusUpdates(
		updated,
		new Map([['repo-main', {status: 'blocked'}]]),
	);
	t.is(cleared[0]?.programStatus?.tool, undefined);
	t.not(cleared[0], updated[0]);
});
