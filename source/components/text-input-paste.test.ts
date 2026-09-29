import React, {useState} from 'react';
import {render} from 'ink-testing-library';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import TextInput from './TextInput.tsx';

// Terminals and tmux deliver a long paste as several stdin reads, which can all
// land before React re-renders the input with the first chunk applied.
test('a paste split across stdin reads keeps every chunk', async t => {
	let latest = '';
	function Field() {
		const [value, setValue] = useState('');
		latest = value;
		return React.createElement(TextInput, {value, onChange: setValue});
	}

	const view = render(React.createElement(Field));
	t.teardown(() => view.unmount());
	await delay(10);

	view.stdin.write('https://gitlab.seatgeekadmin.com/rex/');
	view.stdin.write('catalyst/-/merge_requests/2');
	view.stdin.write('411');
	await delay(50);

	t.is(
		latest,
		'https://gitlab.seatgeekadmin.com/rex/catalyst/-/merge_requests/2411',
	);
});
