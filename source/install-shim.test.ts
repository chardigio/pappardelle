import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';

// The installer pins Bun across non-interactive tmux environments.
const root = path.join(import.meta.dirname, '..');
const templatePath = path.join(root, 'scripts', 'pappardelle-shim-template.sh');
const installShPath = path.join(root, 'install.sh');

const placeholders = ['__BUN_BIN__', '__CLI_JS__', '__MIN_BUN_VERSION__'];

let temporaryCounter = 0;

function createTemporaryDir(suffix = ''): string {
	const dir = path.join(
		os.tmpdir(),
		`install-shim-test-${process.pid}-${Date.now()}-${temporaryCounter++}${suffix}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// Mirrors the `${SHIM_CONTENT//__PLACEHOLDER__/$value}` substitutions in
// install.sh — both are global replaces.
function renderShim(options: {
	bunBin: string;
	cliJs: string;
	minBunVersion: string;
}): string {
	const template = fs.readFileSync(templatePath, 'utf8');
	fs.mkdirSync(path.dirname(options.cliJs), {recursive: true});
	fs.writeFileSync(options.cliJs, '');
	return template
		.replaceAll('__BUN_BIN__', options.bunBin)
		.replaceAll('__CLI_JS__', options.cliJs)
		.replaceAll('__MIN_BUN_VERSION__', String(options.minBunVersion));
}

// A stand-in bun binary. Emulates the three ways the shim invokes bun:
// `-p 'parseInt(process.versions.bun, 10)'` (major only, parseInt
// semantics), `--version` (v-prefixed), and running the CLI (prints a marker
// plus each argument so tests can assert exactly what was exec'd).
function writeFakeBun(dir: string, version: string, name = 'bun'): string {
	const fakePath = path.join(dir, name);
	const script = `#!/bin/bash
FAKE_VERSION="${version}"
case "$1" in
	-p)
		echo "\${FAKE_VERSION%%.*}"
		;;
	--version)
		echo "\${FAKE_VERSION}"
		;;
	*)
		echo "FAKE_BUN \${FAKE_VERSION}"
		for arg in "$@"; do
			echo "ARG:\${arg}"
		done
		;;
esac
`;
	fs.writeFileSync(fakePath, script, {mode: 0o755});
	return fakePath;
}

function writeShim(shim: string): string {
	const dir = createTemporaryDir();
	const shimPath = path.join(dir, 'pappardelle');
	fs.writeFileSync(shimPath, shim, {mode: 0o755});
	return shimPath;
}

function runShim(
	shimPath: string,
	options: {pathDirs?: string[]; args?: string[]} = {},
) {
	// PATH is restricted to the test-provided directories: this both simulates
	// the non-interactive runtime environment and proves the shim needs no
	// external binaries (pure bash builtins), so it can't misbehave on
	// minimal PATHs.
	return spawnSync('/bin/bash', [shimPath, ...(options.args ?? [])], {
		env: {...process.env, PATH: (options.pathDirs ?? []).join(':')},
		encoding: 'utf8',
	});
}

// ============================================================================
// Template / installer drift guards
// ============================================================================

test('shim template exists and declares every placeholder', t => {
	t.true(
		fs.existsSync(templatePath),
		'scripts/pappardelle-shim-template.sh must exist — install.sh renders it',
	);
	const template = fs.readFileSync(templatePath, 'utf8');
	for (const placeholder of placeholders) {
		t.true(
			template.includes(placeholder),
			`template must contain ${placeholder}`,
		);
	}
});

test('install.sh substitutes every placeholder the template declares', t => {
	const installSh = fs.readFileSync(installShPath, 'utf8');
	t.true(
		installSh.includes('pappardelle-shim-template.sh'),
		'install.sh must render the template, not an inline heredoc',
	);
	for (const placeholder of placeholders) {
		t.true(
			installSh.includes(placeholder),
			`install.sh must substitute ${placeholder}`,
		);
	}
});

test('install.sh no longer writes an unpinned `exec bun` shim', t => {
	const installSh = fs.readFileSync(installShPath, 'utf8');
	t.false(
		installSh.includes('exec bun '),
		'a bare `exec bun` resolves from runtime PATH — the exact STA-1682 bug',
	);
});

// ============================================================================
// Pinned-bun behavior (fix 1: determinism)
// ============================================================================

test('shim execs the pinned bun even when PATH resolves to a stale bun', t => {
	const pinnedDir = createTemporaryDir();
	const staleDir = createTemporaryDir();
	const pinnedBun = writeFakeBun(pinnedDir, '1.4.4');
	writeFakeBun(staleDir, '1.3.0'); // The trap that bit on master.
	const cliJs = path.join(pinnedDir, 'cli.js');
	const shimPath = writeShim(
		renderShim({bunBin: pinnedBun, cliJs, minBunVersion: '1.4.0'}),
	);

	const result = runShim(shimPath, {pathDirs: [staleDir]});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(
		result.stdout.includes('FAKE_BUN 1.4.4'),
		`expected the pinned v22, got: ${result.stdout}`,
	);
	t.true(result.stdout.includes(`ARG:${cliJs}`));
});

test('shim accepts a pinned bun exactly at the floor', t => {
	const dir = createTemporaryDir();
	const pinnedBun = writeFakeBun(dir, '1.4.0');
	const shimPath = writeShim(
		renderShim({
			bunBin: pinnedBun,
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes('FAKE_BUN 1.4.0'));
});

test('shim rejects a pinned bun below the floor with an actionable message', t => {
	const dir = createTemporaryDir();
	const pinnedBun = writeFakeBun(dir, '1.3.0');
	const shimPath = writeShim(
		renderShim({
			bunBin: pinnedBun,
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath);

	t.not(result.status, 0);
	t.false(
		result.stdout.includes('FAKE_BUN'),
		'the CLI must not run under a too-old bun',
	);
	t.true(result.stderr.includes('1.3.0'));
	t.true(result.stderr.includes('1.4.0'));
	t.true(result.stderr.includes('install.sh'));
});

test('shim rejects a bun reporting a garbage version instead of half-running', t => {
	const dir = createTemporaryDir();
	const pinnedBun = writeFakeBun(dir, 'garbage');
	const shimPath = writeShim(
		renderShim({
			bunBin: pinnedBun,
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath);

	t.not(result.status, 0);
	t.false(result.stdout.includes('FAKE_BUN'));
});

test('shim handles install paths containing spaces', t => {
	const dir = createTemporaryDir(' with spaces');
	const pinnedBun = writeFakeBun(dir, '1.4.4');
	const cliJs = path.join(dir, 'cli.js');
	const shimPath = writeShim(
		renderShim({bunBin: pinnedBun, cliJs, minBunVersion: '1.4.0'}),
	);

	const result = runShim(shimPath);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes(`ARG:${cliJs}`));
});

test('shim passes arguments through untouched, including spaces', t => {
	const dir = createTemporaryDir();
	const pinnedBun = writeFakeBun(dir, '1.4.4');
	const shimPath = writeShim(
		renderShim({
			bunBin: pinnedBun,
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath, {
		args: ['highlight', 'STA-1682', 'two words'],
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes('ARG:highlight'));
	t.true(result.stdout.includes('ARG:STA-1682'));
	t.true(result.stdout.includes('ARG:two words'));
});

// ============================================================================
// Fallback behavior (fix 2: loud runtime guard when the pin vanishes)
// ============================================================================

test('shim falls back to a good PATH bun when the pinned binary is gone', t => {
	const dir = createTemporaryDir();
	const pathDir = createTemporaryDir();
	writeFakeBun(pathDir, '1.4.4');
	const shimPath = writeShim(
		renderShim({
			bunBin: path.join(dir, 'gone', 'bun'),
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath, {pathDirs: [pathDir]});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes('FAKE_BUN 1.4.4'));
});

test('shim fails loud when the pin is gone and the PATH bun is stale', t => {
	const dir = createTemporaryDir();
	const staleDir = createTemporaryDir();
	writeFakeBun(staleDir, '1.3.0');
	const shimPath = writeShim(
		renderShim({
			bunBin: path.join(dir, 'gone', 'bun'),
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath, {pathDirs: [staleDir]});

	t.not(result.status, 0);
	t.false(
		result.stdout.includes('FAKE_BUN'),
		'silent degradation under a stale bun is the exact bug being fixed',
	);
	t.true(result.stderr.includes('1.3.0'));
	t.true(result.stderr.includes('install.sh'));
});

test('shim fails loud when the pin is gone and no bun is on PATH', t => {
	const dir = createTemporaryDir();
	const emptyDir = createTemporaryDir();
	const goneBun = path.join(dir, 'gone', 'bun');
	const shimPath = writeShim(
		renderShim({
			bunBin: goneBun,
			cliJs: path.join(dir, 'cli.js'),
			minBunVersion: '1.4.0',
		}),
	);

	const result = runShim(shimPath, {pathDirs: [emptyDir]});

	t.not(result.status, 0);
	t.true(
		result.stderr.includes(goneBun),
		'the message must name the pinned path that vanished',
	);
	t.true(result.stderr.includes('install.sh'));
});
