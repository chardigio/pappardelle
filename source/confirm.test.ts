import {PassThrough} from 'node:stream';
import {test, expect} from 'bun:test';
import {confirm} from './confirm.ts';

test('closing stdin at a y/N prompt answers no instead of failing', async () => {
	const input = new PassThrough();
	const answer = confirm('Restart? ', input, new PassThrough());
	input.end();

	expect(await answer).toBe(false);
});

test('y at a y/N prompt answers yes', async () => {
	const input = new PassThrough();
	const answer = confirm('Restart? ', input, new PassThrough());
	input.write('y\n');

	expect(await answer).toBe(true);
});
