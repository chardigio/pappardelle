import {test, expect} from 'bun:test';
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
		// eslint-disable-next-line react/no-children-prop -- createElement's types take a required children prop only in the props object
		React.createElement(PaneFrame, {
			...props,
			isActive: true,
			children: React.createElement('text', null, 'row'),
		}),
		{width, height: 3},
	);
	const {lines} = view.captureSpans();
	await view.unmount();
	const {spans} = lines[0]!;
	return {text: spans.map(span => span.text).join(''), spans};
}

// eslint-disable-next-line no-bitwise
const has = (attributes: number, flag: number) => (attributes & flag) !== 0;

test('the trailing label sits at the right end of the top rule', async () => {
	const row = await topRow({title: 'rail', trailing: '12 spaces'}, 30);
	expect(row.text).toBe(`╭─ rail ${'─'.repeat(9)} 12 spaces ─╮`);
	const label = row.spans.find(span => span.text.includes('12 spaces'));
	expect(has(label!.attributes, TextAttributes.DIM)).toBe(true);
});

test('title runs keep their own colours', async () => {
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
	expect(colorOf('pappa').equals(parseColor(terminalColor('cyan')))).toBe(true);
	expect(colorOf('✗ 2').equals(parseColor(terminalColor('red')))).toBe(true);
});

test('a narrow frame truncates the title before dropping the trailing label', async () => {
	const row = await topRow(
		{title: 'pappa-rex-ai-workspace', trailing: '12 spaces'},
		26,
	);
	expect(row.text).toBe('╭─ pappa-r… ─ 12 spaces ─╮');
});

test('a frame too narrow for both drops the trailing label', async () => {
	const row = await topRow({title: 'rail', trailing: '12 spaces'}, 16);
	expect(row.text).toBe(`╭─ rail ${'─'.repeat(7)}╮`);
});

test('only runs that ask for bold are bold; a plain title is bold', async () => {
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
	expect(has(attributesOf('pappa'), TextAttributes.BOLD)).toBe(true);
	expect(has(attributesOf('✗ 2'), TextAttributes.BOLD)).toBe(false);
	const plain = await topRow({title: 'rail'}, 20);
	expect(
		has(
			plain.spans.find(span => span.text.includes('rail'))!.attributes,
			TextAttributes.BOLD,
		),
	).toBe(true);
});
