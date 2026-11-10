import test from 'ava';
import React from 'react';
import {parseColor, TextAttributes} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import {terminalColor} from '../tui-style.ts';
import TitledBox from './TitledBox.tsx';

async function topEdge(isDim: boolean) {
	const view = await render(
		React.createElement(
			TitledBox,
			{
				title: 'Profile',
				borderColor: 'green',
				titleColor: 'greenBright',
				borderStyle: isDim ? 'round' : 'double',
				isDim,
				paddingY: 0,
			},
			React.createElement('text', null, 'row one'),
		),
		{width: 24, height: 3},
	);
	const [top, middle] = view.captureSpans().lines;
	await view.unmount();
	return {
		corner: top!.spans[0]!,
		title: top!.spans.find(span => span.text.includes('Profile'))!,
		side: middle!.spans[0]!,
	};
}

// eslint-disable-next-line no-bitwise
const has = (attributes: number, flag: number) => (attributes & flag) !== 0;

test('an unfocused frame is dimmed with SGR 2 on its palette colors, not blended toward black', async t => {
	const {corner, title, side} = await topEdge(true);
	for (const span of [corner, side]) {
		t.true(has(span.attributes, TextAttributes.DIM), `"${span.text}"`);
		t.true(
			span.fg.equals(parseColor(terminalColor('green'))),
			`"${span.text}"`,
		);
	}

	t.true(has(title.attributes, TextAttributes.DIM));
	t.true(title.fg.equals(parseColor(terminalColor('greenBright'))));
});

test('a focused frame is undimmed and its title is bold', async t => {
	const {corner, title, side} = await topEdge(false);
	for (const span of [corner, side, title]) {
		t.false(has(span.attributes, TextAttributes.DIM), `"${span.text}"`);
	}

	t.true(has(title.attributes, TextAttributes.BOLD));
	t.is(title.text.trim(), 'Profile');
});
