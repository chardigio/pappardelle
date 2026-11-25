import React, {Profiler} from 'react';
import {render} from '../../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import ClaudeAnimation from './ClaudeAnimation.tsx';

test('twenty active rows animate in one React commit per frame', async () => {
	let commits = 0;
	const view = await render(
		React.createElement(
			Profiler,
			{id: 'busy-workspaces', onRender: () => commits++},
			React.createElement(
				'text',
				null,
				...Array.from({length: 20}, (_, key) =>
					React.createElement(ClaudeAnimation, {key}),
				),
			),
		),
	);
	teardown(async () => {
		await view.unmount();
	});
	await delay(50);
	commits = 0;
	await delay(500);
	expect(commits > 0, 'Spinners must still animate').toBe(true);
	expect(
		commits <= 5,
		`Expected shared frames, received ${commits} commits`,
	).toBe(true);
	const frame = view.lastFrame() ?? '';
	expect(frame.length).toBe(20);
	expect(
		new Set(frame).size,
		'Every row must show the same animation frame',
	).toBe(1);
});
