import React from 'react';
import test from 'ava';
import {render} from '../../test/helpers/render.ts';
import TextInput from './TextInput.tsx';

test('the placeholder stays off the palette slots themes use for the background', async t => {
	const view = await render(
		React.createElement(
			'box',
			{flexDirection: 'row', width: 30},
			React.createElement(TextInput, {
				value: '',
				onChange() {},
				placeholder: 'filter by key or title...',
			}),
		),
		{width: 30, height: 1},
	);
	const placeholder = view
		.captureSpans()
		.lines[0]!.spans.find(span => span.text.includes('filter'));
	await view.unmount();
	t.truthy(placeholder);
	t.false(
		placeholder!.fg.intent === 'indexed' &&
			[0, 8].includes(placeholder!.fg.slot),
	);
});
