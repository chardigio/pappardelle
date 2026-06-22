import test from 'ava';
import {PassThrough} from 'node:stream';
import {Buffer} from 'node:buffer';
import {
	normalizeKittyKeyboard,
	createNormalizingStdin,
} from './kitty-keyboard.ts';
import {parseRawKey} from './parse-raw-key.ts';
import {handleTextInputKey} from './text-input-key.ts';

// ============================================================================
// normalizeKittyKeyboard — the CSI u (Kitty keyboard protocol) decoder.
//
// STA-1545: under tmux extended-keys / terminals with the Kitty keyboard
// protocol "disambiguate escape codes" mode, Esc arrives as `ESC [ 27 u`
// instead of a bare `ESC`. Neither Ink's parseKeypress nor our parseRawKey
// recognizes CSI u, so Esc neither cancelled dialogs nor stayed out of the
// text field (it inserted the literal "[27u"). We rewrite CSI u to its legacy
// byte equivalent at the stdin layer so every downstream parser just works.
// ============================================================================

// --- The reported bug: Esc -------------------------------------------------

test('rewrites CSI u Escape (ESC [ 27 u) to a bare ESC', t => {
	t.is(normalizeKittyKeyboard('\x1b[27u'), '\x1b');
});

test('rewrites CSI u Escape with explicit no-modifier param (27;1)', t => {
	t.is(normalizeKittyKeyboard('\x1b[27;1u'), '\x1b');
});

// --- Other unmodified special keys this mode also encodes -------------------

test('rewrites CSI u Enter (13) to CR', t => {
	t.is(normalizeKittyKeyboard('\x1b[13u'), '\r');
});

test('rewrites CSI u Tab (9) to TAB', t => {
	t.is(normalizeKittyKeyboard('\x1b[9u'), '\t');
});

test('rewrites CSI u Backspace (127) to DEL', t => {
	t.is(normalizeKittyKeyboard('\x1b[127u'), '\x7f');
});

test('rewrites CSI u Space (32) to a space', t => {
	t.is(normalizeKittyKeyboard('\x1b[32u'), ' ');
});

// --- Printable letters (terminals in "report all keys" mode) ---------------

test('rewrites a plain printable codepoint to its character', t => {
	t.is(normalizeKittyKeyboard('\x1b[97u'), 'a');
});

test('uppercases a letter when the Shift modifier is set', t => {
	// modifier param 2 => bitmask 1 => Shift
	t.is(normalizeKittyKeyboard('\x1b[97;2u'), 'A');
});

test('uses the base code, applying Shift, when an alternate (shifted) keycode is present', t => {
	// `code:alternate` form — base 97 (a), alternate 65 (A); Shift set.
	t.is(normalizeKittyKeyboard('\x1b[97:65;2u'), 'A');
});

// --- Ctrl / Alt reconstruction ---------------------------------------------

test('reconstructs Ctrl+letter as the C0 control byte', t => {
	// modifier 5 => bitmask 4 => Ctrl. Ctrl+C must stay \x03 so quit still works.
	t.is(normalizeKittyKeyboard('\x1b[99;5u'), '\x03');
	t.is(normalizeKittyKeyboard('\x1b[97;5u'), '\x01');
});

test('reconstructs Alt+letter as ESC-prefixed (readline word-nav convention)', t => {
	// modifier 3 => bitmask 2 => Alt. Alt+b / Alt+f drive word movement.
	t.is(normalizeKittyKeyboard('\x1b[98;3u'), '\x1bb');
	t.is(normalizeKittyKeyboard('\x1b[102;3u'), '\x1bf');
});

// --- Event types: drop key-release ------------------------------------------

test('drops key-release events so a press is never double-counted', t => {
	// `mods:event-type` — event type 3 = release.
	t.is(normalizeKittyKeyboard('\x1b[97;1:3u'), '');
});

test('keeps press (1) and repeat (2) events', t => {
	t.is(normalizeKittyKeyboard('\x1b[97;1:1u'), 'a');
	t.is(normalizeKittyKeyboard('\x1b[97;1:2u'), 'a');
});

// --- Things we deliberately leave untouched --------------------------------

test('leaves Super/Hyper/Meta-modified keys untouched (no faithful legacy encoding)', t => {
	// Each high modifier must be guarded individually, not just Super — a
	// Hyper/Meta-only key would otherwise be mistranslated to its bare base char.
	t.is(normalizeKittyKeyboard('\x1b[97;9u'), '\x1b[97;9u'); // mod 9  => 0x08 Super
	t.is(normalizeKittyKeyboard('\x1b[97;17u'), '\x1b[97;17u'); // mod 17 => 0x10 Hyper
	t.is(normalizeKittyKeyboard('\x1b[97;33u'), '\x1b[97;33u'); // mod 33 => 0x20 Meta
});

test('still translates an ordinary key reported with only a lock modifier active', t => {
	// mod 65 => bitmask 0x40 (Caps Lock) — a lock state, not a "real" modifier,
	// so the key must still translate rather than be left verbatim.
	t.is(normalizeKittyKeyboard('\x1b[97;65u'), 'a');
});

test('leaves Private-Use / functional keycodes untouched', t => {
	// Kitty encodes functional keys (e.g. F-keys) in the PUA range 57344+.
	t.is(normalizeKittyKeyboard('\x1b[57364u'), '\x1b[57364u');
});

