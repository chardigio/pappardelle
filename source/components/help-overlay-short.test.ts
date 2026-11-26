import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import React from 'react';
import {render} from '../../test/helpers/render.ts';
import {until} from '../../test/helpers/wait.ts';
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

test('a short pane keeps the title and footer and scrolls', async () => {
	const view = await open(13);
	teardown(async () => {
		await view.unmount();
	});
	await until(() => shortPaneShown(view.lastFrame()), view.lastFrame);

	let lines = view.lastFrame().split('\n');
	expect(lines[2]!.includes('Keyboard Shortcuts')).toBe(true);
	expect(lines[5]!.includes('Move down')).toBe(true);
	expect(lines[10]!.includes('j/k scroll')).toBe(true);
	expect(view.lastFrame().includes('Show this help')).toBe(false);

	await view.stdin.write('G');
	await until(
		() => view.lastFrame().includes('Jump to the sous-chef'),
		view.lastFrame,
	);
	lines = view.lastFrame().split('\n');
	expect(lines.length).toBe(13);
	expect(lines[2]!.includes('Keyboard Shortcuts')).toBe(true);
	expect(lines[5]!.includes('Jump to the sous-chef')).toBe(true);
	expect(lines[7]!.includes('Program status:')).toBe(true);
	expect(lines[8]!.includes('✗ error')).toBe(true);
	expect(view.lastFrame().includes('Move down')).toBe(false);
});

test('a tall pane shows every shortcut with no scroll hint', async () => {
	const view = await open(60);
	teardown(async () => {
		await view.unmount();
	});
	await until(
		() => view.lastFrame().includes('Close all done/canceled spaces'),
		view.lastFrame,
	);

	const frame = view.lastFrame();
	expect(frame.includes('Move down')).toBe(true);
	expect(frame.includes('j/k scroll')).toBe(false);
});

test('keys that arrive together each scroll a line', async () => {
	const view = await open(13);
	teardown(async () => {
		await view.unmount();
	});
	await until(() => shortPaneShown(view.lastFrame()), view.lastFrame);
	const before = view.lastFrame().split('\n');

	await view.stdin.write('jjj');
	await until(
		() => view.lastFrame().split('\n')[5] === before[8],
		view.lastFrame,
	);
	expect().pass();
});
