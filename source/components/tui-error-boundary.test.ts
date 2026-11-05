import React from 'react';
import test from 'ava';
import {RGBA} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import TuiErrorBoundary from './TuiErrorBoundary.tsx';

function Broken(): React.ReactNode {
	throw new Error('fixture failure');
}

test('the close hint is dimmed default text, not bright black', async t => {
	const view = await render(
		React.createElement(TuiErrorBoundary, null, React.createElement(Broken)),
		{width: 40, height: 6},
	);
	const hint = view
		.captureSpans()
		.lines.flatMap(line => line.spans)
		.find(span => span.text.includes('Press q'));
	await view.unmount();
	t.truthy(hint);
	t.true(hint!.fg.equals(RGBA.defaultForeground()));
});
