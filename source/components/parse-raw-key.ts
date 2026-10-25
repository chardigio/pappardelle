/**
 * Raw-stdin key parser used by the pappardelle TextInput.
 *
 * Ink 4.x's `parseKeypress` (node_modules/ink/build/parse-keypress.js)
 * conflates two physically distinct Mac keystrokes by naming both `'delete'`:
 *
 *   - `\x7f`       — the Mac Delete/Backspace key (the big key above Return)
 *   - `\x1b[3~`    — fn+Delete (forward delete)
 *
 * STA-1131 added a forward-delete branch keyed off `key.delete && !key.meta`,
 * which then silently fired for every press of the regular Delete key
 * (STA-1145). Because the conflation is baked into Ink, `useInput` consumers
 * cannot recover the original raw sequence — so the pappardelle TextInput
 * parses raw stdin itself via `useRawInput` (which calls this function) and
 * gets back a `KeyLike` with the canonical separation:
 *
 *   - `\x7f`, `\x1b\x7f`, `\b`, `\x1b\b` → `backspace: true`
 *   - `\x1b[3~`                          → `delete: true` (forward only)
 *
 * Logic is ported from Ink's parseKeypress (MIT, via enquirer) with the
 * single classification fix applied at the `\x7f` branch. We deliberately
 * keep the shape compatible with `KeyLike` so the existing
 * `handleTextInputKey` keymap continues to work unchanged.
 */
import {Buffer} from 'node:buffer';
import type {KeyLike} from './text-input-key.ts';

// eslint-disable-next-line no-control-regex
const metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/;
const fnKeyRe =
	// eslint-disable-next-line no-control-regex
	/^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

const keyName: Record<string, string> = {
	OP: 'f1',
	OQ: 'f2',
	OR: 'f3',
	OS: 'f4',
	'[11~': 'f1',
	'[12~': 'f2',
	'[13~': 'f3',
	'[14~': 'f4',
	'[[A': 'f1',
	'[[B': 'f2',
	'[[C': 'f3',
	'[[D': 'f4',
	'[[E': 'f5',
	'[15~': 'f5',
	'[17~': 'f6',
	'[18~': 'f7',
	'[19~': 'f8',
	'[20~': 'f9',
	'[21~': 'f10',
	'[23~': 'f11',
	'[24~': 'f12',
	'[A': 'up',
	'[B': 'down',
	'[C': 'right',
	'[D': 'left',
	'[E': 'clear',
	'[F': 'end',
	'[H': 'home',
	OA: 'up',
	OB: 'down',
	OC: 'right',
	OD: 'left',
	OE: 'clear',
	OF: 'end',
	OH: 'home',
	'[1~': 'home',
	'[2~': 'insert',
	'[3~': 'delete',
	'[4~': 'end',
	'[5~': 'pageup',
	'[6~': 'pagedown',
	'[[5~': 'pageup',
	'[[6~': 'pagedown',
	'[7~': 'home',
	'[8~': 'end',
	'[a': 'up',
	'[b': 'down',
	'[c': 'right',
	'[d': 'left',
	'[e': 'clear',
	'[2$': 'insert',
	'[3$': 'delete',
	'[5$': 'pageup',
	'[6$': 'pagedown',
	'[7$': 'home',
	'[8$': 'end',
	Oa: 'up',
	Ob: 'down',
	Oc: 'right',
	Od: 'left',
	Oe: 'clear',
	'[2^': 'insert',
	'[3^': 'delete',
	'[5^': 'pageup',
	'[6^': 'pagedown',
	'[7^': 'home',
	'[8^': 'end',
	'[Z': 'tab',
};

const shiftCodes = new Set([
	'[a',
	'[b',
	'[c',
	'[d',
	'[e',
	'[2$',
	'[3$',
	'[5$',
	'[6$',
	'[7$',
	'[8$',
	'[Z',
]);

const ctrlCodes = new Set([
	'Oa',
	'Ob',
	'Oc',
	'Od',
	'Oe',
	'[2^',
	'[3^',
	'[5^',
	'[6^',
	'[7^',
	'[8^',
]);

const nonAlphanumericNames = new Set([...Object.values(keyName), 'backspace']);

type Keypress = {
	name: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	option: boolean;
	sequence: string;
};

