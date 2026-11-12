import test from 'ava';
import React from 'react';
import {TextAttributes} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import PaneFrame from './PaneFrame.tsx';
import RailDivider from './RailDivider.tsx';

async function railRows(isActive: boolean) {
	const view = await render(
		React.createElement(
			PaneFrame,
			{title: 'rail', isActive},
			React.createElement('text', null, 'sous-chef'),
			React.createElement(RailDivider, {isActive}),
			React.createElement('text', null, 'In Progress'),
		),
		{width: 20, height: 5},
	);
	const {lines} = view.captureSpans();
	await view.unmount();
	return lines.map(line => ({
		text: line.spans.map(span => span.text).join(''),
		spans: line.spans,
	}));
}

// eslint-disable-next-line no-bitwise
const has = (attributes: number, flag: number) => (attributes & flag) !== 0;

test('the divider meets the rail frame with a tee on each side', async t => {
	const rows = await railRows(true);
	t.is(rows[2]!.text, `├${'─'.repeat(18)}┤`);
	for (const row of [rows[1]!, rows[3]!]) {
		t.true(row.text.startsWith('│'), `"${row.text}"`);
		t.true(row.text.endsWith('│'), `"${row.text}"`);
	}
});

test('the divider dims with the rail frame', async t => {
	for (const isActive of [true, false]) {
		const rows = await railRows(isActive);
		const divider = rows[2]!.spans.find(span => span.text.includes('─'));
		t.is(
			has(divider!.attributes, TextAttributes.DIM),
			!isActive,
			`isActive=${String(isActive)}`,
		);
	}
});
