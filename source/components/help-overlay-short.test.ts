import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
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

test.serial('a short pane keeps the title and footer and scrolls', async t => {
	const view = open(13);
	t.teardown(() => view.unmount());
	await delay(20);

	let lines = (view.lastFrame() ?? '').split('\n');
	t.is(lines.length, 13);
	t.true(lines[2]!.includes('Keyboard Shortcuts'));
	t.true(lines[5]!.includes('Move down'));
	t.true(lines[10]!.includes('j/k scroll'));
	t.false(view.lastFrame()!.includes('Show this help'));

	view.stdin.write('G');
	await delay(20);
	lines = (view.lastFrame() ?? '').split('\n');
	t.is(lines.length, 13);
	t.true(lines[2]!.includes('Keyboard Shortcuts'));
	t.true(lines[8]!.includes('Close all done/canceled spaces'));
	t.false(view.lastFrame()!.includes('Move down'));
});

test.serial('a tall pane shows every shortcut with no scroll hint', async t => {
	const view = open(60);
	t.teardown(() => view.unmount());
	await delay(20);

	const frame = view.lastFrame() ?? '';
	t.true(frame.includes('Move down'));
	t.true(frame.includes('Close all done/canceled spaces'));
	t.false(frame.includes('j/k scroll'));
});
