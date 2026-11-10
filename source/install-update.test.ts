import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'ava';
import {updateShellScript} from './update-check.ts';

// A coworker who presses `U` on an unsupported runtime used to see Pappardelle quit with
// no message: the installer stopped at its Bun check, and the TUI killed its
// tmux session (and the error text) right after. These tests pin the three
// parts of the fix: the installer finds or installs a Bun that meets the
// floor, it never deletes a working install before the new one builds, and
// the `U` wrapper keeps failures visible.

const root = path.join(import.meta.dirname, '..');
const installSh = path.join(root, 'install.sh');

let counter = 0;
function temporaryDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`install-update-test-${process.pid}-${Date.now()}-${counter++}`,
	);
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

// Only these tools are on PATH, so a real bun on the test machine (or the CI
// runner) can never satisfy find_bun by accident.
const TOOLS = [
	'bash',
	'curl',
	'tar',
	'awk',
	'unzip',
	'zip',
	'gzip',
	'shasum',
	'sha256sum',
	'perl',
	'uname',
	'sort',
	'grep',
	'head',
	'cut',
	'mktemp',
	'rm',
	'mkdir',
	'ln',
	'mv',
	'find',
	'dirname',
	'cat',
	'git',
	'tee',
	'env',
];

function toolsDir(): string {
	const dir = temporaryDir();
	for (const tool of TOOLS) {
		const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
			encoding: 'utf8',
		}).stdout.trim();
		if (found) fs.symlinkSync(found, path.join(dir, tool));
	}
	return dir;
}

// Answers the two questions install.sh asks a bun (`-p` with execPath or the
// major version, and `--version`) without running JavaScript.
function fakeBunScript(version: string): string {
	return `#!/bin/bash
case "$1" in
	-p)
		if [[ "$2" == *execPath* ]]; then echo "$0"; else echo "${version.split('.')[0]!}"; fi
		;;
	--version) echo "${version}" ;;
esac
`;
}

function writeFakeBun(dir: string, version: string): string {
	fs.mkdirSync(dir, {recursive: true});
	const bunPath = path.join(dir, 'bun');
	fs.writeFileSync(bunPath, fakeBunScript(version), {mode: 0o755});
	return bunPath;
}

function runInstallFunction(
	call: string,
	env: Record<string, string>,
): {status: number | null; stdout: string; stderr: string} {
	const result = spawnSync(
		'/bin/bash',
		['-c', `source "${installSh}"; ${call}`],
		{
			encoding: 'utf8',
			env: {
				PAPPARDELLE_INSTALL_SOURCE_ONLY: '1',
				PATH: env['PATH'] ?? toolsDir(),
				...env,
			},
		},
	);
	return {
		status: result.status,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function platformSuffix(): string {
	const osName = process.platform === 'darwin' ? 'darwin' : 'linux';
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x64-baseline';
	return `${osName}-${arch}`;
}

// A local stand-in for the pinned official Bun release, served over
// file:// so the test never touches the network.
function fakeBunDist(options: {corruptChecksum?: boolean} = {}): string {
	const dist = temporaryDir();
	const name = `bun-${platformSuffix()}`;
	const build = temporaryDir();
	writeFakeBun(path.join(build, name), '1.4.4');
	const tarball = `${name}.zip`;
	spawnSync('zip', ['-qr', path.join(dist, tarball), name], {cwd: build});
	const hash = options.corruptChecksum
		? '0'.repeat(64)
		: crypto
				.createHash('sha256')
				.update(fs.readFileSync(path.join(dist, tarball)))
				.digest('hex');
	fs.writeFileSync(
		path.join(dist, 'SHASUMS256.txt'),
		`${'1'.repeat(64)}  bun-v1.4.4-aix-ppc64.tar.gz\n${hash}  ${tarball}\n`,
	);
	return `file://${dist}`;
}

// ============================================================================
// find_bun
// ============================================================================

test('find_bun prefers the bun the TUI passes over a stale PATH bun', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeBun(tools, '1.3.0');
	const tuiBun = writeFakeBun(path.join(temporaryDir(), 'bin'), '1.4.4');

	const result = runInstallFunction('find_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN: tuiBun,
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), tuiBun);
});

test('find_bun finds the standard user install after a stale PATH runtime', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeBun(tools, '1.3.0');
	const installed = writeFakeBun(path.join(home, '.bun', 'bin'), '1.4.4');
	const result = runInstallFunction('find_bun', {HOME: home, PATH: tools});
	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(result.stdout.trim(), installed);
});

test('find_bun fails when no bun meets the floor', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeBun(tools, '1.3.0');

	const result = runInstallFunction('find_bun', {HOME: home, PATH: tools});

	t.not(result.status, 0);
	t.is(result.stdout.trim(), '');
});

// ============================================================================
// install_private_bun
// ============================================================================

test('install_private_bun installs a verified bun that find_bun then uses', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	writeFakeBun(tools, '1.3.0');
	const env = {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(),
	};

	const installed = runInstallFunction('install_private_bun', env);
	t.is(installed.status, 0, `stderr: ${installed.stderr}`);
	const privateBun = path.join(home, '.pappardelle', 'bun', 'current', 'bun');
	t.is(installed.stdout.trim(), privateBun);
	t.true(installed.stderr.includes('your own Bun is not changed'));

	const found = runInstallFunction('find_bun', env);
	t.is(found.status, 0, `stderr: ${found.stderr}`);
	t.true(found.stdout.trim().endsWith('/bun'));
	t.true(found.stdout.trim().startsWith(path.join(home, '.pappardelle')));
});

