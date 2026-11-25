import {test, expect} from 'bun:test';
import {MAX_CHARS, sanitizeSubprocessError} from './sanitize-error.ts';

// Mimics what `promisify(execFile)` produces on rejection: an Error with
// `message = "Command failed: <full cmd>\n<stderr>"` plus `stdout`/`stderr`
// properties on the error object.
function makeExecFileError({
	command,
	stderr,
}: {
	command: string;
	stderr: string;
}): Error {
	const err = new Error(`Command failed: ${command}\n${stderr}`) as Error & {
		stdout: string;
		stderr: string;
		code: number;
	};
	err.stdout = '';
	err.stderr = stderr;
	err.code = 1;
	return err;
}

test('prefers err.stderr when present', () => {
	const err = makeExecFileError({
		command: 'gh api graphql -f query=<<huge string>>',
		stderr: 'gh: API rate limit exceeded',
	});
	const sanitized = sanitizeSubprocessError(err);
	expect(sanitized.message).toBe('gh: API rate limit exceeded');
});

test('drops the embedded GraphQL query when err.stderr is non-empty', () => {
	const giantQuery =
		'query($owner: String!, $name: String!, $branch: String!) {\n' +
		'  repository(owner: $owner, name: $name) {\n' +
		'    pullRequests(headRefName: $branch, first: 1, states: OPEN) { nodes { number } }\n' +
		'  }\n' +
		'}';
	const command = `gh api graphql -f query=${giantQuery}`;
	const err = makeExecFileError({
		command,
		stderr: 'HTTP 502: Bad Gateway',
	});
	const sanitized = sanitizeSubprocessError(err);
	expect(
		sanitized.message.includes('query($owner:'),
		'sanitized message must not embed the GraphQL query',
	).toBe(false);
	expect(sanitized.message.includes('HTTP 502')).toBe(true);
});

test('falls back to err.message when stderr is missing', () => {
	const err = new Error('Connection timed out');
	const sanitized = sanitizeSubprocessError(err);
	expect(sanitized.message).toBe('Connection timed out');
});

test('falls back to err.message when stderr is empty/whitespace', () => {
	const err = new Error('something broke') as Error & {stderr: string};
	err.stderr = '   \n  ';
	const sanitized = sanitizeSubprocessError(err);
	expect(sanitized.message).toBe('something broke');
});

test('strips the "Command failed: <cmd>" prefix line on fallback', () => {
	// stderr is empty (e.g. execFileSync without explicit stdio pipe), but
	// err.message still starts with "Command failed: <giant cmd>\n<...>".
	const err = new Error(
		'Command failed: gh api graphql -f query=<<5kb of GraphQL>>\n' +
			'gh: HTTP 401: Bad credentials',
	);
	const sanitized = sanitizeSubprocessError(err);
	expect(sanitized.message).toBe('gh: HTTP 401: Bad credentials');
	expect(sanitized.message.includes('Command failed:')).toBe(false);
});

test('clips very long stderr to MAX_CHARS exactly', () => {
	const longStderr = 'x'.repeat(MAX_CHARS * 10);
	const err = makeExecFileError({
		command: 'gh api graphql',
		stderr: longStderr,
	});
	const sanitized = sanitizeSubprocessError(err);
	expect(
		sanitized.message.length,
		`expected sanitized message exactly ${MAX_CHARS} chars, got ${sanitized.message.length}`,
	).toBe(MAX_CHARS);
	expect(sanitized.message.startsWith('…')).toBe(true);
});

test('returns an Error for non-Error inputs', () => {
	const sanitized = sanitizeSubprocessError('boom');
	expect(sanitized instanceof Error).toBe(true);
	expect(sanitized.message).toBe('boom');
});

test('returns an Error for undefined input', () => {
	const sanitized = sanitizeSubprocessError(undefined);
	expect(sanitized instanceof Error).toBe(true);
	expect(sanitized.message.length > 0).toBe(true);
});

test('preserves the original Error name', () => {
	const err = new TypeError('bad type');
	const sanitized = sanitizeSubprocessError(err);
	expect(sanitized.name).toBe('TypeError');
});
