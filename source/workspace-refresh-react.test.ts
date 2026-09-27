import React, {memo, useEffect} from 'react';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import {WorkspaceRefresh} from './workspace-refresh.ts';
import {useSpaceSelection} from './use-space-selection.ts';
import type {SpaceData} from './types.ts';

test('100 memoized rows skip no-op refreshes and selection survives membership changes during slow Git status', async t => {
	let selection!: ReturnType<typeof useSpaceSelection>;
	let rowCommits = 0;
	const attachments: string[] = [];
	let keys = Array.from({length: 100}, (_, index) => `STA-${index + 1}`);
	let dirty = Promise.resolve(false);
	const Row = memo(function ({space}: {space: SpaceData}) {
		useEffect(() => {
			rowCommits++;
		});
		return React.createElement(Text, {}, space.name);
	});
	function View() {
		selection = useSpaceSelection();
		const selected = selection.spaces[selection.selectedIndex];
		const name = selected?.name;
		const worktreePath = selected?.worktreePath;
		useEffect(() => {
			if (name && worktreePath) attachments.push(name);
		}, [name, worktreePath]);
		return React.createElement(
			Box,
			{flexDirection: 'column'},
			...selection.spaces.map(space =>
				React.createElement(Row, {key: space.name, space}),
			),
			React.createElement(Text, {}, `Selected: ${name ?? 'empty'}`),
		);
	}
	const view = render(React.createElement(View));
	t.teardown(() => view.unmount());
	const refresh = new WorkspaceRefresh({
		readRegistry: async () => keys,
		readStatus: async () => ({status: 'waiting_for_input'}),
		readWorktreePath: async key => `/worktrees/${key}`,
		readMainWorktree: async () => ({path: '/repo', branch: 'main'}),
		readDirty: async () => dirty,
		mainStatusKey: branch => `repo-${branch}`,
		getCachedIssue: () => null,
		async fetchIssues() {},
		readEmoji: async () => undefined,
		setSpaces: update => selection.setSpaces(update),
		onLoaded() {},
		onError(error) {
			throw error;
		},
	});
	t.teardown(() => refresh.stop());
	async function waitFor(check: () => boolean) {
		const deadline = Date.now() + 3000;
		while (!check()) {
			if (Date.now() > deadline)
				throw new Error('Workspace view did not commit');
			await delay(10);
		}
		await delay(30);
	}
	await refresh.refresh();
	await refresh.idle();
	await waitFor(
		() =>
			selection.spaces.length === 101 &&
			selection.spaces.every(space => space.worktreePath),
	);
	selection.selectSpace('STA-50');
	await waitFor(() => view.lastFrame()!.includes('Selected: STA-50'));
	attachments.length = 0;
	const before = rowCommits;
	await refresh.refresh();
	await refresh.idle();
	await delay(50);
	t.is(rowCommits, before);
	t.deepEqual(attachments, []);

	// Rebuilding every row was the old polling behavior, and defeats React.memo.
	selection.setSpaces(spaces => spaces.map(space => ({...space})));
	await waitFor(() => rowCommits === before + 101);
	t.is(rowCommits - before, 101);
	t.deepEqual(attachments, []);

	let finishDirty!: (value: boolean) => void;
	dirty = new Promise(resolve => {
		finishDirty = resolve;
	});
	keys = [...keys.filter(key => key !== 'STA-100'), 'STA-101'];
	await refresh.refresh();
	await waitFor(() => view.lastFrame()!.includes('STA-101'));
	t.true(view.lastFrame()!.includes('Selected: STA-50'));
	t.deepEqual(attachments, []);
	keys = keys.filter(key => key !== 'STA-50');
	await refresh.refreshListOnly();
	await waitFor(() => view.lastFrame()!.includes('Selected: STA-49'));
	t.deepEqual(attachments, ['STA-49']);
	finishDirty(false);
	await refresh.idle();
});
