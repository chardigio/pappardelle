import test from 'ava';
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
	test.serial(`native input preserves ${name}`, async t => {
		const f = await field(initial);
		t.teardown(() => f.view.unmount());
		await f.view.stdin.write(keys);
		t.is(f.value(), expected);
	});
}

test.serial(
	'fragmented bracketed paste is inserted once, without treating shortcuts as keys',
	async t => {
		const f = await field('');
		t.teardown(() => f.view.unmount());
		await f.view.stdin.write('\x1b[200~https://example.com/');
		await f.view.stdin.write('path?q=jk');
		await f.view.stdin.write('\x1b[201~');
		t.is(f.value(), 'https://example.com/path?q=jk');
	},
);

test.serial(
	'the prompt preserves multiline paste and submits it with Enter',
	async t => {
		const f = await field('', {isMultiline: true});
		t.teardown(() => f.view.unmount());
		await f.view.stdin.write('\x1b[200~first line\nsecond line\x1b[201~');
		t.is(f.value(), 'first line\nsecond line');
		await f.view.stdin.write('\r');
		t.is(f.submitted(), 'first line\nsecond line');
	},
);

test.serial(
	'a hidden caret freezes editing but still submits the ready suggestion',
	async t => {
		const f = await field('original', {isShowingCursor: false});
		t.teardown(() => f.view.unmount());
		await f.view.stdin.write('x');
		t.is(f.value(), 'original');
		await f.view.stdin.write('\r');
		t.is(f.submitted(), 'original');
	},
);

test.serial(
	'parent echo keeps the caret while an external completion moves it to the end',
	async t => {
		const f = await field('abc');
		t.teardown(() => f.view.unmount());
		await f.view.stdin.write('\x1b[DX');
		await f.view.stdin.write('Y');
		t.is(f.value(), 'abXYc');
		await f.replace('/completed');
		await f.view.stdin.write('!');
		t.is(f.value(), '/completed!');
	},
);
