import test from 'ava';
import React from 'react';
import {parseColor, TextAttributes} from '@opentui/core';
import {render} from '../../test/helpers/render.ts';
import {terminalColor, textAttributes} from '../tui-style.ts';
import type {Run} from './TruncatedLine.tsx';
import PaneFrame from './PaneFrame.tsx';

async function topRow(
	props: {title: string | readonly Run[]; trailing?: string},
	width: number,
) {
	const view = await render(
		React.createElement(
			PaneFrame,
			{...props, isActive: true},
			React.createElement('text', null, 'row'),
		),
		{width, height: 3},
	);
	const {lines} = view.captureSpans();
	await view.unmount();
	const {spans} = lines[0]!;
	return {text: spans.map(span => span.text).join(''), spans};
}

// eslint-disable-next-line no-bitwise
const has = (attributes: number, flag: number) => (attributes & flag) !== 0;

test('the trailing label sits at the right end of the top rule', async t => {
	const row = await topRow({title: 'rail', trailing: '12 spaces'}, 30);
	t.is(row.text, `╭─ rail ${'─'.repeat(9)} 12 spaces ─╮`);
	const label = row.spans.find(span => span.text.includes('12 spaces'));
	t.true(has(label!.attributes, TextAttributes.DIM));
});

test('title runs keep their own colours', async t => {
	const row = await topRow(
		{
			title: [
				{text: '🍝 pappa', fg: terminalColor('cyan')},
				{text: ' · ', attributes: textAttributes({dim: true})},
				{text: '✗ 2', fg: terminalColor('red')},
			],
		},
		30,
	);
	const colorOf = (text: string) =>
		row.spans.find(span => span.text.includes(text))!.fg;
	t.true(colorOf('pappa').equals(parseColor(terminalColor('cyan'))));
	t.true(colorOf('✗ 2').equals(parseColor(terminalColor('red'))));
});

test('a narrow frame truncates the title before dropping the trailing label', async t => {
	const row = await topRow(
		{title: 'pappa-rex-ai-workspace', trailing: '12 spaces'},
		26,
	);
	t.is(row.text, '╭─ pappa-r… ─ 12 spaces ─╮');
});

test('a frame too narrow for both drops the trailing label', async t => {
	const row = await topRow({title: 'rail', trailing: '12 spaces'}, 16);
	t.is(row.text, `╭─ rail ${'─'.repeat(7)}╮`);
});

test('only runs that ask for bold are bold; a plain title is bold', async t => {
	const row = await topRow(
		{
			title: [
				{
					text: '🍝 pappa',
					fg: terminalColor('cyan'),
					attributes: textAttributes({bold: true}),
				},
				{text: '✗ 2', fg: terminalColor('red')},
			],
		},
		30,
	);
	const attributesOf = (text: string) =>
		row.spans.find(span => span.text.includes(text))!.attributes;
	t.true(has(attributesOf('pappa'), TextAttributes.BOLD));
	t.false(has(attributesOf('✗ 2'), TextAttributes.BOLD));
	const plain = await topRow({title: 'rail'}, 20);
	t.true(
		has(
			plain.spans.find(span => span.text.includes('rail'))!.attributes,
			TextAttributes.BOLD,
		),
	);
});
