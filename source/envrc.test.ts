import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from 'bun:test';
import {loadEnvrcIntoProcessEnv, parseEnvrc} from './envrc.ts';
import {tempDir} from '../test/helpers/temp-dir.ts';

function makeTmpRepo(envrc: string | null): string {
	const dir = tempDir('pappardelle-envrc-test-');
	if (envrc !== null) {
		fs.writeFileSync(path.join(dir, '.envrc'), envrc);
	}

	return dir;
}

// ============================================================================
// parseEnvrc — pure parsing
// ============================================================================

test('parseEnvrc: plain export key=value', () => {
	expect(parseEnvrc('export FOO=bar')).toStrictEqual({FOO: 'bar'});
});

test('parseEnvrc: handles multiple lines', () => {
	expect(parseEnvrc('export FOO=bar\nexport BAZ=qux')).toStrictEqual({
		FOO: 'bar',
		BAZ: 'qux',
	});
});

test('parseEnvrc: strips double quotes around value', () => {
	expect(parseEnvrc('export FOO="bar baz"')).toStrictEqual({FOO: 'bar baz'});
});

test('parseEnvrc: strips single quotes around value', () => {
	expect(parseEnvrc("export FOO='bar baz'")).toStrictEqual({FOO: 'bar baz'});
});

test('parseEnvrc: ignores comments and blank lines', () => {
	const input = `
# a comment
export FOO=bar

# another comment
export BAZ=qux
	`;
	expect(parseEnvrc(input)).toStrictEqual({FOO: 'bar', BAZ: 'qux'});
});

test('parseEnvrc: ignores non-export lines (direnv stdlib calls)', () => {
	const input = `
dotenv
use nodejs 22
source_up
export FOO=bar
	`;
	expect(parseEnvrc(input)).toStrictEqual({FOO: 'bar'});
});

test('parseEnvrc: strips trailing inline comment from unquoted values', () => {
	expect(parseEnvrc('export FOO=bar # trailing')).toStrictEqual({FOO: 'bar'});
});

test('parseEnvrc: preserves # inside quoted values', () => {
	expect(parseEnvrc('export FOO="bar # not a comment"')).toStrictEqual({
		FOO: 'bar # not a comment',
	});
});

test('parseEnvrc: tolerates leading whitespace on lines', () => {
	expect(parseEnvrc('    export FOO=bar')).toStrictEqual({FOO: 'bar'});
});

test('parseEnvrc: empty input → empty map', () => {
	expect(parseEnvrc('')).toStrictEqual({});
});

test('parseEnvrc: value containing = signs (e.g. base64 padding)', () => {
	// The (.*) capture group greedily eats everything after the first `=`,
	// so values with their own `=` (signed JWTs, base64-padded keys, query
	// strings) round-trip intact. Pinning this so a future regex tweak
	// can't silently break it.
	expect(parseEnvrc('export FOO=bar=baz==')).toStrictEqual({FOO: 'bar=baz=='});
});

// ============================================================================
// loadEnvrcIntoProcessEnv — file + env integration
// ============================================================================

test('loadEnvrcIntoProcessEnv: applies vars when not already set', () => {
	const repo = makeTmpRepo('export FROM_FILE=value-from-file');
	const env: NodeJS.ProcessEnv = {};
	loadEnvrcIntoProcessEnv(repo, env);
	expect(env['FROM_FILE']).toBe('value-from-file');
});

test('loadEnvrcIntoProcessEnv: existing env vars take precedence over .envrc', () => {
	// Real failure mode: someone exported a key in their shell to override
	// homebase's default — pappardelle should respect that explicit value,
	// not silently overwrite it from disk.
	const repo = makeTmpRepo('export PRESET=from-file');
	const env: NodeJS.ProcessEnv = {PRESET: 'from-shell'};
	loadEnvrcIntoProcessEnv(repo, env);
	expect(env['PRESET']).toBe('from-shell');
});

test('loadEnvrcIntoProcessEnv: no-op when .envrc is absent', () => {
	const repo = makeTmpRepo(null);
	const env: NodeJS.ProcessEnv = {EXISTING: 'still here'};
	loadEnvrcIntoProcessEnv(repo, env);
	expect(env).toStrictEqual({EXISTING: 'still here'});
});

test('loadEnvrcIntoProcessEnv: skips unsupported direnv stdlib calls', () => {
	// Non-export lines should be ignored, not break the load entirely.
	const repo = makeTmpRepo(
		'dotenv\nuse nodejs 22\nexport LINCTL_API_KEY=lin_api_xyz\n',
	);
	const env: NodeJS.ProcessEnv = {};
	loadEnvrcIntoProcessEnv(repo, env);
	expect(env['LINCTL_API_KEY']).toBe('lin_api_xyz');
});
