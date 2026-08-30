import test from 'ava';
import {reconcileCursorOffset} from './cursor-reconcile.ts';

test('an echo of the value the input itself emitted leaves the cursor alone', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: 'hello',
			lastEmittedValue: 'hello',
			cursorOffset: 2,
		}),
		2,
	);
});

test('an external replacement parks the cursor at the end', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: '/do-pappardelle ',
			lastEmittedValue: '/do-pap',
			cursorOffset: 7,
		}),
		16,
	);
});

test('an external replacement wins even when the cursor is already in range', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: 'a much longer value',
			lastEmittedValue: 'short',
			cursorOffset: 0,
		}),
		19,
	);
});

test('an external clear parks the cursor at zero', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: '',
			lastEmittedValue: 'something',
			cursorOffset: 9,
		}),
		0,
	);
});

test('an echoed value still clamps a cursor that sits past the end', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: 'abc',
			lastEmittedValue: 'abc',
			cursorOffset: 99,
		}),
		3,
	);
});

test('an echoed value clamps a negative cursor to zero', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: 'abc',
			lastEmittedValue: 'abc',
			cursorOffset: -4,
		}),
		0,
	);
});

test('a cursor resting one past the last character is a valid end position', t => {
	t.is(
		reconcileCursorOffset({
			incomingValue: 'abc',
			lastEmittedValue: 'abc',
			cursorOffset: 3,
		}),
		3,
	);
});
