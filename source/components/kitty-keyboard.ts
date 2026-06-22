/**
 * Kitty keyboard protocol (a.k.a. "CSI u" / "fixterms" / progressive keyboard
 * enhancement) normalization for pappardelle's stdin.
 *
 * STA-1545: on terminals/tmux configs that enable the protocol's
 * "disambiguate escape codes" mode, the Esc key arrives as the CSI u sequence
 * `ESC [ 27 u` (codepoint 27 = ESC) rather than a bare `ESC` (0x1b). Neither
 * Ink 4.x's `parseKeypress` nor our own `parseRawKey` recognizes CSI u, so in
 * the New Session prompt Esc neither cancelled the dialog (Ink's `key.escape`
 * never fired) nor stayed out of the field (our parser stripped the leading
 * ESC and inserted the leftover `[27u` as text). Enter/Tab/Backspace are
 * encoded the same way under this mode and were affected identically.
 *
 * Rather than teach two separate parsers about CSI u — or try to *disable* the
 * protocol, which doesn't survive `tmux set extended-keys always` — we rewrite
 * CSI u back to its legacy byte equivalent at the single point both parsers
 * share: the stdin chunk Ink reads via `stdin.read()` and re-emits on
 * `internal_eventEmitter('input')`. Wrapping stdin with a normalizing stream
 * (passed to Ink's `render(node, {stdin})`) fixes every `useInput`/`useRawInput`
 * consumer at once, with zero per-component changes.
 *
 * Terminal-agnostic and regression-safe: a terminal that never emits CSI u
 * sees no `\x1b[…u` matches, so its bytes pass through byte-for-byte.
 */
import {Transform} from 'node:stream';
import {type Buffer} from 'node:buffer';

