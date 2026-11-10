import React from 'react';
import test from 'ava';
import {render} from '../../test/helpers/render.ts';
import {useWidthMethod} from './use-width-method.ts';

function Row() {
	return React.createElement('text', {}, useWidthMethod());
}

// One listener per rail row tripped Node's 10-listener warning, which the
// rail logs as an error and counts in its header.
test('rows share one capabilities subscription', async t => {
	const rows = Array.from({length: 20}, (_, i) =>
		React.createElement(Row, {key: i}),
	);
	const view = await render(React.createElement('box', {}, rows));
	t.is(view.renderer.listenerCount('capabilities'), 1);
	await view.unmount();
});
