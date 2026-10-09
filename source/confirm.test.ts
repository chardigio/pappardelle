import {PassThrough} from 'node:stream';
import test from 'ava';
import {confirm} from './confirm.ts';

test('closing stdin at a y/N prompt answers no instead of failing', async t => {
	const input = new PassThrough();
	const answer = confirm('Restart? ', input, new PassThrough());
	input.end();

	t.false(await answer);
});

test('y at a y/N prompt answers yes', async t => {
	const input = new PassThrough();
	const answer = confirm('Restart? ', input, new PassThrough());
	input.write('y\n');

	t.true(await answer);
});
