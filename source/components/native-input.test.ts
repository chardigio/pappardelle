import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import React, {useState} from 'react';
import {render} from '../../test/helpers/render.ts';
import TextInput from './TextInput.tsx';

async function field(
	initial: string,
	options: {isMultiline?: boolean; isShowingCursor?: boolean} = {},
) {
	let latest = initial;
	let submitted: string | undefined;
	let replace!: (value: string) => void;
	function Field() {
		const [value, setValue] = useState(initial);
		replace = setValue;
		latest = value;
		return React.createElement(TextInput, {
			value,
			onChange: setValue,
			onSubmit(value) {
				submitted = value;
			},
			...options,
		});
	}
	const view = await render(React.createElement(Field), {width: 30, height: 8});
	return {
		view,
		value: () => latest,
		submitted: () => submitted,
		async replace(value: string) {
			replace(value);
			await view.rerender(React.createElement(Field));
		},
	};
}

for (const [name, initial, keys, expected] of [
	['backspace', 'abc', '\x7f', 'ab'],
	['forward delete', 'abc', '\x1b[D\x1b[3~', 'ab'],
	['Ctrl+A and Ctrl+E', 'abc', '\x01X\x05Y', 'XabcY'],
	['Ctrl+U', 'abc def', '\x1b[D\x15', 'f'],
	['readline Alt+B', 'one two', '\x1bbX', 'one Xtwo'],
	['xterm Alt+Left', 'one two', '\x1b[1;3DX', 'one Xtwo'],
	['Alt+Backspace', 'one two', '\x1b\x7f', 'one '],
	['Unicode backspace', 'a👍🏽', '\x7f', 'a'],
] as const) {
	test(`native input preserves ${name}`, async () => {
		const f = await field(initial);
		teardown(() => f.view.unmount());
		await f.view.stdin.write(keys);
		expect(f.value()).toBe(expected);
	});
}

test('fragmented bracketed paste is inserted once, without treating shortcuts as keys', async () => {
	const f = await field('');
	teardown(() => f.view.unmount());
	await f.view.stdin.write('\x1b[200~https://example.com/');
	await f.view.stdin.write('path?q=jk');
	await f.view.stdin.write('\x1b[201~');
	expect(f.value()).toBe('https://example.com/path?q=jk');
});

test('the prompt preserves multiline paste and submits it with Enter', async () => {
	const f = await field('', {isMultiline: true});
	teardown(() => f.view.unmount());
	await f.view.stdin.write('\x1b[200~first line\nsecond line\x1b[201~');
	expect(f.value()).toBe('first line\nsecond line');
	await f.view.stdin.write('\r');
	expect(f.submitted()).toBe('first line\nsecond line');
});

test('a hidden caret freezes editing but still submits the ready suggestion', async () => {
	const f = await field('original', {isShowingCursor: false});
	teardown(() => f.view.unmount());
	await f.view.stdin.write('x');
	expect(f.value()).toBe('original');
	await f.view.stdin.write('\r');
	expect(f.submitted()).toBe('original');
});

test('parent echo keeps the caret while an external completion moves it to the end', async () => {
	const f = await field('abc');
	teardown(() => f.view.unmount());
	await f.view.stdin.write('\x1b[DX');
	await f.view.stdin.write('Y');
	expect(f.value()).toBe('abXYc');
	await f.replace('/completed');
	await f.view.stdin.write('!');
	expect(f.value()).toBe('/completed!');
});
