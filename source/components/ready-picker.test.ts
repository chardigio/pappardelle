import {test, expect} from 'bun:test';
import {
	INPUT_INDEX,
	moveSelection,
	resolveSubmission,
	selectionAfterRemoval,
	visibleWindow,
} from './ready-picker.ts';

// moveSelection

test('down from the input enters the list at the first row', () => {
	expect(moveSelection(INPUT_INDEX, 3, 'down')).toBe(0);
});

test('down walks the list', () => {
	expect(moveSelection(0, 3, 'down')).toBe(1);
	expect(moveSelection(1, 3, 'down')).toBe(2);
});

test('down stops at the last row rather than wrapping', () => {
	expect(moveSelection(2, 3, 'down')).toBe(2);
});

test('up from the first row returns to the input', () => {
	expect(moveSelection(0, 3, 'up')).toBe(INPUT_INDEX);
});

test('up stops at the input rather than wrapping to the last row', () => {
	expect(moveSelection(INPUT_INDEX, 3, 'up')).toBe(INPUT_INDEX);
});

test('an empty list pins the cursor to the input', () => {
	expect(moveSelection(INPUT_INDEX, 0, 'down')).toBe(INPUT_INDEX);
	expect(moveSelection(INPUT_INDEX, 0, 'up')).toBe(INPUT_INDEX);
});

// resolveSubmission

test('a highlighted suggestion wins over typed text', () => {
	expect(
		resolveSubmission('dark mode', ['pappardelle-a1', 'pappardelle-b2'], 1),
	).toBe('pappardelle-b2');
});

test('typed text is submitted when the cursor is in the input', () => {
	expect(
		resolveSubmission('add dark mode', ['pappardelle-a1'], INPUT_INDEX),
	).toBe('add dark mode');
});

test('typed text is trimmed', () => {
	expect(resolveSubmission('  STA-123  ', [], INPUT_INDEX)).toBe('STA-123');
});

test('an empty input submits nothing', () => {
	expect(resolveSubmission('', [], INPUT_INDEX)).toBe(null);
	expect(resolveSubmission('   ', [], INPUT_INDEX)).toBe(null);
});

test('a selection past the end of the list submits nothing', () => {
	expect(resolveSubmission('typed', ['pappardelle-a1'], 5)).toBe(null);
});

// selectionAfterRemoval

test('the cursor holds its row so the next issue slides under it', () => {
	expect(selectionAfterRemoval(1, 4)).toBe(1);
});

test('removing the last row steps the cursor back', () => {
	expect(selectionAfterRemoval(4, 4)).toBe(3);
});

test('emptying the list returns the cursor to the input', () => {
	expect(selectionAfterRemoval(0, 0)).toBe(INPUT_INDEX);
});

test('a cursor already in the input stays there', () => {
	expect(selectionAfterRemoval(INPUT_INDEX, 3)).toBe(INPUT_INDEX);
});

// visibleWindow

test('a list shorter than the window renders whole', () => {
	expect(visibleWindow(INPUT_INDEX, 3, 8)).toStrictEqual({start: 0, end: 3});
});

test('a cursor in the input shows the head of a long list', () => {
	expect(visibleWindow(INPUT_INDEX, 20, 8)).toStrictEqual({start: 0, end: 8});
});

test('the window scrolls to keep the selection centered', () => {
	expect(visibleWindow(10, 20, 8)).toStrictEqual({start: 6, end: 14});
});

test('the window clamps at the end of the list', () => {
	expect(visibleWindow(19, 20, 8)).toStrictEqual({start: 12, end: 20});
});

test('the window never starts before the first row', () => {
	expect(visibleWindow(1, 20, 8)).toStrictEqual({start: 0, end: 8});
});
