import test from 'ava';
import {parseRawKey} from './parse-raw-key.ts';

// ============================================================================
// Backspace / Delete classification — the regression these tests pin in place.
//
// Ink 4.x's parseKeypress names BOTH \x7f (Mac Delete/Backspace key) and
// \x1b[3~ (fn+Delete) as 'delete', so useInput consumers can't tell them
// apart. STA-1131 added a "key.delete && !key.meta → forward delete" branch
// to TextInput, which silently broke the regular Delete key (STA-1145).
// parseRawKey reclassifies the raw bytes so that:
//   - \x7f, \x1b\x7f, \b, \x1b\b → key.backspace=true (backward delete)
//   - \x1b[3~                    → key.delete=true   (forward delete only)
// ============================================================================

test('\\x7f (Mac Delete/Backspace key) is parsed as backspace, not delete', t => {
	const {key} = parseRawKey('\x7f');
	t.true(key.backspace);
	t.false(key.delete);
	t.false(key.meta);
});

test('\\x1b\\x7f (Alt+Backspace) is parsed as backspace+meta', t => {
	const {key} = parseRawKey('\x1b\x7f');
	t.true(key.backspace);
	t.false(key.delete);
	t.true(key.meta);
});

test('\\x1b[3~ (fn+Delete) is parsed as delete, not backspace', t => {
	const {key} = parseRawKey('\x1b[3~');
	t.true(key.delete);
	t.false(key.backspace);
	t.false(key.meta);
});

test('\\b (Ctrl+H) is parsed as backspace', t => {
	const {key} = parseRawKey('\b');
	t.true(key.backspace);
	t.false(key.delete);
});

// ============================================================================
// Cursor navigation — pass-through to standard semantics.
// ============================================================================

test('\\x1b[D is parsed as left arrow', t => {
	const {key} = parseRawKey('\x1b[D');
	t.true(key.leftArrow);
});

test('\\x1b[C is parsed as right arrow', t => {
	const {key} = parseRawKey('\x1b[C');
	t.true(key.rightArrow);
});

test('\\x1b[A is parsed as up arrow', t => {
	const {key} = parseRawKey('\x1b[A');
	t.true(key.upArrow);
});

test('\\x1b[B is parsed as down arrow', t => {
	const {key} = parseRawKey('\x1b[B');
	t.true(key.downArrow);
});

test('\\x1b\\x1b[D (Esc-prefix Option+Left) sets leftArrow + meta', t => {
	const {key} = parseRawKey('\x1b\x1b[D');
	t.true(key.leftArrow);
	t.true(key.meta);
});

test('\\x1b[1;3D (xterm Alt+Left) sets leftArrow + meta', t => {
	const {key} = parseRawKey('\x1b[1;3D');
	t.true(key.leftArrow);
	t.true(key.meta);
});

test('\\x1bb (readline word-back / Natural Text Editing) sets input=b + meta', t => {
	const {input, key} = parseRawKey('\x1bb');
	t.is(input, 'b');
	t.true(key.meta);
	t.false(key.leftArrow);
});

test('\\x1bf (readline word-forward) sets input=f + meta', t => {
	const {input, key} = parseRawKey('\x1bf');
	t.is(input, 'f');
	t.true(key.meta);
	t.false(key.rightArrow);
});

// ============================================================================
// Plain typing and control keys.
// ============================================================================

test('lowercase letter passes through as input', t => {
	const {input, key} = parseRawKey('a');
	t.is(input, 'a');
	t.false(key.ctrl);
	t.false(key.meta);
	t.false(key.shift);
});

test('uppercase letter sets shift', t => {
	const {input, key} = parseRawKey('A');
	t.is(input, 'A');
	t.true(key.shift);
});

test('return is parsed as return', t => {
	const {key} = parseRawKey('\r');
	t.true(key.return);
});

test('tab is parsed as tab', t => {
	const {key} = parseRawKey('\t');
	t.true(key.tab);
});

test('ctrl+a sets ctrl with input=a', t => {
	const {input, key} = parseRawKey('\x01');
	t.is(input, 'a');
	t.true(key.ctrl);
});

test('ctrl+e sets ctrl with input=e', t => {
	const {input, key} = parseRawKey('\x05');
	t.is(input, 'e');
	t.true(key.ctrl);
});

test('ctrl+u sets ctrl with input=u', t => {
	const {input, key} = parseRawKey('\x15');
	t.is(input, 'u');
	t.true(key.ctrl);
});

test('ctrl+c sets ctrl with input=c', t => {
	const {input, key} = parseRawKey('\x03');
	t.is(input, 'c');
	t.true(key.ctrl);
});

test('space is parsed with input=space character', t => {
	const {input} = parseRawKey(' ');
	t.is(input, ' ');
});
