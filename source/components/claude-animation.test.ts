import React, {Profiler} from 'react';
import {Box} from 'ink';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import ClaudeAnimation from './ClaudeAnimation.tsx';

test('twenty active rows animate in one React commit per frame', async t => {
	let commits = 0;
	const view = render(
		React.createElement(
			Profiler,
			{id: 'busy-workspaces', onRender: () => commits++},
			React.createElement(
				Box,
				{},
				...Array.from({length: 20}, (_, key) =>
					React.createElement(ClaudeAnimation, {key}),
				),
			),
		),
	);
	t.teardown(() => view.unmount());
	await delay(50);
	commits = 0;
	await delay(500);
	t.true(commits > 0, 'Spinners must still animate');
	t.true(commits <= 5, `Expected shared frames, received ${commits} commits`);
	const frame = view.lastFrame() ?? '';
	t.is(frame.length, 20);
	t.is(new Set(frame).size, 1, 'Every row must show the same animation frame');
});
