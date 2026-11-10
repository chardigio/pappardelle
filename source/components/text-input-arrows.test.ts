import React, {useState} from 'react';
import {render} from '../../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import TextInput from './TextInput.tsx';

async function typeAfterUp(isKeepingVerticalArrows: boolean) {
	let latest = '';
	function Field() {
		const [value, setValue] = useState('first\nsecond');
		latest = value;
		return React.createElement(TextInput, {
			value,
			onChange: setValue,
			isMultiline: true,
			isKeepingVerticalArrows,
		});
	}

	const view = await render(React.createElement(Field));
	await delay(10);
	await view.stdin.write('\u001B[F');
	await view.stdin.write('\u001B[A');
	await view.stdin.write('X');
	await delay(50);
	await view.unmount();
	return latest;
}

test('with no list to hand Up to, Up moves the caret to the line above', async t => {
	t.is(await typeAfterUp(true), 'firstX\nsecond');
});

test('while a list owns the arrows, Up leaves the caret where it was', async t => {
	t.is(await typeAfterUp(false), 'first\nsecondX');
});