function classifySimple(s: string, k: Keypress): boolean {
	if (s === '\r') {
		k.name = 'return';
		return true;
	}
	if (s === '\n') {
		k.name = 'enter';
		return true;
	}
	if (s === '\t') {
		k.name = 'tab';
		return true;
	}
	if (s === '\b' || s === '\x1b\b' || s === '\x7f' || s === '\x1b\x7f') {
		// Classification fix: Ink names \x7f as 'delete' for legacy reasons.
		// We treat all four (ctrl+h, alt+ctrl+h, backspace, alt+backspace) as
		// backspace so the only thing left to mean "delete" is the explicit
		// fn+Delete sequence \x1b[3~.
		k.name = 'backspace';
		k.meta = s.startsWith('\x1b');
		return true;
	}
	if (s === '\x1b' || s === '\x1b\x1b') {
		k.name = 'escape';
		k.meta = s.length === 2;
		return true;
	}
	if (s === ' ' || s === '\x1b ') {
		k.name = 'space';
		k.meta = s.length === 2;
		return true;
	}
	return false;
}

function classifyChar(s: string, k: Keypress): boolean {
	if (s.length !== 1) {
		return false;
	}
	const code = s.codePointAt(0) ?? 0;
	if (code <= 0x1a) {
		k.name = String.fromCodePoint(code + 'a'.codePointAt(0)! - 1);
		k.ctrl = true;
		return true;
	}
	if (s >= '0' && s <= '9') {
		k.name = 'number';
		return true;
	}
	if (s >= 'a' && s <= 'z') {
		k.name = s;
		return true;
	}
	if (s >= 'A' && s <= 'Z') {
		k.name = s.toLowerCase();
		k.shift = true;
		return true;
	}
	return false;
}

function classifyEscape(s: string, k: Keypress): void {
	const metaMatch = metaKeyCodeRe.exec(s);
	if (metaMatch) {
		k.meta = true;
		k.shift = /^[A-Z]$/.test(metaMatch[1]!);
		k.name = metaMatch[1]!.toLowerCase();
		return;
	}
	const fnMatch = fnKeyRe.exec(s);
	if (!fnMatch) {
		return;
	}
	const segs = [...s];
	if (segs[0] === '\x1b' && segs[1] === '\x1b') {
		k.option = true;
	}
	const code = [fnMatch[1], fnMatch[2], fnMatch[4], fnMatch[6]]
		.filter(Boolean)
		.join('');
	const modifier = (Number(fnMatch[3] ?? fnMatch[5] ?? 1) || 1) - 1;
	// xterm modifier param encodes (1 + Shift + Alt*2 + Ctrl*4 + Meta*8), so
	// `modifier` here is the raw bitmask after subtracting 1: bit 0=Shift,
	// bit 1=Alt, bit 2=Ctrl, bit 3=Meta. The 0b1010 (=10) mask catches Alt or
	// Meta, both of which we surface as `meta` since downstream code treats
	// them interchangeably.
	/* eslint-disable no-bitwise */
	k.ctrl = (modifier & 4) !== 0;
	k.meta = (modifier & 10) !== 0;
	k.shift = (modifier & 1) !== 0;
	/* eslint-enable no-bitwise */
	k.name = keyName[code] ?? '';
	k.shift = shiftCodes.has(code) || k.shift;
	k.ctrl = ctrlCodes.has(code) || k.ctrl;
}

function parseKeypress(input: string): Keypress {
	const s =
		typeof input === 'string'
			? input
			: Buffer.isBuffer(input)
				? String(input)
				: '';
	const k: Keypress = {
		name: '',
		ctrl: false,
		meta: false,
		shift: false,
		option: false,
		sequence: s,
	};

	if (classifySimple(s, k)) {
		return k;
	}
	if (classifyChar(s, k)) {
		return k;
	}
	classifyEscape(s, k);
	return k;
}

export type RawKey = KeyLike;

export function parseRawKey(data: string): {input: string; key: RawKey} {
	const k = parseKeypress(data);
	const key: KeyLike = {
		leftArrow: k.name === 'left',
		rightArrow: k.name === 'right',
		upArrow: k.name === 'up',
		downArrow: k.name === 'down',
		backspace: k.name === 'backspace',
		delete: k.name === 'delete',
		meta: k.meta || k.name === 'escape' || k.option,
		ctrl: k.ctrl,
		shift: k.shift,
		tab: k.name === 'tab',
		return: k.name === 'return',
	};

	let input = k.ctrl ? k.name : k.sequence;
	if (nonAlphanumericNames.has(k.name)) {
		input = '';
	}
	// readline / Natural-Text-Editing convention: \x1bb / \x1bf parse with
	// meta=true and the literal letter as the name. Surface the letter as
	// `input` so handleTextInputKey can branch on `meta + input === 'b'/'f'`.
	if (
		k.meta &&
		!k.ctrl &&
		/^[a-z0-9]$/i.test(k.name) &&
		k.sequence.length > 1
	) {
		input = k.name;
	}
	// Strip a leading ESC that survived the parser (matches Ink's behavior).
	if (input.startsWith('\x1b')) {
		input = input.slice(1);
	}

	return {input, key};
}
