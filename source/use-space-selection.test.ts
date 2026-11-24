import React, {useEffect} from 'react';
import {flushSync, useKeyboard} from '@opentui/react';
import {render} from '../test/helpers/render.ts';
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
		return React.createElement('text', {}, selectedName ?? 'empty');
	}

	const view = await render(React.createElement(WorkspaceView));
	t.teardown(async () => {
		await view.unmount();
	});
	await update(() => {
		selection.setSpaces(spaces(['main', 'STA-4', 'STA-3', 'STA-2', 'STA-1']));
		selection.selectSpace('STA-3');
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
			harness.selection.moveSelection(1);
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

test.serial(
	'keys in one input write see the selection the previous key made',
	async t => {
		function Rail() {
			const selection = useSpaceSelection();
			const {spaces: rows, selectedIndex, setSpaces, selectSpace} = selection;
			useEffect(() => {
				setSpaces(spaces(['main', 'STA-4', 'STA-3', 'STA-2', 'STA-1']));
				selectSpace('STA-4');
			}, [setSpaces, selectSpace]);
			useKeyboard(key => {
				if (key.name === 'j') selection.moveSelection(1);
			});
			return React.createElement(
				'text',
				{},
				rows[selectedIndex]?.name ?? 'empty',
			);
		}

		const view = await render(React.createElement(Rail));
		t.teardown(async () => {
			await view.unmount();
		});
		await view.stdin.write('');
		t.is(view.lastFrame(), 'STA-4');
		await view.stdin.write('jj');
		t.is(view.lastFrame(), 'STA-2');
	},
);

test.serial(
	'a key acts on rows a refresh queued but has not drawn yet',
	async t => {
		let selection!: ReturnType<typeof useSpaceSelection>;
		function Rail() {
			selection = useSpaceSelection();
			useKeyboard(key => {
				if (key.name === 'j') selection.moveSelection(1);
			});
			return React.createElement(
				'text',
				{},
				selection.spaces[selection.selectedIndex]?.name ?? 'empty',
			);
		}

		const view = await render(React.createElement(Rail));
		t.teardown(async () => {
			await view.unmount();
		});
		flushSync(() => {
			selection.setSpaces(spaces(['main', 'STA-4', 'STA-3', 'STA-2', 'STA-1']));
			selection.selectSpace('STA-2');
		});
		// A refresh lands outside any key, so React has not rendered it when the
		// key in the same tick runs.
		selection.setSpaces(current =>
			current.filter(space => space.name !== 'STA-4'),
		);
		await view.stdin.write('j');
		await delay(50);
		await view.stdin.write('');
		t.is(view.lastFrame(), 'STA-1');
	},
);