test('install_private_bun refuses a checksum mismatch and keeps an earlier private bun', t => {
	const home = temporaryDir();
	const tools = toolsDir();
	const good = runInstallFunction('install_private_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist(),
	});
	t.is(good.status, 0, `stderr: ${good.stderr}`);
	const current = path.join(home, '.pappardelle', 'bun', 'current');
	const before = fs.readlinkSync(current);

	const bad = runInstallFunction('install_private_bun', {
		HOME: home,
		PATH: tools,
		PAPPARDELLE_BUN_DIST_URL: fakeBunDist({corruptChecksum: true}),
	});

	t.not(bad.status, 0);
	t.true(bad.stderr.includes('Checksum mismatch'));
	t.is(fs.readlinkSync(current), before);
});

// ============================================================================
// install_repo_atomically
// ============================================================================

// A git repo whose `bun run build` runs build.sh, with a fake bun on PATH so
// the test needs no registry.
function sourceRepo(buildScript: string): string {
	const repo = temporaryDir();
	fs.writeFileSync(path.join(repo, 'build.sh'), buildScript);
	const git = (...args: string[]) =>
		spawnSync('git', args, {cwd: repo, encoding: 'utf8'});
	git('init', '-q');
	git('add', '.');
	git(
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@example.com',
		'commit',
		'-q',
		'-m',
		'init',
	);
	return repo;
}

function toolsWithFakeBun(): string {
	const tools = toolsDir();
	fs.writeFileSync(
		path.join(tools, 'bun'),
		'#!/bin/bash\nif [[ "$1" == run ]]; then bash build.sh; fi\n',
		{mode: 0o755},
	);
	return tools;
}

function existingInstall(home: string): string {
	const repoDir = path.join(home, '.pappardelle', 'repo');
	fs.mkdirSync(path.join(repoDir, 'dist'), {recursive: true});
	fs.writeFileSync(path.join(repoDir, 'dist', 'cli.js'), 'old build');
	return repoDir;
}

test('a failed build leaves the current install in place', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(),
		PAPPARDELLE_REPO_URL: sourceRepo('exit 1\n'),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
	const leftovers = fs
		.readdirSync(path.join(home, '.pappardelle'))
		.filter(name => name.startsWith('repo.staging'));
	t.deepEqual(leftovers, []);
});

test('a clone failure leaves the current install in place', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(),
		PAPPARDELLE_REPO_URL: path.join(temporaryDir(), 'missing'),
	});

	t.not(result.status, 0);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

test('a successful build replaces the install and keeps the old one as a rollback', t => {
	const home = temporaryDir();
	const repoDir = existingInstall(home);

	const result = runInstallFunction('install_repo_atomically', {
		HOME: home,
		PATH: toolsWithFakeBun(),
		PAPPARDELLE_REPO_URL: sourceRepo(
			'mkdir -p dist && echo new build > dist/cli.js\n',
		),
	});

	t.is(result.status, 0, `stderr: ${result.stderr}`);
	t.is(
		fs.readFileSync(path.join(repoDir, 'dist', 'cli.js'), 'utf8').trim(),
		'new build',
	);
	t.is(
		fs.readFileSync(path.join(`${repoDir}.previous`, 'dist', 'cli.js'), 'utf8'),
		'old build',
	);
});

// ============================================================================
// updateShellScript (the `U` wrapper)
// ============================================================================

function runUpdateScript(installCommand: string, waitOnFailure?: boolean) {
	const home = temporaryDir();
	const result = spawnSync(
		'/bin/bash',
		['-c', updateShellScript({installCommand, waitOnFailure})],
		{encoding: 'utf8', env: {...process.env, HOME: home}, stdio: 'pipe'},
	);
	const log = path.join(home, '.pappardelle', 'logs', 'update.log');
	return {result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
}

test('a failed update keeps its exit status, explains it, and writes a log', t => {
	const {result, log} = runUpdateScript('echo installer ran; exit 3');

	t.is(result.status, 3);
	t.true(result.stdout.includes('The Pappardelle update failed (exit 3)'));
	t.true(result.stdout.includes('Press any key to close'));
	t.true(log.includes('installer ran'));
});

test('a failed update run from the shell reports the log without waiting for a key', t => {
	const {result, log} = runUpdateScript('echo installer ran; exit 3', false);

	t.is(result.status, 3);
	t.true(result.stdout.includes('The Pappardelle update failed (exit 3)'));
	t.false(result.stdout.includes('Press any key'));
	t.true(log.includes('installer ran'));
});

test('a successful update exits 0 without a failure message', t => {
	const {result, log} = runUpdateScript('echo all good');

	t.is(result.status, 0);
	t.false(result.stdout.includes('failed'));
	t.true(log.includes('all good'));
});

test('the default update script runs the published installer', t => {
	t.true(
		updateShellScript().includes(
			'https://raw.githubusercontent.com/chardigio/pappardelle/main/install.sh',
		),
	);
});

// ============================================================================
// local_clone_dir
// ============================================================================

function pappardelleCheckout(): string {
	const dir = temporaryDir();
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({name: 'pappardelle'}),
	);
	fs.writeFileSync(path.join(dir, 'install.sh'), '');
	return dir;
}

test('a piped install run from inside a pappardelle checkout is not a local install', t => {
	const checkout = pappardelleCheckout();
	const result = runInstallFunction(
		`cd "${checkout}" && local_clone_dir ""`,
		{},
	);
	t.not(result.status, 0);
	t.is(result.stdout, '');
});

test('an install script run from a pappardelle checkout installs from that checkout', t => {
	const checkout = pappardelleCheckout();
	const elsewhere = temporaryDir();
	const result = runInstallFunction(
		`cd "${elsewhere}" && local_clone_dir "${path.join(checkout, 'install.sh')}"`,
		{},
	);
	t.is(result.status, 0);
	t.is(result.stdout.trim(), checkout);
});
