import React, {useEffect} from 'react';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import {useSpaceSelection} from './use-space-selection.ts';

const spaces = (names: string[]) =>
	names.map(name => ({name, worktreePath: `/worktrees/${name}`}));

async function setup(t: ExecutionContext) {
	let selection!: ReturnType<typeof useSpaceSelection>;
	const attachments: Array<string | undefined> = [];
	let committed: typeof selection | undefined;
	async function update(action: () => void) {
		const previous = selection;
		action();
		const deadline = Date.now() + 2000;
		const hasCommitted = () =>
			committed &&
			committed !== previous &&
			view.lastFrame() ===
				(committed.spaces[committed.selectedIndex]?.name ?? 'empty');
		while (!hasCommitted()) {
			if (Date.now() > deadline)
				throw new Error('Workspace view did not commit');
			await delay(10);
		}
	}
	function WorkspaceView() {
		selection = useSpaceSelection();
		useEffect(() => {
			committed = selection;
		});
		const selectedName = selection.spaces[selection.selectedIndex]?.name;
		useEffect(() => {
			attachments.push(selectedName);
		}, [selectedName]);
		return React.createElement(Text, {}, selectedName ?? 'empty');
	}

	const view = render(React.createElement(WorkspaceView));
	t.teardown(() => view.unmount());
	await update(() => {
		selection.setSpaces(spaces(['main', 'STA-4', 'STA-3', 'STA-2', 'STA-1']));
		selection.setSelectedIndex(2);
	});
	t.is(view.lastFrame(), 'STA-3');
	attachments.length = 0;
	return {
		get selection() {
			return selection;
		},
		view,
		update,
		attachments,
	};
}

for (const [description, names, expected] of [
	[
		'auto-close removes an earlier row',
		['main', 'STA-3', 'STA-2', 'STA-1'],
		'STA-3',
	],
	[
		'auto-close removes a later row',
		['main', 'STA-4', 'STA-3', 'STA-1'],
		'STA-3',
	],
	[
		'a new workspace is inserted ahead of selection',
		['main', 'STA-5', 'STA-4', 'STA-3', 'STA-2', 'STA-1'],
		'STA-3',
	],
	[
		'a refresh reorders workspaces',
		['main', 'STA-1', 'STA-4', 'STA-2', 'STA-3'],
		'STA-3',
	],
	[
		'the selected workspace closes',
		['main', 'STA-4', 'STA-2', 'STA-1'],
		'STA-2',
	],
	[
		'bulk close removes selection and following rows',
		['main', 'STA-4'],
		'STA-4',
	],
	['all workspaces disappear', [], undefined],
] as const) {
	test.serial(description, async t => {
		const harness = await setup(t);
		await harness.update(() => harness.selection.setSpaces(spaces([...names])));
		t.is(harness.view.lastFrame(), expected ?? 'empty');
		t.deepEqual(harness.attachments, expected === 'STA-3' ? [] : [expected]);
	});
}

test.serial(
	'concurrent closes preserve navigation made while teardown was pending',
	async t => {
		const harness = await setup(t);
		await harness.update(() => {
			harness.selection.setSelectedIndex(3);
			harness.selection.setSpaces(current =>
				current.filter(space => space.name !== 'STA-4'),
			);
			harness.selection.setSpaces(current =>
				current.filter(space => space.name !== 'STA-3'),
			);
		});
		t.is(harness.view.lastFrame(), 'STA-2');
		t.deepEqual(harness.attachments, ['STA-2']);
	},
);

test.serial(
	'highlight requests resolve against the updated list in the same batch',
	async t => {
		const harness = await setup(t);
		await harness.update(() => {
			harness.selection.setSpaces(current =>
				current.filter(space => space.name !== 'STA-4'),
			);
			harness.selection.selectSpace('sta-1');
		});
		t.is(harness.view.lastFrame(), 'STA-1');
		t.deepEqual(harness.attachments, ['STA-1']);
	},
);

test.serial(
	'reopening a closed workspace does not steal selection back',
	async t => {
		const harness = await setup(t);
		await harness.update(() =>
			harness.selection.setSpaces(current =>
				current.filter(space => space.name !== 'STA-3'),
			),
		);
		await harness.update(() =>
			harness.selection.setSpaces(
				spaces(['main', 'STA-4', 'STA-3', 'STA-2', 'STA-1']),
			),
		);
		t.is(harness.view.lastFrame(), 'STA-2');
		t.deepEqual(harness.attachments, ['STA-2']);
	},
);
