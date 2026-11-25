import React, {useState} from 'react';
import {render} from '../../test/helpers/render.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {test, expect} from 'bun:test';
import {teardown} from '../../test/helpers/teardown.ts';
import TextInput from './TextInput.tsx';

test('a prompt cleared on submit stays cleared', async () => {
	const submitted: string[] = [];
	let latest: string | undefined;
	function Field() {
		const [value, setValue] = useState('');
		latest = value;
		return React.createElement(TextInput, {
			value,
			onChange: setValue,
			onSubmit(text) {
				submitted.push(text);
				setValue('');
			},
			isMultiline: true,
		});
	}

	const view = await render(React.createElement(Field));
	teardown(async () => {
		await view.unmount();
	});
	await delay(10);

	await view.stdin.write('fix the login');
	await delay(20);
	await view.stdin.write('\r');
	await delay(50);

	expect(submitted).toStrictEqual(['fix the login']);
	expect(latest).toBe('');
});
