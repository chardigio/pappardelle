import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';

// Regression tests for STA-1682: install.sh's preflight verified `node >= 18`
// in the *interactive* shell (where nvm/volta select a modern node), but the
// shim it wrote resolved `node` from PATH at *runtime* — a non-interactive
// environment where nvm never loads, so a stale /usr/local/bin/node (v16 from
// a 2021 .pkg install) silently won. The process started, looked healthy, and
// degraded in undocumented ways (`fetch is not defined`, …).
//
// The fix pins the installer-verified node binary into the shim and keeps a
// runtime major-version guard as belt-and-suspenders for when the pinned
// binary later vanishes (nvm uninstall, brew cleanup). These tests render the
// real template (`scripts/pappardelle-shim-template.sh`) exactly the way
// install.sh does, then run it against fake node binaries — proving the shim
// ignores a stale PATH node when the pin is healthy, and fails loud instead
// of half-working when no acceptable node can be found.

const root = path.join(import.meta.dirname, '..');
const templatePath = path.join(root, 'scripts', 'pappardelle-shim-template.sh');
const installShPath = path.join(root, 'install.sh');

const placeholders = ['__NODE_BIN__', '__CLI_JS__', '__MIN_NODE_MAJOR__'];

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
	nodeBin: string;
	cliJs: string;
	minNodeMajor: number;
}): string {
	const template = fs.readFileSync(templatePath, 'utf8');
	return template
		.replaceAll('__NODE_BIN__', options.nodeBin)
		.replaceAll('__CLI_JS__', options.cliJs)
		.replaceAll('__MIN_NODE_MAJOR__', String(options.minNodeMajor));
}

// A stand-in node binary. Emulates the three ways the shim invokes node:
// `-p 'parseInt(process.versions.node, 10)'` (major only, parseInt
// semantics), `--version` (v-prefixed), and running the CLI (prints a marker
// plus each argument so tests can assert exactly what was exec'd).
function writeFakeNode(dir: string, version: string, name = 'node'): string {
	const fakePath = path.join(dir, name);
	const script = `#!/bin/bash
FAKE_VERSION="${version}"
case "$1" in
	-p)
		echo "\${FAKE_VERSION%%.*}"
		;;
	--version)
		echo "v\${FAKE_VERSION}"
		;;
	*)
		echo "FAKE_NODE \${FAKE_VERSION}"
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

test('install.sh no longer writes an unpinned `exec node` shim', t => {
	const installSh = fs.readFileSync(installShPath, 'utf8');
	t.false(
		installSh.includes('exec node '),
		'a bare `exec node` resolves from runtime PATH — the exact STA-1682 bug',
	);
});

// ============================================================================
// Pinned-node behavior (fix 1: determinism)
// ============================================================================

test('shim execs the pinned node even when PATH resolves to a stale node', t => {
	const pinnedDir = createTemporaryDir();
	const staleDir = createTemporaryDir();
	const pinnedNode = writeFakeNode(pinnedDir, '22.20.0');
	writeFakeNode(staleDir, '16.13.0'); // The trap that bit on master.
	const cliJs = path.join(pinnedDir, 'cli.js');
	const shimPath = writeShim(
		renderShim({nodeBin: pinnedNode, cliJs, minNodeMajor: 18}),
	);

	const result = runShim(shimPath, {pathDirs: [staleDir]});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(
		result.stdout.includes('FAKE_NODE 22.20.0'),
		`expected the pinned v22, got: ${result.stdout}`,
	);
	t.true(result.stdout.includes(`ARG:${cliJs}`));
});

test('shim accepts a pinned node exactly at the floor', t => {
	const dir = createTemporaryDir();
	const pinnedNode = writeFakeNode(dir, '18.0.0');
	const shimPath = writeShim(
		renderShim({
			nodeBin: pinnedNode,
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes('FAKE_NODE 18.0.0'));
});

test('shim rejects a pinned node below the floor with an actionable message', t => {
	const dir = createTemporaryDir();
	const pinnedNode = writeFakeNode(dir, '16.13.0');
	const shimPath = writeShim(
		renderShim({
			nodeBin: pinnedNode,
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath);

	t.not(result.status, 0);
	t.false(
		result.stdout.includes('FAKE_NODE'),
		'the CLI must not run under a too-old node',
	);
	t.true(result.stderr.includes('v16.13.0'));
	t.true(result.stderr.includes('18'));
	t.true(result.stderr.includes('install.sh'));
});

test('shim rejects a node reporting a garbage version instead of half-running', t => {
	const dir = createTemporaryDir();
	const pinnedNode = writeFakeNode(dir, 'garbage');
	const shimPath = writeShim(
		renderShim({
			nodeBin: pinnedNode,
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath);

	t.not(result.status, 0);
	t.false(result.stdout.includes('FAKE_NODE'));
});

test('shim handles install paths containing spaces', t => {
	const dir = createTemporaryDir(' with spaces');
	const pinnedNode = writeFakeNode(dir, '22.20.0');
	const cliJs = path.join(dir, 'cli.js');
	const shimPath = writeShim(
		renderShim({nodeBin: pinnedNode, cliJs, minNodeMajor: 18}),
	);

	const result = runShim(shimPath);

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes(`ARG:${cliJs}`));
});

test('shim passes arguments through untouched, including spaces', t => {
	const dir = createTemporaryDir();
	const pinnedNode = writeFakeNode(dir, '22.20.0');
	const shimPath = writeShim(
		renderShim({
			nodeBin: pinnedNode,
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
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

test('shim falls back to a good PATH node when the pinned binary is gone', t => {
	const dir = createTemporaryDir();
	const pathDir = createTemporaryDir();
	writeFakeNode(pathDir, '22.20.0');
	const shimPath = writeShim(
		renderShim({
			nodeBin: path.join(dir, 'gone', 'node'),
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath, {pathDirs: [pathDir]});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.true(result.stdout.includes('FAKE_NODE 22.20.0'));
});

test('shim fails loud when the pin is gone and the PATH node is stale', t => {
	const dir = createTemporaryDir();
	const staleDir = createTemporaryDir();
	writeFakeNode(staleDir, '16.13.0');
	const shimPath = writeShim(
		renderShim({
			nodeBin: path.join(dir, 'gone', 'node'),
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath, {pathDirs: [staleDir]});

	t.not(result.status, 0);
	t.false(
		result.stdout.includes('FAKE_NODE'),
		'silent degradation under a stale node is the exact bug being fixed',
	);
	t.true(result.stderr.includes('v16.13.0'));
	t.true(result.stderr.includes('install.sh'));
});

test('shim fails loud when the pin is gone and no node is on PATH', t => {
	const dir = createTemporaryDir();
	const emptyDir = createTemporaryDir();
	const goneNode = path.join(dir, 'gone', 'node');
	const shimPath = writeShim(
		renderShim({
			nodeBin: goneNode,
			cliJs: path.join(dir, 'cli.js'),
			minNodeMajor: 18,
		}),
	);

	const result = runShim(shimPath, {pathDirs: [emptyDir]});

	t.not(result.status, 0);
	t.true(
		result.stderr.includes(goneNode),
		'the message must name the pinned path that vanished',
	);
	t.true(result.stderr.includes('install.sh'));
});
