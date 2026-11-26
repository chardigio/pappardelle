import React from 'react';
import {test, expect} from 'bun:test';
import {RGBA} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import {until} from '../../test/helpers/wait.ts';
import TuiErrorBoundary from './TuiErrorBoundary.tsx';

function Broken(): React.ReactNode {
	throw new Error('fixture failure');
}

test('the close hint is dimmed default text, not bright black', async () => {
	const view = await render(
		React.createElement(TuiErrorBoundary, null, React.createElement(Broken)),
		{width: 40, height: 6},
	);
	const hint = view
		.captureSpans()
		.lines.flatMap(line => line.spans)
		.find(span => span.text.includes('Press q'));
	await view.unmount();
	expect(hint).toBeTruthy();
	expect(hint!.fg.equals(RGBA.defaultForeground())).toBe(true);
});

test('q in the failed view hands closing to onClose, so the rail can close its layout too', async () => {
	let closed = 0;
	const view = await render(
		React.createElement(
			TuiErrorBoundary,
			{
				onClose() {
					closed++;
				},
			},
			React.createElement(Broken),
		),
		{width: 40, height: 6},
	);
	await until(() => view.lastFrame()?.includes('Press q') ?? false);
	await view.stdin.write('q');
	await until(() => closed === 1, {frame: () => view.lastFrame()});
	await view.unmount();
	expect(closed).toBe(1);
});
