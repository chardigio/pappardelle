import test from 'ava';
import {
	INPUT_INDEX,
	moveSelection,
	resolveSubmission,
	selectionAfterRemoval,
	visibleWindow,
} from './ready-picker.ts';

// moveSelection

test('down from the input enters the list at the first row', t => {
	t.is(moveSelection(INPUT_INDEX, 3, 'down'), 0);
});

test('down walks the list', t => {
	t.is(moveSelection(0, 3, 'down'), 1);
	t.is(moveSelection(1, 3, 'down'), 2);
});

test('down stops at the last row rather than wrapping', t => {
	t.is(moveSelection(2, 3, 'down'), 2);
});

test('up from the first row returns to the input', t => {
	t.is(moveSelection(0, 3, 'up'), INPUT_INDEX);
});

test('up stops at the input rather than wrapping to the last row', t => {
	t.is(moveSelection(INPUT_INDEX, 3, 'up'), INPUT_INDEX);
});

test('an empty list pins the cursor to the input', t => {
	t.is(moveSelection(INPUT_INDEX, 0, 'down'), INPUT_INDEX);
	t.is(moveSelection(INPUT_INDEX, 0, 'up'), INPUT_INDEX);
});

// resolveSubmission

test('a highlighted suggestion wins over typed text', t => {
	t.is(
		resolveSubmission('dark mode', ['pappardelle-a1', 'pappardelle-b2'], 1),
		'pappardelle-b2',
	);
});

test('typed text is submitted when the cursor is in the input', t => {
	t.is(
		resolveSubmission('add dark mode', ['pappardelle-a1'], INPUT_INDEX),
		'add dark mode',
	);
});

test('typed text is trimmed', t => {
	t.is(resolveSubmission('  STA-123  ', [], INPUT_INDEX), 'STA-123');
});

test('an empty input submits nothing', t => {
	t.is(resolveSubmission('', [], INPUT_INDEX), null);
	t.is(resolveSubmission('   ', [], INPUT_INDEX), null);
});

test('a selection past the end of the list submits nothing', t => {
	t.is(resolveSubmission('typed', ['pappardelle-a1'], 5), null);
});

// selectionAfterRemoval

test('the cursor holds its row so the next issue slides under it', t => {
	t.is(selectionAfterRemoval(1, 4), 1);
});

test('removing the last row steps the cursor back', t => {
	t.is(selectionAfterRemoval(4, 4), 3);
});

test('emptying the list returns the cursor to the input', t => {
	t.is(selectionAfterRemoval(0, 0), INPUT_INDEX);
});

test('a cursor already in the input stays there', t => {
	t.is(selectionAfterRemoval(INPUT_INDEX, 3), INPUT_INDEX);
});

// visibleWindow

test('a list shorter than the window renders whole', t => {
	t.deepEqual(visibleWindow(INPUT_INDEX, 3, 8), {start: 0, end: 3});
});

test('a cursor in the input shows the head of a long list', t => {
	t.deepEqual(visibleWindow(INPUT_INDEX, 20, 8), {start: 0, end: 8});
});

test('the window scrolls to keep the selection centered', t => {
	t.deepEqual(visibleWindow(10, 20, 8), {start: 6, end: 14});
});

test('the window clamps at the end of the list', t => {
	t.deepEqual(visibleWindow(19, 20, 8), {start: 12, end: 20});
});

test('the window never starts before the first row', t => {
	t.deepEqual(visibleWindow(1, 20, 8), {start: 0, end: 8});
});
