import test from 'ava';
import React from 'react';
import stringWidth from 'string-width';
import {render, until} from '../../test/helpers/render.ts';
import HelpOverlay from './HelpOverlay.tsx';
import TruncatedLine from './TruncatedLine.tsx';

const MESSAGE = 'Deinit failed: Failing hook exited with status 1';

const header = (width: number) =>
	React.createElement(
		'box',
		{flexDirection: 'row', width, height: 1},
		React.createElement(TruncatedLine, {runs: [{text: MESSAGE}]}),
	);

test('a line that does not fit ends in an ellipsis, and widening restores it', async t => {
	const view = await render(header(30), {width: 60, height: 1});
	t.teardown(async () => {
		await view.unmount();
	});
	await until(
		() => view.lastFrame() === 'Deinit failed: Failing hook e…',
		view.lastFrame,
	);

	await view.rerender(header(60));
	await until(() => view.lastFrame() === MESSAGE, view.lastFrame);
	t.pass();
});

test('the help legend is cut with an ellipsis inside a narrow overlay', async t => {
	const width = 40;
	const view = await render(
		React.createElement(
			'box',
			{width, flexDirection: 'column'},
			React.createElement(HelpOverlay, {
				commitSha: 'abc1234',
				availableHeight: 40,
				onClose() {},
			}),
		),
		{width, height: 40},
	);
	t.teardown(async () => {
		await view.unmount();
	});
	const legend = () =>
		view
			.lastFrame()
			.split('\n')
			.find(line => line.includes('Program status:'));
	await until(() => /… +│$/.test(legend() ?? ''), view.lastFrame);
	t.is(stringWidth(legend()!), width);
});