test('leaves malformed CSI-u-like sequences untouched', t => {
	t.is(normalizeKittyKeyboard('\x1b[u'), '\x1b[u');
	t.is(normalizeKittyKeyboard('\x1b[;u'), '\x1b[;u');
});

// --- Regression: no CSI u present => byte-for-byte identical ----------------
// This is the off-by-default guarantee: a terminal that never emits CSI u
// (e.g. the personal MacBook today) sees zero behavior change.

test('passes plain text through unchanged', t => {
	t.is(normalizeKittyKeyboard('hello world'), 'hello world');
	t.is(normalizeKittyKeyboard('a'), 'a');
});

test('passes a bare ESC through unchanged', t => {
	t.is(normalizeKittyKeyboard('\x1b'), '\x1b');
});

test('passes legacy arrow / function escape sequences through unchanged', t => {
	t.is(normalizeKittyKeyboard('\x1b[A'), '\x1b[A'); // up arrow
	t.is(normalizeKittyKeyboard('\x1b[1;3D'), '\x1b[1;3D'); // Alt+Left (xterm)
	t.is(normalizeKittyKeyboard('\x1b[3~'), '\x1b[3~'); // fn+Delete
});

test('never touches SGR mouse sequences (terminate in M/m, contain <)', t => {
	t.is(normalizeKittyKeyboard('\x1b[<0;10;20M'), '\x1b[<0;10;20M');
	t.is(normalizeKittyKeyboard('\x1b[<0;10;20m'), '\x1b[<0;10;20m');
});

test('never touches a Kitty flags query response (CSI ? flags u)', t => {
	t.is(normalizeKittyKeyboard('\x1b[?1u'), '\x1b[?1u');
});

// --- Multiple / embedded sequences in one chunk ----------------------------

test('rewrites every CSI u sequence in a chunk', t => {
	t.is(normalizeKittyKeyboard('\x1b[27u\x1b[27u'), '\x1b\x1b');
});

test('rewrites CSI u sequences embedded among other text', t => {
	t.is(normalizeKittyKeyboard('a\x1b[27ub'), 'a\x1bb');
});

// ============================================================================
// End-to-end: the exact STA-1545 bug, pinned through the real parsers.
//
// Without normalization, `\x1b[27u` parses to the literal input "[27u" and gets
// typed into the field ("hi" -> "hi[27u"). After normalization it is a bare ESC
// that parseRawKey treats as Escape (input "", meta) — identical to a real Esc.
// ============================================================================

test('regression: un-normalized CSI u Esc IS the "[27u" bug (documents prior behavior)', t => {
	const before = parseRawKey('\x1b[27u');
	t.is(before.input, '[27u');
	t.is(handleTextInputKey('hi', 2, before.input, before.key).value, 'hi[27u');
});

test('end-to-end: a normalized CSI u Esc parses identically to a real Esc', t => {
	const after = parseRawKey(normalizeKittyKeyboard('\x1b[27u'));
	t.is(after.input, '');
	t.true(after.key.meta);
	t.deepEqual(after, parseRawKey('\x1b'));
});

test('end-to-end: a normalized CSI u Esc never inserts text into TextInput', t => {
	const {input, key} = parseRawKey(normalizeKittyKeyboard('\x1b[27u'));
	t.is(handleTextInputKey('hi', 2, input, key).value, 'hi');
});

// ============================================================================
// createNormalizingStdin — the stdin wrapper Ink reads through.
// ============================================================================

function fakeTty() {
	const src = new PassThrough() as PassThrough & {
		isTTY?: boolean;
		setRawMode?: (mode: boolean) => void;
		ref?: () => void;
		unref?: () => void;
	};
	const calls = {rawMode: [] as boolean[], ref: 0, unref: 0};
	src.isTTY = true;
	src.setRawMode = (mode: boolean) => {
		calls.rawMode.push(mode);
	};
	src.ref = () => {
		calls.ref++;
	};
	src.unref = () => {
		calls.unref++;
	};
	return {src, calls};
}

test('createNormalizingStdin normalizes bytes that flow through it', async t => {
	const {src} = fakeTty();
	const wrapped = createNormalizingStdin(src);
	const out: string[] = [];
	wrapped.setEncoding('utf8');
	wrapped.on('data', (chunk: string) => out.push(chunk));

	src.write(Buffer.from('\x1b[27u'));
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	t.is(out.join(''), '\x1b');
});

test('createNormalizingStdin forwards a source error to the wrapper (pipe gotcha)', async t => {
	const {src} = fakeTty();
	const wrapped = createNormalizingStdin(src);
	const boom = new Error('stdin hangup');

	const seen = new Promise<Error>(resolve => {
		wrapped.on('error', resolve);
	});
	src.emit('error', boom);

	t.is(await seen, boom);
});

test('createNormalizingStdin exposes isTTY and forwards setRawMode/ref/unref', t => {
	const {src, calls} = fakeTty();
	const wrapped = createNormalizingStdin(src) as ReturnType<
		typeof createNormalizingStdin
	> & {
		isTTY?: boolean;
		setRawMode: (mode: boolean) => void;
		ref: () => void;
		unref: () => void;
	};

	t.true(wrapped.isTTY);

	wrapped.setRawMode(true);
	wrapped.setRawMode(false);
	wrapped.ref();
	wrapped.unref();

	t.deepEqual(calls.rawMode, [true, false]);
	t.is(calls.ref, 1);
	t.is(calls.unref, 1);
});
