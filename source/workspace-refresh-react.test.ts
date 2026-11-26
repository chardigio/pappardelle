import React, {memo, useEffect} from 'react';
import {render} from '../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../test/helpers/teardown.ts';
import {workspaceRefreshDeps} from '../test/helpers/workspace-refresh-deps.ts';
import {until} from '../test/helpers/wait.ts';
import {WorkspaceRefresh} from './workspace-refresh.ts';
import {useSpaceSelection} from './use-space-selection.ts';
import type {SpaceData} from './types.ts';

test('100 memoized rows skip no-op refreshes and selection survives membership changes during slow Git status', async () => {
	let selection!: ReturnType<typeof useSpaceSelection>;
	let rowCommits = 0;
	const attachments: string[] = [];
	let keys = Array.from({length: 100}, (_, index) => `STA-${index + 1}`);
	let dirty = Promise.resolve(false);
	const Row = memo(function ({space}: {space: SpaceData}) {
		useEffect(() => {
			rowCommits++;
		});
		return React.createElement('text', {}, space.name);
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
			'box',
			{flexDirection: 'column'},
			...selection.spaces.map(space =>
				React.createElement(Row, {key: space.name, space}),
			),
			React.createElement('text', {}, `Selected: ${name ?? 'empty'}`),
		);
	}
	const view = await render(React.createElement(View));
	teardown(async () => {
		await view.unmount();
	});
	const refresh = new WorkspaceRefresh(
		workspaceRefreshDeps({
			readRegistry: async () => keys,
			readDirty: async () => dirty,
			setSpaces: update => selection.setSpaces(update),
		}),
	);
	teardown(() => refresh.stop());
	const frame = () => view.lastFrame();
	// The checks after these waits are for what must not happen (a second
	// commit of a row, a stray attachment), which would land after the frame
	// the wait saw.
	async function settled(check: () => boolean) {
		await until(check, {frame});
		await delay(30);
	}

	await refresh.refresh();
	await refresh.idle();
	await until(
		() =>
			selection.spaces.length === 101 &&
			selection.spaces.every(space => space.worktreePath),
		{frame},
	);
	selection.selectSpace('STA-50');
	await until(() => view.lastFrame()!.includes('Selected: STA-50'), {frame});
	attachments.length = 0;
	const before = rowCommits;
	await refresh.refresh();
	await refresh.idle();
	await delay(50);
	expect(rowCommits).toBe(before);
	expect(attachments).toStrictEqual([]);

	// Rebuilding every row was the old polling behavior, and defeats React.memo.
	selection.setSpaces(spaces => spaces.map(space => ({...space})));
	await settled(() => rowCommits >= before + 101);
	expect(rowCommits - before).toBe(101);
	expect(attachments).toStrictEqual([]);

	let finishDirty!: (value: boolean) => void;
	dirty = new Promise(resolve => {
		finishDirty = resolve;
	});
	keys = [...keys.filter(key => key !== 'STA-100'), 'STA-101'];
	await refresh.refresh();
	await settled(() => view.lastFrame()!.includes('STA-101'));
	expect(view.lastFrame()!.includes('Selected: STA-50')).toBe(true);
	expect(attachments).toStrictEqual([]);
	keys = keys.filter(key => key !== 'STA-50');
	await refresh.refreshListOnly();
	await settled(() => view.lastFrame()!.includes('Selected: STA-49'));
	expect(attachments).toStrictEqual(['STA-49']);
	finishDirty(false);
	await refresh.idle();
});
