// Defense-in-depth clipping for error text rendered in the TUI. Even after
// upstream sanitization, a noisy provider could push a multi-screen error
// through `log.warn` and trash the rail layout. We cap displayed errors at a
// few short lines and surface a hint pointing the user at ~/.pappardelle/logs/
// for the full text.

export const MAX_ERROR_LINES = 3;
export const MAX_ERROR_CHARS = 200;

export interface ClippedError {
	text: string;
	truncated: boolean;
}

export function clipErrorText(input: string): ClippedError {
	if (input.length === 0) return {text: '', truncated: false};

	const lines = input.split('\n');
	let truncated = false;
	let working = lines;
	if (lines.length > MAX_ERROR_LINES) {
		working = lines.slice(-MAX_ERROR_LINES);
		truncated = true;
	}

	let joined = working.join('\n');
	if (joined.length > MAX_ERROR_CHARS) {
		// Reserve one char for the leading ellipsis.
		joined = '…' + joined.slice(joined.length - (MAX_ERROR_CHARS - 1));
		truncated = true;
	}

	return {text: joined, truncated};
}
