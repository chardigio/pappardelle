// Sanitize subprocess errors so we don't dump kilobytes of command line into
// the TUI. Node's `execFile` rejects with an Error whose `.message` is
// "Command failed: <full command line>\n<stderr>". When the command embeds a
// large argument (e.g. a GraphQL query passed via `-f query=…`), the verbatim
// message swamps the actual signal from stderr. Prefer `err.stderr`; fall back
// to `err.message` with the "Command failed:" prefix line stripped. The result
// is always clipped to a sane character cap so a runaway error can't fill the
// TUI even after sanitization.

export const MAX_CHARS = 500;

export function sanitizeSubprocessError(err: unknown): Error {
	if (!(err instanceof Error)) {
		return new Error(typeof err === 'string' ? err : 'Unknown error');
	}

	const {stderr} = err as {stderr?: unknown};
	if (typeof stderr === 'string' && stderr.trim().length > 0) {
		return cloneError(err, clip(stderr.trim()));
	}

	const body = stripCommandFailedPrefix(err.message);
	return cloneError(err, clip(body));
}

function stripCommandFailedPrefix(message: string): string {
	if (!message.startsWith('Command failed:')) return message.trim();
	const newlineIdx = message.indexOf('\n');
	if (newlineIdx === -1) return message.trim();
	const remainder = message.slice(newlineIdx + 1).trim();
	return remainder.length > 0 ? remainder : message.trim();
}

function clip(text: string): string {
	if (text.length <= MAX_CHARS) return text;
	// Keep the tail — the most recent stderr lines are usually the load-bearing
	// ones. Reserve one char for the leading ellipsis so total length is exactly
	// MAX_CHARS (matches the convention in clip-error-text.ts).
	return '…' + text.slice(text.length - (MAX_CHARS - 1));
}

function cloneError(err: Error, message: string): Error {
	const clone = new Error(message);
	clone.name = err.name;
	const {code} = err as {code?: unknown};
	if (code !== undefined) {
		(clone as Error & {code?: unknown}).code = code;
	}

	return clone;
}
