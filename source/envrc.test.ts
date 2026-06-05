import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {loadEnvrcIntoProcessEnv, parseEnvrc} from './envrc.ts';

let tmpCounter = 0;
function makeTmpRepo(envrc: string | null): string {
	const dir = fs.mkdtempSync(
		path.join(
			os.tmpdir(),
			`pappardelle-envrc-test-${process.pid}-${tmpCounter++}-`,
		),
	);
	if (envrc !== null) {
		fs.writeFileSync(path.join(dir, '.envrc'), envrc);
	}

	return dir;
}

// ============================================================================
// parseEnvrc — pure parsing
// ============================================================================

test('parseEnvrc: plain export key=value', t => {
	t.deepEqual(parseEnvrc('export FOO=bar'), {FOO: 'bar'});
});

test('parseEnvrc: handles multiple lines', t => {
	t.deepEqual(parseEnvrc('export FOO=bar\nexport BAZ=qux'), {
		FOO: 'bar',
		BAZ: 'qux',
	});
});

test('parseEnvrc: strips double quotes around value', t => {
	t.deepEqual(parseEnvrc('export FOO="bar baz"'), {FOO: 'bar baz'});
});

test('parseEnvrc: strips single quotes around value', t => {
	t.deepEqual(parseEnvrc("export FOO='bar baz'"), {FOO: 'bar baz'});
});

test('parseEnvrc: ignores comments and blank lines', t => {
	const input = `
# a comment
export FOO=bar

# another comment
export BAZ=qux
	`;
	t.deepEqual(parseEnvrc(input), {FOO: 'bar', BAZ: 'qux'});
});

test('parseEnvrc: ignores non-export lines (direnv stdlib calls)', t => {
	const input = `
dotenv
use nodejs 22
source_up
export FOO=bar
	`;
	t.deepEqual(parseEnvrc(input), {FOO: 'bar'});
});

test('parseEnvrc: strips trailing inline comment from unquoted values', t => {
	t.deepEqual(parseEnvrc('export FOO=bar # trailing'), {FOO: 'bar'});
});

test('parseEnvrc: preserves # inside quoted values', t => {
	t.deepEqual(parseEnvrc('export FOO="bar # not a comment"'), {
		FOO: 'bar # not a comment',
	});
});

test('parseEnvrc: tolerates leading whitespace on lines', t => {
	t.deepEqual(parseEnvrc('    export FOO=bar'), {FOO: 'bar'});
});

test('parseEnvrc: empty input → empty map', t => {
	t.deepEqual(parseEnvrc(''), {});
});

test('parseEnvrc: value containing = signs (e.g. base64 padding)', t => {
	// The (.*) capture group greedily eats everything after the first `=`,
	// so values with their own `=` (signed JWTs, base64-padded keys, query
	// strings) round-trip intact. Pinning this so a future regex tweak
	// can't silently break it.
	t.deepEqual(parseEnvrc('export FOO=bar=baz=='), {FOO: 'bar=baz=='});
});

// ============================================================================
// loadEnvrcIntoProcessEnv — file + env integration
// ============================================================================

test('loadEnvrcIntoProcessEnv: applies vars when not already set', t => {
	const repo = makeTmpRepo('export FROM_FILE=value-from-file');
	const env: NodeJS.ProcessEnv = {};
	loadEnvrcIntoProcessEnv(repo, env);
	t.is(env['FROM_FILE'], 'value-from-file');
});

test('loadEnvrcIntoProcessEnv: existing env vars take precedence over .envrc', t => {
	// Real failure mode: someone exported a key in their shell to override
	// homebase's default — pappardelle should respect that explicit value,
	// not silently overwrite it from disk.
	const repo = makeTmpRepo('export PRESET=from-file');
	const env: NodeJS.ProcessEnv = {PRESET: 'from-shell'};
	loadEnvrcIntoProcessEnv(repo, env);
	t.is(env['PRESET'], 'from-shell');
});

test('loadEnvrcIntoProcessEnv: no-op when .envrc is absent', t => {
	const repo = makeTmpRepo(null);
	const env: NodeJS.ProcessEnv = {EXISTING: 'still here'};
	loadEnvrcIntoProcessEnv(repo, env);
	t.deepEqual(env, {EXISTING: 'still here'});
});

test('loadEnvrcIntoProcessEnv: skips unsupported direnv stdlib calls', t => {
	// Non-export lines should be ignored, not break the load entirely.
	const repo = makeTmpRepo(
		'dotenv\nuse nodejs 22\nexport LINCTL_API_KEY=lin_api_xyz\n',
	);
	const env: NodeJS.ProcessEnv = {};
	loadEnvrcIntoProcessEnv(repo, env);
	t.is(env['LINCTL_API_KEY'], 'lin_api_xyz');
});
