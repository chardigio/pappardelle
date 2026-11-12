import test from 'ava';
import React from 'react';
import {render, until} from '../../test/helpers/render.ts';
import HelpOverlay from './HelpOverlay.tsx';

function open(availableHeight?: number) {
	return render(
		React.createElement(HelpOverlay, {
			commitSha: 'abc1234',
			availableHeight,
			onClose() {},
		}),
	);
}

const shortPaneShown = (frame: string) =>
	frame.split('\n').length === 13 && frame.includes('Keyboard Shortcuts');

test.serial('a short pane keeps the title and footer and scrolls', async t => {
	const view = await open(13);
	t.teardown(async () => {
		await view.unmount();
	});
	await until(() => shortPaneShown(view.lastFrame()), view.lastFrame);

	let lines = view.lastFrame().split('\n');
	t.true(lines[2]!.includes('Keyboard Shortcuts'));
	t.true(lines[5]!.includes('Move down'));
	t.true(lines[10]!.includes('j/k scroll'));
	t.false(view.lastFrame().includes('Show this help'));

	await view.stdin.write('G');
	await until(
		() => view.lastFrame().includes('Jump to the sous-chef'),
		view.lastFrame,
	);
	lines = view.lastFrame().split('\n');
	t.is(lines.length, 13);
	t.true(lines[2]!.includes('Keyboard Shortcuts'));
	t.true(lines[5]!.includes('Jump to the sous-chef'));
	t.true(lines[7]!.includes('Program status:'));
	t.true(lines[8]!.includes('✗ error'));
	t.false(view.lastFrame().includes('Move down'));
});

test.serial('a tall pane shows every shortcut with no scroll hint', async t => {
	const view = await open(60);
	t.teardown(async () => {
		await view.unmount();
	});
	await until(
		() => view.lastFrame().includes('Close all done/canceled spaces'),
		view.lastFrame,
	);

	const frame = view.lastFrame();
	t.true(frame.includes('Move down'));
	t.false(frame.includes('j/k scroll'));
});

test.serial('keys that arrive together each scroll a line', async t => {
	const view = await open(13);
	t.teardown(async () => {
		await view.unmount();
	});
	await until(() => shortPaneShown(view.lastFrame()), view.lastFrame);
	const before = view.lastFrame().split('\n');

	await view.stdin.write('jjj');
	await until(
		() => view.lastFrame().split('\n')[5] === before[8],
		view.lastFrame,
	);
	t.pass();
});