// CSI u keyboard sequences look like `ESC [ <params> u`, where <params> is the
// key code optionally followed by `;modifiers` (each field may carry a `:`
// sub-parameter — `code:alt-code`, `mods:event-type`). Restricting the body to
// [0-9;:] guarantees we never match SGR mouse reports (which contain `<` and
// terminate in M/m) or protocol query responses (`CSI ? flags u`, which
// contain `?`).
// eslint-disable-next-line no-control-regex
const csiURe = /\x1b\[([0-9;:]+)u/g;

// Legacy byte for the control/whitespace keys the protocol re-encodes as CSI u.
// (Their codepoints are the C0/DEL/space values themselves.)
const specialByCode: Record<number, string> = {
	9: '\t', // Tab
	13: '\r', // Enter / Return
	27: '\x1b', // Escape
	32: ' ', // Space
	127: '\x7f', // Backspace (Mac Delete key)
};

/** Kitty's functional keys live in the Unicode Private-Use ranges. */
function isPrivateUse(code: number): boolean {
	return (
		(code >= 0xe000 && code <= 0xf8ff) ||
		(code >= 0xf_0000 && code <= 0xf_fffd) ||
		(code >= 0x10_0000 && code <= 0x10_fffd)
	);
}

/** Translate a single CSI u match (already split into its params) to legacy bytes. */
function decodeCsiU(whole: string, params: string): string {
	const fields = params.split(';');
	const code = Number((fields[0] ?? '').split(':')[0]);
	if (!Number.isInteger(code) || code <= 0) {
		return whole;
	}

	const modSubs = (fields[1] ?? '').split(':');
	const modifiers = Number(modSubs[0] || '1') || 1;
	const eventType = Number(modSubs[1] || '1') || 1;
	// Drop key-release events (3); only press (1) and repeat (2) are real input.
	if (eventType === 3) {
		return '';
	}

	/* eslint-disable no-bitwise */
	const bits = modifiers - 1;
	const shift = (bits & 1) !== 0;
	const alt = (bits & 2) !== 0;
	const ctrl = (bits & 4) !== 0;
	// Super (0x08), Hyper (0x10) and Meta (0x20) have no faithful legacy
	// encoding — guard all three, not just Super, or a Hyper/Meta-only key would
	// slip through and be mistranslated to its bare base char. Lock states
	// (Caps 0x40, Num 0x80) are deliberately NOT guarded: an ordinary key
	// reported with a lock active must still translate.
	const superLike = (bits & (8 | 16 | 32)) !== 0;
	/* eslint-enable no-bitwise */

	if (superLike) {
		return whole;
	}

	let base = specialByCode[code];
	if (base === undefined) {
		// Printable Unicode scalar → its character. Skip Private-Use/functional
		// keys (F-keys etc.) and any surrogate range; we don't translate those.
		if (code >= 0x20 && code <= 0x10_ffff && !isPrivateUse(code)) {
			try {
				base = String.fromCodePoint(code);
			} catch {
				return whole;
			}
		} else {
			return whole;
		}
	}

	let out = base;
	if (ctrl) {
		// Ctrl maps ASCII letters to C0 controls (Ctrl+C → \x03 etc.). Only
		// letters are unambiguous across layouts; for anything else fall back to
		// the bare base so we never invent a control byte.
		const lower = base.toLowerCase();
		if (lower >= 'a' && lower <= 'z') {
			out = String.fromCodePoint(lower.codePointAt(0)! - 96);
		}
	} else if (shift && base >= 'a' && base <= 'z') {
		out = base.toUpperCase();
	}

	// Alt/Option is the ESC prefix (readline word-nav convention: \x1bb / \x1bf).
	if (alt) {
		out = '\x1b' + out;
	}

	return out;
}

/**
 * Rewrite every CSI u keyboard sequence in `data` to its legacy byte
 * equivalent. Pure and idempotent on already-legacy input.
 */
export function normalizeKittyKeyboard(data: string): string {
	if (!data.includes('\x1b[')) {
		return data;
	}
	return data.replace(csiURe, (whole, params: string) =>
		decodeCsiU(whole, params),
	);
}

/**
 * The subset of TTY-stream API Ink's `App` touches on its `props.stdin` that a
 * plain `Transform` doesn't already provide.
 */
type TtyLike = NodeJS.ReadStream;

/**
 * Wrap a TTY input stream so the bytes Ink reads have had their CSI u keyboard
 * sequences normalized. Forwards the TTY-specific methods Ink relies on
 * (`setRawMode`, `ref`, `unref`, `isTTY`) to the underlying stream; `read`,
 * `setEncoding`, and the `readable` event come from the Transform itself.
 *
 * We set the source encoding to utf8 so multi-byte input is decoded whole
 * before re-chunking, preventing a paste from splitting a codepoint across
 * reads.
 */
export function createNormalizingStdin(source: TtyLike): TtyLike {
	const transform = new Transform({
		transform(chunk: Buffer | string, _encoding, callback) {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			callback(null, normalizeKittyKeyboard(text));
		},
	}) as Transform & {
		isTTY?: boolean;
		setRawMode?: (mode: boolean) => void;
		ref?: () => void;
		unref?: () => void;
	};

	source.setEncoding('utf8');
	source.pipe(transform);
	// pipe() forwards `end` but not `error` (a Node gotcha) — couple the
	// transform's lifetime to the source so a stdin hangup tears it down too,
	// instead of leaving the wrapper alive waiting for data that never comes.
	source.on('error', (error: Error) => {
		transform.destroy(error);
	});

	transform.isTTY = source.isTTY;
	transform.setRawMode = (mode: boolean) => {
		source.setRawMode?.(mode);
		return transform as unknown as NodeJS.ReadStream;
	};
	transform.ref = () => {
		source.ref?.();
		return transform as unknown as NodeJS.ReadStream;
	};
	transform.unref = () => {
		source.unref?.();
		return transform as unknown as NodeJS.ReadStream;
	};

	return transform as unknown as TtyLike;
}
