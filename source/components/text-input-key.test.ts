import test from 'ava';
import {handleTextInputKey, type KeyLike} from './text-input-key.ts';

const k = (overrides: KeyLike = {}): KeyLike => ({
	leftArrow: false,
	rightArrow: false,
	upArrow: false,
	downArrow: false,
	backspace: false,
	delete: false,
	meta: false,
	ctrl: false,
	shift: false,
	tab: false,
	return: false,
	...overrides,
});

// ============================================================================
// Plain typing
// ============================================================================

test('typing inserts character at cursor', t => {
	const r = handleTextInputKey('helo', 2, 'l', k());
	t.is(r.value, 'hello');
	t.is(r.cursorOffset, 3);
});

test("typing 'b' without meta inserts the letter", t => {
	const r = handleTextInputKey('a', 1, 'b', k());
	t.is(r.value, 'ab');
	t.is(r.cursorOffset, 2);
});

test("typing 'f' without meta inserts the letter", t => {
	const r = handleTextInputKey('a', 1, 'f', k());
	t.is(r.value, 'af');
	t.is(r.cursorOffset, 2);
});

// ============================================================================
// Plain arrows
// ============================================================================

test('left arrow moves cursor one char back', t => {
	const r = handleTextInputKey('hello', 3, '', k({leftArrow: true}));
	t.is(r.cursorOffset, 2);
	t.is(r.value, 'hello');
});

test('right arrow moves cursor one char forward', t => {
	const r = handleTextInputKey('hello', 3, '', k({rightArrow: true}));
	t.is(r.cursorOffset, 4);
});

test('left arrow at position 0 stays at 0', t => {
	const r = handleTextInputKey('hello', 0, '', k({leftArrow: true}));
	t.is(r.cursorOffset, 0);
});

test('right arrow at end stays at end', t => {
	const r = handleTextInputKey('hello', 5, '', k({rightArrow: true}));
	t.is(r.cursorOffset, 5);
});

// ============================================================================
// Alt+Arrow — three terminal conventions
// ============================================================================

test('alt+left via leftArrow+meta moves to previous word boundary', t => {
	// e.g. \x1b\x1b[D or \x1b[1;3D
	const r = handleTextInputKey(
		'hello world',
		11,
		'',
		k({leftArrow: true, meta: true}),
	);
	t.is(r.cursorOffset, 6);
});

test('alt+right via rightArrow+meta moves to next word boundary', t => {
	const r = handleTextInputKey(
		'hello world',
		0,
		'',
		k({rightArrow: true, meta: true}),
	);
	t.is(r.cursorOffset, 5);
});

test('alt+left via meta+b (readline / Natural Text Editing convention)', t => {
	// macOS Terminal default and iTerm2 "Natural Text Editing" send
	// Option+Left as \x1bb, which Ink parses as input='b', meta=true,
	// leftArrow=false. Must still be treated as word-back, NOT as typing 'b'.
	const r = handleTextInputKey('hello world', 11, 'b', k({meta: true}));
	t.is(r.cursorOffset, 6);
	t.is(r.value, 'hello world');
});

test('alt+right via meta+f (readline / Natural Text Editing convention)', t => {
	const r = handleTextInputKey('hello world', 0, 'f', k({meta: true}));
	t.is(r.cursorOffset, 5);
	t.is(r.value, 'hello world');
});

test('alt+left via meta+b across multiple words', t => {
	const r1 = handleTextInputKey('one two three', 13, 'b', k({meta: true}));
	t.is(r1.cursorOffset, 8);
	const r2 = handleTextInputKey('one two three', 8, 'b', k({meta: true}));
	t.is(r2.cursorOffset, 4);
	const r3 = handleTextInputKey('one two three', 4, 'b', k({meta: true}));
	t.is(r3.cursorOffset, 0);
});

test('alt+right via meta+f across multiple words', t => {
	const r1 = handleTextInputKey('one two three', 0, 'f', k({meta: true}));
	t.is(r1.cursorOffset, 3);
	const r2 = handleTextInputKey('one two three', 3, 'f', k({meta: true}));
	t.is(r2.cursorOffset, 7);
	const r3 = handleTextInputKey('one two three', 7, 'f', k({meta: true}));
	t.is(r3.cursorOffset, 13);
});

// ============================================================================
// Alt+Shift+Arrow — what Ghostty/Termius pass through where plain Alt+Arrow
// gets swallowed by the terminal/host before reaching the app.
// ============================================================================

test('shift+alt+left moves to previous word boundary', t => {
	// xterm sends \x1b[1;4D for Shift+Alt+Left, which Ink parses as
	// {leftArrow: true, meta: true, shift: true}.
	const r = handleTextInputKey(
		'hello world',
		11,
		'',
		k({leftArrow: true, meta: true, shift: true}),
	);
	t.is(r.cursorOffset, 6);
});

test('shift+alt+right moves to next word boundary', t => {
	const r = handleTextInputKey(
		'hello world',
		0,
		'',
		k({rightArrow: true, meta: true, shift: true}),
	);
	t.is(r.cursorOffset, 5);
});

test('shift+left without meta does not jump words', t => {
	// shift alone should not trigger word nav — falls through to char-left.
	const r = handleTextInputKey(
		'hello world',
		11,
		'',
		k({leftArrow: true, shift: true}),
	);
	t.is(r.cursorOffset, 10);
});

test('shift+right without meta does not jump words', t => {
	const r = handleTextInputKey(
		'hello world',
		0,
		'',
		k({rightArrow: true, shift: true}),
	);
	t.is(r.cursorOffset, 1);
});

// ============================================================================
// Alt+Backspace — already worked, but include for regression
// ============================================================================

test('alt+backspace deletes previous word', t => {
	const r = handleTextInputKey(
		'hello world',
		11,
		'',
		k({backspace: true, meta: true}),
	);
	t.is(r.value, 'hello ');
	t.is(r.cursorOffset, 6);
});

test('alt+delete deletes previous word (some terminals send delete vs backspace)', t => {
	const r = handleTextInputKey(
		'hello world',
		11,
		'',
		k({delete: true, meta: true}),
	);
	t.is(r.value, 'hello ');
	t.is(r.cursorOffset, 6);
});

test('plain backspace deletes one char', t => {
	const r = handleTextInputKey('hello', 5, '', k({backspace: true}));
	t.is(r.value, 'hell');
	t.is(r.cursorOffset, 4);
});

// ============================================================================
// Ignored keys
// ============================================================================

test('up arrow is ignored', t => {
	const r = handleTextInputKey('hello', 3, '', k({upArrow: true}));
	t.true(r.ignored);
});

test('down arrow is ignored', t => {
	const r = handleTextInputKey('hello', 3, '', k({downArrow: true}));
	t.true(r.ignored);
});

test('tab is ignored', t => {
	const r = handleTextInputKey('hello', 3, '', k({tab: true}));
	t.true(r.ignored);
});

test('ctrl+c is ignored', t => {
	const r = handleTextInputKey('hello', 3, 'c', k({ctrl: true}));
	t.true(r.ignored);
});

test('return signals submit', t => {
	const r = handleTextInputKey('hello', 5, '', k({return: true}));
	t.true(r.submit);
});
